import { describe, expect, test } from "bun:test";
import { type Holder, type Holders, withPools } from "../holders";
import { type MemoryMapInput, memoryMap, type Tile } from "../memory-map";
import { COUNTERS, type Field, type WindowsCounters } from "../windows";
import type { PoolTag } from "../windows-memory";

/** `gb` gigabytes, in whole MiB so that sums are exact. */
const GB = (gb: number) => Math.round(gb * 1024) * 2 ** 20;

const none = Object.fromEntries(Object.keys(COUNTERS).map((f) => [f, null])) as Record<Field, null>;

/** The laptop on 2026-10-30, roughly: 48 GB of RAM, a 75 GB limit, 70 GB committed. */
const COUNTED: WindowsCounters = {
  ...none,
  at: 0,
  availableMB: 9 * 1024,
  committedBytes: GB(70),
  commitLimit: GB(75),
  poolPaged: GB(4),
  poolNonpaged: GB(1),
  poolPagedResident: GB(3),
  wslVmMem: GB(10),
  standbyCore: GB(0.5),
  standbyNormal: GB(6.5),
  standbyReserve: GB(1.5),
  free: GB(0.5),
  modified: GB(0.25),
  cacheResident: GB(0.75),
};

const INFO = { name: "JIMMY-ROG", cores: 16, memTotal: GB(48) };

const group = (key: string, name: string, commit: number, ram: number, count = 1): Holder => ({
  key,
  name,
  commit: GB(commit),
  ram: GB(ram),
  processes: Array.from({ length: count }, (_, i) => ({
    pid: i + 1,
    name,
    commit: GB(commit) / count,
    ram: GB(ram) / count,
  })),
});

const GROUPS = [
  group("wsl", "WSL VM", 24, 10),
  group("dictation", "Dictation workers", 4.5, 0.75, 2),
  group("claude", "Claude sessions", 3.5, 1.5, 8),
  group("host", "prifly host", 3, 1.25),
  group("window", "prifly's window", 2.5, 2.5, 3),
  group("chrome", "Chrome", 4.5, 3.5, 26),
  group("webview2", "WebView2", 2.5, 1.5, 29),
  group("p:dwm", "dwm", 1.75, 1),
  group("p:memory compression", "Memory Compression", 0, 4.5),
  group("more", "30 more programs", 8.5, 8.5, 300),
];

/** The process list's read, given the counters' pools as the status does. */
function holdersOf(groups: Holder[], committed = COUNTED.committedBytes): Holders {
  const inProcesses = groups.reduce((s, g) => s + g.commit, 0);
  const read = { groups, committed, pools: null, inProcesses, shared: null, error: "" };
  return withPools(read, COUNTED);
}

const TOKE: PoolTag = { tag: "Toke", pool: "paged", bytes: GB(1.5), live: 737000, meaning: "x" };
const TAGS: PoolTag[] = [
  TOKE,
  { tag: "EtwD", pool: "paged", bytes: GB(0.25), live: 10, meaning: "" },
  { tag: "Big1", pool: "nonpaged", bytes: GB(0.75), live: 10, meaning: "" },
];

const input = (over: Partial<MemoryMapInput> = {}): MemoryMapInput => ({
  counters: COUNTED,
  info: INFO,
  holders: holdersOf(GROUPS),
  tags: TAGS,
  compressed: GB(4.5),
  ...over,
});

const total = (tiles: Tile[]) => tiles.reduce((s, t) => s + t.value, 0);
const keys = (tiles: Tile[]) => tiles.map((t) => t.key);
const find = (tiles: Tile[], key: string) => tiles.find((t) => t.key === key);
const every = (tiles: Tile[]): Tile[] => tiles.flatMap((t) => [t, ...every(t.children ?? [])]);

/** The map of `over`, failing the test where it is null. */
function mapOf(over: Partial<MemoryMapInput> = {}) {
  const map = memoryMap(input(over));
  if (map === null) throw new Error("no map");
  return map;
}

describe("the promised view", () => {
  test("adds up to the commit limit: committed, then what is still free to promise", () => {
    const map = mapOf();
    expect(total(map.commit)).toBe(GB(75));
    expect(find(map.commit, "headroom")?.value).toBe(GB(5));
    expect(keys(map.commit)).toContain("shared");
  });

  test("a group's value is its children's, and the WSL VM shows what of it is in RAM", () => {
    const map = mapOf();
    const prifly = find(map.commit, "prifly");
    expect(prifly?.value).toBe(GB(13.5));
    expect(prifly?.children?.map((c) => c.name)).toEqual([
      "Dictation worker ×2",
      "Claude sessions ×8",
      "Host and helpers",
      "Window (WebView2) ×3",
    ]);
    expect(find(map.commit, "wsl")?.ram).toBe(GB(10));
    expect(find(map.commit, "chrome")?.name).toBe("Chrome ×26");
  });

  test("the compression store's process is no program", () => {
    const names = every(mapOf().commit).map((t) => t.name);
    expect(names.some((n) => /Memory Compression/.test(n))).toBe(false);
  });

  test("the paged pool's big tag has a tile of its own, the rest of the pool another", () => {
    const pools = find(mapOf().commit, "pools");
    expect(pools?.value).toBe(GB(5));
    expect(pools?.ram).toBe(GB(4));
    expect(pools?.children?.map((c) => [c.key, c.value])).toEqual([
      ["tag:Toke", GB(1.5)],
      ["paged", GB(2.5)],
      ["nonpaged", GB(1)],
    ]);
  });

  test("shared memory and the headroom are never below 0, and then have no tile", () => {
    const over = { ...COUNTED, committedBytes: GB(80) };
    // Processes alone hold more than Windows says is committed.
    const map = mapOf({ counters: over, holders: holdersOf(GROUPS, GB(50)) });
    expect(keys(map.commit)).not.toContain("shared");
    expect(keys(map.commit)).not.toContain("headroom");
    expect(keys(map.commit)).toContain("wsl");
  });
});

