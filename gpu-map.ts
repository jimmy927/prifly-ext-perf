/**
 * The Memory tab's graphics card section: the card's dedicated memory as
 * treemap tiles, the same holders the Machine tab's Graphics card card lists
 * (`gpu.ts`' rows: prifly's model workers a tile per model, the WSL VM's
 * remainder, each Windows program, and free), and a pressure strip of three
 * readings with the last hour of each. Pure: `gpu-live.ts` reads.
 */

import type { GpuRow, Grey } from "./gpu";
import type { GpuStatus } from "./gpu-live";
import type { Tile } from "./memory-map";
import type { Tone } from "./verdict";

/** One `nvidia-smi` read, MiB, with the card's shared memory in use where Windows counts it. */
export type GpuPoint = { at: number; total: number; free: number; shared: number | null };

/** What grey words need, marked on the free tile: their MiB as bytes, and whether they run or would start. */
export type GreyMark = { needs: number; state: Grey; label: string };

/** A tile of the card: `sub` is its exact MiB and where it runs; the free tile carries `grey`. */
export type GpuTile = Tile & { sub: string; grey?: GreyMark };

export type GpuReading = {
  key: "dedicated" | "grey" | "shared";
  name: string;
  /** What the reading means, in a line. */
  means: string;
  /** The number, or "—" where Windows gave no counter. */
  main: string;
  /** Beside the number: "of 8.0 GB"; "" where there is none. */
  small: string;
  /** Null where there is no counter: no colour. */
  tone: Tone | null;
  /** The least value the sparkline's top is at: a calm line stays low. */
  ceiling: number;
  /** The last hour, a point a minute; empty before there is any. */
  series: number[];
};

export type GpuMap = {
  name: string;
  /** Bytes. */
  total: number;
  free: number;
  greyNeeds: number;
  grey: Grey;
  tiles: GpuTile[];
  readings: GpuReading[];
  /** What is not known, "" when nothing is missing. */
  note: string;
};

/** Dedicated memory in use from which the reading is orange: on an 8 GB card, 1.2 GB left, less than grey words need. */
export const DEDICATED_WARNING = 85;
/** From here red: 0.4 GB left on 8 GB, where the driver starts moving the card's memory out to shared. */
export const DEDICATED_CRITICAL = 95;
/** Shared memory in use, MiB, from which the reading is orange: a desktop at rest borrows a few hundred MB. */
export const SHARED_WARNING = 1024;

const MiB = 2 ** 20;
const MISSING = "—";
const MINUTE = 60_000;
const MINUTES = 60;

/** MiB as the Graphics card card writes them: "1.2 GB", "211 MB". */
export const size = (mib: number): string =>
  mib >= 1000 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`;

const exact = (mib: number) => `${Math.round(mib).toLocaleString("en")} MiB`;

const WINDOWS_WHY =
  "A Windows program's share of the card. Windows' counters for programs overlap, so they are scaled down to fit in what the WSL VM leaves.";
const WINDOWS_OTHER_WHY =
  "The rest of what is in use: Windows programs not named, and what no counter owns.";
const WSL_OTHER_WHY =
  "The rest of the WSL VM's share: WSL processes other than prifly's model workers that have the GPU open, or GPU use in another distro or Docker Desktop.";

/** A row's Why: the card's own, or what its kind of row is where the card has none. */
function whyOf(row: GpuRow): string {
  if (row.what !== "") return row.what;
  if (row.name === "Windows other") return WINDOWS_OTHER_WHY;
  return row.where === "WSL" ? WSL_OTHER_WHY : WINDOWS_WHY;
}

/** The card's rows as tiles, each with a key of its own across the redraw every second. */
function holderTiles(rows: GpuRow[]): GpuTile[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = `gpu:${row.name}|${row.model ?? ""}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return {
      key: n === 0 ? base : `${base}#${n}`,
      name: row.model === undefined ? row.name : `${row.name}: ${row.model}`,
      colour: row.kind,
      value: row.mib * MiB,
      why: whyOf(row),
      sub: `${exact(row.mib)} · ${row.where}`,
    };
  });
}

/** What the free tile says of grey words. */
function greyMark(gpu: {
  free: number;
  greyNeeds: number;
  grey: Grey;
}): GreyMark & { why: string } {
  const need = size(gpu.greyNeeds);
  const needs = gpu.greyNeeds * MiB;
  if (gpu.grey === "on") {
    return {
      needs,
      state: "on",
      label: "grey words on",
      why: "Free memory. Grey words are on: their worker holds its own memory, so what is free says nothing about them.",
    };
  }
  if (gpu.grey === "fits") {
    return {
      needs,
      state: "fits",
      label: `grey words need ${need}: would start`,
      why: `Free memory. Grey words need ${need} free to start: they would start (the dashed part).`,
    };
  }
  return {
    needs,
    state: "short",
    label: `grey words need ${need}: would not start`,
    why: `Free memory. Grey words need ${need} free to start: they would not, ${size(gpu.greyNeeds - gpu.free)} short.`,
  };
}

