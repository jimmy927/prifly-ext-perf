/** A prifly host on Windows itself: WSL's process table through `wsl.exe`, and the host's own Windows processes. */

import { describe, expect, test } from "bun:test";
import { averageProcs } from "../average";
import { parseInspect } from "../docker";
import type { McpConfig } from "../mcp";
import { isRelay, priflyReport, usageOf } from "../prifly";
import type { Proc, ProcSnapshot } from "../procs";
import type { ShellChild } from "../shell";
import { Tables } from "../tables";
import { hostTreeOf, splitCommandLine } from "../windows";
import { headSections, PROCS_READ, parseProcsRead, WslLinux } from "../wsl-exe";

const SESSION = "9c45c7d0-37c1-4589-9eca-b75e815a885a";
const AGENT = "/home/j/.cache/prifly/agent/p3-cbc9f2bd15df/prifly-agent";
const CONTAINER = "536c8b2ed1fa531417d0fedce9696a0c924ef8bad80d17ab06f36c8bb483e3c6";

/** A `/proc/<pid>/stat` line: ppid is field 4, utime and stime 14 and 15, rss (pages) 24. */
function stat(pid: number, comm: string, ppid: number, ticks: number, pages = 256): string {
  const fields = ["S", String(ppid), ...Array(9).fill("0"), String(ticks), "0"];
  return `${pid} (${comm}) ${[...fields, ...Array(8).fill("0"), String(pages), "0"].join(" ")}\n`;
}

const io = (read: number, write: number) =>
  `rchar: 1\nwchar: 1\nsyscr: 1\nsyscw: 1\nread_bytes: ${read}\nwrite_bytes: ${write}\ncancelled_write_bytes: 0\n`;

const cmdline = (...args: string[]) => args.map((arg) => `${arg}\0`).join("");

/** What GNU `head -v` prints for these files: each under its header, a newline between them. */
const head = (files: [string, string][]) =>
  files.map(([path, text]) => `==> ${path} <==\n${text}`).join("\n");

type Fake = { pid: number; comm: string; ppid: number; ticks: number; argv: string[]; io?: string };

const PROCS: Fake[] = [
  { pid: 1, comm: "init", ppid: 0, ticks: 5, argv: ["/init"] },
  { pid: 100, comm: "Relay(101)", ppid: 1, ticks: 0, argv: ["/init"] },
  {
    pid: 200,
    comm: "prifly-agent",
    ppid: 100,
    ticks: 40,
    argv: [AGENT, "--port", "48983", "--relay-dir", "/r", "--build", "p3-cbc9f2bd15df"],
    io: io(4096, 0),
  },
  { pid: 300, comm: "prifly-agent", ppid: 100, ticks: 10, argv: [AGENT, "relay", "/r", SESSION] },
  {
    pid: 301,
    comm: "claude",
    ppid: 300,
    ticks: 900,
    // A system prompt: spaces, a newline, and something that looks like a header but is not on a line of its own.
    argv: [
      "/home/j/.local/bin/claude",
      "--append-system-prompt",
      "Be brief.\nSay ==> 5/stat <== to no one.",
    ],
  },
  {
    pid: 302,
    comm: "npm exec @play",
    ppid: 301,
    ticks: 30,
    argv: ["npm exec @playwright/mcp@latest"],
  },
  { pid: 303, comm: "node", ppid: 302, ticks: 70, argv: ["node", "/n/playwright-mcp/cli.js"] },
  { pid: 310, comm: "zsh", ppid: 301, ticks: 2, argv: ["/usr/bin/zsh", "-c", "pytest -n 6"] },
  {
    pid: 311,
    comm: "python3",
    ppid: 310,
    ticks: 600,
    argv: ["python3", "-m", "pytest", "-n", "6"],
    io: io(8192, 1024),
  },
  {
    pid: 400,
    comm: "prifly-agent",
    ppid: 200,
    ticks: 20,
    argv: [AGENT, "/home/j/.cache/prifly/runners/r-834d20426ebe/op-runner.js", "/ops/1.json"],
  },
  { pid: 401, comm: "git", ppid: 400, ticks: 3, argv: ["git", "fetch"] },
  { pid: 500, comm: "sshd", ppid: 1, ticks: 1, argv: ["sshd: /usr/sbin/sshd"] },
];

