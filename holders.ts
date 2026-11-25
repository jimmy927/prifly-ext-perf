// Who holds Windows' memory, by commit: every process's private bytes, in RAM
// or not, grouped by what it is, and what no process holds (the kernel's pools,
// and shared sections, page tables and the rest). Task Manager's Memory column
// counts only what is in RAM, so a process Windows has trimmed looks small: on
// 2026-10-29 `bun` held 13 GB committed and 3.3 GB in RAM.

import { helperOf, isClaude } from "./prifly";
import { childrenOf, hostTreeOf, type WindowsRow, windowsRowsOf } from "./windows";

/** One process of a group: its commit and its working set, in bytes. */
export type HeldBy = {
  pid: number;
  name: string;
  commit: number;
  ram: number;
  /** A session's own `claude` process (`isClaude`), not a tool or helper under it. */
  session?: boolean;
  /** An outermost test run (`isTestRun`, its parent not one): a run, not one of its workers. */
  run?: boolean;
};

/** One row of the list: what its processes are, and what they hold, added up. */
export type Holder = {
  key: string;
  name: string;
  commit: number;
  ram: number;
  processes: HeldBy[];
};

/**
 * The list: groups by commit, largest first (the programs folded into one
 * last); Windows' committed bytes; the kernel's paged and non-paged pools; and
 * what is committed but held by no process and no pool, never below 0. A part
 * Windows did not give is null; `error` says why the list itself is missing.
 */
export type Holders = {
  groups: Holder[];
  committed: number | null;
  pools: { paged: number; nonpaged: number } | null;
  /** Every process's commit added up. */
  inProcesses: number;
  shared: number | null;
  error: string;
};

/** The groups that are not a program by name, and what the panel calls them. */
const NAMES = {
  wsl: "WSL VM",
  claude: "Claude sessions",
  host: "prifly host",
  agent: "prifly agent and relays",
  dictation: "Dictation workers",
  intent: "Intent model",
  tests: "Test runs",
  chrome: "Chrome",
  webview2: "WebView2",
  window: "prifly's window",
  docker: "Docker Desktop",
} as const;
type Named = keyof typeof NAMES;

/** How many other programs get a row of their own; the rest share one. */
const PROGRAMS = 8;

const DOCKER = /^(docker desktop|docker|dockerd|com\.docker\..+|docker-.+|vpnkit.*)$/i;
const RUNNERS = /^(bun|node|deno|npm|npx|pnpm|yarn)$/;
const TEST_WORDS = /^(test|--test|(vitest|jest|mocha|playwright)(\.[cm]?js)?)$/;

/** A program's name as a word: the last part of a path, lower case, without `.exe` or `.cmd`. */
const word = (arg: string) =>
  (arg.split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.(exe|cmd)$/, "");

/** `bun test`, `npm run test`, `node --test`, vitest, jest: a test run. */
export function isTestRun(argv: string[]): boolean {
  const words = argv.map(word);
  return RUNNERS.test(words[0] ?? "") && words.slice(1).some((w) => TEST_WORDS.test(w));
}

/**
 * A bun running prifly's gate: `…/gate/cli.ts`, `scripts/test-changed.ts` or
 * `scripts/timed-run.ts`. A land's gate runs them in a chain (the gate, `bun
 * run test:changed`, test-changed, timed-run, the gate again, `bun test`, its
 * workers), under claude.exe or the host's land runner (2026-11-01: four
 * overlapping gates ran 16 test workers and a dozen wrappers).
 */
const GATE_SCRIPT = /[\\/](gate[\\/]cli|scripts[\\/](test-changed|timed-run))\.[cm]?[jt]s$/;
const isGate = (argv: string[]) =>
  word(argv[0] ?? "") === "bun" && argv.slice(1).some((arg) => GATE_SCRIPT.test(arg));

/** Part of a test run: a test command, or a bun running prifly's gate. */
const isTestProcess = (row: WindowsRow) => isTestRun(row.argv) || isGate(row.argv);

/**
 * prifly's agent on Windows and its relays: `bun …\node-agent\main.ts
 * --relay-dir …` and `bun …\node-agent\main.ts relay …`, a session's
 * `claude.exe` under each relay (2026-10-29), or built, `prifly-agent`.
 */
const isWindowsAgent = (row: WindowsRow) =>
  word(row.argv[0] ?? "") === "prifly-agent" ||
  row.argv.some((arg) => /[\\/]node-agent[\\/]main\.[jt]s$/.test(arg));

