/**
 * Every process this Linux can see, from `/proc`, with its counters. Only this distro's processes are visible: Docker
 * Desktop's containers live in a distro of their own, so they count in the
 * kernel's totals (`wsl.ts`) but never appear here; their cgroups do (`docker.ts`).
 * A host on Windows itself has no `/proc`: it reads the same files through
 * `wsl.exe` (`wsl-exe.ts`) and parses them with `readingOf`.
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

/** `/proc/<pid>/io`: bytes read from and written to disk since it started. */
export function parseIo(text: string): { read: number; write: number } {
  const read = Number(/^read_bytes: (\d+)/m.exec(text)?.[1] ?? 0);
  const write = Number(/^write_bytes: (\d+)/m.exec(text)?.[1] ?? 0);
  return { read, write };
}

/** `/proc/<pid>/cmdline`: its arguments, each ended by a NUL; [] for a kernel thread. */
export function parseCmdline(text: string): string[] {
  return text.split("\0").filter(Boolean);
}

/**
 * One process from the text of its `stat`, `cmdline` and `io` (null where its
 * I/O is not ours to read); null when its `stat` makes no sense.
 */
export function readingOf(
  pid: number,
  stat: string,
  cmdline: string,
  io: string | null,
): ProcReading | null {
  const parsed = parseProcStat(stat);
  if (parsed === null) return null;
  return {
    pid,
    ppid: parsed.ppid,
    comm: parsed.comm,
    argv: parseCmdline(cmdline),
    rss: parsed.rssPages * PAGE,
    ticks: parsed.ticks,
    ...(io === null ? { read: 0, write: 0 } : parseIo(io)),
  };
}

function readIo(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/io`, "utf8");
  } catch (error) {
    // Another user's process: its I/O is not ours to read.
    if (errno(error) === "EACCES" || gone(error)) return null;
    throw error;
  }
}

function readOne(pid: number): ProcReading | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return readingOf(pid, stat, cmdline, readIo(pid));
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
    if (one !== null) procs.set(pid, one);
  }
  return { at: Date.now(), procs };
}
