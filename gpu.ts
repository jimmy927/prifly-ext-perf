/**
 * The graphics card's memory and who holds it, worked out from three sources
 * that each see part of it:
 *
 * - `nvidia-smi` knows the card's name, total and free memory, but under WSL
 *   lists every process's memory as "[N/A]".
 * - Windows' counters (`windows.ts`) know each Windows process's share of the
 *   card, among them `vmwp`, the WSL VM, which holds everything WSL runs on it.
 * - prifly's host publishes what each of its GPU model workers holds
 *   (`gpu-holders.json`), which splits the VM's share. Those are estimates, so
 *   which WSL processes have `/dev/dxg` open (`gpu-live.ts` scans `/proc`)
 *   says whether anything else can hold part of it.
 *
 * This file is the pure part: parsing and the sums. `gpu-live.ts` reads.
 */

/**
 * The free memory at which prifly starts dictation's grey words (its
 * `GREY_START_FREE_MIB`), where the host has not said: it publishes its own as
 * `greyNeeds` in `gpu-holders.json`, which wins (`readGreyNeeds`).
 */
export const GREY_NEEDS_MIB = 1536;
/** A holders file older than this is from a host that is no longer running. */
export const HOLDERS_FRESH_MS = 10 * 60_000;
/** Windows processes named in the table; the rest of the card is "Windows other". */
const NAMED_WINDOWS = 5;
/** The WSL VM, in Windows' list of processes. */
const WSL_VM = "vmwp";

export type Card = { name: string; total: number; free: number };

/** `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits`, first card. */
export function parseNvidiaSmi(text: string): Card | null {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "");
  if (line === undefined) return null;
  const parts = line.split(",").map((part) => part.trim());
  const free = Number(parts.at(-1));
  const total = Number(parts.at(-2));
  const name = parts
    .slice(0, -2)
    .join(", ")
    .replace(/^NVIDIA\s+/i, "");
  if (name === "" || !Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
  return { name, total, free: Math.min(free, total) };
}

/** The adapter whose dedicated usage is closest to what `nvidia-smi` says is used: the NVIDIA card, not the integrated one. */
export function pickLuid(adapters: Map<string, number>, usedMib: number): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const [luid, mib] of adapters) {
    const away = Math.abs(mib - usedMib);
    if (away < distance) {
      best = luid;
      distance = away;
    }
  }
  return best;
}

export type GpuUse = { pid: number; luid: string; mib: number };
export type GpuProcesses = { uses: GpuUse[]; names: Map<number, string> };

