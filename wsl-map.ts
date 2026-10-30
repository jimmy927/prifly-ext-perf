// The Memory tab's WSL VM tile split by what Linux says the VM holds
// (`memory-map.ts` draws it): its file cache, prifly's processes, Docker's
// containers, every other program, the kernel, what is free, and what the VM
// costs Windows beyond Linux's memory. From `/proc/meminfo` (`wsl.ts`), the
// prifly report and Docker's cgroups. prifly's part and the kernel's are
// groups: prifly's by the containers its sessions started, their `claude`
// (by PSS, `pss.ts`), the agent and relays and the sessions' tools; the
// kernel's by what `/proc/meminfo` names of it.
//
// Windows does not say which of the VM's pages it trimmed, so each part is in
// RAM at the VM's average share.

import { basename } from "node:path";
import type { Container } from "./docker";
import type { Tile } from "./memory-map";
import type { Kind, SessionRow } from "./prifly";
import type { Proc } from "./procs";
import type { LinuxSample } from "./wsl";

/** Linux's read of the VM: what the split needs of a `LinuxSample`. */
export type VmLinux = Pick<LinuxSample, "memTotal" | "meminfo">;

/**
 * Bytes in the VM: prifly's, as the tiles of its group (`priflyTiles`: the
 * containers its sessions started, their `claude`, the agent and relays, the
 * sessions' tools), and the other containers' anon memory (`memory.stat`),
 * without their file cache.
 */
export type InVm = { prifly: Tile[]; docker: number };

/** The WSL VM's tile once it is split; `share` is the VM's in-RAM share. */
const splitWhy = (share: number) =>
  "The Linux VM's memory, split by what Linux says it holds. Windows charges the VM's whole size " +
  "against the limit when it starts, used or not. Windows does not say which of the VM's pages it " +
  `trimmed, so each part's stripes are the VM's average in-RAM share: ${Math.round(share * 100)} %.`;

const RAM_WHY =
  "The part of the Linux VM's memory in RAM now, split by what Linux says it holds, each part at " +
  "the VM's average in-RAM share.";

const PART_WHY = {
  cache:
    "Files Linux read or wrote, kept in case they are needed again (Buffers and Cached, less shared " +
    "memory). Linux could drop it at once, but Windows counts it as used like any program's memory: " +
    "it is promised, and Windows trims and compresses it. autoMemoryReclaim=dropCache in .wslconfig " +
    "is meant to hand it back to Windows.",
  prifly:
    "What prifly's sessions run inside WSL: the containers a session started, each session's " +
    "claude, prifly's agent and relays, and the MCP servers and tools their turns run.",
  docker:
    "Containers Docker runs in the VM that no session started: their processes' own memory, from " +
    "their cgroups. Their file cache is in the Linux file cache.",
  other:
    "Every other process in the VM: its own memory (AnonPages and Shmem) less prifly's and Docker's.",
  programs:
    "Every process in the VM: its own memory (AnonPages and Shmem). What of it is prifly's and " +
    "Docker's shows once the process table is read.",
  kernel:
    "Linux's own memory: what /proc/meminfo puts outside programs, the file cache and free memory.",
  free: "Memory Linux has not used. Windows has promised it all the same.",
  overhead:
    "What the VM costs Windows beyond the memory Linux sees: the VM's own process and devices.",
};

const KERNEL_WHY = {
  caches:
    "Directory entries and inodes the file systems keep (SReclaimable). Linux drops them under " +
    "pressure, like the file cache.",
  self:
    "What the kernel itself needs: the slab it cannot free, vmalloc, page tables and kernel stacks " +
    "(SUnreclaim, VmallocUsed, PageTables, KernelStack).",
  unaccounted:
    "MemTotal less every field /proc/meminfo lists. Drivers take memory straight from the page " +
    "allocator (WSL's GPU and Hyper-V drivers, for example), and Linux does not name it.",
};

/** Bytes that are a number and not below 0: a missing or odd reading counts nothing. */
const bytesOf = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

const sum = (tiles: readonly { value: number }[]) => tiles.reduce((s, t) => s + t.value, 0);

