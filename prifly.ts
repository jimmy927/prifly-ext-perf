/**
 * prifly's own processes, grouped the way the reader thinks of them: per
 * session, and per kind — the `claude` each session runs, the relay that
 * keeps it alive through a host restart, the MCP servers each `claude`
 * starts, and the tools its turns run (shells, tests, builds).
 *
 * The extension runs inside the host, so `process.pid` is the host. Relays
 * outlive it: one started before the host last restarted hangs under init,
 * so relays are found by their command line wherever they hang. A relay's
 * last argument is its session's id. The runners that land a branch or run
 * a git button (and the test gate under them) are found the same way: they
 * are detached, so they outlive the host too.
 */

import { basename } from "node:path";
import type { Container } from "./docker";
import type { McpConfig, McpServer } from "./mcp";
import { serverOf } from "./mcp";
import type { ExtensionSession } from "./prifly-api";
import type { Proc } from "./procs";

export type Kind = "host" | "relay" | "claude" | "mcp" | "tools" | "containers" | "gates";

export type Usage = { processes: number; rss: number; cpu: number; read: number; write: number };

export type SessionRow = Usage & {
  id: string;
  title: string;
  state: string;
  cwd: string;
  /** The MCP servers its `claude` runs, by name, one entry per copy. */
  mcp: string[];
  /** The busiest program its turn runs now, or "". */
  doing: string;
  /** The Docker containers it started, by name (`docker.ts`). */
  containers: string[];
};

export type McpRow = Usage & {
  name: string;
  transport: "stdio" | "http";
  scope: McpServer["scope"] | "running";
  /** Sessions running a copy of it; an HTTP server has none of its own. */
  copies: number;
};

export type PriflyReport = {
  total: Usage;
  kinds: Record<Kind, Usage>;
  sessions: SessionRow[];
  mcp: McpRow[];
  /** Containers no running session started: outside prifly, like other programs. */
  otherContainers: Usage;
  /** How many containers each side has; their processes are not counted, as Docker hides them. */
  containerCount: { sessions: number; other: number };
  /** What no session owns, by what it is for: the parts of `total` the sessions leave. */
  own: Record<Own, Usage>;
};

/**
 * What no session owns: the host with its own short `claude` calls, the
 * speech models dictation keeps loaded, the model that reads each message's
 * intent, and the git buttons' runs (a writer's land is its session's).
 */
export type Own = "host" | "dictation" | "intent" | "gates";

const empty = (): Usage => ({ processes: 0, rss: 0, cpu: 0, read: 0, write: 0 });
const noKinds = (): Record<Kind, Usage> => ({
  host: empty(),
  relay: empty(),
  claude: empty(),
  mcp: empty(),
  tools: empty(),
  containers: empty(),
  gates: empty(),
});

/** A container as a `Usage`: its memory and CPU; its processes and disk are not read. */
function addContainer(into: Usage, container: Container): void {
  into.rss += container.memory;
  into.cpu += container.cpu;
}

function add(into: Usage, proc: Proc): void {
  into.processes += 1;
  into.rss += proc.rss;
  into.cpu += proc.cpu;
  into.read += proc.read;
  into.write += proc.write;
}

type Tree = { byPid: Map<number, Proc>; children: Map<number, Proc[]> };

function treeOf(procs: Proc[]): Tree {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const children = new Map<number, Proc[]>();
  for (const proc of procs) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc);
    children.set(proc.ppid, list);
  }
  return { byPid, children };
}

function subtree(tree: Tree, root: Proc): Proc[] {
  const out: Proc[] = [];
  const stack = [root];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    out.push(next);
    stack.push(...(tree.children.get(next.pid) ?? []));
  }
  return out;
}

const isRelay = (proc: Proc) => proc.argv.some((arg) => arg.endsWith("relay/relay.ts"));
/** A land of a writer's branch (`land-branch/runner.ts`) or a git button's run (`git/op-runner.ts`). */
const isGateRunner = (proc: Proc) =>
  proc.argv.some(
    (arg) => arg.endsWith("land-branch/runner.ts") || arg.endsWith("git/op-runner.ts"),
  );