const INSTANCE = /^pid_(\d+)_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+(?:#\d+)?$/i;

/** One pid's instances on one adapter, as `G` (dedicated) and `C` (committed) figures. */
type Instances = { luid: string; pid: number; dedicated: number[]; committed: number[] };

function addInstance(into: Map<string, Instances>, use: GpuUse, kind: "G" | "C"): void {
  const key = `${use.luid}/${use.pid}`;
  let seen = into.get(key);
  if (seen === undefined) {
    seen = { luid: use.luid, pid: use.pid, dedicated: [], committed: [] };
    into.set(key, seen);
  }
  (kind === "G" ? seen.dedicated : seen.committed).push(use.mib);
}

function instanceUse(instance: string, bytes: string): GpuUse | null {
  const match = INSTANCE.exec(instance);
  const mib = Number(bytes) / 2 ** 20;
  if (match === null || !Number.isFinite(mib) || mib < 0) return null;
  return { pid: Number(match[1]), luid: (match[2] ?? "").toLowerCase(), mib };
}

/** The instances' figure: the WSL VM's add up, every other process's overlap and count the largest. */
function combine(figures: number[], sum: boolean): number | undefined {
  if (figures.length === 0) return undefined;
  return sum ? figures.reduce((a, b) => a + b, 0) : Math.max(...figures);
}

function reduceInstances(one: Instances, names: Map<number, string>): GpuUse[] {
  // Names come in any order, so the VM is told apart only once all lines are read.
  const sum = names.get(one.pid) === WSL_VM;
  const mib = combine(one.dedicated, sum);
  if (mib === undefined) return [];
  const cap = combine(one.committed, sum);
  return [{ pid: one.pid, luid: one.luid, mib: cap === undefined ? mib : Math.min(mib, cap) }];
}

/**
 * `gpuProcessCounters()`'s lines. A pid listed more than once for one adapter
 * (`phys_0#2`) counts its largest, not the sum: the instances overlap. The WSL
 * VM (`vmwp`) is the exception: it has one instance per WSL process using the
 * GPU, so its instances add up (3,820 and 1,598 MiB with dictation's final and
 * grey workers running: 5.4 GB). A process counts at most what it has
 * committed: some report a dedicated usage far past the card (NVIDIA Overlay
 * 34.9 GB on an 8 GB card, 86 MB committed), which would otherwise take most
 * of the card's shares.
 */
export function parseGpuProcesses(out: string): GpuProcesses {
  const instances = new Map<string, Instances>();
  const names = new Map<number, string>();
  for (const line of out.split(/\r?\n/)) {
    const [kind, first, second] = line.trim().split("|");
    if (first === undefined || second === undefined) continue;
    if (kind === "P") {
      names.set(Number(first), second.toLowerCase());
      continue;
    }
    const use = kind === "G" || kind === "C" ? instanceUse(first, second) : null;
    if (use !== null) addInstance(instances, use, kind as "G" | "C");
  }
  const uses = [...instances.values()].flatMap((one) => reduceInstances(one, names));
  return { uses, names };
}

export type Share = { name: string; mib: number };
export type Shares = {
  /** The biggest Windows programs, scaled so that all shares together are at most what is used. */
  named: Share[];
  /** What the WSL VM (`vmwp`) holds, as counted: never scaled down. */
  vm: number;
  /** The rest of what is used: Windows programs not named, and what no counter owns. */
  other: number;
};

/**
 * One adapter's processes, as shares of what is used. The WSL VM's figure is
 * taken as it is (up to `used`): its dedicated and committed figures agree.
 * Windows programs' figures overlap (the desktop compositor counts memory its
 * clients also count), so they are scaled down until they fit in what the VM
 * leaves; the rest is `other`. A program with several processes (chrome) is
 * one share.
 */
export function shareOut(uses: GpuUse[], names: Map<number, string>, used: number): Shares {
  const byName = new Map<string, number>();
  for (const use of uses) {
    const name = names.get(use.pid) ?? `pid ${use.pid}`;
    byName.set(name, (byName.get(name) ?? 0) + use.mib);
  }
  const vm = Math.min(byName.get(WSL_VM) ?? 0, used);
  const room = used - vm;
  const sum = [...byName].reduce((a, [name, mib]) => (name === WSL_VM ? a : a + mib), 0);
  const scale = sum > room && sum > 0 ? room / sum : 1;
  const named = [...byName]
    .filter(([name]) => name !== WSL_VM)
    .map(([name, mib]) => ({ name, mib: mib * scale }))
    .filter((share) => share.mib >= 1)
    .sort((a, b) => b.mib - a.mib)
    .slice(0, NAMED_WINDOWS);
  const shown = named.reduce((a, b) => a + b.mib, 0);
  return { named, vm, other: Math.max(0, used - vm - shown) };
}

/** One model inside a worker that holds several (Parakeet and turbo in the final worker). */
export type Part = { model: string; mib: number };

export type Holder = {
  pid: number;
  which: string;
  label: string;
  model: string;
  mib: number;
  /** Each model's share of `mib`, where the host says; empty for a worker with one model. */
  parts: Part[];
};

/**
 * `gpu-holders.json`, read tolerantly. Null (use the one bar) when it is not
 * JSON, older than ten minutes, or holds nobody whose process is still alive.
 * A `which` this code does not know stays a holder; an entry that is not
 * shaped like one is skipped, not the whole file.
 */
export function readHolders(
  text: string,
  now: number,
  alive: (pid: number) => boolean,
): Holder[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { at, holders } = parsed as { at?: unknown; holders?: unknown };
  if (typeof at !== "number" || now - at > HOLDERS_FRESH_MS || !Array.isArray(holders)) return null;
  const kept = (holders as unknown[]).flatMap((entry) => {
    const holder = holderOf(entry);
    return holder !== null && alive(holder.pid) ? [holder] : [];
  });
  return kept.length > 0 ? kept : null;
}

/** Whether dictation's grey words are running, would start on the free memory, or would not. */
export type Grey = "on" | "fits" | "short";

/**
 * "on" when a live grey worker is listed (it holds its own memory, so free
 * says nothing about it), else free memory against what the words need.
 * `holders` is `readHolders`' answer: null for a missing or stale file, or nobody alive.
 */
export function greyState(holders: Holder[] | null, free: number, greyNeeds: number): Grey {
  if (holders?.some((h) => h.which === "grey")) return "on";
  return free >= greyNeeds ? "fits" : "short";
}

/** `gpu-holders.json`'s `greyNeeds`, MiB; null where the file is not fresh or does not say. */
export function readGreyNeeds(text: string, now: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { at, greyNeeds } = parsed as { at?: unknown; greyNeeds?: unknown };
  if (typeof at !== "number" || now - at > HOLDERS_FRESH_MS) return null;
  return typeof greyNeeds === "number" && Number.isFinite(greyNeeds) && greyNeeds > 0
    ? greyNeeds
    : null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** One entry of the file; null where it is not shaped like a holder. */
function holderOf(entry: unknown): Holder | null {
  const h = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
  const { pid, mib } = h;
  if (typeof pid !== "number" || typeof mib !== "number" || !Number.isFinite(mib) || mib < 0) {
    return null;
  }
  const which = str(h["which"]);
  const label = str(h["label"]) || which || "prifly";
  return { pid, which, label, model: str(h["model"]), mib, parts: partsOf(h["parts"]) };
}

/** A holder's `parts`; entries not shaped like a part are left out. */
function partsOf(value: unknown): Part[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const p = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const { mib } = p;
    const model = str(p["model"]);
    return model !== "" && typeof mib === "number" && Number.isFinite(mib) && mib >= 0
      ? [{ model, mib }]
      : [];
  });
}

