/**
 * The nanny: when WSL is out of CPU or memory, it says whose tools cause it.
 * On 2026-10-04 the laptop ran at load 111–139 on 16 cores because benchmarks,
 * test gates and `ty --watch` from different sessions piled up, and only the
 * reader noticed.
 *
 * `decide` is the whole policy and does no I/O: what it is told (the 10 s
 * verdicts, each session's tools, the time) and what it remembered last call
 * go in; the chips to show, the notices to send into sessions, a note for the
 * reader and what to remember come out. `index.ts` carries them out.
 *
 * - Chips name the sessions behind the load while CPU or memory is orange or
 *   red, and stay until the machine has been green for 60 s, so a verdict that
 *   flips for a second does not make them flicker.
 * - A notice goes into a session's conversation only when CPU or memory has
 *   been red for 30 s without a break, only to the session using most, only
 *   when that session is working (`prompt` resumes an ended session and
 *   clears its snooze, so an idle one is never messaged), and at most once
 *   every 10 min per session.
 * - The reader is told at most once every 10 min: after 3 min red, or at
 *   once when most of the load is no session's.
 */

import type { Decoration } from "./prifly-api";
import type { Verdicts } from "./verdict";

/** What the nanny judges: the two resources a session's tools can exhaust. */
type Resource = "cpu" | "memory";
const RESOURCES: Resource[] = ["cpu", "memory"];

/** Red for this long, without a break, before a session is told. */
export const NOTICE_AFTER = 30_000;
/** Red for this long before the reader is told, whoever is behind it. */
export const NOTIFY_AFTER = 180_000;
/** The longest between two messages to one session, and between two to the reader. */
export const COOLDOWN = 10 * 60_000;
/** Green this long, without a break, before the chips go. */
export const GREEN_FOR = 60_000;
/** The most sessions with a chip at once. */
const CHIPS = 3;
/** A session is a culprit from this many cores, or this share of the RAM. */
const MIN_CORES = 1;
const MIN_RAM = 0.1;

export type NannySession = {
  id: string;
  title: string;
  /** As prifly reports it; only "working" is ever messaged. */
  state: string;
  /** Cores its tools use, averaged over a window. */
  cores: number;
  /** Bytes of memory its tools hold. */
  rss: number;
  /** Its busiest program, as `commandLabel` names it, or "". */
  doing: string;
  /** That program's pid, or 0. */
  pid: number;
};

export type NannyInput = {
  /** The last 10 s of WSL, judged. */
  verdicts: Verdicts;
  /** The figures the message quotes: CPU `some`, and memory `full`, in percent. */
  psi: { cpu: number; memory: number };
  cores: number;
  /** Total RAM, bytes. */
  memTotal: number;
  sessions: NannySession[];
  /** Cores in use that no session owns: the machine's busy cores less every session's processes. */
  unowned: number;
};

export type NannyMemory = {
  /** When each resource turned red and has stayed so; null while it is not. */
  critical: Record<Resource, number | null>;
  /** When both turned green and have stayed so; null while either is not. */
  greenSince: number | null;
  /** The chips on show, by session id. */
  chips: Record<string, Decoration>;
  /** When each session was last sent a notice. */
  told: Record<string, number>;
  /** When the reader was last told. */
  notifiedAt: number | null;
};

export type Notice = { session: string; text: string };

export type Decision = {
  chips: Record<string, Decoration[]>;
  notices: Notice[];
  notify: { text: string; session?: string } | null;
  memory: NannyMemory;
};

export const newNannyMemory = (): NannyMemory => ({
  critical: { cpu: null, memory: null },
  greenSince: null,
  chips: {},
  told: {},
  notifiedAt: null,
});

/** How much of a resource a session's tools use, and how much of it there is. */
function useOf(resource: Resource, session: NannySession, input: NannyInput) {
  return resource === "cpu"
    ? { used: session.cores, of: input.cores, min: MIN_CORES }
    : { used: session.rss, of: input.memTotal, min: MIN_RAM * input.memTotal };
}

const gigabytes = (bytes: number): string => (bytes / 2 ** 30).toFixed(1);