function dump(procs: Fake[], containers = true): string {
  const files: [string, string][] = [
    ...procs.map((p): [string, string] => [`${p.pid}/stat`, stat(p.pid, p.comm, p.ppid, p.ticks)]),
    // Another user's io is not ours to read: `head` leaves it out.
    ...procs.flatMap((p): [string, string][] =>
      p.io === undefined ? [] : [[`${p.pid}/io`, p.io]],
    ),
    ...procs.map((p): [string, string] => [`${p.pid}/cmdline`, cmdline(...p.argv)]),
  ];
  const cgroups = head([
    [`docker/${CONTAINER}/cpu.stat`, "usage_usec 2000000\nuser_usec 1500000\n"],
    ["docker/buildx/cpu.stat", "usage_usec 5\n"],
    [`docker/${CONTAINER}/memory.current`, "104857600\n"],
    ["docker/buildx/memory.current", "1\n"],
    [`docker/${CONTAINER}/memory.stat`, "anon 1\ninactive_file 4857600\n"],
    ["docker/buildx/memory.stat", "anon 1\n"],
  ]);
  // The `echo` between the two `head`s.
  return `${head(files)}\n${containers ? cgroups : ""}`;
}

const config = {
  forFolder: () => [
    {
      name: "playwright",
      scope: "user" as const,
      transport: "stdio" as const,
      marks: ["@playwright/mcp@latest"],
    },
  ],
} as unknown as McpConfig;
const known = [{ id: SESSION, title: "odi-11", cwd: "/w", state: "working" }];

/** Two reads a second apart, averaged: what the panel's one-second window shows. */
function averaged(first: ProcSnapshot, second: ProcSnapshot): Proc[] {
  return averageProcs([first, second], 1)?.value ?? [];
}

describe("the process table read through wsl.exe", () => {
  const read = parseProcsRead(dump(PROCS), 1000);

  test("every file's text is cut out by its header, less head's newline between files", () => {
    const files = headSections(dump(PROCS));
    expect(files.get("1/stat")).toBe(stat(1, "init", 0, 5));
    expect(files.get("300/cmdline")).toBe(cmdline(AGENT, "relay", "/r", SESSION));
    expect(files.get("docker/buildx/memory.current")).toBe("1\n");
    // The last file has no newline after it from `head`: it loses its own, which no parser needs.
    expect(files.get("docker/buildx/memory.stat")).toBe("anon 1");
  });

  test("each process keeps its arguments whole, NULs, spaces and newlines alike", () => {
    expect(read.procs.procs.size).toBe(PROCS.length);
    const claude = read.procs.procs.get(301);
    expect(claude?.argv).toEqual(PROCS[4]?.argv ?? []);
    expect(claude).toMatchObject({ comm: "claude", ppid: 300, ticks: 900, rss: 256 * 4096 });
    expect(read.procs.procs.get(311)).toMatchObject({ read: 8192, write: 1024 });
    // No io to read: none counted.
    expect(read.procs.procs.get(301)).toMatchObject({ read: 0, write: 0 });
  });

  test("a container is read from its cgroup; a folder that is no container's is not", () => {
    expect([...read.containers.containers.values()]).toEqual([
      { id: CONTAINER, usage: 2_000_000, memory: 100_000_000 },
    ]);
  });

  test("no Docker in WSL: no containers, the table all the same", () => {
    const bare = parseProcsRead(dump(PROCS, false), 1000);
    expect(bare.containers.containers.size).toBe(0);
    expect(bare.procs.procs.get(300)?.argv).toEqual([AGENT, "relay", "/r", SESSION]);
  });

  test("a process that ended between its stat and its command line is left out", () => {
    const cut = dump(PROCS).replace(/==> 500\/cmdline <==\n[^\n]*\n/, "");
    expect(parseProcsRead(cut, 1000).procs.procs.has(500)).toBe(false);
  });

  test("the command is one line, and reads the cgroups after the table", () => {
    expect(PROCS_READ).not.toContain("\n");
    expect(PROCS_READ.indexOf("[0-9]*/cmdline")).toBeLessThan(PROCS_READ.indexOf("cpu.stat"));
  });
});

