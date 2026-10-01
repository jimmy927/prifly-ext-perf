/**
 * prifly's own processes, grouped the way the reader thinks of them: per
 * session, and per kind — the `claude` each session runs, the relay that
 * keeps it alive through a host restart, the MCP servers each `claude`
 * starts, and the tools its turns run (shells, tests, builds).
 *
 * The extension runs inside the host, so `process.pid` is the host. Relays
 * outlive it: one started before the host last restarted hangs under init,
 * so relays are found by their command line wherever they hang. A relay's
 * last argument is its session's id.
 */

import { basename } from "node:path";
import type { McpConfig, McpServer } from "./mcp";
import { serverOf } from "./mcp";
import type { ExtensionSession } from "./prifly-api";
import type { Proc } from "./procs";

export type Kind = "host" | "relay" | "claude" | "mcp" | "tools";

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
};

const empty = (): Usage => ({ processes: 0, rss: 0, cpu: 0, read: 0, write: 0 });

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
function doingOf(tools: Proc[]): string {
  const busiest = tools.filter((proc) => !SHELLS.has(proc.comm)).sort((a, b) => b.cpu - a.cpu)[0];
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

function readRelay(acc: Acc, tree: Tree, relay: Proc, known: Map<string, ExtensionSession>) {
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
  return row;
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

/** The session each process works for, by walking up to its relay; absent for the rest. */
export function ownersOf(procs: Proc[], sessions: SessionRow[]): Map<number, string> {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  const titles = new Map(sessions.map((row) => [row.id, row.title]));
  const owners = new Map<number, string>();
  for (const proc of procs) {
    for (let at: Proc | undefined = proc; at !== undefined; at = byPid.get(at.ppid)) {
      if (!isRelay(at)) continue;
      const title = titles.get(at.argv.at(-1) ?? "");
      if (title !== undefined) owners.set(proc.pid, title);
      break;
    }
  }
  return owners;
}

export function priflyReport(
  procs: Proc[],
  hostPid: number,
  known: ExtensionSession[],
  config: McpConfig,
): PriflyReport {
  const tree = treeOf(procs);
  const kinds = { host: empty(), relay: empty(), claude: empty(), mcp: empty(), tools: empty() };
  const acc: Acc = { kinds, mcp: new Map(), config };
  const byId = new Map(known.map((session) => [session.id, session]));
  const host = tree.byPid.get(hostPid);
  const sessions: SessionRow[] = [];
  if (host !== undefined) add(kinds.host, host);
  // Wherever they hang: a relay started before the host last restarted is init's child now.
  for (const relay of procs.filter(isRelay)) sessions.push(readRelay(acc, tree, relay, byId));
  for (const child of tree.children.get(hostPid) ?? []) {
    if (isRelay(child)) continue;
    // prifly's own short `claude` calls — a branch name, a summary — are claude too.
    const kind = isClaude(child) ? kinds.claude : kinds.host;
    for (const proc of subtree(tree, child)) add(kind, proc);
  }
  httpServers(acc, sessions);
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
  return { total, kinds, sessions: sessions.sort((a, b) => b.cpu - a.cpu), mcp };
}
