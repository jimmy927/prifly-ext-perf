/**
 * The sparklines: one point per window, each the average of that window, for
 * Linux and Windows side by side.
 */

import { averageLinux, averageWindows } from "./average";
import { endAt, windowEnds } from "./ring";
import { machineBusy, type WindowsCounters, type WindowsInfo } from "./windows";
import type { LinuxRaw, LinuxSample } from "./wsl";

/** One point of every sparkline: the average of one window. */
export type Point = {
  at: number;
  linux: { cpu: number; memory: number; disk: number } | null;
  windows: { cpu: number; memory: number; disk: number } | null;
};

function point(
  info: WindowsInfo | null,
  s: LinuxSample | null,
  c: WindowsCounters | null,
  at: number,
): Point {
  const memTotal = info?.memTotal ?? 0;
  return {
    at,
    linux:
      s === null
        ? null
        : {
            cpu: s.cpu?.some ?? s.busy,
            memory: s.memTotal > 0 ? 100 * (1 - s.memAvailable / s.memTotal) : 0,
            disk: s.diskRead + s.diskWrite,
          },
    windows:
      c === null
        ? null
        : {
            cpu: machineBusy(c),
            memory: memTotal > 0 ? 100 * (1 - ((c.availableMB ?? 0) * 2 ** 20) / memTotal) : 0,
            disk: (c.diskRead ?? 0) + (c.diskWrite ?? 0),
          },
  };
}

/**
 * One point per window, the last 60 that fit in the hour: at Linux's reads, or
 * at Windows' where there are none (a host on Windows with no WSL to read).
 */
export function historyOf(
  linux: readonly LinuxRaw[],
  windows: readonly WindowsCounters[],
  info: WindowsInfo | null,
  seconds: number,
): Point[] {
  if (linux.length === 0) {
    return windowEnds(windows, seconds).flatMap((index) => {
      const w = averageWindows(windows, seconds, index);
      return w === null ? [] : [point(info, null, w.value, w.value.at)];
    });
  }
  return windowEnds(linux, seconds).flatMap((index) => {
    const l = averageLinux(linux, seconds, index);
    if (l === null) return [];
    const w = averageWindows(windows, seconds, endAt(windows, l.value.at));
    return [point(info, l.value, w?.value ?? null, l.value.at)];
  });
}
