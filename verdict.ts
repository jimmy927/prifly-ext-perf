/**
 * Green, orange or red for each resource, and the sentence that says what
 * the machine is out of. Thresholds, and where they come from:
 *
 * - Linux: pressure stall information (docs.kernel.org/accounting/psi.html).
 *   CPU `some` is the share of time at least one task waited for a core;
 *   memory and I/O `full` the share when every task waited — time lost
 *   outright. Memory also turns red under 10 % available, before stalls.
 * - Windows: the long-standing Performance Monitor guidance — a processor
 *   queue above two per core is a CPU bottleneck; under 10 % of RAM available
 *   is short of memory; disk reads slower than 25 ms are out of spec (15 ms
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
    cpu: s.cpu === null ? band(s.runnable / s.cores, 1, 2) : band(s.cpu.some.avg10, 10, 40),
    memory: worst(
      band(s.memory?.full.avg10 ?? 0, 0.5, 5),
      available < 0.1 ? "critical" : available < 0.2 ? "warning" : "good",
    ),
    disk: band(s.io?.full.avg10 ?? 0, 5, 20),
  };
}

export function windowsVerdicts(c: WindowsCounters, info: WindowsInfo): Verdicts {
  const available = info.memTotal > 0 ? ((c.availableMB ?? 0) * 2 ** 20) / info.memTotal : 1;
  const latency = Math.max(c.readLatency ?? 0, c.writeLatency ?? 0) * 1000;
  return {
    cpu: band((c.queue ?? 0) / info.cores, 1, 2),
    memory: worst(
      available < 0.1 ? "critical" : available < 0.2 ? "warning" : "good",
      band(c.committed ?? 0, 90, 97),
    ),
    disk: band(latency, 15, 25),
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