describe("prifly's sessions on a host on Windows itself", () => {
  const later = PROCS.map((p) => ({ ...p, ticks: p.ticks + (p.pid === 311 ? 150 : 0) }));
  const table = averaged(
    parseProcsRead(dump(PROCS), 1000).procs,
    parseProcsRead(dump(later), 2000).procs,
  );
  const report = priflyReport(table, null, known, config);

  test("a relay is the agent's `prifly-agent relay`, or the host's relay.ts; the agent itself is none", () => {
    const relay = table.find((p) => p.pid === 300);
    const agent = table.find((p) => p.pid === 200);
    expect(relay !== undefined && isRelay(relay)).toBe(true);
    expect(agent !== undefined && isRelay(agent)).toBe(false);
    const old = { ...(relay as Proc), comm: "bun", argv: ["bun", "/p/relay/relay.ts", "/r", "x"] };
    expect(isRelay(old)).toBe(true);
  });

  test("the session is found by its relay, with its MCP server and what it is doing", () => {
    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]).toMatchObject({
      id: SESSION,
      title: "odi-11",
      processes: 6,
      mcp: ["playwright"],
      doing: "pytest -n 6",
    });
    expect(report.sessions[0]?.cpu).toBeCloseTo(1.5);
    expect(report.kinds.mcp.processes).toBe(2);
    expect(report.kinds.tools.processes).toBe(2);
  });

  test("the agent counts as the host, its runner and what it runs as gates; init and sshd as nothing", () => {
    expect(report.kinds.host.processes).toBe(1);
    expect(report.own.host.processes).toBe(1);
    expect(report.kinds.gates.processes).toBe(2);
    expect(report.total.processes).toBe(9);
  });
});

/** What `windowsProcessList` printed, cut to the processes that matter. */
const WINDOWS = [
  "0|0|0|System Idle Process|0|8192|0|0|0|",
  "4|0|630000000000000000|System|9000000|20480|0|0|200000|",
  "8000|1|638000000000000000|explorer.exe|50000000|90000000|0|0|120000000|C:\\Windows\\Explorer.EXE",
  // The host.
  '9000|8000|639000000000000000|prifly.exe|20000000|300000000|1000|2000|900000000|"C:\\Users\\j\\AppData\\Local\\sh.prifly.app\\prifly.exe"',
  '9100|9000|639000000000000100|bun.exe|10000000|500000000|0|0|4000000000|"C:\\p\\bun.exe" "C:\\p\\dictation\\final-worker.ts" {}',
  '9101|9000|639000000000000100|bun.exe|5000000|200000000|0|0|400000000|"C:\\p\\bun.exe" C:\\p\\intent-model\\worker.js',
  '9200|9000|639000000000000200|msedgewebview2.exe|3000000|100000000|0|0|800000000|"C:\\Program Files\\msedgewebview2.exe" --type=browser --x=a|b',
  "9201|9200|639000000000000300|msedgewebview2.exe|1000000|50000000|0|0|800000000|msedgewebview2.exe --type=renderer",
  "9300|9000|639000000000000400|claude.exe|1000000|60000000|0|0|200000000|claude.exe --print --model haiku",
  // A dead parent's pid, reused by the host: this started before it, so it is not its child.
  "9400|9000|637000000000000000|conhost.exe|1000000|1000000|0|0|5000000|conhost.exe",
  "9500|8000|639000000000000500|Code.exe|90000000|900000000|0|0|700000000|Code.exe",
  "this line is no process",
].join("\r\n");

