import { describe, expect, test } from "bun:test";
import type { Container } from "../docker";
import type { McpConfig } from "../mcp";
import type { Tile } from "../memory-map";
import { type Kind, priflyReport, type SessionRow } from "../prifly";
import type { Proc } from "../procs";
import { inVmOf, splitWsl, splitWslRam, type VmLinux, wslParts } from "../wsl-map";

const GIB = 2 ** 30;
const gib = (n: number | undefined) => Math.round(((n ?? 0) / GIB) * 100) / 100;
const total = (tiles: readonly Tile[] | undefined) =>
  (tiles ?? []).reduce((s, t) => s + t.value, 0);
const find = (tiles: readonly Tile[] | undefined, key: string): Tile | undefined => {
  for (const t of tiles ?? []) {
    if (t.key === key) return t;
    const inner = find(t.children, key);
    if (inner !== undefined) return inner;
  }
  return undefined;
};
const every = (tiles: readonly Tile[]): Tile[] =>
  tiles.flatMap((t) => [t, ...every(t.children ?? [])]);

let next = 100;
const proc = (rss: number, comm = "x"): Proc => {
  next += 1;
  return { pid: next, ppid: 1, comm, argv: [comm], rss, cpu: 0, read: 0, write: 0 };
};

const SESSION = "11111111-2222-3333-4444-555555555555";
const UNTITLED = "99999999-2222-3333-4444-555555555555";
const row = (id: string, title: string, cwd: string): SessionRow => ({
  id,
  title,
  cwd,
  state: "working",
  processes: 0,
  rss: 0,
  cpu: 0,
  read: 0,
  write: 0,
  mcp: [],
  doing: "",
  containers: [],
});
const SESSIONS = [
  row(SESSION, "skapa-mojlighet-att-bygga-en-candidate", "/home/j/src/odi.worktrees/skapa"),
  // A session with no title: the report names it by its id's first 8.
  row(UNTITLED, "99999999", "/home/j/src/odi.worktrees/fix-login"),
];
const container = (id: string, name: string, session: string, anon: number, service?: string) =>
  ({ id, name, cpu: 0, memory: anon, anon, session, ...(service ? { service } : {}) }) as Container;

/** Measured live on 2026-10-30: 26 claude, 4.9 GB RSS, 4.0 GB PSS; the agent and relays 0.7 GB. */
const CLAUDES = Array.from({ length: 26 }, () => proc((4.9 * GIB) / 26, "claude"));
const PSS = new Map(CLAUDES.map((p) => [p.pid, (4.0 * GIB) / 26]));
const AGENT = proc(0.3 * GIB, "prifly-agent");
const RELAYS = Array.from({ length: 4 }, () => proc(0.1 * GIB, "prifly-agent"));
const MCP = proc(0.2 * GIB, "node");
const TOOLS = [proc(0.25 * GIB, "pytest"), proc(0.05 * GIB, "zsh")];
const STRANGER = proc(1 * GIB, "sshd");
const PROCS = [...CLAUDES, AGENT, ...RELAYS, MCP, ...TOOLS, STRANGER];
const KINDS = new Map<number, Kind>([
  ...CLAUDES.map((p) => [p.pid, "claude"] as [number, Kind]),
  [AGENT.pid, "host"],
  ...RELAYS.map((p) => [p.pid, "relay"] as [number, Kind]),
  [MCP.pid, "mcp"],
  ...TOOLS.map((p) => [p.pid, "tools"] as [number, Kind]),
]);
const CONTAINERS = [
  container("a".repeat(64), "odi-elasticsearch-1", SESSION, 4.55 * GIB, "elasticsearch"),
  container("b".repeat(64), "odi-redis-1", UNTITLED, 0.1 * GIB, "redis"),
  container("c".repeat(64), "loki", "", 0.2 * GIB),
];