export type GpuRow = {
  /** The colour class: `g-final`, `g-grey`, `g-intent`, `g-wsl`, `g-win`, `g-win2`; a worker's later models add `g-part`. */
  kind: string;
  where: "Windows" | "prifly" | "WSL";
  name: string;
  what: string;
  mib: number;
};

const HOLDER_KIND: Record<string, string> = {
  final: "g-final",
  grey: "g-grey",
  intent: "g-intent",
};

/** A WSL process that has `/dev/dxg`, the GPU, open: its pid and short name (`/proc/<pid>/comm`). */
export type DxgProcess = { pid: number; name: string };

/** More other GPU processes than this are listed in the Why, not in the name. */
const NAMED_OTHERS = 3;

/**
 * The VM's share as rows: prifly's workers and what else WSL holds, or one bar
 * when the host did not say. The holders' figures are estimates, so `dxg`, the
 * WSL processes that have the GPU open, says whether anything but them can
 * hold the rest: when none does, the holders take the whole share; when others
 * do, the remainder is named after them. Null `dxg` (no `/proc` to look in)
 * leaves the remainder as "WSL other".
 */
export function vmRows(
  vm: number,
  holders: Holder[] | null,
  dxg: DxgProcess[] | null = null,
): GpuRow[] {
  if (vm < 1) return [];
  if (holders === null) {
    return [
      {
        kind: "g-wsl",
        where: "WSL",
        name: "prifly (WSL)",
        what: "prifly's models, not split: the host does not publish per-model figures yet",
        mib: vm,
      },
    ];
  }
  const listed = new Set(holders.map((h) => h.pid));
  const others = dxg === null ? [] : dxg.filter((p) => !listed.has(p.pid));
  // Only prifly's workers have the GPU open: the card's count for the VM is all theirs.
  const onlyHolders = holders.length > 0 && dxg !== null && others.length === 0;
  const rows = holderRows(holders);
  const sum = rows.reduce((a, r) => a + r.mib, 0);
  // The VM's figure is the card's own count: prifly's own may not exceed it.
  const scale = onlyHolders && sum > 0 ? vm / sum : sum > vm ? vm / sum : 1;
  for (const row of rows) row.mib = onlyHolders && sum <= 0 ? vm / rows.length : row.mib * scale;
  const rest = Math.max(0, vm - sum);
  if (onlyHolders || rest < 1) return rows;
  return [...rows, otherRow(others, rest)];
}