/** The session a writer's land is for: its state file is under `.prifly/drops/<first 8 of its id>/`. */
export function gateSessionPrefix(runner: Proc): string | null {
  for (const arg of runner.argv) {
    const match = /\/\.prifly\/drops\/([0-9a-f]{8})\//.exec(arg);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}
const isClaude = (proc: Proc) =>
  proc.comm === "claude" || basename(proc.argv[0] ?? "") === "claude";
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** A program as a person would name it: `pytest -n 6`, `tsc --noEmit`. */
export function commandLabel(argv: string[]): string {
  const words = argv.map((word) => (word.includes("/") ? basename(word) : word));
  // `python3 -m pytest` and `node …/tsc` say more by what they run than by the interpreter.
  const start = /^(python\d*(\.\d+)?|node|bun)$/.test(words[0] ?? "") && words.length > 1 ? 1 : 0;
  const shown = words.slice(start).filter((word, i) => !(i === 0 && word === "-m"));
  return shown.slice(0, 4).join(" ").slice(0, 60);
}

/** The busiest non-shell program among a turn's tools. */
function busiestOf(tools: Proc[]): Proc | undefined {
  return tools.filter((proc) => !SHELLS.has(proc.comm)).sort((a, b) => b.cpu - a.cpu)[0];
}

/** The busiest non-shell program among a turn's tools, named; "a shell command" when all are shells. */
function doingOf(tools: Proc[]): string {
  const busiest = busiestOf(tools);
  if (busiest !== undefined) return commandLabel(busiest.argv);
  return tools.length > 0 ? "a shell command" : "";
}

type Acc = {
  kinds: Record<Kind, Usage>;
  mcp: Map<string, McpRow>;
  config: McpConfig;
};

function countMcp(acc: Acc, name: string, server: McpServer | undefined, procs: Proc[]): void {
  const row = acc.mcp.get(name) ?? {
    ...empty(),
    name,
    transport: "stdio",
    scope: server?.scope ?? "running",
    copies: 0,
  };
  row.copies += 1;
  for (const proc of procs) add(row, proc);
  acc.mcp.set(name, row);
}

/** One `claude` and what it started: its MCP servers, and the tools of its turn. */
function readClaude(acc: Acc, tree: Tree, claude: Proc, row: SessionRow): Proc[] {
  add(acc.kinds.claude, claude);
  add(row, claude);
  const servers = acc.config.forFolder(row.cwd);
  const tools: Proc[] = [];
  for (const child of tree.children.get(claude.pid) ?? []) {
    const name = serverOf(child.argv, servers);
    const procs = subtree(tree, child);
    for (const proc of procs) {
      add(name === null ? acc.kinds.tools : acc.kinds.mcp, proc);
      add(row, proc);
    }
    if (name === null) tools.push(...procs);
    else {
      row.mcp.push(name);
      countMcp(
        acc,
        name,
        servers.find((server) => server.name === name),
        procs,
      );
    }
  }
  return tools;
}

/** One session's row, and the processes of its turns' tools that it was made from. */
function readRelay(
  acc: Acc,
  tree: Tree,
  relay: Proc,
  known: Map<string, ExtensionSession>,
): { row: SessionRow; tools: Proc[] } {
  const id = relay.argv.at(-1) ?? "";
  const session = known.get(id);
  const row: SessionRow = {
    ...empty(),
    id,
    title: session?.title ?? id.slice(0, 8),
    state: session?.state ?? "unknown",
    cwd: session?.cwd ?? "",
    mcp: [],
    doing: "",
    containers: [],
  };
  add(acc.kinds.relay, relay);
  add(row, relay);
  const tools: Proc[] = [];
  for (const child of tree.children.get(relay.pid) ?? []) {
    if (isClaude(child)) tools.push(...readClaude(acc, tree, child, row));
    else
      for (const proc of subtree(tree, child)) {
        add(acc.kinds.tools, proc);
        add(row, proc);
        tools.push(proc);
      }
  }
  row.doing = doingOf(tools);
  return { row, tools };
}

/** The HTTP servers configured anywhere a running session looks: shared, so no copies. */
function httpServers(acc: Acc, sessions: SessionRow[]): void {
  for (const session of sessions) {
    for (const server of acc.config.forFolder(session.cwd)) {
      if (server.transport !== "http" || acc.mcp.has(server.name)) continue;
      acc.mcp.set(server.name, { ...empty(), ...server, copies: 0 });
    }
  }
}

/**
 * The id of the session each process works for: the last argument of the
 * relay above it, found by walking up the tree. A relay that outlived the host
 * hangs under init (ppid 1) and is still a relay, so it is found all the same.
 * A process with no relay above it is absent.
 */
export function ownerIdsOf(procs: Proc[]): Map<number, string> {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const owners = new Map<number, string>();
  for (const proc of procs) {
    for (let at: Proc | undefined = proc; at !== undefined; at = byPid.get(at.ppid)) {
      if (!isRelay(at)) continue;
      owners.set(proc.pid, at.argv.at(-1) ?? "");
      break;
    }
  }
  return owners;
}

/** The session each process works for, by walking up to its relay; absent for the rest. */
export function ownersOf(procs: Proc[], sessions: SessionRow[]): Map<number, string> {
  const titles = new Map(sessions.map((row) => [row.id, row.title]));
  const owners = new Map<number, string>();
  for (const [pid, id] of ownerIdsOf(procs)) {
    const title = titles.get(id);
    if (title !== undefined) owners.set(pid, title);
  }
  return owners;
}

/** What one session's tools use: cores and memory summed, and its busiest program. */
export type ToolUse = {
  /** Cores in use, summed over its tools (not its `claude` or MCP servers). */
  cores: number;
  /** Resident memory of its tools, bytes. */
  rss: number;
  /** The busiest program, as `commandLabel` names it, or "". */
  doing: string;
  /** That program's pid, or 0 when there is none. */
  pid: number;
};

/**
 * Each session's tool CPU and memory, by session id, from a table already
 * averaged over a window (`averageProcs`). Tools are what the panel's "doing"
 * column looks at: what a turn runs, not the `claude` or its MCP servers. A
 * session with no tools is absent.
 */
export function toolUseOf(
  procs: Proc[],
  known: ExtensionSession[],
  config: McpConfig,
): Map<string, ToolUse> {
  const tree = treeOf(procs);
  const acc: Acc = { kinds: noKinds(), mcp: new Map(), config };
  const byId = new Map(known.map((session) => [session.id, session]));
  const out = new Map<string, ToolUse>();
  for (const relay of procs.filter(isRelay)) {
    const { row, tools } = readRelay(acc, tree, relay, byId);
    if (tools.length === 0) continue;
    const busiest = busiestOf(tools) ?? [...tools].sort((a, b) => b.cpu - a.cpu)[0];
    const use = out.get(row.id) ?? { cores: 0, rss: 0, doing: row.doing, pid: busiest?.pid ?? 0 };
    use.cores += tools.reduce((sum, proc) => sum + proc.cpu, 0);
    use.rss += tools.reduce((sum, proc) => sum + proc.rss, 0);
    out.set(row.id, use);
  }
  return out;
}

/** A runner and the gate under it, counted as gates and as its session's — or, for a git button's, as no one's. */
function countGate(
  gates: Usage,
  own: Usage,
  tree: Tree,
  runner: Proc,
  sessions: SessionRow[],
): void {
  const prefix = gateSessionPrefix(runner);
  const row = prefix === null ? undefined : sessions.find((s) => s.id.startsWith(prefix));
  for (const proc of subtree(tree, runner)) {
    add(gates, proc);
    add(row ?? own, proc);
  }
}

/** Which of the host's own helpers a child of it is, by the script it runs. */
function helperOf(child: Proc): Own {
  if (child.argv.some((arg) => /\/dictation\/[\w-]+-worker\.ts$/.test(arg))) return "dictation";
  if (child.argv.some((arg) => arg.endsWith("intent-model/worker.ts"))) return "intent";
  return "host";
}

/**
 * The host and what it started that is no session's and no gate: its helpers
 * as host, and its own short `claude` calls — a branch name, a summary — as
 * claude, all of them as `own` by what they are for.
 */
function readHost(
  kinds: Record<Kind, Usage>,
  own: Record<Own, Usage>,
  tree: Tree,
  hostPid: number,
): void {
  const host = tree.byPid.get(hostPid);
  if (host !== undefined) {
    add(kinds.host, host);
    add(own.host, host);
  }
  for (const child of tree.children.get(hostPid) ?? []) {
    if (isRelay(child) || isGateRunner(child)) continue;
    const kind = isClaude(child) ? kinds.claude : kinds.host;
    const helper = own[helperOf(child)];
    for (const proc of subtree(tree, child)) {
      add(kind, proc);
      add(helper, proc);
    }
  }
}

/**
 * prifly's processes by kind and session, and Docker's containers beside
 * them: one a running session started counts as that session's, the rest are
 * `otherContainers`.
 */
export function priflyReport(
  procs: Proc[],
  hostPid: number,
  known: ExtensionSession[],
  config: McpConfig,
  containers: Container[] = [],
): PriflyReport {
  const tree = treeOf(procs);
  const kinds = noKinds();
  const acc: Acc = { kinds, mcp: new Map(), config };
  const byId = new Map(known.map((session) => [session.id, session]));
  const own: Record<Own, Usage> = {
    host: empty(),
    dictation: empty(),
    intent: empty(),
    gates: empty(),
  };
  const sessions: SessionRow[] = [];
  // Wherever they hang: a relay started before the host last restarted is init's child now.
  for (const relay of procs.filter(isRelay)) sessions.push(readRelay(acc, tree, relay, byId).row);
  for (const runner of procs.filter(isGateRunner)) {
    countGate(kinds.gates, own.gates, tree, runner, sessions);
  }
  readHost(kinds, own, tree, hostPid);
  httpServers(acc, sessions);
  const rows = new Map(sessions.map((row) => [row.id, row]));
  const otherContainers = empty();
  const containerCount = { sessions: 0, other: 0 };
  for (const container of containers) {
    const row = rows.get(container.session);
    if (row === undefined) {
      addContainer(otherContainers, container);
      containerCount.other += 1;
      continue;
    }
    containerCount.sessions += 1;
    addContainer(kinds.containers, container);
    addContainer(row, container);
    row.containers.push(container.name);
  }
  const total = Object.values(kinds).reduce(
    (sum, usage) => ({
      processes: sum.processes + usage.processes,
      rss: sum.rss + usage.rss,
      cpu: sum.cpu + usage.cpu,
      read: sum.read + usage.read,
      write: sum.write + usage.write,
    }),
    empty(),
  );
  const mcp = [...acc.mcp.values()].sort((a, b) => b.processes - a.processes);
  const byCpu = sessions.sort((a, b) => b.cpu - a.cpu);
  return { total, kinds, sessions: byCpu, mcp, otherContainers, containerCount, own };
}

/**
 * The busiest processes this Linux sees and Docker's busiest containers, each
 * with the session it works for.
 */
export function topLinux(table: Proc[], containers: Container[], report: PriflyReport | null) {
  const owners = ownersOf(table, report?.sessions ?? []);
  const titles = new Map((report?.sessions ?? []).map((row) => [row.id, row.title]));
  const procs = table.map((proc) => ({
    pid: proc.pid,
    what: commandLabel(proc.argv.length > 0 ? proc.argv : [proc.comm]),
    session: owners.get(proc.pid) ?? "",
    cpu: proc.cpu,
    rss: proc.rss,
    disk: proc.read + proc.write,
  }));
  const docker = containers.map((container) => ({
    pid: 0,
    what: `container ${container.name}`,
    session: titles.get(container.session) ?? "",
    cpu: container.cpu,
    rss: container.memory,
    disk: 0,
  }));
  return [...procs, ...docker]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .filter((row) => row.cpu >= 0.05);
}
