/**
 * The Memory tab's Trimming reading says how many pages a second Windows
 * takes from programs and gives back. This is what sits under it: what kinds
 * of page fault there are (Windows' `\Memory` fault counters), and which
 * programs fault most (`\Process(*)\Page Faults/sec`, `windows-top.ts`).
 */

import { thousands } from "./verdict";
import type { WindowsCounters } from "./windows";

/** One kind of page fault, as a bar under the Trimming reading. */
export type FaultBar = {
  key: "transition" | "zero" | "cache" | "disk" | "other";
  /** "back from trimming 30k/s". */
  text: string;
  /** Faults a second of this kind. */
  rate: number;
  /** Its share of all page faults, 0–1. */
  share: number;
  /** One sentence on what this kind is. */
  means: string;
};

/** The Trimming reading's page-fault breakdown: its bars and the line on who faults. */
export type Faults = { bars: FaultBar[]; most: string | null };

/** A program's page faults a second, all kinds together (`windows-top.ts`). */
export type ProcessFaults = { name: string; faults: number };

/** Programs the "Most faults" line names. */
const MOST_FAULTS = 3;
/** Faults in no process's counter are named once they are over this share of all. */
const UNCOUNTED_SHARE = 0.1;

const NAMES: Record<FaultBar["key"], string> = {
  transition: "back from trimming",
  zero: "new zeroed pages",
  cache: "from the file cache",
  disk: "from disk",
  other: "other kinds",
};

const rate = (n: number): string => `${thousands(n)}/s`;
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);

/**
 * What is being faulted back in: one bar per kind whose counter was read, each
 * the kind's share of all page faults (`pageFaults`), and "other kinds"
 * (copy-on-write, guard pages) as what `pageFaults` leaves after the four,
 * only where `pageFaults` was read. The line names the programs faulting most
 * and, over 10 % of all, the faults in no process's counter; `processes` null
 * (the per-process read is not done yet) gives no line. Null where there are
 * no faults. Never NaN.
 */
export function faultsOf(
  c: WindowsCounters,
  processes: readonly ProcessFaults[] | null,
): Faults | null {
  const kinds: Pick<FaultBar, "key" | "means" | "rate">[] = [];
  const add = (key: FaultBar["key"], n: number | null, means: string) => {
    if (finite(n)) kinds.push({ key, rate: Math.max(0, n), means });
  };
  add(
    "transition",
    c.transitionFaults,
    "Pages Windows trimmed out of a program and handed back the next time it touched them.",
  );
  add(
    "zero",
    c.demandZeroFaults,
    "Pages a program asked for that Windows handed over zeroed: new memory, not memory taken back.",
  );
  add(
    "cache",
    c.cacheFaults,
    "Faults on the file cache's own pages, answered from memory or disk; also counted under the kinds above.",
  );
  add("disk", c.pageReads, "Faults that had to be read from the disk or the page file.");
  // Cache faults overlap the others (each is answered from memory or disk), so
  // only the other three add up to a part of all faults.
  const distinct = () =>
    kinds.reduce((sum, k) => (k.key === "cache" || k.key === "other" ? sum : sum + k.rate), 0);
  const all = finite(c.pageFaults) ? Math.max(0, c.pageFaults) : null;
  if (all !== null) {
    const summed = distinct();
    add(
      "other",
      Math.max(0, all - summed),
      "Faults of none of the kinds above: copy-on-write of shared pages, guard pages and the like.",
    );
  }
  // The kinds can add to more than the total: the total is then what the
  // distinct ones add to, and no bar passes the whole.
  const total = Math.max(all ?? 0, distinct());
  if (!(total > 0)) return null;
  const bars = kinds.map((k) => ({
    ...k,
    text: `${NAMES[k.key]} ${rate(k.rate)}`,
    share: Math.min(1, k.rate / total),
  }));
  return { bars, most: mostFaults(all, processes) };
}

/**
 * The "Most faults" line: the busiest programs, and the faults no process
 * counted. Null with nothing to say, and while the per-process read is not
 * done (null, or no process at all).
 */
function mostFaults(all: number | null, processes: readonly ProcessFaults[] | null): string | null {
  if (processes === null || processes.length === 0) return null;
  const faulting = processes.filter((p) => finite(p.faults) && p.faults > 0);
  const named = [...faulting]
    .sort((a, b) => b.faults - a.faults)
    .slice(0, MOST_FAULTS)
    .map((p) => `${p.name} ${rate(p.faults)}`);
  const counted = faulting.reduce((sum, p) => sum + p.faults, 0);
  if (all !== null && all - counted > UNCOUNTED_SHARE * all) {
    named.push(`${rate(all - counted)} in no process's counter`);
  }
  return named.length === 0 ? null : `Most faults: ${named.join(" · ")}`;
}