/** "claude ×26": a count after a name where there is more than one. */
const counted = (name: string, count: number) => (count > 1 ? `${name} ×${count}` : name);

/** A group of `children`, its value theirs added up. */
const group = (tile: Omit<Tile, "value" | "children">, children: Tile[]): Tile => ({
  ...tile,
  value: sum(children),
  children,
});

/** A session as the prifly tab names it, by its title; by its folder where it has none. */
function sessionName(row: SessionRow): string {
  const title = row.title.trim();
  if (title !== "" && title !== row.id.slice(0, 8)) return title;
  return basename(row.cwd) || title || row.id.slice(0, 8);
}

/** The `claude` tile's text: by PSS, by RSS where `smaps_rollup` was not read, or a mix. */
function claudeWhy(count: number, rss: number, pss: number, read: number): string {
  const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
  const one = count === 1 ? "The session's claude" : `The sessions' ${count} claude processes`;
  if (read === count) {
    return (
      `${one}: ${gb(rss)} counted per process (RSS), ${gb(pss)} once the pages they share are ` +
      "counted once (PSS, from /proc/<pid>/smaps_rollup)."
    );
  }
  if (read === 0) {
    return (
      `${one}, counted per process (RSS): /proc/<pid>/smaps_rollup could not be read, so the ` +
      "pages they share count once for each of them."
    );
  }
  return (
    `${one}, the pages they share counted once (PSS, from /proc/<pid>/smaps_rollup) where it ` +
    `could be read; ${count - read} of them count per process (RSS) instead.`
  );
}

/** Which of prifly's process tiles each report kind goes in; containers are tiles of their own. */
const TILE_OF: Record<Exclude<Kind, "containers">, "claude" | "agent" | "mcp" | "tools"> = {
  claude: "claude",
  host: "agent",
  relay: "agent",
  mcp: "mcp",
  tools: "tools",
  gates: "tools",
};

/** The processes the report counted (`kinds`), by the tile each goes in. */
function byTile(procs: readonly Proc[], kinds: ReadonlyMap<number, Kind>) {
  const by: Record<"claude" | "agent" | "mcp" | "tools", Proc[]> = {
    claude: [],
    agent: [],
    mcp: [],
    tools: [],
  };
  for (const proc of procs) {
    const kind = kinds.get(proc.pid);
    if (kind !== undefined && kind !== "containers") by[TILE_OF[kind]].push(proc);
  }
  return by;
}

/**
 * prifly's part of the VM as tiles, and the other containers' anon memory:
 * the containers its sessions (`sessions`, the report's) started, one each by
 * their anon memory; the `claude` processes the report counted (`kinds`, from
 * `priflyReport`), by PSS where `pss` has it and RSS where not; the agent and
 * relays (with a host inside WSL, the host and its helpers); the MCP servers;
 * and the sessions' tools and runners. A tile of 0 is left out.
 */
export function inVmOf(
  procs: readonly Proc[],
  kinds: ReadonlyMap<number, Kind>,
  pss: ReadonlyMap<number, number>,
  containers: readonly Container[],
  sessions: readonly SessionRow[],
): InVm {
  const rows = new Map(sessions.map((row) => [row.id, row]));
  const tiles: Tile[] = [];
  let docker = 0;
  for (const container of containers) {
    const row = rows.get(container.session);
    if (row === undefined) {
      docker += bytesOf(container.anon);
      continue;
    }
    const session = sessionName(row);
    tiles.push({
      key: `wsl:prifly:c:${container.id.slice(0, 12)}`,
      name: `${container.service ?? container.name} · ${session}`,
      colour: "k-docker",
      value: bytesOf(container.anon),
      why:
        `A container the session ${session} started (${container.name}): its processes' own ` +
        "memory (anon in its cgroup's memory.stat), not its file cache. Stopping that stack frees it.",
    });
  }
  const by = byTile(procs, kinds);
  const rss = (list: Proc[]) => list.reduce((s, p) => s + bytesOf(p.rss), 0);
  const claudeRss = rss(by.claude);
  const read = by.claude.filter((p) => pss.has(p.pid)).length;
  const claudePss = by.claude.reduce((s, p) => s + bytesOf(pss.get(p.pid) ?? p.rss), 0);
  tiles.push(
    {
      key: "wsl:prifly:claude",
      name: counted("claude", by.claude.length),
      colour: "k-claude",
      value: claudePss,
      why: claudeWhy(by.claude.length, claudeRss, claudePss, read),
    },
    {
      key: "wsl:prifly:agent",
      name: "prifly agent and relays",
      colour: "k-host",
      value: rss(by.agent),
      why:
        "prifly's agent inside WSL and the relays that keep each session alive through a host " +
        "restart (with the host inside WSL, the host and its helpers too).",
    },
    {
      key: "wsl:prifly:mcp",
      name: counted("MCP servers", by.mcp.length),
      colour: "k-mcp",
      value: rss(by.mcp),
      why: "The MCP servers each session's claude starts, counted per process (RSS).",
    },
    {
      key: "wsl:prifly:tools",
      name: counted("Session tools", by.tools.length),
      colour: "k-tools",
      value: rss(by.tools),
      why:
        "What the sessions' turns run: shells, tests, builds, and the lands and git buttons' runs " +
        "with their test gates, counted per process (RSS).",
    },
  );
  return { prifly: tiles.filter((t) => t.value > 0), docker };
}

