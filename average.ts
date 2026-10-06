/**
 * What the panel shows is the average over a window, so a number does not
 * jitter from one second to the next. Two kinds, made two ways:
 *
 * - Rates (CPU, disk, `busy`, time stalled) are exact: the counter now minus
 *   the counter at the window's start, over the time between. A 2 s spike in a
 *   30 s window counts for 1/15, however the seconds were sampled.
 * - Levels (memory available, run queue, load, Windows' counters)
 *   are the mean of the one-second samples in the window.
 *
 * A window that has not filled yet averages what there is; `covered` says how
 * long that is.
 */

import type { Container, ContainerInfo, ContainerSnapshot } from "./docker";
import { type Proc, type ProcSnapshot, TICKS_PER_SECOND, type Totals } from "./procs";
import { spanOf } from "./ring";
import { COUNTERS, type Field, type WindowsCounters } from "./windows";
import type { LinuxRaw, LinuxSample, Pressure, Stalls } from "./wsl";

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

/**
 * The share of the window stalled, from the time stalled since boot at both
 * ends: exact for 1 s as for 5 min. A window of one read has no two ends, so
 * it takes the kernel's own last 10 s.
 */
function stalledOver(start: Pressure | null, end: Pressure | null, seconds: number): Stalls | null {
  if (end === null) return null;
  if (start === null || seconds <= 0) return { some: end.some.avg10, full: end.full.avg10 };
  // Microseconds stalled per second, over 10,000, is percent.
  const share = (before: number, after: number) =>
    Math.min(100, rateOf(before, after, seconds) / 10_000);
  return {
    some: share(start.some.total, end.some.total),
    full: share(start.full.total, end.full.total),
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
    kernel: ticks > 0 ? ((end.kernel - start.kernel) / ticks) * end.cores : 0,
    runnable: level((raw) => raw.runnable),
    load: [level((raw) => raw.load[0]), level((raw) => raw.load[1]), level((raw) => raw.load[2])],
    memTotal: end.memTotal,
    memAvailable: level((raw) => raw.memAvailable),
    swapTotal: end.swapTotal,
    swapUsed: level((raw) => raw.swapUsed),
    // pgpgin and pgpgout count kB.
    diskRead: rateOf(start.pgpgin, end.pgpgin, span.seconds) * 1024,
    diskWrite: rateOf(start.pgpgout, end.pgpgout, span.seconds) * 1024,
    cpu: stalledOver(start.cpu, end.cpu, span.seconds),
    memory: stalledOver(start.memory, end.memory, span.seconds),
    io: stalledOver(start.io, end.io, span.seconds),
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

/**
 * Every container running at the window's end, its CPU averaged over the
 * window the way `averageProcs` does a process's; memory as of the end. What each is and whose comes from `infos` and `owner`; one Docker
 * has not named yet goes by its id.
 */
export function averageContainers(
  ring: readonly ContainerSnapshot[],
  seconds: number,
  infos: ReadonlyMap<string, ContainerInfo>,
  owner: (info: ContainerInfo) => string,
): Container[] {
  const span = spanOf(ring, seconds);
  if (span === null) return [];
  const first = new Map<string, number>();
  for (const snapshot of span.all) {
    for (const [id, reading] of snapshot.containers)
      if (!first.has(id)) first.set(id, reading.usage);
  }
  return [...span.end.containers.values()].map((reading) => {
    const info = infos.get(reading.id) ?? { name: reading.id.slice(0, 12), paths: [] };
    return {
      id: reading.id,
      name: info.name,
      // Microseconds of CPU per second, over a million, is cores.
      cpu: rateOf(first.get(reading.id) ?? reading.usage, reading.usage, span.seconds) / 1e6,
      memory: reading.memory,
      session: owner(info),
    };
  });
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
