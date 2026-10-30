// The Memory tab's treemap: Windows' memory as two trees of tiles, each tile
// as big as what it holds. One is what Windows has promised (commit charge
// against its limit, which is what runs out); the other is what sits in RAM
// now. The programs come from who holds Windows' memory (`holders.ts`), the
// kernel pools' biggest tags from `poolTags`, the rest from typeperf.
//
// A counter Windows did not give leaves its tile out: never a 0 that looks read.

import type { Holder, Holders } from "./holders";
import type { WindowsCounters, WindowsInfo } from "./windows";
import type { PoolTag } from "./windows-memory";

/**
 * One tile: its colour class on the panel (`k-…`), its bytes, and in the
 * promised view what of it is in RAM (its working set; absent where no
 * counter says). `why` is a sentence on what it is.
 */
export type Tile = {
  key: string;
  name: string;
  colour: string;
  value: number;
  ram?: number;
  why: string;
  children?: Tile[];
};

/**
 * Both views, with the totals their headers give. `scale` is what the
 * programs' working sets were multiplied by to fit RAM in use (they count a
 * page several programs share once for each), 1 where they fitted; null where
 * RAM in use is not known. `note` says what is missing, "" when nothing is.
 */
export type MemoryMap = {
  limit: number | null;
  committed: number | null;
  ramTotal: number;
  available: number | null;
  commit: Tile[];
  ram: Tile[];
  scale: number | null;
  note: string;
};

export type MemoryMapInput = {
  /** typeperf's counters, averaged over the page's window. */
  counters: WindowsCounters | null;
  info: WindowsInfo | null;
  /** With the counters' pools (`withPools`); null until the process list is first read. */
  holders: Holders | null;
  /** The biggest pool tags; null until read, or where they cannot be. */
  tags: PoolTag[] | null;
  /** The `Memory Compression` process's working set: the compression store in RAM. */
  compressed: number | null;
};

/** A paged pool tag gets a tile of its own from this share of the paged pool. */
const TAG_SHARE = 1 / 8;
/** At most this many tags get a tile of their own. */
const TAGS_SHOWN = 3;

const PROGRAMS_WHY = "Programs' own memory: heaps, JavaScript objects, buffers.";

const WSL_WHY =
  "The Linux VM's memory. Windows charges the VM's whole size against the limit when it starts, " +
  "used or not: what Linux keeps free inside it is promised all the same. The striped part is the " +
  "VM's memory that is not in RAM: never touched, or trimmed out by Windows.";

const STORE_WHY =
  "RAM holding compressed copies of pages Windows trimmed out of programs: much of the striped " +
  "part in the Promised view. Rather than write a trimmed page to the page file, Windows squeezes " +
  "it into this store, still in RAM; when the program touches the page again it is decompressed " +
  "back, a soft fault (the transition faults on the Machine tab). No counter gives how much " +
  "uncompressed memory it holds.";

/** prifly's parts, by holder group: the key and name of the tile each goes in, in this order. */
const PRIFLY_PARTS: [string, string, string[]][] = [
  ["dictation", "Dictation worker", ["dictation"]],
  ["claude", "Claude sessions", ["claude"]],
  ["host", "Host and helpers", ["host", "intent", "agent"]],
  ["window", "Window (WebView2)", ["window"]],
  ["bun", "Other bun", ["tests", "p:bun"]],
];

/** The programs with a tile of their own beside prifly. */
const PROGRAM_TILES: [string, string, string, string, string][] = [
  ["chrome", "chrome", "Chrome", "k-chrome", PROGRAMS_WHY],
  ["webview2", "webview", "WebView2, other apps", "k-webview", PROGRAMS_WHY],
  ["p:dwm", "dwm", "Desktop compositor (dwm)", "k-dwm", "Windows' desktop window manager."],
];

/** The compression store's own process: the RAM view's compressed pages, not a program. */
const STORE_PROCESS = "p:memory compression";

/** A holder group's processes as a count after its name: "Chrome ×26". */
const counted = (name: string, count: number) => (count > 1 ? `${name} ×${count}` : name);

const sum = (tiles: readonly { value: number }[]) => tiles.reduce((s, t) => s + t.value, 0);