/** "Using 6.4 of 16 cores", "Using 12.3 of 31.3 GB". */
function usingOf(resource: Resource, session: NannySession, input: NannyInput): string {
  return resource === "cpu"
    ? `${session.cores.toFixed(1)} of ${input.cores} cores`
    : `${gigabytes(session.rss)} of ${gigabytes(input.memTotal)} GB`;
}

/** The sessions that use at least the minimum of a resource that is short, the heaviest first. */
function culprits(input: NannyInput) {
  const best = new Map<string, { session: NannySession; resource: Resource; share: number }>();
  for (const resource of RESOURCES) {
    if (input.verdicts[resource] === "good") continue;
    for (const session of input.sessions) {
      const { used, of, min } = useOf(resource, session, input);
      if (of <= 0 || used < min) continue;
      const share = used / of;
      if (share > (best.get(session.id)?.share ?? 0))
        best.set(session.id, { session, resource, share });
    }
  }
  return [...best.values()].sort((a, b) => b.share - a.share).slice(0, CHIPS);
}

/** "45 s", "3 min": coarse on purpose. */
function spanText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** The figure a message quotes for a resource. */
function psiText(resource: Resource, input: NannyInput): string {
  return resource === "cpu"
    ? `PSI cpu some ${Math.round(input.psi.cpu)} %`
    : `PSI memory full ${Math.round(input.psi.memory)} %`;
}

const WORDS: Record<Resource, string> = { cpu: "CPU", memory: "memory" };

function chipFor(
  culprit: { session: NannySession; resource: Resource },
  input: NannyInput,
  memory: NannyMemory,
  now: number,
): Decoration {
  const { session, resource } = culprit;
  const tone = input.verdicts[resource] === "critical" ? "critical" : "warning";
  const told = memory.told[session.id];
  return {
    key: "nanny",
    icon: "activity",
    label: `Using ${usingOf(resource, session, input)}${session.doing === "" ? "" : `: ${session.doing}`}`,
    tone,
    details: [
      `WSL is ${tone === "critical" ? "out of" : "short of"} ${WORDS[resource]} (${psiText(resource, input)}); this session's tools use the most.`,
      session.doing === ""
        ? "No single busy program."
        : `Busiest program: ${session.doing} (pid ${session.pid})`,
      told === undefined
        ? "Not told by the nanny yet."
        : `Told by the nanny ${spanText(now - told)} ago.`,
    ],
    panel: "perf",
  };
}

/**
 * The chips: fresh while something is short; kept while the machine has been
 * green for less than `GREEN_FOR`; dropped after. While something is short but
 * no session uses enough to blame, the old ones stay.
 */
function chipsOf(input: NannyInput, memory: NannyMemory, now: number) {
  const short = RESOURCES.some((resource) => input.verdicts[resource] !== "good");
  if (short) {
    const fresh = culprits(input);
    const chips =
      fresh.length === 0
        ? memory.chips
        : Object.fromEntries(
            fresh.map((culprit) => [culprit.session.id, chipFor(culprit, input, memory, now)]),
          );
    return { chips, greenSince: null };
  }
  const greenSince = memory.greenSince ?? now;
  return { chips: now - greenSince >= GREEN_FOR ? {} : memory.chips, greenSince };
}

/** The resources that have been red for at least `ms`, CPU first. */
function redFor(memory: NannyMemory, now: number, ms: number): Resource[] {
  return RESOURCES.filter((resource) => {
    const since = memory.critical[resource];
    return since !== null && now - since >= ms;
  });
}

/** The session using most of a resource, if it uses enough to be blamed. */
function heaviest(resource: Resource, input: NannyInput): NannySession | undefined {
  const top = [...input.sessions].sort(
    (a, b) => useOf(resource, b, input).used - useOf(resource, a, input).used,
  )[0];
  return top !== undefined && useOf(resource, top, input).used >= useOf(resource, top, input).min
    ? top
    : undefined;
}

