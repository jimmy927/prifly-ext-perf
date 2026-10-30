/**
 * The Memory tab's pressure strip: how hard Windows is working to make room,
 * as three readings, each coloured by the memory verdict's own checks
 * (`windowsMemoryChecks`), so the strip and the Memory row never disagree.
 */

import { standbyOf } from "./memory-map";
import {
  gb,
  type MemoryCheck,
  type Tone,
  TRIMMING_CRITICAL,
  thousands,
  windowsMemoryChecks,
} from "./verdict";
import type { WindowsCounters, WindowsInfo } from "./windows";

export type Reading = {
  key: "commit" | "trimming" | "free";
  name: string;
  /** What the reading means, in a line. */
  means: string;
  /** The number, or "—" where Windows gave no counter. */
  main: string;
  /** Beside the number: "of 75 GB", "0.4 GB empty"; "" where there is none. */
  small: string;
  /** Null where there is no counter: no colour. */
  tone: Tone | null;
  /** The least value the sparkline's top is at: a calm line stays low. */
  ceiling: number;
};

const MISSING = "—";

/**
 * RAM a program could get now, in bytes: standby (cached pages Windows drops
 * the moment they are wanted) plus free and zeroed pages; where those were
 * not all read, what Windows counts as available; null where neither was.
 */
export function reallyFree(c: WindowsCounters): number | null {
  const standby = standbyOf(c);
  if (standby !== null && c.free !== null) return standby + c.free;
  return c.availableMB === null ? null : c.availableMB * 2 ** 20;
}

/** The strip's three readings for `c`, each toned by the matching memory check. */
export function pressureOf(c: WindowsCounters, info: WindowsInfo): Reading[] {
  const checks = windowsMemoryChecks(c, info);
  const toneOf = (what: MemoryCheck["what"]): Tone | null =>
    checks.find((check) => check.what === what)?.tone ?? null;
  const free = reallyFree(c);
  const empty = standbyOf(c) !== null && c.free !== null ? `${gb(c.free)} empty` : "";
  return [
    {
      key: "commit",
      name: "Commit",
      means: "how full Windows' promises are",
      main: c.committed === null ? MISSING : `${Math.round(c.committed)} %`,
      small: c.committed === null || c.commitLimit === null ? "" : `of ${gb(c.commitLimit)}`,
      tone: toneOf("commit"),
      ceiling: 100,
    },
    {
      key: "trimming",
      name: "Trimming",
      means: "pages Windows takes from programs and gives back",
      main: c.transitionFaults === null ? MISSING : `${thousands(c.transitionFaults)} pages/s`,
      small: "",
      tone: toneOf("trimming"),
      ceiling: TRIMMING_CRITICAL,
    },
    {
      key: "free",
      name: "RAM really free",
      means: "RAM a program could get now",
      main: free === null ? MISSING : gb(free),
      small: empty,
      tone: toneOf("available"),
      ceiling: info.memTotal,
    },
  ];
}
