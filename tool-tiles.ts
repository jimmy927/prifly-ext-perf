// The Memory tab's "Session tools" tile split by program (`wsl-map.ts` places
// it): the shells, tests, builds and test gates the sessions' turns run, one
// child for each program that holds enough to be worth a tile, counted by PSS
// where `smaps_rollup` was read and by RSS where not (`pss.ts`).

import { basename } from "node:path";
import type { Tile } from "./memory-map";
import type { Proc } from "./procs";

/** Bytes that are a number and not below 0: a missing or odd reading counts nothing. */
export const bytesOf = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

/** "claude ×26": a count after a name where there is more than one. */
export const counted = (name: string, count: number) => (count > 1 ? `${name} ×${count}` : name);

/** A program holding under this share of the tools folds into "Other". */
const FOLD_BELOW = 0.02;

type Head = { slug: string; name: string; colour: string; why: string };
type Rule = Head & { match: (p: Proc) => boolean };

const hasWord = (p: Proc, re: RegExp) => p.argv.some((arg) => re.test(basename(arg)));

/** The programs worth a name of their own, first match wins; the rest are named by `programOf`. */
const RULES: Rule[] = [
  {
    slug: "gates",
    name: "Test gates waiting/running",
    colour: "k-gates",
    why:
      "The test gates that lands and git buttons run (gate/cli.ts, also the agent's built runner). " +
      "Most are queued, waiting for cores or memory, and hold little each.",
    // The agent builds the runner as `…/runners/r-<hash>/cli.js`.
    match: (p) =>
      p.argv.some(
        (arg) => /gate\/cli\.[tj]s$/.test(arg) || /\/runners\/r-[0-9a-f]+\/cli\.js$/.test(arg),
      ),
  },
  {
    slug: "tsc",
    name: "tsc",
    colour: "k-tools",
    why: "The TypeScript compiler a turn ran (tsc --build, --noEmit): it holds a whole project in memory.",
    match: (p) => hasWord(p, /^tsc$/),
  },
  {
    slug: "bun-test",
    name: "bun test",
    colour: "k-tools",
    why: "bun's test runs and their workers (bun test, --test-worker).",
    match: (p) =>
      p.argv.includes("--test-worker") ||
      (basename(p.argv[0] ?? "") === "bun" && p.argv[1] === "test"),
  },
  {
    slug: "pytest",
    name: "pytest",
    colour: "k-tools",
    why: "Python test runs (pytest, python -m pytest) and their workers.",
    match: (p) => hasWord(p, /^pytest$/),
  },
  {
    slug: "builds",
    name: "Builds",
    colour: "k-tools",
    why: "Front-end builds a turn ran: vite, esbuild, webpack, rollup and singlefile-build.",
    match: (p) => hasWord(p, /^(vite|esbuild|webpack|rollup|singlefile-build(\.m?js)?)$/),
  },
  {
    slug: "shells",
    name: "Shells",
    colour: "k-tools",
    why: "The shells (sh, bash, zsh, dash) that run each command of a turn and wait on it.",
    match: (p) => ["sh", "bash", "zsh", "dash"].includes(p.comm),
  },
];

/** A program as a person names it: its script for `node x.mjs` or `python -m x`, else its own name. */
function programOf(proc: Proc): string {
  const words = proc.argv.map((word) => basename(word));
  const first = words[0] || proc.comm;
  if (!/^(python\d*(\.\d+)?|node|bun)$/.test(first)) return first;
  const script = words.slice(1).find((word) => !word.startsWith("-"));
  return script ?? first;
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The group `proc` goes in: a rule's, else one for its program's name. */
function headOf(proc: Proc): Head {
  const rule = RULES.find((r) => r.match(proc));
  if (rule !== undefined) return rule;
  const name = programOf(proc) || "unknown";
  return {
    slug: `p-${slugOf(name) || "unknown"}`,
    name,
    colour: "k-tools",
    why: `${name}, run by a turn.`,
  };
}

/** The parent's text: PSS where it was read, RSS where not, like the `claude` tile's. */
function toolsWhy(count: number, rss: number, pss: number, read: number): string {
  const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
  const lead =
    "What the sessions' turns run: shells, tests, builds, and the lands and git buttons' runs " +
    "with their test gates, one tile per program";
  if (read === count) {
    return (
      `${lead}: ${gb(rss)} counted per process (RSS), ${gb(pss)} once the pages they share are ` +
      "counted once (PSS, from /proc/<pid>/smaps_rollup)."
    );
  }
  if (read === 0) {
    return (
      `${lead}, counted per process (RSS): /proc/<pid>/smaps_rollup could not be read, so the ` +
      "pages they share count once for each of them."
    );
  }
  return (
    `${lead}, the pages they share counted once (PSS, from /proc/<pid>/smaps_rollup) where it ` +
    `could be read; ${count - read} of ${count} count per process (RSS) instead.`
  );
}

type Sum = { head: Head; count: number; value: number };

/**
 * The tools (`procs`) as child tiles, one per program, biggest first, each by
 * PSS where `pss` has the pid and RSS where not. Programs under 2 % of the
 * tools (`FOLD_BELOW`) fold into one "Other ×N" child; a single such program
 * keeps its own tile. `value` is the children's sum, `why` the parent's.
 */
export function toolTiles(
  procs: readonly Proc[],
  pss: ReadonlyMap<number, number>,
): { value: number; why: string; children: Tile[] } {
  const groups = new Map<string, Sum>();
  let rss = 0;
  let read = 0;
  for (const proc of procs) {
    const head = headOf(proc);
    const own = pss.get(proc.pid);
    rss += bytesOf(proc.rss);
    if (own !== undefined) read += 1;
    const g = groups.get(head.slug) ?? { head, count: 0, value: 0 };
    g.count += 1;
    g.value += bytesOf(own ?? proc.rss);
    groups.set(head.slug, g);
  }
  const all = [...groups.values()].sort((a, b) => b.value - a.value);
  const value = all.reduce((s, g) => s + g.value, 0);
  const small = all.filter((g) => g.value < value * FOLD_BELOW);
  const folded = small.length > 1;
  const tile = (g: Sum): Tile => ({
    key: `wsl:prifly:tools:${g.head.slug}`,
    name: counted(g.head.name, g.count),
    colour: g.head.colour,
    value: g.value,
    why: g.head.why,
  });
  const children = all
    .filter((g) => !folded || !small.includes(g))
    .map(tile)
    .filter((t) => t.value > 0);
  if (folded) {
    children.push({
      key: "wsl:prifly:tools:other",
      name: counted(
        "Other",
        small.reduce((s, g) => s + g.count, 0),
      ),
      colour: "k-tools",
      value: small.reduce((s, g) => s + g.value, 0),
      why:
        `${small.length} smaller programs, each under ${FOLD_BELOW * 100} % of the tools: ` +
        "sleep and tail loops, git and the like.",
    });
  }
  return { value, why: toolsWhy(procs.length, rss, value, read), children };
}
