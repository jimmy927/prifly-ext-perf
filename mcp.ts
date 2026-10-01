/**
 * The MCP servers Claude Code is configured with, and which of a session's
 * child processes are one of them.
 *
 * A stdio server (a `command`) is started by every `claude` process that
 * loads it — one copy per session. An HTTP or SSE server (a `url`) runs once,
 * elsewhere, and costs a session nothing here. Read from the places Claude
 * Code reads (code.claude.com/docs/en/mcp): `mcpServers` in `~/.claude.json`
 * (every project), the same key under `projects[<folder>]` (one folder), and
 * a project's `.mcp.json`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type McpServer = {
  name: string;
  /** "user" (every project), "local" (one folder in ~/.claude.json) or "project" (.mcp.json). */
  scope: "user" | "local" | "project";
  /** stdio: a process per session; http: one server, shared. */
  transport: "stdio" | "http";
  /** What a process of it has in its command line; [] for an HTTP server. */
  marks: string[];
};

type Entry = { type?: string; command?: string; args?: string[]; url?: string };
type Config = { mcpServers?: Record<string, Entry>; projects?: Record<string, Config> };

/** Words in every launcher's command line, which tell no server apart. */
const COMMON = new Set([
  "npx",
  "node",
  "bun",
  "bunx",
  "uvx",
  "uv",
  "python",
  "python3",
  "sh",
  "bash",
  "run",
  "exec",
]);

/**
 * What a process started from this entry shows in its command line. `npx -y
 * @playwright/mcp@latest` runs as `npm exec @playwright/mcp@latest`, so the
 * package, not the launcher, is what tells it apart.
 */
export function marksOf(entry: Entry): string[] {
  const words = [entry.command ?? "", ...(entry.args ?? [])].filter(
    (word) => word.length > 2 && !word.startsWith("-") && !COMMON.has(basename(word)),
  );
  if (words.length > 0) return words;
  return entry.command === undefined ? [] : [basename(entry.command)];
}

function serversOf(config: Config | undefined, scope: McpServer["scope"]): McpServer[] {
  return Object.entries(config?.mcpServers ?? {}).map(([name, entry]) => {
    const http = entry.url !== undefined || entry.type === "http" || entry.type === "sse";
    return { name, scope, transport: http ? "http" : "stdio", marks: http ? [] : marksOf(entry) };
  });
}

function readJson(path: string): Config | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // A file being written as it is read: next time.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** The nearest `.mcp.json` at or above the folder, as Claude Code finds a project's. */
function projectConfig(folder: string): Config | undefined {
  for (let at = folder; ; at = dirname(at)) {
    const found = readJson(join(at, ".mcp.json"));
    if (found !== undefined || at === dirname(at) || at === homedir()) return found;
  }
}

/** Reads the configuration once; `forFolder` answers per session from it. */
export class McpConfig {
  private readonly global: Config | undefined;
  private readonly projects = new Map<string, Config | undefined>();

  constructor(home = homedir()) {
    this.global = readJson(join(home, ".claude.json"));
  }

  /** Every server a session in this folder loads. */
  forFolder(folder: string): McpServer[] {
    if (!this.projects.has(folder)) this.projects.set(folder, projectConfig(folder));
    return [
      ...serversOf(this.global, "user"),
      ...serversOf(this.global?.projects?.[folder], "local"),
      ...serversOf(this.projects.get(folder), "project"),
    ];
  }
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** The server a child process of `claude` is, by its command line; null when it is none. */
export function serverOf(argv: string[], servers: McpServer[]): string | null {
  const line = argv.join(" ");
  for (const server of servers) {
    if (server.marks.length > 0 && server.marks.some((mark) => line.includes(mark))) {
      return server.name;
    }
  }
  // A shell is a Bash tool call or a hook, whatever its command mentions.
  if (SHELLS.has(basename(argv[0] ?? "")) && argv[1] === "-c") return null;
  // A server from a plugin or a config not read here still says what it is, mostly.
  if (/(^|[\s/@_-])mcp([\s/@_-]|$)|mcp-server|server-mcp/i.test(line)) {
    return `${basename(argv[0] ?? "mcp")} (unlisted)`;
  }
  return null;
}