/** Several holder groups as one tile: their commit as its value, their working set as `ram`. */
function leaf(key: string, name: string, colour: string, why: string, groups: Holder[]): Tile {
  const count = groups.reduce((n, g) => n + g.processes.length, 0);
  return {
    key,
    name: counted(name, count),
    colour,
    value: groups.reduce((s, g) => s + g.commit, 0),
    ram: groups.reduce((s, g) => s + g.ram, 0),
    why,
  };
}

/** A group tile of `children`, whose value and `ram` are theirs added up. */
function parent(key: string, name: string, colour: string, why: string, children: Tile[]): Tile {
  return {
    key,
    name,
    colour,
    value: sum(children),
    ram: children.reduce((s, c) => s + (c.ram ?? 0), 0),
    why,
    children,
  };
}

/**
 * The programs as promised-view tiles: the WSL VM, prifly by part, Chrome,
 * WebView2, dwm, and every other program under one tile. A group with no
 * process holding anything has no tile.
 */
export function programTiles(holders: Holders): Tile[] {
  const byKey = new Map(holders.groups.map((g) => [g.key, g]));
  const used = new Set<string>([STORE_PROCESS]);
  const take = (keys: string[]) =>
    keys.flatMap((key) => {
      const group = byKey.get(key);
      if (group === undefined) return [];
      used.add(key);
      return [group];
    });
  const tiles: Tile[] = [];
  const wsl = take(["wsl"]);
  if (wsl.length > 0) tiles.push(leaf("wsl", "WSL VM", "k-containers", WSL_WHY, wsl));
  const prifly = PRIFLY_PARTS.flatMap(([key, name, keys]) => {
    const groups = take(keys);
    return groups.length === 0 ? [] : [leaf(key, name, "k-claude", PROGRAMS_WHY, groups)];
  });
  if (prifly.length > 0) {
    tiles.push(
      parent("prifly", "prifly", "k-claude", "Everything prifly runs on Windows.", prifly),
    );
  }
  for (const [group, key, name, colour, why] of PROGRAM_TILES) {
    const groups = take([group]);
    if (groups.length > 0) tiles.push(leaf(key, name, colour, why, groups));
  }
  const others = holders.groups.filter((g) => !used.has(g.key));
  if (others.length > 0) {
    const count = others.reduce((n, g) => n + g.processes.length, 0);
    const rest = others.map((g) => leaf(`other:${g.key}`, g.name, "k-shared", PROGRAMS_WHY, [g]));
    const why = "Every other Windows process, by program.";
    tiles.push(parent("other", counted("Other programs", count), "k-shared", why, rest));
  }
  return tiles;
}

/** The kernel pools' sizes: the counters', else the process list's own read. */
function poolSizes(c: WindowsCounters, holders: Holders | null) {
  return {
    paged: c.poolPaged ?? holders?.pools?.paged ?? null,
    nonpaged: c.poolNonpaged ?? holders?.pools?.nonpaged ?? null,
  };
}

/** The paged pool's biggest tags, each a tile of its own: those over `TAG_SHARE` of the pool. */
function tagTiles(tags: PoolTag[] | null, paged: number): Tile[] {
  return (tags ?? [])
    .filter((t) => t.pool === "paged" && t.bytes >= paged * TAG_SHARE)
    .slice(0, TAGS_SHOWN)
    .map((t) => ({
      key: `tag:${t.tag}`,
      name: t.meaning === "" ? t.tag : `${t.tag}: ${t.meaning.split(";")[0]}`,
      colour: "k-pool",
      value: t.bytes,
      why: `Pool tag ${t.tag}${t.meaning === "" ? "" : `, ${t.meaning}`}: ${t.live.toLocaleString("en")} allocations alive.`,
    }));
}

/**
 * The kernel pools, promised: the paged pool's biggest tags, the rest of the
 * paged pool, and the non-paged pool. In RAM: the paged pool's resident part
 * and all of the non-paged pool. Null where Windows gave no pool size.
 */