describe("the host's own Windows processes", () => {
  const tree = hostTreeOf(WINDOWS, 9000, 1000);

  test("the host and all under it, by parent pid; not a process that merely took a dead parent's pid", () => {
    expect([...tree.procs.keys()].sort()).toEqual([9000, 9100, 9101, 9200, 9201, 9300]);
  });

  test("its name loses .exe, its command line is split, and a | inside it is kept", () => {
    expect(tree.procs.get(9300)).toMatchObject({ comm: "claude", rss: 60_000_000 });
    expect(tree.procs.get(9100)?.argv).toEqual([
      "C:\\p\\bun.exe",
      "C:\\p\\dictation\\final-worker.ts",
      "{}",
    ]);
    expect(tree.procs.get(9200)?.argv.at(-1)).toBe("--x=a|b");
    expect(splitCommandLine('"C:\\a b\\x.exe" -y')).toEqual(["C:\\a b\\x.exe", "-y"]);
  });

  test("CPU time counts in ticks of 10 ms, from Windows' 100 ns", () => {
    expect(tree.procs.get(9000)?.ticks).toBe(200);
    const busier = WINDOWS.replace("|20000000|300000000|", "|35000000|300000000|");
    const host = averaged(tree, hostTreeOf(busier, 9000, 2000)).find((p) => p.pid === 9000);
    // 1.5 s of CPU in one second.
    expect(host?.cpu).toBeCloseTo(1.5);
  });

  test("they count as the host's, its dictation and its intent model, and add up apart", () => {
    const windows = averaged(tree, hostTreeOf(WINDOWS, 9000, 2000));
    const report = priflyReport([], null, [], config, [], { procs: windows, hostPid: 9000 });
    expect(report.own.dictation.processes).toBe(1);
    expect(report.own.intent.processes).toBe(1);
    // The host, its WebView2 and its renderer, and its own short `claude` call.
    expect(report.own.host.processes).toBe(4);
    expect(report.kinds.claude.processes).toBe(1);
    expect(report.kinds.host.processes).toBe(5);
    expect(usageOf(windows)).toMatchObject({ processes: 6, rss: 1_210_000_000 });
  });

  test("a host not in the list has no processes", () => {
    expect(hostTreeOf(WINDOWS, 1234, 1000).procs.size).toBe(0);
    expect(hostTreeOf("", 9000, 1000).procs.size).toBe(0);
  });
});

describe("Docker asked from inside WSL", () => {
  test("one JSON line per container, shaped like the API's", () => {
    const line = JSON.stringify({
      Id: CONTAINER,
      Names: ["/odi-elastic-1"],
      Labels: { "com.docker.compose.project.working_dir": "/home/j/src/odi" },
      Mounts: [],
    });
    expect(parseInspect(`${line}\n`).get(CONTAINER)).toEqual({
      name: "odi-elastic-1",
      paths: ["/home/j/src/odi"],
    });
  });

  test("no docker in WSL is an error that says what it printed", () => {
    expect(() => parseInspect("sh: 1: docker: not found\n")).toThrow("docker: not found");
  });
});

/** A `wsl.exe -e sh` the test answers by hand. */
class FakeSh implements ShellChild {
  written: string[] = [];
  private data: ((chunk: string) => void)[] = [];
  private exit: ((reason: string) => void)[] = [];
  write(text: string): void {
    this.written.push(text);
  }
  kill(): void {
    for (const listener of this.exit) listener("killed");
  }
  onData(listener: (chunk: string) => void): void {
    this.data.push(listener);
  }
  onExit(listener: (reason: string) => void): void {
    this.exit.push(listener);
  }
  answer(output: string): void {
    const id = /<<END-([^>]+)>>/.exec(this.written.at(-1) ?? "")?.[1] ?? "";
    for (const listener of this.data) listener(`${output}<<END-${id}>>\n`);
  }
  end(reason: string): void {
    for (const listener of this.exit) listener(reason);
  }
}