/** `tiles` and their children, each value times `by`. */
const scaled = (tiles: Tile[], by: number): Tile[] =>
  tiles.map((t) => ({
    ...t,
    value: t.value * by,
    ...(t.children === undefined ? {} : { children: scaled(t.children, by) }),
  }));

/**
 * The kernel's part: `kernel`, the value it had as one tile, split into the
 * caches it can drop, what it needs itself and what Linux does not name. A
 * child whose `/proc/meminfo` fields are all missing is left out; with any
 * field missing the rest is "Rest of the kernel", not "Not accounted by
 * Linux". One child or none: the tile stays whole.
 */
function kernelTile(m: VmLinux["meminfo"], kernel: number): Tile {
  const tile = { key: "wsl:kernel", name: "Linux kernel", colour: "k-kernel" };
  const have = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);
  const self = [m.sUnreclaim, m.vmallocUsed, m.pageTables, m.kernelStack];
  const caches = have(m.sReclaimable) ? bytesOf(m.sReclaimable) : null;
  const own = self.some(have) ? self.filter(have).reduce((s, n) => s + bytesOf(n), 0) : null;
  const all = caches !== null && self.every(have);
  const rest = bytesOf(kernel - (caches ?? 0) - (own ?? 0));
  const children: Tile[] = [
    ...(caches === null
      ? []
      : [
          {
            key: "wsl:kernel:caches",
            name: "Kernel caches",
            colour: "k-cache",
            value: caches,
            why: KERNEL_WHY.caches,
          },
        ]),
    ...(own === null
      ? []
      : [
          {
            key: "wsl:kernel:self",
            name: "Kernel itself",
            colour: "k-kernel",
            value: own,
            why: KERNEL_WHY.self,
          },
        ]),
    all
      ? {
          key: "wsl:kernel:unaccounted",
          name: "Not accounted by Linux",
          colour: "k-shared",
          value: rest,
          why: KERNEL_WHY.unaccounted,
        }
      : {
          key: "wsl:kernel:rest",
          name: "Rest of the kernel",
          colour: "k-shared",
          value: rest,
          why: "What the kernel holds beyond the fields this kernel's /proc/meminfo gives.",
        },
  ].filter((t) => t.value > 0);
  if (children.length < 2) return { ...tile, value: kernel, why: PART_WHY.kernel };
  return group({ ...tile, why: PART_WHY.kernel }, children);
}

/**
 * What the VM holds by Linux's account, in bytes, before any view scales
 * them: the file cache, the programs (prifly's group and Docker's apart once
 * `inVm` is read), the kernel's group with whatever `MemTotal` leaves
 * unaccounted, what is free, and, given the VM's commit, what the VM costs
 * beyond `MemTotal`. prifly and Docker are capped at what the programs hold,
 * prifly's children scaled with it. A part of 0 has no tile.
 */
