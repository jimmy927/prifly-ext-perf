/**
 * Linux's own view of how stretched it is: pressure stall information
 * (`/proc/pressure`, docs.kernel.org/accounting/psi.html) for CPU, memory and
 * disk, and the counters in `/proc/stat`, `/proc/meminfo`, `/proc/vmstat` and
 * `/proc/loadavg` beside it. Inside WSL that is the WSL VM's view: one kernel
 * for every distro, Docker Desktop's included.
 *
 * PSI measures what matters — the share of time tasks were stalled waiting
 * for a resource — where load and percentages only say how busy it is.
 */

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";

/** One line of a pressure file: the share of the last 10 s and 60 s, in percent. */
export type Stall = { avg10: number; avg60: number };
export type Pressure = { some: Stall; full: Stall };

export type LinuxSample = {
  at: number;
  cores: number;
  /** Share of all cores busy since the last sample, 0–100. */
  busy: number;
  /** Tasks ready to run, the running included (`procs_running`). */
  runnable: number;
  load: [number, number, number];
  memTotal: number;
  memAvailable: number;
  swapTotal: number;
  swapUsed: number;
  /** Bytes per second read from and written to disk since the last sample. */
  diskRead: number;
  diskWrite: number;
  cpu: Pressure | null;
  memory: Pressure | null;
  io: Pressure | null;
};

const NO_STALL: Stall = { avg10: 0, avg60: 0 };

function stallOf(line: string | undefined): Stall {
  if (line === undefined) return NO_STALL;
  const avg10 = /avg10=([\d.]+)/.exec(line)?.[1];
  const avg60 = /avg60=([\d.]+)/.exec(line)?.[1];
  return { avg10: Number(avg10 ?? 0), avg60: Number(avg60 ?? 0) };
}

/** A `/proc/pressure/*` file's text: its `some` and `full` lines. */
export function parsePressure(text: string): Pressure {
  const lines = text.split("\n");
  return {
    some: stallOf(lines.find((line) => line.startsWith("some "))),
    full: stallOf(lines.find((line) => line.startsWith("full "))),
  };
}

function readPressure(kind: "cpu" | "memory" | "io"): Pressure | null {
  try {
    return parsePressure(readFileSync(`/proc/pressure/${kind}`, "utf8"));
  } catch (error) {
    // A kernel built without PSI, or one booted with psi=0.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `/proc/meminfo` as kB by name. */
export function parseMeminfo(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match?.[1] !== undefined) out.set(match[1], Number(match[2]));
  }
  return out;
}

/** The counters a sample needs from `/proc/stat`: total and idle jiffies, and `procs_running`. */
export function parseStat(text: string): { total: number; idle: number; runnable: number } {
  const lines = text.split("\n");
  const cpu = (lines.find((line) => line.startsWith("cpu ")) ?? "")
    .split(/\s+/)
    .slice(1)
    .map(Number);
  const total = cpu.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  // idle + iowait: a core waiting on disk is not doing work either.
  const idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
  const running = lines.find((line) => line.startsWith("procs_running "));
  return { total, idle, runnable: Number(running?.split(" ")[1] ?? 0) };
}

function vmstat(): { pgpgin: number; pgpgout: number } {
  const text = readFileSync("/proc/vmstat", "utf8");
  const read = (name: string) => Number(new RegExp(`^${name} (\\d+)`, "m").exec(text)?.[1] ?? 0);
  return { pgpgin: read("pgpgin"), pgpgout: read("pgpgout") };
}

type Counters = { at: number; total: number; idle: number; pgpgin: number; pgpgout: number };

/** Reads Linux every call and turns its counters into rates against the call before. */
export class LinuxSampler {
  private before: Counters | null = null;

  sample(): LinuxSample {
    const at = Date.now();
    const stat = parseStat(readFileSync("/proc/stat", "utf8"));
    const io = vmstat();
    const now: Counters = { at, total: stat.total, idle: stat.idle, ...io };
    const was = this.before ?? now;
    this.before = now;
    const ticks = now.total - was.total;
    const seconds = Math.max((now.at - was.at) / 1000, 0.001);
    const mem = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
    const kb = (name: string) => (mem.get(name) ?? 0) * 1024;
    const load = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number);
    return {
      at,
      cores: availableParallelism(),
      busy: ticks > 0 ? (100 * (ticks - (now.idle - was.idle))) / ticks : 0,
      runnable: stat.runnable,
      load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
      memTotal: kb("MemTotal"),
      memAvailable: kb("MemAvailable"),
      swapTotal: kb("SwapTotal"),
      swapUsed: kb("SwapTotal") - kb("SwapFree"),
      // pgpgin/pgpgout count kB.
      diskRead: ((now.pgpgin - was.pgpgin) * 1024) / seconds,
      diskWrite: ((now.pgpgout - was.pgpgout) * 1024) / seconds,
      cpu: readPressure("cpu"),
      memory: readPressure("memory"),
      io: readPressure("io"),
    };
  }
}