describe("prifly sessions, split by what they run", () => {
  const vm = inVmOf(PROCS, KINDS, PSS, CONTAINERS, SESSIONS);

  test("a container a session started is named by its service and its session", () => {
    const es = find(vm.prifly, `wsl:prifly:c:${"a".repeat(12)}`);
    expect(es?.name).toBe("elasticsearch · skapa-mojlighet-att-bygga-en-candidate");
    expect(gib(es?.value)).toBe(4.55);
    expect(es?.why).toMatch(/odi-elasticsearch-1/);
  });

  test("a container whose session has no title is named by its folder", () => {
    expect(find(vm.prifly, `wsl:prifly:c:${"b".repeat(12)}`)?.name).toBe("redis · fix-login");
  });

  test("a container no session started is Docker's, not prifly's", () => {
    expect(gib(vm.docker)).toBe(0.2);
    expect(vm.prifly.map((t) => t.name).join()).not.toMatch(/loki/);
  });

  test("the claude processes count by PSS, and the tile says what RSS was", () => {
    const claude = find(vm.prifly, "wsl:prifly:claude");
    expect(claude?.name).toBe("claude ×26");
    expect(gib(claude?.value)).toBe(4);
    expect(claude?.why).toMatch(/4\.9 GB counted per process \(RSS\), 4\.0 GB once/);
  });

  test("the agent and relays, the MCP servers and the tools are a tile each", () => {
    expect(gib(find(vm.prifly, "wsl:prifly:agent")?.value)).toBe(0.7);
    expect(find(vm.prifly, "wsl:prifly:mcp")?.name).toBe("MCP servers");
    expect(find(vm.prifly, "wsl:prifly:tools")?.name).toBe("Session tools ×2");
    expect(gib(find(vm.prifly, "wsl:prifly:tools")?.value)).toBe(0.3);
  });

  test("what the report did not count is in no tile", () => {
    // 4.55 + 0.1 + 4.0 + 0.7 + 0.2 + 0.3: the sshd's 1 GB is not among them.
    expect(gib(total(vm.prifly))).toBe(9.85);
  });

  test("no smaps_rollup read: RSS, and the claude tile says so", () => {
    const claude = find(
      inVmOf(PROCS, KINDS, new Map(), CONTAINERS, SESSIONS).prifly,
      "wsl:prifly:claude",
    );
    expect(gib(claude?.value)).toBe(4.9);
    expect(claude?.why).toMatch(
      /counted per process \(RSS\): \/proc\/<pid>\/smaps_rollup could not be read/,
    );
  });

  test("smaps_rollup read for some: those by PSS, the rest by RSS, and the tile says how many", () => {
    const some = new Map([...PSS].slice(0, 13));
    const claude = find(
      inVmOf(PROCS, KINDS, some, CONTAINERS, SESSIONS).prifly,
      "wsl:prifly:claude",
    );
    expect(gib(claude?.value)).toBe(4.45);
    expect(claude?.why).toMatch(/13 of them count per process \(RSS\)/);
  });

  test("before the process table is read there is nothing to split", () => {
    expect(inVmOf([], new Map(), new Map(), [], [])).toEqual({ prifly: [], docker: 0 });
  });

  test("the report says which kind it counted each process as", () => {
    let pid = 5000;
    const p = (ppid: number, argv: string[]): Proc => {
      pid += 1;
      return { pid, ppid, comm: argv[0] ?? "", argv, rss: 1, cpu: 0, read: 0, write: 0 };
    };
    const agent = p(1, ["prifly-agent", "--port", "1", "--relay-dir", "/r"]);
    const relay = p(agent.pid, ["prifly-agent", "relay", "/r", SESSION]);
    const claude = p(relay.pid, ["claude"]);
    const shell = p(claude.pid, ["zsh", "-c", "pytest"]);
    const kinds = new Map<number, Kind>();
    const config = { forFolder: () => [] } as unknown as McpConfig;
    priflyReport([agent, relay, claude, shell], null, [], config, [], null, kinds);
    expect(Object.fromEntries(kinds)).toEqual({
      [agent.pid]: "host",
      [relay.pid]: "relay",
      [claude.pid]: "claude",
      [shell.pid]: "tools",
    });
  });
});

/** /proc/meminfo in the VM, measured live on 2026-10-30 (GiB). */
const MEMINFO = {
  memFree: 0.41 * GIB,
  buffers: 6.34 * GIB,
  cached: 4.21 * GIB,
  shmem: 0.02 * GIB,
  anonPages: 12 * GIB,
  slab: 1.55 * GIB,
  sReclaimable: 1.3 * GIB,
  sUnreclaim: 0.25 * GIB,
  vmallocUsed: 0.11 * GIB,
  pageTables: 0.07 * GIB,
  kernelStack: 0.025 * GIB,
};
/** MemTotal leaves 1.11 GiB unaccounted beside slab, page tables and stacks: 1.0 once vmalloc is named. */
const LINUX: VmLinux = { memTotal: (10.53 + 12.02 + 1.645 + 1.11 + 0.41) * GIB, meminfo: MEMINFO };

