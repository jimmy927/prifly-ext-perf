/**
 * What the panel shows is the average over a window, so a number does not
 * jitter from one second to the next. Two kinds, made two ways:
 *
 * - Rates (CPU, disk, `busy`) are exact: the counter now minus the counter at
 *   the window's start, over the time between. A 2 s spike in a 30 s window
 *   counts for 1/15, however the seconds were sampled.
 * - Levels (memory available, run queue, pressure, load, Windows' counters)
 *   are the mean of the one-second samples in the window.
 *
 * A window that has not filled yet averages what there is; `covered` says how
 * long that is.
 */

import { type Proc, type ProcSnapshot, TICKS_PER_SECOND, type Totals } from "./procs";
import { spanOf } from "./ring";
import { COUNTERS, type Field, type WindowsCounters } from "./windows";
import type { LinuxRaw, LinuxSample, Pressure } from "./wsl";

/** The windows the panel offers, in seconds. */
export const WINDOWS = [1, 2, 5, 10, 30, 60, 300];
export const DEFAULT_WINDOW = 2;

/** The window a request asks for (`?window=30`): one of `WINDOWS`, else an error. */
export function windowOf(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WINDOW;
  const seconds = Number(raw);
  if (!WINDOWS.includes(seconds)) {
    throw new Error(`No such window: ${raw}. Use one of ${WINDOWS.join(", ")} seconds.`);
  }
  return seconds;
}

export type Averaged<T> = { value: T; covered: number };

const mean = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;

/** Per second between two readings of a counter; a counter that went back (a reused pid) counts 0. */
export const rateOf = (before: number, after: number, seconds: number): number =>
  seconds > 0 ? Math.max(0, after - before) / seconds : 0;

function averagePressure(list: (Pressure | null)[]): Pressure | null {
  const have = list.filter((p): p is Pressure => p !== null);
  if (have.length === 0) return null;
  const of = (pick: (p: Pressure) => number) => mean(have.map(pick));
  return {
    some: { avg10: of((p) => p.some.avg10), avg60: of((p) => p.some.avg60) },
    full: { avg10: of((p) => p.full.avg10), avg60: of((p) => p.full.avg60) },
  };
}

/** Linux over the window that ends at `endIndex` (the last read by default). */
export function averageLinux(
  ring: readonly LinuxRaw[],
  seconds: number,
  endIndex?: number,
): Averaged<LinuxSample> | null {
  const span = spanOf(ring, seconds, endIndex);
  if (span === null) return null;
  const { start, end, inside } = span;
  const level = (pick: (raw: LinuxRaw) => number) => mean(inside.map(pick));
  const ticks = end.total - start.total;
  const value: LinuxSample = {
    at: end.at,
    cores: end.cores,
    busy: ticks > 0 ? (100 * (ticks - (end.idle - start.idle))) / ticks : 0,
    runnable: level((raw) => raw.runnable),
    load: [level((raw) => raw.load[0]), level((raw) => raw.load[1]), level((raw) => raw.load[2])],
    memTotal: end.memTotal,
    memAvailable: level((raw) => raw.memAvailable),
    swapTotal: end.swapTotal,
    swapUsed: level((raw) => raw.swapUsed),
    // pgpgin and pgpgout count kB.
    diskRead: rateOf(start.pgpgin, end.pgpgin, span.seconds) * 1024,
    diskWrite: rateOf(start.pgpgout, end.pgpgout, span.seconds) * 1024,
    cpu: averagePressure(inside.map((raw) => raw.cpu)),
    memory: averagePressure(inside.map((raw) => raw.memory)),
    io: averagePressure(inside.map((raw) => raw.io)),
  };
  return { value, covered: span.seconds };
}

/**
 * Every process alive at the window's end, with its CPU and disk averaged over
 * the whole window: its counters now minus those at its first sample in the
 * window, over the window. A process born mid-window counts only what it used
 * since, spread over the window, so the processes still add up to the machine.
 * One that ended inside the window is gone from the table.
 */
export function averageProcs(
  ring: readonly ProcSnapshot[],
  seconds: number,
): Averaged<Proc[]> | null {
  const span = spanOf(ring, seconds);
  if (span === null) return null;
  const first = new Map<number, Totals>();
  for (const snapshot of span.all) {
    for (const [pid, reading] of snapshot.procs) if (!first.has(pid)) first.set(pid, reading);
  }
  const value: Proc[] = [];
  for (const reading of span.end.procs.values()) {
    const from = first.get(reading.pid) ?? reading;
    const per = (a: number, b: number) => rateOf(a, b, span.seconds);
    value.push({
      pid: reading.pid,
      ppid: reading.ppid,
      comm: reading.comm,
      argv: reading.argv,
      rss: reading.rss,
      cpu: per(from.ticks, reading.ticks) / TICKS_PER_SECOND,
      read: per(from.read, reading.read),
      write: per(from.write, reading.write),
    });
  }
  return { value, covered: span.seconds };
}

/** Windows' counters, each the mean of the lines that had it; null where none did. */
export function averageWindows(
  ring: readonly WindowsCounters[],
  seconds: number,
  endIndex?: number,
): Averaged<WindowsCounters> | null {
  const span = spanOf(ring, seconds, endIndex);
  if (span === null) return null;
  const value = { at: span.end.at } as WindowsCounters;
  for (const field of Object.keys(COUNTERS) as Field[]) {
    const have = span.inside.map((c) => c[field]).filter((v): v is number => v !== null);
    value[field] = have.length === 0 ? null : mean(have);
  }
  return { value, covered: span.seconds };
}
