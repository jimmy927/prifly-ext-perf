import { describe, expect, test } from "bun:test";
import { holdersOf, isTestRun, withPools } from "../holders";

/** `gb` gigabytes, in whole MiB so that sums are exact. */
const GB = (gb: number) => Math.round(gb * 1024) * 2 ** 20;

/** One process as `PROCESS_LIST` prints it. */
const line = (pid: number, ppid: number, name: string, commit: number, ram: number, cmd = name) =>
  `${pid}|${ppid}|639000000000000${String(pid).padStart(3, "0").slice(-3)}|${name}|0|${GB(ram)}|0|0|${GB(commit)}|${cmd}`;

const HOST = 9000;

/** Windows on 2026-10-29: 72 GB committed, as measured, cut to the processes that matter. */
const MACHINE = [
  "c|vmmemwsl|% processor time|250",
  "compression|1064304640",
  `memory|${GB(72)}|${GB(3)}|${GB(3.4)}`,
  "0|0|0|System Idle Process|0|8192|0|0||",
  line(4, 0, "System", 0.2, 0.01),
  line(100, 4, "vmmemWSL", 24.1, 8),
  line(500, 4, "explorer.exe", 0.5, 0.2),
  // The host and what it started.
  line(HOST, 500, "prifly.exe", 1.8, 0.6, '"C:\\p\\prifly.exe"'),
  line(9100, HOST, "bun.exe", 3, 1, '"C:\\p\\bun.exe" "C:\\p\\dictation\\final-worker.ts"'),
  line(9101, HOST, "bun.exe", 1.4, 0.5, '"C:\\p\\bun.exe" "C:\\p\\dictation\\grey-worker.ts"'),
  line(9102, HOST, "bun.exe", 0.35, 0.3, '"C:\\p\\bun.exe" C:\\p\\intent-model\\worker.js'),
  line(9200, HOST, "msedgewebview2.exe", 1.2, 0.4, "msedgewebview2.exe --type=browser"),
  line(9201, 9200, "msedgewebview2.exe", 0.4, 0.2, "msedgewebview2.exe --type=renderer"),
  // Ten sessions' `claude.exe`, 4.6 GB.
  ...Array.from({ length: 10 }, (_, i) => line(9300 + i, HOST, "claude.exe", 0.46, 0.2)),
  // A session's test run, through a shell: 2.8 GB.
  line(9400, 9300, "bash.exe", 0.01, 0.01, "bash -c 'bun test'"),
  line(9401, 9400, "bun.exe", 2.79, 0.9, '"C:\\p\\bun.exe" test test/x.test.ts'),
  // A bun that is not a test, under the host: the host's.
  line(9500, HOST, "bun.exe", 0.01, 0.01, "bun x tsc"),
  // prifly's agent on Windows and its relays, apart from the host.
  line(
    9700,
    500,
    "bun.exe",
    0.3,
    0.05,
    "bun.exe C:\\p\\node-agent\\main.ts --port 4201 --relay-dir C:\\r",
  ),
  line(9701, 9700, "bun.exe", 0.75, 0.1, "bun.exe C:\\p\\node-agent\\main.ts relay C:\\r 1234"),
  line(9702, 9700, "bun.exe", 0.75, 0.1, "bun.exe C:\\p\\node-agent\\main.ts relay C:\\r 5678"),
  // The installed app's window, outside the host: its launcher, its bun and a renderer.
  line(
    9800,
    500,
    "launcher.exe",
    0.01,
    0.01,
    '"C:\\U\\AppData\\Local\\sh.prifly.app\\bin\\launcher.exe"',
  ),
  line(
    9801,
    9800,
    "bun.exe",
    0.3,
    0.2,
    '"C:\\U\\AppData\\Local\\sh.prifly.app\\bin\\bun.exe" main.js',
  ),
  line(
    9802,
    9801,
    "bun Helper.exe",
    0.5,
    0.4,
    '"C:\\U\\AppData\\Local\\sh.prifly.app\\bin\\bun Helper.exe" --type=renderer',
  ),
  line(8100, 500, "chrome.exe", 2, 1, "chrome.exe"),
  line(8101, 8100, "chrome.exe", 0.8, 0.4, "chrome.exe --type=renderer"),
  // Another program's WebView2: not prifly's window.
  line(8200, 500, "olk.exe", 0.4, 0.3),
  line(8201, 8200, "msedgewebview2.exe", 2.1, 0.8),
  line(8300, 500, "Docker Desktop.exe", 0.3, 0.2),
  line(8301, 8300, "com.docker.backend.exe", 0.2, 0.1),
  line(700, 4, "dwm.exe", 1.65, 0.3),
  ...["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((n, i) =>
    line(1000 + i, 500, `${n}.exe`, 0.1 * (i + 1), 0.05),
  ),
].join("\r\n");