const settle = () => new Promise((done) => setTimeout(done, 5));

/** Enough of `/proc` for `WslLinux` to count WSL as read. */
const LINUX =
  "==> /proc/stat <==\ncpu  1 0 1 10 0 0 0 0 0 0\ncpu0 1 0 1 10\n\n==> /proc/meminfo <==\nMemTotal: 1000 kB\nMemAvailable: 500 kB\n";

async function nativeTables(probe: string) {
  const children: FakeSh[] = [];
  const logged: string[] = [];
  const wsl = new WslLinux({
    spawn: () => {
      const child = new FakeSh();
      children.push(child);
      return child;
    },
    probe: async () => probe,
    onRead: () => {},
  });
  const tables = new Tables({
    wsl,
    windows: false,
    hostPid: 9000,
    log: (event, data) => logged.push(`${event}: ${data.error}`),
  });
  wsl.poll();
  await settle();
  if (probe === "") {
    wsl.poll();
    children[0]?.answer(LINUX);
    await settle();
  }
  return { wsl, tables, children, logged };
}

describe("reading the table on a host on Windows itself", () => {
  test("WSL not running: nothing is read, and WSL says why", async () => {
    const { wsl, tables, children } = await nativeTables("WSL is not running on this host.");
    tables.readAll(310, Date.now());
    tables.readProcs(30);
    await settle();
    expect(children).toHaveLength(0);
    expect(tables.procs).toHaveLength(0);
    expect(wsl.absent).toBe("WSL is not running on this host.");
  });

  test("before WSL's first read nothing is asked, and nothing breaks", async () => {
    const children: FakeSh[] = [];
    const wsl = new WslLinux({
      spawn: () => {
        const child = new FakeSh();
        children.push(child);
        return child;
      },
      probe: async () => "",
      onRead: () => {},
    });
    const tables = new Tables({ wsl, windows: false, hostPid: 1, log: () => {} });
    tables.readAll(310, Date.now());
    await settle();
    expect(tables.procs).toHaveLength(0);
    expect(averageProcs(tables.procs, 2)).toBeNull();
  });

  test("the table and its containers come through the same shell, one read at a time", async () => {
    const { tables, children } = await nativeTables("");
    tables.readAll(310, Date.now());
    tables.readAll(310, Date.now());
    const shell = children[0];
    expect(children).toHaveLength(1);
    expect(shell?.written.filter((line) => line.startsWith(PROCS_READ))).toHaveLength(1);
    shell?.answer(dump(PROCS));
    await settle();
    expect(tables.procs).toHaveLength(1);
    expect(tables.containers[0]?.containers.has(CONTAINER)).toBe(true);
    // A container runs: Docker is asked what it is, through the same shell.
    expect(shell?.written.at(-1)).toStartWith("docker ps -q");
  });

  test("for the nanny, the table alone", async () => {
    const { tables, children } = await nativeTables("");
    tables.readProcs(30);
    children[0]?.answer(dump(PROCS));
    await settle();
    expect(tables.procs).toHaveLength(1);
    expect(tables.containers).toHaveLength(0);
  });

  test("a read that WSL dies during keeps nothing, and is WSL gone rather than a logged failure", async () => {
    const { wsl, tables, children, logged } = await nativeTables("");
    tables.readProcs(30);
    children[0]?.end("exit 1: The Windows Subsystem for Linux instance has terminated.");
    await settle();
    expect(tables.procs).toHaveLength(0);
    expect(wsl.absent).toStartWith("WSL: shell ended");
    expect(logged).toEqual([]);
  });

  test("output that is no table is logged, and kept out", async () => {
    const { tables, children, logged } = await nativeTables("");
    tables.readProcs(30);
    children[0]?.answer("sh: 1: head: not found\n");
    await settle();
    expect(tables.procs).toHaveLength(0);
    expect(logged[0]).toStartWith("wsl_procs_failed: Error: no process in what it printed");
  });
});