/** The last hour of `of`, a mean a minute ending at `now`; minutes with no read are left out. */
export function seriesOf(
  history: readonly GpuPoint[],
  now: number,
  of: (p: GpuPoint) => number | null,
): number[] {
  const sums = Array.from({ length: MINUTES }, () => ({ sum: 0, n: 0 }));
  for (const p of history) {
    const ago = Math.floor((now - p.at) / MINUTE);
    const value = of(p);
    const bucket = sums[MINUTES - 1 - ago];
    if (bucket === undefined || value === null) continue;
    bucket.sum += value;
    bucket.n += 1;
  }
  return sums.flatMap((b) => (b.n === 0 ? [] : [b.sum / b.n]));
}

const dedicatedTone = (pct: number): Tone =>
  pct >= DEDICATED_CRITICAL ? "critical" : pct >= DEDICATED_WARNING ? "warning" : "good";

type Loaded = Extract<GpuStatus, { loading: false }>;

/** The strip's three readings: dedicated in use, free against grey words, shared in use. */
export function gpuReadings(gpu: Loaded, history: readonly GpuPoint[], now: number): GpuReading[] {
  // Rounded as shown, so "85 %" is never green.
  const pct = Math.round((100 * (gpu.total - gpu.free)) / gpu.total);
  const short = gpu.greyNeeds - gpu.free;
  const greyMeans = {
    on: "grey words on",
    fits: "grey words would start",
    short: `grey words would not start: ${size(short)} short`,
  }[gpu.grey];
  return [
    {
      key: "dedicated",
      name: "Dedicated in use",
      means: "how full the card's own memory is",
      main: `${pct} %`,
      small: `of ${size(gpu.total)}`,
      tone: dedicatedTone(pct),
      ceiling: 100,
      series: seriesOf(history, now, (p) => (100 * (p.total - p.free)) / p.total),
    },
    {
      key: "grey",
      name: "Free for grey words",
      means: greyMeans,
      main: size(gpu.free),
      small: `needs ${size(gpu.greyNeeds)}`,
      tone: gpu.grey === "short" ? "warning" : "good",
      ceiling: gpu.total,
      series: seriesOf(history, now, (p) => p.free),
    },
    {
      key: "shared",
      name: "Shared GPU memory",
      means: "system RAM the card borrows when its own is short",
      main: gpu.shared === null ? MISSING : size(gpu.shared),
      small: "",
      tone: gpu.shared === null ? null : gpu.shared >= SHARED_WARNING ? "warning" : "good",
      ceiling: 2 * SHARED_WARNING,
      series: seriesOf(history, now, (p) => p.shared),
    },
  ];
}

/**
 * The section for `gpu` (`GpuMonitor.status`): null where there is no NVIDIA
 * card, `{loading: true}` until the first read. Where who holds the card is
 * unknown, what is used is one tile and the note says why.
 */
export function gpuMemoryMap(
  gpu: GpuStatus | null,
  history: readonly GpuPoint[],
  now: number,
): GpuMap | { loading: true } | null {
  if (gpu === null) return null;
  if (gpu.loading) return { loading: true };
  const used = gpu.total - gpu.free;
  const { why, ...grey } = greyMark(gpu);
  const free: GpuTile = {
    key: "gpu:free",
    name: "Free",
    colour: "k-ramfree",
    value: gpu.free * MiB,
    why,
    sub: exact(gpu.free),
    grey,
  };
  const known = gpu.unknown === "";
  const held: GpuTile[] = known
    ? holderTiles(gpu.holders)
    : [
        {
          key: "gpu:used",
          name: "In use",
          colour: "g-unknown",
          value: used * MiB,
          why: `Who holds it is unknown: ${gpu.unknown}`,
          sub: exact(used),
        },
      ];
  return {
    name: gpu.name,
    total: gpu.total * MiB,
    free: gpu.free * MiB,
    greyNeeds: gpu.greyNeeds * MiB,
    grey: gpu.grey,
    tiles: [...held, free].filter((t) => t.value > 0),
    readings: gpuReadings(gpu, history, now),
    note: known ? "" : `Who holds it is unknown: ${gpu.unknown}`,
  };
}