function poolTile(c: WindowsCounters, holders: Holders | null, tags: PoolTag[] | null) {
  const { paged, nonpaged } = poolSizes(c, holders);
  if (paged === null && nonpaged === null) return null;
  const children: Tile[] = [];
  if (paged !== null) {
    const named = tagTiles(tags, paged);
    children.push(...named, {
      key: "paged",
      name: named.length === 0 ? "Paged pool" : "Other paged pool",
      colour: "k-pool",
      value: Math.max(0, paged - sum(named)),
      why: "Kernel memory that may leave RAM: event tracing, file names, mapped-file tables and more.",
    });
  }
  if (nonpaged !== null) {
    children.push({
      key: "nonpaged",
      name: "Non-paged pool",
      colour: "k-pool",
      value: nonpaged,
      ram: nonpaged,
      why: "Kernel memory that never leaves RAM: network and driver buffers.",
    });
  }
  const resident =
    c.poolPagedResident === null || nonpaged === null ? undefined : c.poolPagedResident + nonpaged;
  const why =
    "Windows' own heaps for drivers and the kernel. A few hundred MB each is usual; gigabytes mean something leaks.";
  const value = sum(children);
  const tile: Tile = { key: "pools", name: "Kernel pools", colour: "k-pool", value, why, children };
  if (resident !== undefined) tile.ram = Math.min(resident, value);
  return tile;
}

const readable = (h: Holders | null): h is Holders =>
  h !== null && !(h.error !== "" && h.groups.length === 0);

/** Why the programs are one tile, or "" where they are not. */
function holdersNote(h: Holders | null): string {
  if (h === null) return "Reading Windows' process list: programs are one tile until then.";
  return h.error !== "" && h.groups.length === 0 ? `${h.error} Programs are one tile.` : "";
}

/** The promised view: who holds the commit charge, and what is still free to promise. */
function commitView(input: MemoryMapInput, c: WindowsCounters): Tile[] {
  const { holders, tags } = input;
  const pools = poolTile(c, holders, tags);
  const tiles: Tile[] = [];
  if (readable(holders)) {
    tiles.push(...programTiles(holders));
    if (holders.shared !== null) {
      tiles.push({
        key: "shared",
        name: "Shared memory and page tables",
        colour: "k-shared",
        value: holders.shared,
        why: "Committed, but in no process's own count and no pool: memory shared between processes (the GPU driver's, Chrome's) and the tables that map every process's memory.",
      });
    }
  } else if (c.committedBytes !== null) {
    tiles.push({
      key: "programs",
      name: "Programs and shared memory",
      colour: "k-shared",
      value: Math.max(0, c.committedBytes - (pools?.value ?? 0)),
      why: "Everything committed but the kernel pools: programs' own memory, the WSL VM, shared memory and page tables.",
    });
  }
  if (pools !== null) tiles.push(pools);
  if (c.committedBytes !== null && c.commitLimit !== null) {
    tiles.push({
      key: "headroom",
      name: "Still free to promise",
      colour: "k-headroom",
      value: Math.max(0, c.commitLimit - c.committedBytes),
      why: "What Windows can still hand out before it must grow the page file or refuse.",
    });
  }
  return tiles.filter((t) => t.value > 0);
}

/** A RAM-view tile from one reading, or none where the reading is missing. */
function reading(key: string, name: string, colour: string, value: number | null, why: string) {
  return value === null ? [] : [{ key, name, colour, value, why }];
}

/** Standby in its three priorities, added up; null unless all three were read. */
export function standbyOf(c: WindowsCounters): number | null {
  if (c.standbyCore === null || c.standbyNormal === null || c.standbyReserve === null) return null;
  return c.standbyCore + c.standbyNormal + c.standbyReserve;
}

/** The RAM view's fixed tiles: everything but the programs. */
function systemTiles(c: WindowsCounters, compressed: number | null): Tile[] {
  const pools =
    c.poolPagedResident === null || c.poolNonpaged === null
      ? null
      : c.poolPagedResident + c.poolNonpaged;
  return [
    ...reading(
      "wslram",
      "WSL VM",
      "k-containers",
      c.wslVmMem,
      "The part of the Linux VM's memory in RAM now.",
    ),
    ...reading("store", "Compressed pages", "k-store", compressed, STORE_WHY),
    ...reading(
      "poolram",
      "Kernel pools",
      "k-pool",
      pools,
      "The kernel pools' part in RAM: the paged pool's resident part and all of the non-paged pool.",
    ),
    ...reading(
      "cache",
      "File cache",
      "k-cache",
      c.cacheResident,
      "Files Windows is reading and writing, in use now.",
    ),
    ...reading(
      "modified",
      "Modified",
      "k-cache",
      c.modified,
      "Pages changed in RAM that must be written to disk (a file, or the page file) before the RAM can be reused.",
    ),
    ...reading(
      "standby",
      "Standby: cached, can be dropped",
      "k-cache",
      standbyOf(c),
      "Pages of files and of trimmed programs kept in case they are needed again. Windows drops them at once when a program wants RAM, so they count as available.",
    ),
    ...reading("free", "Free", "k-ramfree", c.free, "Empty RAM, zeroed or about to be."),
  ];
}

