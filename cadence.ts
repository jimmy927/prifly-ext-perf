/**
 * How often WSL and Windows are read (`index.ts`). Every second while the
 * window is open or WSL is not green: the window repaints every second, and
 * the nanny must see a load as it comes. Once nobody has looked and WSL has
 * been green for a minute, every 5 s, whatever Windows' colour.
 *
 * While the window is closed only the chip uses Windows' counters, and it
 * judges the last 10 s, which two reads 5 s apart still span: its rates are
 * the same (a counter a second, such as the pages trimmed, is averaged over
 * the 5 s between reads by `typeperf` itself), and it can change colour at
 * most once a read, so a slower read never makes it flicker more often.
 * Windows that stays orange or red (a pool that leaked, a commit charge that
 * stays high: the reader's laptop, 2026-11-01) is read as slowly as green.
 *
 * Measured on the reader's laptop (2026-11-01): the `typeperf` costs 1.6 % of
 * a core at a sample a second and 0.3 % at one every 5 s, besides 0.65 s of
 * CPU each time one starts (`SLOW_RUN_SECONDS`); the WSL read a few tenths of
 * a percent between `wsl.exe`, the relay inside WSL and its `tail`.
 */

import { HOUR, keep, TOLERANCE } from "./ring";
import { open, type State } from "./state";
import { readLinux } from "./wsl";

/** Seconds between reads while someone looks or WSL is not green. */
export const FAST = 1;
/** Seconds between reads once nobody has looked and WSL has been green for `SETTLE`. */
export const IDLE = 5;
export const SETTLE = 60_000;

/** The pace now, and since when nobody has looked and WSL has been green (null while not). */
export type Pace = { every: number; quietSince: number | null };

export const firstPace = (): Pace => ({ every: FAST, quietSince: null });

/**
 * The pace after a second in which the window was `looking` or not, and WSL
 * `green` or not (true where there is no WSL to judge).
 */
export function paceOf(previous: Pace, looking: boolean, green: boolean, now: number): Pace {
  if (looking || !green) return { every: FAST, quietSince: null };
  const quietSince = previous.quietSince ?? now;
  return { every: now - quietSince >= SETTLE ? IDLE : FAST, quietSince };
}

/** Whether a read last asked for `at` is due again at `every` seconds; a tick may come a little early. */
export function due(at: number, every: number, now: number): boolean {
  return now - at >= every * 1000 - TOLERANCE;
}

/** Reads Linux now: at once inside WSL, a moment later through `wsl.exe` (its answer lands in the ring, `activate`). */
export function readLinuxNow(current: State, now: number): void {
  current.linuxAt = now;
  if (current.wsl === null) keep(current.linux, readLinux(), HOUR);
  else current.wsl.poll(now);
}

/**
 * The pace for the next second, carried out: Windows' sampler starts again
 * at it when it changed, and Linux is read on the tick it is due (`index.ts`).
 */
export function pace(current: State, wslGreen: boolean, now: number): void {
  current.pace = paceOf(current.pace, open(current), wslGreen, now);
  current.windows?.setEvery(current.pace.every);
}

/**
 * The window is open: back to a read a second at once if it was slower, and
 * Linux read now rather than on the tick it would have been due at the
 * slower pace.
 */
export function hurry(current: State, now: number): void {
  if (current.pace.every === FAST) return;
  pace(current, true, now);
  readLinuxNow(current, now);
}
