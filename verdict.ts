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
 *   page-file writes, trimming and the kernel pools (`windowsMemoryChecks`),
 *   with the reasons named; disk reads slower than 25 ms are out of spec (15 ms
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
 * Calibrated on the one recording there is, made while the machine was
 * overloaded (2026-10-29, 17:27–17:48, every 5 s, 240 samples; commit 88–98 %,
 * 2.8–11 GB of 47 GB available, the page file untouched at the median): its
 * 5th/25th/50th/75th/95th percentiles were 55k/89k/117k/143k/168k a second.
 * Orange sits below the 5th, so even the mildest minute of that overload is
 * orange; red below the 25th. No calm reading exists yet (WSL's way into
 * Windows died at 17:48), so a calm machine's level is not known.
 */
const TRIMMING_WARNING = 30_000;
const TRIMMING_CRITICAL = 80_000;

/** Bytes in a kernel pool past which it is abnormal: usual is a few hundred MB, and 4.7 GB was a token leak. */
export const POOL_ABNORMAL = 2 * 2 ** 30;

const GiB = 2 ** 30;
const gb = (n: number): string => `${(n / GiB).toFixed(1)} GB`;
const thousands = (n: number): string =>
  n < 1000 ? `${Math.round(n)}` : `${Math.round(n / 1000)}k`;

/** What Windows memory was judged by: one check, its colour and what it says. */
export type MemoryCheck = {
  what: "commit" | "trimming" | "pageFile" | "available" | "poolPaged" | "poolNonpaged";
  tone: Tone;
  text: string;
};

/**
 * Windows memory, judged by what shows a real shortage: commit charge (can
 * Windows still hand memory out?), writes to the page file (is it pushing
 * memory out to make room?), transition faults (is it trimming working sets
 * and compressing them, which never reaches the page file?) and the kernel's
 * pools (is a driver or service leaking?). Available memory counts only when
 * it is truly low: the WSL VM keeps its own file cache
 * (`autoMemoryReclaim=disabled`), so 18 % available with 70 % committed and no
 * paging is a calm machine, not a short one (measured here, 2026-10-01).
 *
 * Every check Windows gave a reading for, green ones too, so the screen can
 * say why memory is fine as well as why it is not. A counter that is missing
 * is no check at all, never a 0.
 */
export function windowsMemoryChecks(c: WindowsCounters, info: WindowsInfo): MemoryCheck[] {
  const checks = [
    c.committed === null ? null : commitCheck(c.committed),
    c.transitionFaults === null ? null : trimmingCheck(c.transitionFaults),
    c.pagesOut === null ? null : pageFileCheck(c.pagesOut),
    c.availableMB === null ? null : availableCheck(c.availableMB * 2 ** 20, info.memTotal),
    c.poolPaged === null ? null : poolCheck("poolPaged", "paged pool", c.poolPaged),
    c.poolNonpaged === null ? null : poolCheck("poolNonpaged", "non-paged pool", c.poolNonpaged),
  ];
  return checks.filter((check) => check !== null);
}

function commitCheck(committed: number): MemoryCheck {
  const text = `${Math.round(committed)} % of commit used`;
  return { what: "commit", tone: band(committed, 90, 97), text };
}

function trimmingCheck(faults: number): MemoryCheck {
  const tone = band(faults, TRIMMING_WARNING, TRIMMING_CRITICAL);
  return {
    what: "trimming",
    tone,
    text: `Windows is trimming ${thousands(faults)} pages a second`,
  };
}

/** Pages of 4 KB: 1 MB/s to the page file is orange, 10 MB/s red. */
function pageFileCheck(pagesOut: number): MemoryCheck {
  const mb = (pagesOut * 4096) / 2 ** 20;
  const text =
    mb < 0.1 ? "nothing written to the page file" : `${mb.toFixed(1)} MB/s to the page file`;
  return { what: "pageFile", tone: band(pagesOut, 256, 2560), text };
}

function availableCheck(bytes: number, memTotal: number): MemoryCheck {
  const share = memTotal > 0 ? bytes / memTotal : 1;
  const tone: Tone =
    share < 0.05 || bytes < GiB ? "critical" : share < 0.1 || bytes < 2 * GiB ? "warning" : "good";
  const text = tone === "good" ? `${gb(bytes)} available` : `only ${gb(bytes)} available`;
  return { what: "available", tone, text };
}

function poolCheck(what: "poolPaged" | "poolNonpaged", name: string, bytes: number): MemoryCheck {
  if (bytes <= POOL_ABNORMAL) return { what, tone: "good", text: `${name} ${gb(bytes)}` };
  const text = `kernel ${name} ${gb(bytes)}, over 2 GB: a driver or service is leaking`;
  return { what, tone: "warning", text };
}

/** The checks that are not green, worst first: why Windows is short of memory. */
export function memoryReasons(checks: readonly MemoryCheck[]): MemoryCheck[] {
  return checks
    .filter((check) => check.tone !== "good")
    .sort((a, b) => RANK[b.tone] - RANK[a.tone]);
}

export function windowsVerdicts(c: WindowsCounters, info: WindowsInfo): Verdicts {
  const latency = Math.max(c.readLatency ?? 0, c.writeLatency ?? 0) * 1000;
  return {
    cpu: band((c.queue ?? 0) / info.cores, 1, 2),
    memory: worst(...windowsMemoryChecks(c, info).map((check) => check.tone)),
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

/** A place the headline judges; `memoryReasons` (Windows) says why its memory is not green. */
export type Place = { name: string; verdicts: Verdicts; memoryReasons?: readonly string[] };

/**
 * "Out of CPU in WSL." / "Short of memory in Windows: 96 % of commit used,
 * Windows is trimming 150k pages a second." / "Nothing is short: …". A place
 * with memory reasons names them after its memory sentence.
 */
export function headline(places: Place[]): {
  tone: Tone;
  text: string;
} {
  const out: string[] = [];
  let tone: Tone = "good";
  for (const severity of ["critical", "warning"] as const) {
    for (const { name, verdicts, memoryReasons: why = [] } of places) {
      const short = (Object.keys(verdicts) as Resource[]).filter((r) => verdicts[r] === severity);
      if (short.length === 0) continue;
      tone = worst(tone, severity);
      const what = short.map((r) => WORDS[r]).join(" and ");
      const reasons = short.includes("memory") && why.length > 0 ? `: ${why.join(", ")}` : "";
      out.push(`${severity === "critical" ? "Out of" : "Short of"} ${what} in ${name}${reasons}.`);
    }
  }
  return {
    tone,
    text: out.length > 0 ? out.join(" ") : "Nothing is short: CPU, memory and disk are fine.",
  };
}