/**
 * What of RAM is left for the programs: RAM less what is idle (standby and
 * free, else what Windows counts as available) and less every other in-use
 * tile. Null where neither idle reading is there.
 */
function programBudget(c: WindowsCounters, ramTotal: number, system: Tile[]): number | null {
  const standby = standbyOf(c);
  const available = c.availableMB === null ? null : c.availableMB * 2 ** 20;
  const idle = standby !== null && c.free !== null ? standby + c.free : available;
  if (idle === null) return null;
  const inUse = sum(system.filter((t) => t.key !== "standby" && t.key !== "free"));
  return Math.max(0, ramTotal - idle - inUse);
}

/** A promised-view tile as its RAM-view twin: its working set, times `scale`, its children one level deep. */
function inRam(tile: Tile, scale: number): Tile {
  const { ram = 0, children, ...rest } = tile;
  const out: Tile = { ...rest, key: `ram:${tile.key}`, value: ram * scale };
  if (children !== undefined) {
    out.children = children.map(({ children: _, ...child }) => inRam(child, scale));
  }
  return out;
}

/**
 * The RAM view: the WSL VM, the programs, compressed pages, the pools, file
 * cache, modified, standby and free. The programs' working sets are scaled down
 * to what is left of RAM in use; any RAM left over after them has a tile.
 */
function ramView(input: MemoryMapInput, c: WindowsCounters, ramTotal: number) {
  const system = systemTiles(c, input.compressed);
  const budget = programBudget(c, ramTotal, system);
  const tiles = [...system];
  if (!readable(input.holders)) {
    if (budget !== null) {
      tiles.push({
        key: "ram:programs",
        name: "Programs and the rest",
        colour: "k-shared",
        value: budget,
        why: "RAM in use outside the other tiles: programs' working sets, drivers and page tables.",
      });
    }
    return { tiles: tiles.filter((t) => t.value > 0), scale: null };
  }
  const programs = programTiles(input.holders).filter((t) => t.key !== "wsl");
  const ws = programs.reduce((s, t) => s + (t.ram ?? 0), 0);
  const scale = budget === null ? null : ws <= 0 ? 1 : Math.min(1, budget / ws);
  const children = programs.map((t) => inRam(t, scale ?? 1));
  const group = parent("progs", "Windows programs", "k-claude", "", children);
  group.why =
    scale === null || scale >= 1
      ? "Programs' working sets: their memory in RAM."
      : `Programs' working sets: their memory in RAM, scaled to ${Math.round(scale * 100)} % so that pages several programs share count once.`;
  delete group.ram;
  tiles.push(group);
  const left = budget === null ? 0 : budget - group.value;
  if (left > 0) {
    tiles.push({
      key: "ram:rest",
      name: "Drivers, page tables and the rest",
      colour: "k-shared",
      value: left,
      why: "RAM in use outside every other tile: drivers' locked memory, page tables, the kernel's code.",
    });
  }
  return { tiles: tiles.filter((t) => t.value > 0), scale };
}

/**
 * Both views of Windows' memory; null until typeperf and Windows' own info
 * have been read (the tab then says it is reading).
 */
export function memoryMap(input: MemoryMapInput): MemoryMap | null {
  const { counters: c, info } = input;
  if (c === null || info === null) return null;
  const ram = ramView(input, c, info.memTotal);
  return {
    limit: c.commitLimit,
    committed: c.committedBytes,
    ramTotal: info.memTotal,
    available: c.availableMB === null ? null : c.availableMB * 2 ** 20,
    commit: commitView(input, c),
    ram: ram.tiles,
    scale: ram.scale,
    note: holdersNote(input.holders),
  };
}
