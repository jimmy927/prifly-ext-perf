import { describe, expect, test } from "bun:test";
import { McpConfig, marksOf, serverOf } from "../mcp";
import { commandLabel, ownerIdsOf, ownersOf, priflyReport, toolUseOf } from "../prifly";
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

  test("a process is owned by its relay's session id, even a relay that hangs under init", () => {
    const owners = ownerIdsOf(all);
    expect(relay.ppid).toBe(1);
    for (const owned of [relay, claude, npm, node, shell, pytest]) {
      expect(owners.get(owned.pid)).toBe("aaaaaaaa-1111");
    }
    for (const other of [host, worker, namer, stranger]) expect(owners.has(other.pid)).toBe(false);
  });

  test("each session's tools are summed, without its claude or MCP servers", () => {
    const busy = proc(shell.pid, ["python3", "-m", "pytest", "-n", "6"], 5);
    const use = toolUseOf([...all, busy], known, config).get("aaaaaaaa-1111");
    // The shell (0) and both pytests (3 and 5); the claude and playwright are not tools.
    expect(use?.cores).toBe(8);
    expect(use?.rss).toBe(3 * 2 ** 20);
    expect(use?.doing).toBe("pytest -n 6");
    expect(use?.pid).toBe(busy.pid);
  });

  test("a land and its gate are gates, and count for the session whose drop it lands", () => {
    const land = proc(host.pid, [
      "bun",
      "/p/land-branch/runner.ts",
      "/w/.prifly/drops/aaaaaaaa/land/x.land",
    ]);
    const gate = proc(land.pid, ["bun", "test", "--parallel"], 4);
    // Detached, so a host restart leaves it under init.
    const op = proc(1, ["bun", "/p/git/op-runner.ts", "/ops/ops/1.json"]);
    const hook = proc(op.pid, ["bun", "run", "check"], 2);
    const withGates = priflyReport([...all, land, gate, op, hook], host.pid, known, config);
    expect(withGates.kinds.gates).toMatchObject({ processes: 4, cpu: 6 });
    expect(withGates.kinds.host.processes).toBe(2);
    expect(withGates.total.processes).toBe(13);
    // The writer's land is its session's; a git button's run is no session's.
    expect(withGates.sessions[0]).toMatchObject({ processes: 8, cpu: 7 });
  });

  test("a session with no tools is absent", () => {
    expect(toolUseOf([relay, claude], known, config).size).toBe(0);
  });
});