export function wslParts(linux: VmLinux, inVm: InVm | null, commit: number | null): Tile[] {
  const m = linux.meminfo;
  const cache = bytesOf(m.buffers + m.cached - m.shmem);
  const programs = bytesOf(m.anonPages) + bytesOf(m.shmem);
  const priflyWhole = inVm === null ? 0 : sum(inVm.prifly);
  const prifly = Math.min(priflyWhole, programs);
  const docker = inVm === null ? 0 : Math.min(bytesOf(inVm.docker), programs - prifly);
  const free = bytesOf(m.memFree);
  const kernelOwn = bytesOf(m.slab) + bytesOf(m.pageTables) + bytesOf(m.kernelStack);
  const kernel = kernelTile(
    m,
    kernelOwn + bytesOf(bytesOf(linux.memTotal) - (cache + programs + kernelOwn + free)),
  );
  const inLinux = cache + programs + kernel.value + free;
  const part = (key: keyof typeof PART_WHY, name: string, colour: string, value: number) => ({
    key: `wsl:${key}`,
    name,
    colour,
    value,
    why: PART_WHY[key],
  });
  const priflyChildren =
    inVm === null || !(priflyWhole > 0) ? [] : scaled(inVm.prifly, prifly / priflyWhole);
  return [
    part("cache", "Linux file cache", "k-cache", cache),
    priflyChildren.length === 0
      ? part("prifly", "prifly sessions", "k-claude", prifly)
      : group(
          { key: "wsl:prifly", name: "prifly sessions", colour: "k-claude", why: PART_WHY.prifly },
          priflyChildren,
        ),
    part("docker", "Docker containers", "k-docker", docker),
    inVm === null
      ? part("programs", "Linux programs", "k-other", programs)
      : part("other", "Other Linux programs", "k-other", programs - prifly - docker),
    kernel,
    part("free", "Free in the VM", "k-headroom", free),
    part("overhead", "VM overhead", "k-shared", commit === null ? 0 : bytesOf(commit - inLinux)),
  ].filter((t) => t.value > 0);
}

/**
 * `parts` scaled to add up to `total` (down, where Linux counts more than
 * the VM's commit), their children with them, each with `ram` its share of
 * `ram` where that is given; none where there is nothing to scale.
 */
function scaledTo(parts: Tile[], total: number, ram?: number): Tile[] {
  const whole = sum(parts);
  if (!(whole > 0) || !(total > 0)) return [];
  const withRam = (tiles: Tile[]): Tile[] =>
    tiles.map((t) => ({
      ...t,
      ...(ram === undefined ? {} : { ram: (t.value * ram) / total }),
      ...(t.children === undefined ? {} : { children: withRam(t.children) }),
    }));
  return withRam(scaled(parts, total / whole));
}

/**
 * The promised view's WSL VM tile (its value the VM's commit, its `ram` the
 * VM's working set) split by `wslParts`; the tile as it was without a Linux read.
 */
export function splitWsl(tile: Tile, linux: VmLinux | null, inVm: InVm | null): Tile {
  if (linux === null || tile.children !== undefined) return tile;
  const children = scaledTo(wslParts(linux, inVm, tile.value), tile.value, tile.ram);
  if (children.length === 0) return tile;
  const share = tile.ram === undefined ? 1 : Math.min(1, tile.ram / tile.value);
  return { ...tile, why: splitWhy(share), children };
}

/** `tiles` and their children with `ram:` before each key: the RAM view's keys. */
const ramKeys = (tiles: Tile[]): Tile[] =>
  tiles.map((t) => ({
    ...t,
    key: `ram:${t.key}`,
    ...(t.children === undefined ? {} : { children: ramKeys(t.children) }),
  }));

/**
 * The RAM view's WSL VM tile (its value the VM's working set) split the same
 * way, with the VM's `commit` where the process list gave it, scaled to the
 * working set; the tile as it was without a Linux read.
 */
export function splitWslRam(
  tile: Tile,
  linux: VmLinux | null,
  inVm: InVm | null,
  commit: number | null,
): Tile {
  if (linux === null) return tile;
  const children = ramKeys(scaledTo(wslParts(linux, inVm, commit), tile.value));
  return children.length === 0 ? tile : { ...tile, why: RAM_WHY, children };
}
