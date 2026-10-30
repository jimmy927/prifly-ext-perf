// The Memory tab's WSL VM tile split by what Linux says the VM holds
// (`memory-map.ts` draws it): its file cache, prifly's processes, Docker's
// containers, every other program, the kernel, what is free, and what the VM
// costs Windows beyond Linux's memory. From `/proc/meminfo` (`wsl.ts`), the
// prifly report and Docker's cgroups.
//
// Windows does not say which of the VM's pages it trimmed, so each part is in
// RAM at the VM's average share.

import type { Tile } from "./memory-map";
import type { LinuxSample } from "./wsl";

/** Linux's read of the VM: what the split needs of a `LinuxSample`. */
export type VmLinux = Pick<LinuxSample, "memTotal" | "meminfo">;

/**
 * Bytes in the VM: prifly's (its processes' rss and the anon memory of the
 * containers its sessions started, as the prifly tab counts them) and the
 * other containers' anon memory (`memory.stat`), without their file cache.
 */
export type InVm = { prifly: number; docker: number };

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
    "prifly's processes inside WSL: the sessions' claude, their MCP servers, the tools their turns " +
    "run and the containers they started (their own memory, not their file cache), as the prifly " +
    "tab counts them.",
  docker:
    "Containers Docker runs in the VM that no session started: their processes' own memory, from " +
    "their cgroups. Their file cache is in the Linux file cache.",
  other:
    "Every other process in the VM: its own memory (AnonPages and Shmem) less prifly's and Docker's.",
  programs:
    "Every process in the VM: its own memory (AnonPages and Shmem). What of it is prifly's and " +
    "Docker's shows once the process table is read.",
  kernel:
    "Linux's own memory: slab caches (inodes, dentries), page tables and kernel stacks, and what " +
    "/proc/meminfo leaves unaccounted.",
  free: "Memory Linux has not used. Windows has promised it all the same.",
  overhead:
    "What the VM costs Windows beyond the memory Linux sees: the VM's own process and devices.",
};

/** Bytes that are a number and not below 0: a missing or odd reading counts nothing. */
const bytesOf = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);

const sum = (tiles: readonly { value: number }[]) => tiles.reduce((s, t) => s + t.value, 0);

/**
 * What the VM holds by Linux's account, in bytes, before any view scales
 * them: the file cache, the programs (prifly's and Docker's apart once
 * `inVm` is read), the kernel with whatever `MemTotal` leaves unaccounted,
 * what is free, and, given the VM's commit, what the VM costs beyond
 * `MemTotal`. prifly and Docker are capped at what the programs hold. A part
 * of 0 has no tile.
 */
export function wslParts(linux: VmLinux, inVm: InVm | null, commit: number | null): Tile[] {
  const m = linux.meminfo;
  const cache = bytesOf(m.buffers + m.cached - m.shmem);
  const programs = bytesOf(m.anonPages) + bytesOf(m.shmem);
  const prifly = inVm === null ? 0 : Math.min(bytesOf(inVm.prifly), programs);
  const docker = inVm === null ? 0 : Math.min(bytesOf(inVm.docker), programs - prifly);
  const free = bytesOf(m.memFree);
  const kernelOwn = bytesOf(m.slab) + bytesOf(m.pageTables) + bytesOf(m.kernelStack);
  const kernel =
    kernelOwn + bytesOf(bytesOf(linux.memTotal) - (cache + programs + kernelOwn + free));
  const inLinux = cache + programs + kernel + free;
  const part = (key: keyof typeof PART_WHY, name: string, colour: string, value: number) => ({
    key: `wsl:${key}`,
    name,
    colour,
    value,
    why: PART_WHY[key],
  });
  return [
    part("cache", "Linux file cache", "k-cache", cache),
    part("prifly", "prifly sessions", "k-claude", prifly),
    part("docker", "Docker containers", "k-docker", docker),
    inVm === null
      ? part("programs", "Linux programs", "k-other", programs)
      : part("other", "Other Linux programs", "k-other", programs - prifly - docker),
    part("kernel", "Linux kernel", "k-kernel", kernel),
    part("free", "Free in the VM", "k-headroom", free),
    part("overhead", "VM overhead", "k-shared", commit === null ? 0 : bytesOf(commit - inLinux)),
  ].filter((t) => t.value > 0);
}

/**
 * `parts` scaled to add up to `total` (down, where Linux counts more than
 * the VM's commit), each with `ram` its share of `ram` where that is given;
 * none where there is nothing to scale.
 */
function scaledTo(parts: Tile[], total: number, ram?: number): Tile[] {
  const whole = sum(parts);
  if (!(whole > 0) || !(total > 0)) return [];
  return parts.map((t) => {
    const value = (t.value * total) / whole;
    return ram === undefined ? { ...t, value } : { ...t, value, ram: (value * ram) / total };
  });
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
  const children = scaledTo(wslParts(linux, inVm, commit), tile.value).map((t) => ({
    ...t,
    key: `ram:${t.key}`,
  }));
  return children.length === 0 ? tile : { ...tile, why: RAM_WHY, children };
}
