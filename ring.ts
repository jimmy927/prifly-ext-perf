/**
 * Samples kept in time order, and the span of them one window averages over.
 * Rates need two ends of the window, so a span says which sample starts it.
 */

/** Seconds in the hour the rings keep, so sparklines reach back an hour. */
export const HOUR = 3600;

/** Samples come about a second apart, never exactly: an edge may miss by this much. */
export const TOLERANCE = 250;

export type Timed = { at: number };

/** Adds `item`, and forgets what is older than `seconds`. */
export function keep<T extends Timed>(ring: T[], item: T, seconds: number): void {
  ring.push(item);
  for (let first = ring[0]; first !== undefined && first.at < item.at - seconds * 1000; ) {
    ring.shift();
    first = ring[0];
  }
}

export type Span<T> = {
  start: T;
  end: T;
  /** From `start` to `end`, both included. */
  all: T[];
  /** The samples whose mean is the window's level: after `start`, or all of them when short. */
  inside: T[];
  /** Time between `start` and `end`: the window, or less before it has filled. */
  seconds: number;
};

/**
 * The window of `seconds` that ends at `endIndex` (the last sample by default):
 * it starts at the last sample at or before its edge. Before the ring reaches
 * back that far, it starts at the oldest sample and `seconds` is what there is.
 */
export function spanOf<T extends Timed>(
  ring: readonly T[],
  seconds: number,
  endIndex = ring.length - 1,
): Span<T> | null {
  const end = ring[endIndex];
  if (end === undefined) return null;
  const edge = end.at - seconds * 1000 + TOLERANCE;
  let from = endIndex;
  while (from > 0 && (ring[from]?.at ?? 0) > edge) from -= 1;
  const start = ring[from];
  if (start === undefined) return null;
  const all = ring.slice(from, endIndex + 1);
  const full = start.at <= edge;
  return {
    start,
    end,
    all,
    inside: full ? all.slice(1) : all,
    seconds: (end.at - start.at) / 1000,
  };
}

/** The index of the last sample at or before `time`, or -1. */
export function endAt(ring: readonly Timed[], time: number): number {
  let at = ring.length - 1;
  while (at >= 0 && (ring[at]?.at ?? 0) > time) at -= 1;
  return at;
}

/**
 * Where the windows of `seconds` end, oldest first: the last, and each one
 * back from it, as many as are whole in the ring, at most 60 and an hour.
 */
export function windowEnds(ring: readonly Timed[], seconds: number): number[] {
  const last = ring.at(-1);
  const first = ring[0];
  if (last === undefined || first === undefined) return [];
  const ends = [ring.length - 1];
  const count = Math.min(60, Math.floor(HOUR / seconds));
  for (let back = 1; back < count; back += 1) {
    const time = last.at - back * seconds * 1000 + TOLERANCE;
    const index = endAt(ring, time);
    const at = ring[index]?.at ?? 0;
    if (index < 0 || first.at > at - seconds * 1000 + TOLERANCE) break;
    ends.unshift(index);
  }
  return ends;
}
