import { describe, expect, test } from "bun:test";
import { McpConfig, marksOf, serverOf } from "../mcp";
import { commandLabel, ownersOf, priflyReport } from "../prifly";
import type { Proc } from "../procs";

const PLAYWRIGHT = {
  name: "playwright",
  scope: "user" as const,
  transport: "stdio" as const,
  marks: ["@playwright/mcp@latest", "http://host.docker.internal:9222"],
};

describe("MCP servers", () => {
  test("npx is told apart by its package, not the launcher", () => {
    expect(marksOf({ command: "npx", args: ["-y", "@playwright/mcp@latest"] })).toEqual([
      "@playwright/mcp@latest",
    ]);
  });

  test("npx runs as npm exec, and is still found", () => {
    expect(serverOf(["npm exec @playwright/mcp@latest"], [PLAYWRIGHT])).toBe("playwright");
  });

  test("a Bash tool call that mentions mcp is no server", () => {
    expect(serverOf(["/usr/bin/zsh", "-c", "grep mcp-server x"], [])).toBeNull();
  });

  test("an unlisted server still shows as one", () => {
    expect(serverOf(["node", "/x/server-mcp/index.js"], [])).toBe("node (unlisted)");
  });

  test("a home without ~/.claude.json has user servers none", () => {
    expect(new McpConfig("/nonexistent").forFolder("/nonexistent")).toEqual([]);
  });
});

test("a program is named by what it runs", () => {
  expect(commandLabel(["/usr/bin/python3", "-m", "pytest", "-n", "6"])).toBe("pytest -n 6");
  expect(commandLabel(["/x/node_modules/.bin/tsc", "--noEmit"])).toBe("tsc --noEmit");
});

let pid = 1000;
function proc(ppid: number, argv: string[], cpu = 0): Proc {
  pid += 1;
  const comm = (argv[0] ?? "").split("/").at(-1) ?? "";
  return { pid, ppid, comm, argv, rss: 2 ** 20, cpu, read: 0, write: 0 };
}

describe("prifly's processes", () => {
  const host = proc(1, ["bun", "src/index.ts"]);
  const worker = proc(host.pid, ["bun", "intent-model/worker.ts"]);
  // Started before the host restarted: init's now.
  const relay = proc(1, ["bun", "/p/relay/relay.ts", "/r", "aaaaaaaa-1111"]);
  const claude = proc(relay.pid, ["claude", "--print"]);
  const npm = proc(claude.pid, ["npm exec @playwright/mcp@latest"]);
  const node = proc(npm.pid, ["node", "playwright-mcp"]);
  const shell = proc(claude.pid, ["/usr/bin/zsh", "-c", "pytest"]);
  const pytest = proc(shell.pid, ["python3", "-m", "pytest"], 3);
  const namer = proc(host.pid, ["claude", "--model", "haiku"]);
  const stranger = proc(1, ["sshd"]);
  const all = [host, worker, relay, claude, npm, node, shell, pytest, namer, stranger];
  const config = { forFolder: () => [PLAYWRIGHT] } as unknown as McpConfig;
  const known = [{ id: "aaaaaaaa-1111", title: "odi-11", cwd: "/w", state: "working" }];
  const report = priflyReport(all, host.pid, known, config);

  test("each process is counted once, by kind", () => {
    expect(report.total.processes).toBe(9);
    expect(report.kinds.host.processes).toBe(2);
    expect(report.kinds.relay.processes).toBe(1);
    expect(report.kinds.claude.processes).toBe(2);
    expect(report.kinds.mcp.processes).toBe(2);
    expect(report.kinds.tools.processes).toBe(2);
  });

  test("a session carries its MCP copies and what it is doing", () => {
    const [row] = report.sessions;
    expect(row?.title).toBe("odi-11");
    expect(row?.processes).toBe(6);
    expect(row?.mcp).toEqual(["playwright"]);
    expect(row?.doing).toBe("pytest");
  });

  test("an MCP server counts its copies and processes", () => {
    expect(report.mcp).toEqual([
      expect.objectContaining({ name: "playwright", copies: 1, processes: 2 }),
    ]);
  });

  test("a tool's process is owned by its session", () => {
    expect(ownersOf(all, report.sessions).get(pytest.pid)).toBe("odi-11");
    expect(ownersOf(all, report.sessions).has(stranger.pid)).toBe(false);
  });
});
