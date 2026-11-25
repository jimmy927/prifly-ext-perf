/**
 * One second of the nanny (`nanny.ts`) in the running extension: reading the
 * process table for it while the window is closed, working out each session's
 * tools, and carrying out what it decided.
 */

import { averageLinux, averageProcs } from "./average";
import { McpConfig } from "./mcp";
import { decide, type NannySession, type Notice } from "./nanny";
import { ownerIdsOf, toolUseOf } from "./prifly";
import { open, type State } from "./state";
import type { Verdicts } from "./verdict";
import type { LinuxSample } from "./wsl";

/** While only the nanny reads them: every 5 s, 30 s kept, and averaged over the 30 s. */
const NANNY_EVERY = 5_000;
const NANNY_KEEP = 30;
/** A table older than this is from before a gap, and says nothing about now. */
const NANNY_STALE = 15_000;
/** The fewest seconds a table must span for its rates to mean anything. */
const NANNY_MIN_SPAN = 3;

/**
 * While WSL's CPU or memory is not green and the window is closed, nobody else
 * reads the process table: read it every 5 s, and keep 30 s of it. After a
 * gap the old tables would stretch the average over the gap, so they go.
 */
function readForNanny(current: State, verdicts: Verdicts, now: number): void {
  if (verdicts.cpu === "good" && verdicts.memory === "good") return;
  const procs = current.tables.procs;
  const last = procs.at(-1);
  if (last !== undefined && now - last.at < NANNY_EVERY - 250) return;
  if (last !== undefined && now - last.at > NANNY_STALE) procs.length = 0;
  current.tables.readProcs(NANNY_KEEP);
}

/**
 * Each session's tools, and the cores no session owns, from the process table
 * averaged over its last 30 s. Worked out once per table, not once a second.
 * Null while the table is missing, stale or too short for its rates to mean
 * anything: a nanny that cannot see says nothing.
 */
function nannyUse(current: State, now: number): State["nannyUse"] {
  const last = current.tables.procs.at(-1);
  if (last === undefined || now - last.at > NANNY_STALE) return null;
  if (current.nannyUse?.at === last.at) return current.nannyUse;
  const procs = averageProcs(current.tables.procs, NANNY_KEEP);
  if (procs === null || procs.covered < NANNY_MIN_SPAN) return null;
  // The machine's busy cores over the same stretch, less every process some session owns:
  // what is left is Docker, Windows-side work, or something started by hand.
  const linux = averageLinux(current.linux, procs.covered);
  const owners = ownerIdsOf(procs.value);
  const owned = procs.value.reduce((sum, p) => sum + (owners.has(p.pid) ? p.cpu : 0), 0);
  const busy = linux === null ? 0 : (linux.value.busy * linux.value.cores) / 100;
  current.nannyUse = {
    at: last.at,
    use: toolUseOf(procs.value, current.api.sessions(), new McpConfig()),
    unowned: Math.max(0, busy - owned),
  };
  return current.nannyUse;
}

/** The sessions the host knows that run tools, with their state as it is now. */
function nannySessions(current: State, now: number): { sessions: NannySession[]; unowned: number } {
  const data = nannyUse(current, now);
  if (data === null) return { sessions: [], unowned: 0 };
  const sessions = current.api.sessions().flatMap((session) => {
    const use = data.use.get(session.id);
    return use === undefined
      ? []
      : [{ id: session.id, title: session.title, state: session.state, ...use }];
  });
  return { sessions, unowned: data.unowned };
}

/** Tells a session to ease off. A failure is logged, never thrown: the nanny must go on. */
async function sendNotice(current: State, notice: Notice): Promise<void> {
  current.api.log("nanny_notice", { session: notice.session, text: notice.text });
  try {
    const { delivered } = await current.api.prompt(notice.session, notice.text);
    if (!delivered) current.api.log("nanny_notice_failed", { session: notice.session });
  } catch (error) {
    current.api.log("nanny_notice_failed", { session: notice.session, error: String(error) });
  }
}

/** One second of the nanny: judge, carry out what it decided, and return the chips to show. */
export function nannyStep(current: State, linux: LinuxSample, verdicts: Verdicts) {
  const now = Date.now();
  if (!open(current)) readForNanny(current, verdicts, now);
  const { sessions, unowned } = nannySessions(current, now);
  const decision = decide(
    current.nanny,
    {
      verdicts,
      psi: { cpu: linux.cpu?.some ?? 0, memory: linux.memory?.full ?? 0 },
      cores: linux.cores,
      memTotal: linux.memTotal,
      sessions,
      unowned,
    },
    now,
  );
  current.nanny = decision.memory;
  for (const notice of decision.notices) void sendNotice(current, notice);
  if (decision.notify !== null) {
    const { text, session } = decision.notify;
    current.api.log("nanny_notify", { text, session: session ?? null });
    const tone = "warning";
    current.api.notify(text, session === undefined ? { tone } : { tone, session });
  }
  return decision.chips;
}
