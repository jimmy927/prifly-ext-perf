/**
 * Every process this Linux can see, from `/proc`, with its counters. Only this distro's processes are visible: Docker
 * Desktop's containers live in a distro of their own, so they count in the
 * kernel's totals (`wsl.ts`) but never appear here; their cgroups do (`docker.ts`).
 */

import { readdirSync, readFileSync } from "node:fs";

export const TICKS_PER_SECOND = 100;
const PAGE = 4096;

export type Proc = {
  pid: number;
  ppid: number;
  /** The program's name as the kernel keeps it, at most 15 characters. */
  comm: string;
  /** Its command line, arguments split; [] for a kernel thread. */
  argv: string[];
  /** Resident memory, bytes. */
  rss: number;
  /** Cores in use over the window: 1.5 is one and a half cores. */
  cpu: number;
  /** Bytes per second read from and written to disk over the window. */
  read: number;
  write: number;
};

/** What a process has used since it started: clock ticks and bytes. */
export type Totals = { ticks: number; read: number; write: number };

export type ProcReading = Omit<Proc, "cpu" | "read" | "write"> & Totals;

/** `/proc/<pid>/stat`: the comm may hold spaces and brackets, so fields count from its last `)`. */
export function parseProcStat(
  text: string,
): { comm: string; ppid: number; ticks: number; rssPages: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const rest = text.slice(close + 2).split(" ");
  // rest[0] is field 3 (state): ppid is field 4, utime 14, stime 15, rss 24.
  return {
    comm: text.slice(open + 1, close),
    ppid: Number(rest[1]),
    ticks: Number(rest[11]) + Number(rest[12]),
    rssPages: Number(rest[21]),
  };
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** A process that ended while it was being read. */
function gone(error: unknown): boolean {
  return errno(error) === "ENOENT" || errno(error) === "ESRCH";
}

function readIo(pid: number): { read: number; write: number } {
  try {
    const text = readFileSync(`/proc/${pid}/io`, "utf8");
    const read = Number(/^read_bytes: (\d+)/m.exec(text)?.[1] ?? 0);
    const write = Number(/^write_bytes: (\d+)/m.exec(text)?.[1] ?? 0);
    return { read, write };
  } catch (error) {
    // Another user's process: its I/O is not ours to read.
    if (errno(error) === "EACCES" || gone(error)) return { read: 0, write: 0 };
    throw error;
  }
}

function readOne(
  pid: number,
): { proc: Omit<Proc, "cpu" | "read" | "write">; totals: Totals } | null {
  try {
    const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (stat === null) return null;
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const io = readIo(pid);
    return {
      proc: { pid, ppid: stat.ppid, comm: stat.comm, argv, rss: stat.rssPages * PAGE },
      totals: { ticks: stat.ticks, ...io },
    };
  } catch (error) {
    // Ended between the listing and the read.
    if (gone(error)) return null;
    throw error;
  }
}

/** The table as one read saw it; rates come from two of these (`average.ts`). */
export type ProcSnapshot = { at: number; procs: Map<number, ProcReading> };

/** Reads the process table now: what each process is, and its counters since it started. */
export function readProcs(): ProcSnapshot {
  const procs = new Map<number, ProcReading>();
  for (const name of readdirSync("/proc")) {
    const pid = Number(name);
    if (!Number.isInteger(pid)) continue;
    const one = readOne(pid);
    if (one !== null) procs.set(pid, { ...one.proc, ...one.totals });
  }
  return { at: Date.now(), procs };
}
