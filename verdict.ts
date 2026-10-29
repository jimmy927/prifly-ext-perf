/**
 * Green, orange or red for each resource, and the sentence that says what
 * the machine is out of. Thresholds, and where they come from:
 *
 * - Linux: pressure stall information (docs.kernel.org/accounting/psi.html).
 *   CPU `some` is the share of time at least one task waited for a core;
 *   memory and I/O `full` the share when every task waited — time lost
 *   outright. Memory is orange from 5 % `full` or 20 % `some`, red from 20 %
 *   `full`, and also by what is available (orange under 20 %, red under 10 %).
 * - Windows: the long-standing Performance Monitor guidance — a processor
 *   queue above two per core is a CPU bottleneck; memory by commit charge,
 *   page-file writes and trimming (`windowsMemory`); disk reads slower than 25 ms are out of spec (15 ms
 *   worth watching). `Pages Input/sec` is left out on purpose: its "under 15"
 *   rule dates from spinning disks, and an NVMe laptop reads thousands a
 *   second with nothing wrong (4,195 measured here, 2026-10-01).
 */

import type { WindowsCounters, WindowsInfo } from "./windows";
import type { LinuxSample } from "./wsl";

export type Tone = "good" | "warning" | "critical";
export type Resource = "cpu" | "memory" | "disk";
export type Verdicts = Record<Resource, Tone>;

const RANK: Record<Tone, number> = { good: 0, warning: 1, critical: 2 };

function band(value: number, warning: number, critical: number): Tone {
  if (value >= critical) return "critical";
  return value >= warning ? "warning" : "good";
}

export function worst(...tones: Tone[]): Tone {
  return tones.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "good");
}

export function linuxVerdicts(s: LinuxSample): Verdicts {
  const available = s.memTotal > 0 ? s.memAvailable / s.memTotal : 1;
  return {
    // Without PSI, a run queue twice the cores stands in.
    cpu: s.cpu === null ? band(s.runnable / s.cores, 1, 2) : band(s.cpu.some, 10, 40),
    memory: worst(
      // A memory stall also counts reading dropped file pages back and small
      // reclaim pauses, which a healthy machine has: 0.6 % `full` with 40 % free
      // read "short" on 2026-10-01. Only stalls a person would feel count.
      band(s.memory?.full ?? 0, 5, 20),
      band(s.memory?.some ?? 0, 20, Number.POSITIVE_INFINITY),
      available < 0.1 ? "critical" : available < 0.2 ? "warning" : "good",
    ),
    disk: band(s.io?.full ?? 0, 5, 20),
  };
}

/**
 * Transition faults a second at which Windows counts as short, and out, of
 * memory: pages trimmed out of working sets and faulted straight back.
 * PROVISIONAL, awaiting idle and normal readings on this machine: on
 * 2026-10-29, at 92 % committed and 4.7–7.6 GB of 47 GB available, it ran
 * 74,000–160,000 a second (138,000 typical) with no page-file writes at all.
 */
const TRIMMING_WARNING = 20_000;
const TRIMMING_CRITICAL = 80_000;

/**
 * Windows memory, judged by what shows a real shortage: commit charge (can
 * Windows still hand memory out?), writes to the page file (is it pushing
 * memory out to make room?) and transition faults (is it trimming working
 * sets and compressing them, which never reaches the page file?). Available
 * memory counts only when it is truly low: the WSL VM keeps its own file cache
 * (`autoMemoryReclaim=disabled`), so 18 % available with 70 % committed and no
 * paging is a calm machine, not a short one (measured here, 2026-10-01).
 */
function windowsMemory(c: WindowsCounters, info: WindowsInfo): Tone {
  const availableBytes = (c.availableMB ?? 0) * 2 ** 20;
  const available = info.memTotal > 0 ? availableBytes / info.memTotal : 1;
  const low =
    available < 0.05 || availableBytes < 2 ** 30
      ? "critical"
      : available < 0.1 || availableBytes < 2 * 2 ** 30
        ? "warning"
        : "good";
  // Pages of 4 KB: 1 MB/s to the page file is orange, 10 MB/s red.
  return worst(
    low,
    band(c.committed ?? 0, 90, 97),
    band(c.pagesOut ?? 0, 256, 2560),
    band(c.transitionFaults ?? 0, TRIMMING_WARNING, TRIMMING_CRITICAL),
  );
}

export function windowsVerdicts(c: WindowsCounters, info: WindowsInfo): Verdicts {
  const latency = Math.max(c.readLatency ?? 0, c.writeLatency ?? 0) * 1000;
  return {
    cpu: band((c.queue ?? 0) / info.cores, 1, 2),
    memory: windowsMemory(c, info),
    disk: band(latency, 15, 25),
  };
}

/**
 * Adds that dictation's grey words would not start (the graphics card is short of
 * memory) to a headline that has nothing else to say. A real shortage of CPU,
 * memory or disk wins: it stays the headline, and its colour.
 */
export function withGreyWords<H extends { tone: Tone; text: string }>(h: H, greyOff: boolean): H {
  if (!greyOff || h.tone !== "good") return h;
  return {
    ...h,
    tone: "warning",
    text: "Grey words would not start: the graphics card is short of memory.",
  };
}

const WORDS: Record<Resource, string> = { cpu: "CPU", memory: "memory", disk: "disk" };

/** "Out of CPU in WSL." / "Short of memory in Windows." / "Everything is fine." */
export function headline(places: { name: string; verdicts: Verdicts }[]): {
  tone: Tone;
  text: string;
} {
  const out: string[] = [];
  let tone: Tone = "good";
  for (const severity of ["critical", "warning"] as const) {
    for (const { name, verdicts } of places) {
      const short = (Object.keys(verdicts) as Resource[]).filter((r) => verdicts[r] === severity);
      if (short.length === 0) continue;
      tone = worst(tone, severity);
      const what = short.map((r) => WORDS[r]).join(" and ");
      out.push(`${severity === "critical" ? "Out of" : "Short of"} ${what} in ${name}.`);
    }
  }
  return {
    tone,
    text: out.length > 0 ? out.join(" ") : "Nothing is short: CPU, memory and disk are fine.",
  };
}