/** prifly's workers as rows, as they say: a worker with several models is a row per model, so the expensive one shows. */
function holderRows(holders: Holder[]): GpuRow[] {
  return holders.flatMap((h) => {
    const kind = HOLDER_KIND[h.which] ?? "g-wsl";
    const parts = h.parts.length > 0 ? h.parts : [{ model: h.model, mib: h.mib }];
    return parts.map((part, i) => ({
      kind: i === 0 ? kind : `${kind} g-part`,
      where: "prifly" as const,
      name: h.label,
      what: part.model,
      mib: part.mib,
    }));
  });
}

/** What is left of the VM's share, named after the other processes that have the GPU open. */
function otherRow(others: DxgProcess[], mib: number): GpuRow {
  const names = others.map((p) => `${p.name} (pid ${p.pid})`);
  return {
    kind: "g-wsl",
    where: "WSL",
    name: others.length > 0 && others.length <= NAMED_OTHERS ? names.join(", ") : "WSL other",
    what: others.length > NAMED_OTHERS ? names.join(", ") : "",
    mib,
  };
}

type Known = { name: string; what: string; where?: GpuRow["where"] };

/** Windows processes worth a plain name and a reason, by lowercased process name. */
const KNOWN_WINDOWS: Record<string, Known> = {
  dwm: {
    name: "Desktop compositor (dwm)",
    what: "Draws every window on the monitors this card drives",
  },
  "bun helper": {
    name: "prifly window (bun Helper)",
    what: "This window's web view",
    where: "prifly",
  },
  explorer: { name: "Explorer", what: "Taskbar, Start, file windows" },
  csrss: { name: "csrss", what: "Windows core" },
  "nvidia overlay": { name: "NVIDIA overlay", what: "NVIDIA App's overlay" },
  msedgewebview2: { name: "Edge WebView", what: "Web views inside apps" },
};

/** What the table shows for a Windows process: a plain name and a Why where it is known. */
export function knownWindows(process: string): Known {
  return KNOWN_WINDOWS[process.toLowerCase()] ?? { name: process, what: "" };
}

/** The card as the table lists it: prifly and WSL first, then Windows, biggest first. */
export function rowsOf(
  shares: Shares,
  holders: Holder[] | null,
  dxg: DxgProcess[] | null = null,
): GpuRow[] {
  const windows: GpuRow[] = shares.named.map((share, i) => {
    const known = knownWindows(share.name);
    return {
      kind: i === 0 ? "g-win" : "g-win2",
      where: known.where ?? "Windows",
      name: known.name,
      what: known.what,
      mib: share.mib,
    };
  });
  if (shares.other >= 1) {
    windows.push({
      kind: "g-win2",
      where: "Windows",
      name: "Windows other",
      what: "",
      mib: shares.other,
    });
  }
  return [...vmRows(shares.vm, holders, dxg), ...windows];
}