describe("the RAM view", () => {
  test("adds up to RAM, the programs scaled down to what is left of RAM in use", () => {
    const map = mapOf();
    expect(total(map.ram)).toBe(GB(48));
    // In use outside the programs: 10 VM + 4.5 store + 4 pools + 0.75 cache + 0.25 modified.
    const left = GB(48) - GB(9) - GB(19.5);
    const programs = find(map.ram, "progs");
    expect(programs?.value).toBeCloseTo(left, 0);
    // Their working sets add up to 20.5 GB, more than the 19.5 GB left: scaled down.
    expect(map.scale).toBeCloseTo(left / GB(20.5), 6);
    const prifly = find(programs?.children ?? [], "ram:prifly");
    expect(prifly?.value).toBeCloseTo(GB(6) * (map.scale ?? 0), 0);
    expect(total(prifly?.children ?? [])).toBeCloseTo(prifly?.value ?? 0, 0);
    expect(programs?.why).toMatch(/scaled to \d+ %/);
  });

  test("standby and free are what Windows counts as available", () => {
    const map = mapOf();
    expect(find(map.ram, "standby")?.value).toBe(GB(8.5));
    expect(find(map.ram, "free")?.value).toBe(GB(0.5));
    expect(find(map.ram, "store")?.value).toBe(GB(4.5));
  });

  test("programs that fit are not scaled up: the rest of RAM in use gets its own tile", () => {
    const small = [group("wsl", "WSL VM", 24, 10), group("chrome", "Chrome", 2, 1)];
    const map = mapOf({ holders: holdersOf(small) });
    expect(map.scale).toBe(1);
    expect(find(map.ram, "progs")?.value).toBe(GB(1));
    expect(find(map.ram, "ram:rest")?.value).toBe(GB(19.5) - GB(1));
    expect(total(map.ram)).toBe(GB(48));
  });
});

describe("what is missing", () => {
  test("no map before the counters, or Windows' own info, are read", () => {
    expect(memoryMap(input({ counters: null }))).toBeNull();
    expect(memoryMap(input({ info: null }))).toBeNull();
  });

  test("a missing counter leaves its tile out, never a 0 or NaN", () => {
    const counters = {
      ...COUNTED,
      standbyNormal: null,
      cacheResident: null,
      poolPagedResident: null,
    };
    const map = mapOf({ counters });
    expect(keys(map.ram)).not.toContain("standby");
    expect(keys(map.ram)).not.toContain("cache");
    expect(keys(map.ram)).not.toContain("poolram");
    expect(find(map.commit, "pools")?.ram).toBeUndefined();
    for (const t of [...every(map.ram), ...every(map.commit)]) {
      expect(Number.isFinite(t.value)).toBe(true);
      expect(t.value).toBeGreaterThan(0);
    }
    // Without standby, what is in use comes from Windows' available memory.
    expect(map.scale).not.toBeNull();
  });

  test("no limit: no headroom, and the header has none to give", () => {
    const map = mapOf({ counters: { ...COUNTED, commitLimit: null } });
    expect(map.limit).toBeNull();
    expect(keys(map.commit)).not.toContain("headroom");
  });

  test("no WSL: no VM tile in either view", () => {
    const map = mapOf({
      counters: { ...COUNTED, wslVmMem: null },
      holders: holdersOf(GROUPS.filter((g) => g.key !== "wsl")),
    });
    expect(keys(map.commit)).not.toContain("wsl");
    expect(keys(map.ram)).not.toContain("wslram");
    expect(total(map.ram)).toBe(GB(48));
  });

  test("before the process list is read the programs are one tile, with a note", () => {
    const map = mapOf({ holders: null });
    expect(map.note).toMatch(/Reading Windows' process list/);
    expect(find(map.commit, "programs")?.value).toBe(GB(70) - GB(5));
    expect(total(map.commit)).toBe(GB(75));
    expect(find(map.ram, "ram:programs")?.value).toBe(GB(48) - GB(9) - GB(19.5));
    expect(map.scale).toBeNull();
  });

  test("an unreadable process list still shows what the counters give, and why", () => {
    const failed: Holders = {
      groups: [],
      committed: null,
      pools: null,
      shared: null,
      inProcesses: 0,
      error: "Windows' process list could not be read: timed out",
    };
    const map = mapOf({ holders: failed, compressed: null });
    expect(map.note).toBe(
      "Windows' process list could not be read: timed out Programs are one tile.",
    );
    expect(keys(map.commit)).toEqual(["programs", "pools", "headroom"]);
    expect(keys(map.ram)).not.toContain("store");
    expect(keys(map.ram)).toContain("wslram");
    expect(total(map.ram)).toBe(GB(48));
  });
});