describe("the Linux kernel, split by what /proc/meminfo names", () => {
  const kernel = find(wslParts(LINUX, null, null), "wsl:kernel");

  test("caches, the kernel itself and what Linux does not name", () => {
    expect(kernel?.children?.map((t) => [t.key, t.name, gib(t.value)])).toEqual([
      ["wsl:kernel:caches", "Kernel caches", 1.3],
      // SUnreclaim + VmallocUsed + PageTables + KernelStack.
      ["wsl:kernel:self", "Kernel itself", 0.46],
      ["wsl:kernel:unaccounted", "Not accounted by Linux", 1],
    ]);
    expect(kernel?.value).toBeCloseTo(total(kernel?.children), 0);
    // 1.645 for slab, page tables and stacks, and the 1.11 MemTotal leaves: as one tile it had.
    expect(kernel?.value).toBeCloseTo(2.755 * GIB, -6);
    expect(find(kernel?.children, "wsl:kernel:unaccounted")?.why).toMatch(/Hyper-V/);
  });

  test("a missing field leaves its child out, and the rest is not called unaccounted", () => {
    const parts = wslParts(
      { ...LINUX, meminfo: { ...MEMINFO, sReclaimable: Number.NaN } },
      null,
      null,
    );
    const k = find(parts, "wsl:kernel");
    expect(k?.children?.map((t) => t.key)).toEqual(["wsl:kernel:self", "wsl:kernel:rest"]);
    for (const t of every(parts)) {
      expect(Number.isFinite(t.value)).toBe(true);
      expect(t.value).toBeGreaterThan(0);
    }
    expect(k?.value).toBeCloseTo(total(k?.children), 0);
  });

  test("none of the fields read: the kernel stays one tile", () => {
    const meminfo = {
      ...MEMINFO,
      sReclaimable: Number.NaN,
      sUnreclaim: Number.NaN,
      vmallocUsed: Number.NaN,
    };
    const k = find(
      wslParts(
        { ...LINUX, meminfo: { ...meminfo, pageTables: Number.NaN, kernelStack: Number.NaN } },
        null,
        null,
      ),
      "wsl:kernel",
    );
    expect(k?.children).toBeUndefined();
    expect(k?.value).toBeGreaterThan(0);
  });

  test("the fields over what the kernel's tile held: the remainder is left out, not below 0", () => {
    const tight: VmLinux = { ...LINUX, memTotal: LINUX.memTotal - 1.11 * GIB };
    const k = find(wslParts(tight, null, null), "wsl:kernel");
    expect(k?.children?.map((t) => t.key)).toEqual(["wsl:kernel:caches", "wsl:kernel:self"]);
    expect(gib(k?.value)).toBe(1.76);
  });
});

describe("the groups in the WSL VM's tile", () => {
  const inVm = inVmOf(PROCS, KINDS, PSS, CONTAINERS, SESSIONS);
  const VM: Tile = {
    key: "wsl",
    name: "WSL VM",
    colour: "k-wsl",
    value: 24 * GIB,
    ram: 8 * GIB,
    why: "",
  };

  test("promised: prifly's group is the sum of its children, all at the VM's in-RAM share", () => {
    const wsl = splitWsl(VM, LINUX, inVm);
    const prifly = find(wsl.children, "wsl:prifly");
    expect(prifly?.name).toBe("prifly sessions");
    expect(prifly?.value).toBeCloseTo(total(prifly?.children), 0);
    expect(total(wsl.children)).toBeCloseTo(24 * GIB, -3);
    for (const t of every(wsl.children ?? [])) expect(t.ram).toBeCloseTo((t.value * 8) / 24, -3);
  });

  test("in RAM: the groups' children get the RAM view's keys", () => {
    const wsl = splitWslRam({ ...VM, key: "wslram", value: 8 * GIB }, LINUX, inVm, 24 * GIB);
    expect(find(wsl.children, "ram:wsl:prifly:claude")).toBeDefined();
    expect(find(wsl.children, "ram:wsl:kernel:caches")).toBeDefined();
    expect(total(wsl.children)).toBeCloseTo(8 * GIB, -3);
  });

  test("prifly counted over what Linux says programs hold: capped, its children with it", () => {
    const small: VmLinux = { ...LINUX, meminfo: { ...MEMINFO, anonPages: 5 * GIB } };
    const prifly = find(wslParts(small, inVm, null), "wsl:prifly");
    expect(gib(prifly?.value)).toBe(5.02);
    expect(prifly?.value).toBeCloseTo(total(prifly?.children), 0);
  });

  test("before the process table is read: no prifly or container children", () => {
    const parts = wslParts(LINUX, null, null);
    expect(find(parts, "wsl:prifly")).toBeUndefined();
    expect(find(parts, "wsl:programs")).toBeDefined();
  });
});