const group = (out: string, key: string, hostPid: number | null = HOST) =>
  holdersOf(out, hostPid).groups.find((g) => g.key === key);

describe("who holds Windows' memory", () => {
  const holders = holdersOf(MACHINE, HOST);

  test("each group adds up its processes' commit and RAM", () => {
    expect(group(MACHINE, "wsl")).toMatchObject({ name: "WSL VM", commit: GB(24.1), ram: GB(8) });
    expect(group(MACHINE, "claude")?.commit).toBe(10 * GB(0.46) + GB(0.01));
    expect(group(MACHINE, "claude")?.processes).toHaveLength(11);
    expect(group(MACHINE, "dictation")?.commit).toBe(GB(3) + GB(1.4));
    expect(group(MACHINE, "intent")?.commit).toBe(GB(0.35));
    expect(group(MACHINE, "tests")?.commit).toBe(GB(2.79));
    expect(group(MACHINE, "chrome")?.commit).toBe(GB(2) + GB(0.8));
    expect(group(MACHINE, "webview2")?.commit).toBe(GB(2.1));
    // The host's WebView2 and the installed app's window.
    expect(group(MACHINE, "window")?.commit).toBe(GB(1.2) + GB(0.4) + GB(0.01) + GB(0.3) + GB(0.5));
    expect(group(MACHINE, "agent")).toMatchObject({
      name: "prifly agent and relays",
      commit: GB(0.3) + 2 * GB(0.75),
    });
    expect(group(MACHINE, "docker")?.commit).toBe(GB(0.3) + GB(0.2));
    // The host, and the bun under it that is no test; the shell a session ran its test in is the session's.
    expect(group(MACHINE, "host")?.commit).toBe(GB(1.8) + GB(0.01));
    expect(group(MACHINE, "claude")?.processes.map((p) => p.pid)).toContain(9400);
    expect(group(MACHINE, "p:dwm")?.commit).toBe(GB(1.65));
  });

  test("largest commit first, and the programs past eight share one row, last", () => {
    const commits = holders.groups.slice(0, -1).map((g) => g.commit);
    expect(commits).toEqual([...commits].sort((a, b) => b - a));
    expect(holders.groups[0]?.key).toBe("wsl");
    const more = holders.groups.at(-1);
    expect(more?.key).toBe("more");
    const programs = holders.groups.filter((g) => g.key.startsWith("p:"));
    expect(programs).toHaveLength(8);
    // System, explorer, olk, dwm and a–i are 13 programs: 8 rows and 5 more.
    expect(more?.name).toBe("5 more programs");
    expect(more?.processes).toHaveLength(5);
  });

  test("the pools are their own row, and the rest of what is committed is shared", () => {
    expect(holders.committed).toBe(GB(72));
    expect(holders.pools).toEqual({ paged: GB(3), nonpaged: GB(3.4) });
    const inProcesses = holders.groups.reduce((sum, g) => sum + g.commit, 0);
    expect(holders.shared).toBe(GB(72) - inProcesses - GB(3) - GB(3.4));
    expect(holders.shared).toBeGreaterThan(0);
    expect(holders.error).toBe("");
  });

  test("the pools are the Memory row's where typeperf gives them, and shared follows", () => {
    const row = withPools(holders, { poolPaged: GB(4), poolNonpaged: GB(2) });
    expect(row.pools).toEqual({ paged: GB(4), nonpaged: GB(2) });
    expect(row.shared).toBe(GB(72) - holders.inProcesses - GB(4) - GB(2));
    expect(row.groups).toBe(holders.groups);
    // Without both counters the list keeps its own read.
    expect(withPools(holders, { poolPaged: GB(4), poolNonpaged: null })).toBe(holders);
    expect(withPools(holders, null)).toBe(holders);
    // An unreadable list has no shared row, whatever the pools.
    const broken = holdersOf("listerr|denied", HOST);
    expect(withPools(broken, { poolPaged: GB(4), poolNonpaged: GB(2) }).shared).toBeNull();
  });

  test("what is shared never goes below 0 when the processes add up past the total", () => {
    const over = MACHINE.replace(/^memory\|.*$/m, `memory|${GB(40)}|${GB(3)}|${GB(3.4)}`);
    expect(holdersOf(over, HOST).shared).toBe(0);
  });

  test("without the memory counters there is no pools or shared row, and the groups stay", () => {
    const none = MACHINE.replace(/^memory\|.*$/m, "memerr|Invalid class");
    const read = holdersOf(none, HOST);
    expect(read).toMatchObject({ committed: null, pools: null, shared: null, error: "" });
    expect(read.groups.length).toBeGreaterThan(0);
  });

  test("with no WSL VM there is no WSL row", () => {
    const noWsl = MACHINE.split("\r\n")
      .filter((l) => !l.includes("vmmemWSL"))
      .join("\r\n");
    expect(group(noWsl, "wsl")).toBeUndefined();
  });

  test("a host inside WSL has no host row, and a WebView2 is no longer known to be prifly's", () => {
    expect(group(MACHINE, "host", null)).toBeUndefined();
    // The installed app is still told by where it runs from.
    expect(group(MACHINE, "window", null)?.commit).toBe(GB(0.01) + GB(0.3) + GB(0.5));
    expect(group(MACHINE, "webview2", null)?.commit).toBe(GB(2.1) + GB(1.2) + GB(0.4));
    // Dictation is a bun program then, and the sessions' claude still theirs.
    expect(group(MACHINE, "claude", null)?.commit).toBe(10 * GB(0.46) + GB(0.01));
  });

  test("a process that ended between the reads counts what it still had, and one with nothing is left out", () => {
    const out = [
      `memory|${GB(10)}|${GB(1)}|${GB(1)}`,
      // Gone from Get-Process before Win32_Process listed it: no commit.
      "200|4|639000000000000000|dwm.exe|0|1048576||0||dwm.exe",
      // Gone with no figures at all.
      "201|4|639000000000000000|ghost.exe||||||",
      line(202, 4, "dwm.exe", 1, 0.5),
    ].join("\r\n");
    const dwm = group(out, "p:dwm", null);
    expect(dwm).toMatchObject({ commit: GB(1), ram: GB(0.5) + 1048576 });
    expect(dwm?.processes).toHaveLength(2);
    expect(group(out, "p:ghost", null)).toBeUndefined();
  });

  test("an unreadable process list says so, with Windows' words", () => {
    const out = `c|bun|% processor time|5\r\nmemory|1|0|0\r\nlisterr|Access denied\r\n`;
    expect(holdersOf(out, HOST)).toMatchObject({
      groups: [],
      error: "Windows' process list could not be read: Access denied",
    });
    expect(holdersOf("", HOST).error).toBe("Windows' process list could not be read.");
  });
});

test("a test run is bun test, a package script's test, node --test or a test runner", () => {
  expect(isTestRun(["C:\\p\\bun.exe", "test", "x.test.ts"])).toBe(true);
  expect(isTestRun(["npm.cmd", "run", "test"])).toBe(true);
  expect(isTestRun(["node", "--test"])).toBe(true);
  expect(isTestRun(["node", "C:\\r\\node_modules\\vitest\\vitest.mjs", "run"])).toBe(true);
  expect(isTestRun(["bun", "x", "tsc"])).toBe(false);
  expect(isTestRun(["python", "test"])).toBe(false);
});