/** CPU is mostly nobody's: more cores go to processes no session owns than to its heaviest. */
function mostlyUnowned(input: NannyInput): boolean {
  const top = heaviest("cpu", input);
  return input.unowned >= MIN_CORES && input.unowned > (top?.cores ?? 0);
}

function noticeText(resource: Resource, session: NannySession, input: NannyInput, ms: number) {
  const program = session.doing === "" ? "" : `: \`${session.doing}\` (pid ${session.pid})`;
  return (
    `prifly's Performance extension: WSL has been out of ${WORDS[resource]} for ${spanText(ms)} ` +
    `(${psiText(resource, input)}). This session's tools use ${usingOf(resource, session, input)}${program}. ` +
    "Please let it finish without starting more heavy work. If it is a benchmark, a long build or a " +
    "training run, stop it and offer the reader a rented machine (`mcp__prifly__machines`). " +
    "Reply briefly; no need to ask the reader about this notice."
  );
}

/** The one session to tell, if any: the heaviest, and only if it is working and not told lately. */
function noticeFor(input: NannyInput, memory: NannyMemory, now: number): Notice | null {
  const unowned = mostlyUnowned(input);
  for (const resource of redFor(memory, now, NOTICE_AFTER)) {
    if (resource === "cpu" && unowned) continue;
    const top = heaviest(resource, input);
    if (top === undefined || top.state !== "working") continue;
    const last = memory.told[top.id];
    if (last !== undefined && now - last < COOLDOWN) continue;
    const since = memory.critical[resource] ?? now;
    return { session: top.id, text: noticeText(resource, top, input, now - since) };
  }
  return null;
}

/** What to tell the reader, if anything is worth it now. */
function notifyFor(input: NannyInput, memory: NannyMemory, now: number): Decision["notify"] {
  if (memory.notifiedAt !== null && now - memory.notifiedAt < COOLDOWN) return null;
  const cpuSince = memory.critical.cpu;
  if (cpuSince !== null && now - cpuSince >= NOTICE_AFTER && mostlyUnowned(input)) {
    return {
      text:
        `WSL has been out of CPU for ${spanText(now - cpuSince)} (${psiText("cpu", input)}). ` +
        `Most of it is no session's: ${input.unowned.toFixed(1)} of ${input.cores} cores go to ` +
        "processes outside every prifly session (Docker, Windows-side tools or something started by hand).",
    };
  }
  const [resource] = redFor(memory, now, NOTIFY_AFTER);
  if (resource === undefined) return null;
  const top = heaviest(resource, input);
  const since = memory.critical[resource] ?? now;
  const text = `WSL has been out of ${WORDS[resource]} for ${spanText(now - since)} (${psiText(resource, input)}).`;
  if (top === undefined) return { text };
  const program = top.doing === "" ? "" : `: ${top.doing}`;
  return {
    text: `${text} The most is used by "${top.title}": ${usingOf(resource, top, input)}${program}.`,
    session: top.id,
  };
}

/** Forget what was told long ago: only the last 10 min matter. */
function recent(told: Record<string, number>, now: number): Record<string, number> {
  return Object.fromEntries(Object.entries(told).filter(([, at]) => now - at < COOLDOWN));
}

export function decide(memory: NannyMemory, input: NannyInput, now: number): Decision {
  const critical = { ...memory.critical };
  for (const resource of RESOURCES) {
    if (input.verdicts[resource] !== "critical") critical[resource] = null;
    else critical[resource] ??= now;
  }
  const seen: NannyMemory = { ...memory, critical, told: recent(memory.told, now) };
  const shown = chipsOf(input, seen, now);
  const notice = noticeFor(input, seen, now);
  const notify = notifyFor(input, seen, now);
  const next: NannyMemory = {
    critical,
    greenSince: shown.greenSince,
    chips: shown.chips,
    told: notice === null ? seen.told : { ...seen.told, [notice.session]: now },
    notifiedAt: notify === null ? memory.notifiedAt : now,
  };
  return {
    chips: Object.fromEntries(Object.entries(shown.chips).map(([id, chip]) => [id, [chip]])),
    notices: notice === null ? [] : [notice],
    notify,
    memory: next,
  };
}