/**
 * prifly's installed app, outside the host: its launcher, the window's own
 * bun (`…\Resources\main.js`) and its renderers (`bun Helper.exe --type=…`),
 * all from `%LOCALAPPDATA%\sh.prifly.app` (2026-10-29).
 */
const isPriflyApp = (row: WindowsRow) => /[\\/]sh\.prifly\.app[\\/]/i.test(row.argv[0] ?? "");

/**
 * What a process is, from its parent's group (null for a process with no
 * parent in the list) and whether it is under the host (`hostTreeOf`). The
 * host's helpers go by `helperOf`, as on the prifly tab; `claude` by
 * `isClaude`. A test run (or a bun running prifly's gate) is one wherever its
 * parent is, and everything under it is part of it. A WebView2 under the host, or the prifly app outside it, is prifly's window.
 * A process that is none of these is its parent's if that is one of the
 * groups, else a program of its own name (null).
 */
function groupOf(
  row: WindowsRow,
  parent: Named | null,
  hostPid: number | null,
  inHost: boolean,
): Named | null {
  if (row.pid === hostPid) return "host";
  return priflyGroup(row, parent, inHost) ?? programGroup(row, inHost) ?? parent;
}

/** prifly's own kinds: its sessions, the host's helpers, test runs, the agent and the window. */
function priflyGroup(row: WindowsRow, parent: Named | null, inHost: boolean): Named | null {
  // `parent` is only for the app's window below; a test run is one wherever its parent is.
  if (isClaude(row)) return "claude";
  const helper = inHost ? helperOf(row) : "host";
  if (helper === "dictation" || helper === "intent") return helper;
  if (isTestProcess(row)) return "tests";
  if (isWindowsAgent(row)) return "agent";
  if (!inHost && parent === null && isPriflyApp(row)) return "window";
  return null;
}

/** The other programs with a row of their own, by name: the WSL VM, WebView2, Chrome, Docker. */
function programGroup(row: WindowsRow, inHost: boolean): Named | null {
  const name = row.comm.toLowerCase();
  if (/^vmmem/.test(name)) return "wsl";
  if (name === "msedgewebview2") return inHost ? "window" : "webview2";
  if (name === "chrome") return "chrome";
  return DOCKER.test(name) ? "docker" : null;
}

const held = (row: WindowsRow, run: boolean): HeldBy => ({
  pid: row.pid,
  name: row.comm,
  commit: row.commit,
  ram: row.rss,
  ...(isClaude(row) ? { session: true } : {}),
  ...(run ? { run: true } : {}),
});

/**
 * The console Windows attaches under a process (`conhost.exe`) is not a
 * process of prifly's: under one of prifly's own groups its memory is the
 * group's, but it is neither listed nor counted.
 */
const isConsoleOf = (row: WindowsRow, parent: Named | null) =>
  parent !== null && PRIFLY_GROUPS.has(parent) && row.comm.toLowerCase() === "conhost";

const PRIFLY_GROUPS = new Set<Named>([
  "dictation",
  "intent",
  "host",
  "agent",
  "claude",
  "tests",
  "window",
]);

function add(
  groups: Map<string, Holder>,
  key: string,
  name: string,
  row: WindowsRow,
  run = false,
  listed = true,
): void {
  const group = groups.get(key) ?? { key, name, commit: 0, ram: 0, processes: [] };
  group.commit += row.commit;
  group.ram += row.rss;
  if (listed) group.processes.push(held(row, run));
  groups.set(key, group);
}

const byCommit = (a: { commit: number }, b: { commit: number }) => b.commit - a.commit;

/** Every program past the first `PROGRAMS` by commit, as one row. */
function folded(programs: Holder[]): Holder[] {
  const kept = programs.slice(0, PROGRAMS);
  const rest = programs.slice(PROGRAMS);
  if (rest.length === 0) return kept;
  const more: Holder = {
    key: "more",
    name: `${rest.length} more programs`,
    commit: rest.reduce((sum, g) => sum + g.commit, 0),
    ram: rest.reduce((sum, g) => sum + g.ram, 0),
    processes: rest.flatMap((g) => g.processes).sort(byCommit),
  };
  return [...kept, more];
}

/** `memory|committed|paged|non-paged` from `topProcesses`; null without it. */
function memoryLine(out: string) {
  const match = /^memory\|(\d+)\|(\d+)\|(\d+)\s*$/m.exec(out);
  if (match === null) return null;
  return { committed: Number(match[1]), paged: Number(match[2]), nonpaged: Number(match[3]) };
}

