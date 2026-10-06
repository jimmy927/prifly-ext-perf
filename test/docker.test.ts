import { describe, expect, test } from "bun:test";
import { averageContainers } from "../average";
import { type ContainerSnapshot, infoOf, memoryStat, ownerOf, parseCpuStat } from "../docker";
import type { McpConfig } from "../mcp";
import { priflyReport } from "../prifly";
import type { Proc } from "../procs";

const A = "d0dae39b-ff13-4747-b5a0-7e291a038689";
const B = "2c003443-2f11-4c38-9f7b-75985a415898";
const C = "2e62fdbc-c69b-48d6-aae2-82f4be891b78";
const sessions = [
  { id: A, title: "odi-46", cwd: "/home/j/src/odi.worktrees/odi-46", state: "working" },
  { id: B, title: "odi-47", cwd: "/home/j/src/odi.worktrees/odi-47", state: "waiting" },
  // Two sessions in the main checkout: a stack there is neither's.
  { id: C, title: "main-a", cwd: "/home/j/src/odi", state: "idle" },
  { id: "c2", title: "main-b", cwd: "/home/j/src/odi", state: "idle" },
];

describe("cgroup files", () => {
  test("cpu.stat gives the microseconds used", () => {
    expect(parseCpuStat("usage_usec 759950221\nuser_usec 453079323\n")).toBe(759950221);
  });

  test("memory.stat gives a field in bytes", () => {
    expect(memoryStat("anon 100\ninactive_file 4096\nactive_file 9\n", "inactive_file")).toBe(4096);
  });
});

describe("what a container is", () => {
  test("Docker Desktop's binds are read from its labels, not its own mount paths", () => {
    const info = infoOf({
      Id: "e90eb98c3e5e".padEnd(64, "0"),
      Names: ["/odi46-outlook-selector-test"],
      Labels: {
        "desktop.docker.io/binds/0/Source": `/tmp/claude-1000/-home-j-src-odi/${A}/scratchpad/x.py`,
        "desktop.docker.io/binds/0/Target": "/code/x.py",
      },
      Mounts: [{ Source: "/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/1ee1" }],
    });
    expect(info).toEqual({
      name: "odi46-outlook-selector-test",
      paths: [`/tmp/claude-1000/-home-j-src-odi/${A}/scratchpad/x.py`],
    });
  });

  test("a compose project's folder and files count as its paths", () => {
    const info = infoOf({
      Id: "f".repeat(64),
      Names: ["/threadhawk-postgres"],
      Labels: {
        "com.docker.compose.project.working_dir": "/home/j/src/threadhawk/infra",
        "com.docker.compose.project.config_files": "/home/j/src/threadhawk/infra/a.yml,/x/b.yml",
      },
      Mounts: [{ Source: "/var/lib/docker/volumes/pg/_data" }],
    });
    expect(info.paths).toEqual([
      "/home/j/src/threadhawk/infra",
      "/home/j/src/threadhawk/infra/a.yml",
      "/x/b.yml",
      "/var/lib/docker/volumes/pg/_data",
    ]);
  });
});

describe("whose a container is", () => {
  const info = (...paths: string[]) => ({ name: "c", paths });

  test("a mounted scratchpad names its session, wherever else it mounts", () => {
    const paths = ["/home/j/src/odi/x.py", `/tmp/claude-1000/-home-j-src-odi/${A}/scratchpad/y`];
    expect(ownerOf(info(...paths), sessions)).toBe(A);
  });

  test("a scratchpad of a session the host does not know names no one", () => {
    const other = "00000000-0000-0000-0000-000000000000";
    expect(ownerOf(info(`/tmp/claude-1000/p/${other}/scratchpad`), sessions)).toBe("");
  });

  test("a path inside one session's folder is that session's", () => {
    expect(ownerOf(info("/home/j/src/odi.worktrees/odi-47/docker"), sessions)).toBe(B);
  });

  test("a folder that only starts with a session's folder's name is not inside it", () => {
    expect(ownerOf(info("/home/j/src/odi.worktrees/odi-470"), sessions)).toBe("");
  });

  test("a folder several sessions share is none of theirs", () => {
    expect(ownerOf(info("/home/j/src/odi/composeexample"), sessions)).toBe("");
  });

  test("a container with no paths of ours is no one's", () => {
    expect(ownerOf(info("/var/lib/docker/volumes/pg/_data"), sessions)).toBe("");
  });
});

describe("containers over a window", () => {
  const id = "a".repeat(64);
  const snap = (second: number, usage: number): ContainerSnapshot => ({
    at: 1_000_000 + second * 1000,
    containers: new Map([[id, { id, usage, memory: 2 ** 30 }]]),
  });
  const ring = [snap(0, 0), snap(1, 500_000), snap(2, 3_000_000)];
  const infos = new Map([[id, { name: "bot", paths: [] }]]);

  test("CPU is the cgroup's microseconds over the window, in cores", () => {
    const [one] = averageContainers(ring, 2, infos, () => A);
    expect(one).toEqual({
      id,
      name: "bot",
      cpu: 1.5,
      memory: 2 ** 30,
      session: A,
    });
  });

  test("one Docker has not named yet goes by its short id", () => {
    expect(averageContainers(ring, 2, new Map(), () => "")[0]?.name).toBe("a".repeat(12));
  });
});

test("a session's containers count in its row, the rest beside prifly", () => {
  const relay: Proc = {
    pid: 10,
    ppid: 1,
    comm: "bun",
    argv: ["bun", "/p/relay/relay.ts", "/r", A],
    rss: 0,
    cpu: 0,
    read: 0,
    write: 0,
  };
  const container = (name: string, session: string) => ({
    id: name,
    name,
    cpu: 2,
    memory: 100,
    session,
  });
  const config = { forFolder: () => [] } as unknown as McpConfig;
  const report = priflyReport([relay], 999, sessions, config, [
    container("bot", A),
    container("postgres", ""),
    // Its session runs no relay here: not one of prifly's.
    container("stale", B),
  ]);
  const [row] = report.sessions;
  expect(row?.containers).toEqual(["bot"]);
  expect(row?.cpu).toBe(2);
  expect(report.kinds.containers).toEqual({ processes: 0, rss: 100, cpu: 2, read: 0, write: 0 });
  expect(report.otherContainers.cpu).toBe(4);
  expect(report.containerCount).toEqual({ sessions: 1, other: 2 });
  expect(report.total.cpu).toBe(2);
});