/**
 * Every process, walked from the top of the process tree so that each knows
 * its parent's group: the named groups, and the programs by name. A process
 * Windows gave no memory for holds nothing and is left out.
 */
function grouped(rows: Map<number, WindowsRow>, out: string, hostPid: number | null) {
  const inHost =
    hostPid === null ? new Set<number>() : new Set(hostTreeOf(out, hostPid, 0).procs.keys());
  const children = childrenOf(rows);
  // A process whose parent is in the list is reached from it; the rest are where the walk starts.
  const isChild = new Set(
    [...children]
      .filter(([ppid]) => rows.has(ppid))
      .flatMap(([, list]) => list.map((row) => row.pid)),
  );
  const named = new Map<string, Holder>();
  const programs = new Map<string, Holder>();
  // Each entry also says whether the parent is a test command: a `bun test` under one is its worker, not a run.
  const stack: [WindowsRow, Named | null, boolean][] = [...rows.values()]
    .filter((row) => !isChild.has(row.pid))
    .map((row) => [row, null, false]);
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [row, parent, underTest] = next;
    const group = groupOf(row, parent, hostPid, inHost.has(row.pid));
    const test = group === "tests" && isTestRun(row.argv);
    if (row.commit > 0 || row.rss > 0) {
      if (group === null) add(programs, `p:${row.comm.toLowerCase()}`, row.comm, row);
      else add(named, group, NAMES[group], row, test && !underTest, !isConsoleOf(row, parent));
    }
    for (const child of children.get(row.pid) ?? []) stack.push([child, group, test]);
  }
  for (const group of [...named.values(), ...programs.values()]) group.processes.sort(byCommit);
  return { named: [...named.values()], programs: [...programs.values()].sort(byCommit) };
}

/**
 * Who holds Windows' memory, from `topProcesses`' output (`windows-top.ts`).
 * `hostPid` is the host's Windows pid on a host on Windows itself, null
 * elsewhere: then nothing is the host's or its helpers', and a WebView2 is
 * no longer known to be prifly's window.
 */
export function holdersOf(out: string, hostPid: number | null): Holders {
  const rows = windowsRowsOf(out);
  // The idle process holds nothing.
  rows.delete(0);
  const memory = memoryLine(out);
  const pools = memory === null ? null : { paged: memory.paged, nonpaged: memory.nonpaged };
  const committed = memory?.committed ?? null;
  if (rows.size === 0) {
    const why = /^listerr\|(.*)$/m.exec(out)?.[1]?.trim();
    const error = `Windows' process list could not be read${why ? `: ${why}` : "."}`;
    return { groups: [], committed, pools, shared: null, inProcesses: 0, error };
  }
  const { named, programs } = grouped(rows, out, hostPid);
  const kept = folded(programs);
  const more = kept.at(-1)?.key === "more" ? kept.pop() : undefined;
  const groups = [...named, ...kept].sort(byCommit);
  if (more !== undefined) groups.push(more);
  const byProcesses = [...rows.values()].reduce((sum, row) => sum + row.commit, 0);
  const shared = memory === null ? null : unheld(memory.committed, byProcesses, memory);
  return { groups, committed, pools, shared, inProcesses: byProcesses, error: "" };
}

/** What is committed but in no process's own count and no pool, never below 0. */
const unheld = (
  committed: number,
  inProcesses: number,
  pools: { paged: number; nonpaged: number },
) => Math.max(0, committed - inProcesses - pools.paged - pools.nonpaged);

/**
 * The list with the pools the Memory row shows (`poolPaged` and
 * `poolNonpaged`, averaged over the page's window), so that the two never
 * disagree; the shared row is worked out again from them. Where typeperf gave
 * no pool sizes, the list keeps its own read.
 */
export function withPools(
  holders: Holders,
  counters: { poolPaged: number | null; poolNonpaged: number | null } | null,
): Holders {
  if (counters === null || counters.poolPaged === null || counters.poolNonpaged === null) {
    return holders;
  }
  const pools = { paged: counters.poolPaged, nonpaged: counters.poolNonpaged };
  const shared =
    holders.committed === null || holders.error !== ""
      ? null
      : unheld(holders.committed, holders.inProcesses, pools);
  return { ...holders, pools, shared };
}
