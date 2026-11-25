import { describe, expect, test } from "bun:test";
import { GREY_NEEDS_MIB, greyState, type Holder, readHolders, rowsOf, shareOut } from "../gpu";
import type { GpuStatus } from "../gpu-live";
import { type GpuMap, type GpuPoint, gpuMemoryMap, seriesOf } from "../gpu-map";

const MiB = 2 ** 20;
const now = 10_000_000;
const TOTAL = 8192;

const FINAL = {
  pid: 100,
  which: "final",
  label: "Dictation (final)",
  model: "parakeet-tdt-0.6b + whisper turbo",
  mib: 4000,
  parts: [
    { model: "parakeet-tdt-0.6b", mib: 1800 },
    { model: "whisper turbo", mib: 2200 },
  ],
};

/** What `GpuMonitor.status` gives for an 8 GB card with `free` MiB free and `holders` (null: no file). */
function status(free: number, holders: Holder[] | null, shared: number | null = 211): GpuStatus {
  const used = TOTAL - free;
  const names = new Map([
    [7, "vmwp"],
    [8, "nvidia overlay"],
  ]);
  const uses = [
    { pid: 7, luid: "l", mib: used - 300 },
    { pid: 8, luid: "l", mib: 300 },
  ];
  const dxg = [
    { pid: 100, name: "bun" },
    { pid: 999, name: "python3" },
  ];
  return {
    loading: false,
    name: "GeForce RTX 3080 Laptop GPU",
    total: TOTAL,
    free,
    greyNeeds: GREY_NEEDS_MIB,
    grey: greyState(holders, free, GREY_NEEDS_MIB),
    holders: rowsOf(shareOut(uses, names, used), holders, dxg),
    unknown: "",
    shared,
  };
}

const finalWorker = () =>
  readHolders(JSON.stringify({ at: now, holders: [FINAL] }), now, () => true);

function map(gpu: GpuStatus, history: GpuPoint[] = []): GpuMap {
  const out = gpuMemoryMap(gpu, history, now);
  if (out === null || "loading" in out) throw new Error("no map");
  return out;
}

const tile = (m: GpuMap, name: string) => m.tiles.find((t) => t.name === name);
const reading = (m: GpuMap, key: string) => m.readings.find((r) => r.key === key);

describe("the graphics card's treemap", () => {
  test("8 GB, final worker with Parakeet and turbo, WSL other, NVIDIA Overlay, 1.2 GB free: grey words would not start", () => {
    const m = map(status(1229, finalWorker()));
    expect(m.tiles.map((t) => [t.name, Math.round(t.value / MiB)])).toEqual([
      ["Dictation (final): parakeet-tdt-0.6b", 1800],
      ["Dictation (final): whisper turbo", 2200],
      ["python3 (pid 999)", 6963 - 300 - 4000],
      ["NVIDIA overlay", 300],
      ["Free", 1229],
    ]);
    // The tiles add up to the card.
    expect(Math.round(m.tiles.reduce((s, t) => s + t.value, 0) / MiB)).toBe(TOTAL);
    const turbo = tile(m, "Dictation (final): whisper turbo");
    expect(turbo?.why).toBe(
      "Detects which language you speak; turns Swedish speech into text · whisper turbo",
    );
    expect(turbo?.sub).toBe("2,200 MiB · prifly");
    expect(turbo?.colour).toBe("g-final g-part");
    expect(tile(m, "python3 (pid 999)")?.why).toContain("WSL processes other than prifly's");
    expect(tile(m, "NVIDIA overlay")?.why).toBe("NVIDIA App's overlay");
    const free = tile(m, "Free");
    expect(free?.grey).toEqual({
      needs: GREY_NEEDS_MIB * MiB,
      state: "short",
      label: "grey words need 1.5 GB: would not start",
    });
    expect(free?.why).toContain("they would not, 307 MB short");
    expect(m.grey).toBe("short");
    expect(m.note).toBe("");
  });

  test("3 GB free: grey words would start", () => {
    const m = map(status(3072, finalWorker()));
    expect(tile(m, "Free")?.grey?.state).toBe("fits");
    expect(tile(m, "Free")?.grey?.label).toBe("grey words need 1.5 GB: would start");
    expect(reading(m, "grey")).toMatchObject({
      main: "3.0 GB",
      small: "needs 1.5 GB",
      means: "grey words would start",
      tone: "good",
    });
  });

  test("no holders file: the VM is one tile, and free memory alone decides", () => {
    const m = map(status(1229, null));
    expect(m.tiles.map((t) => t.name)).toEqual(["prifly (WSL)", "NVIDIA overlay", "Free"]);
    expect(tile(m, "prifly (WSL)")?.why).toContain("not split");
    expect(tile(m, "Free")?.grey?.state).toBe("short");
    expect(map(status(3072, null)).grey).toBe("fits");
  });

  test("who holds it unknown: what is used is one tile, and the note says why", () => {
    const gpu = {
      ...status(1229, null),
      holders: [],
      unknown: "Windows' counters could not be read.",
    };
    const m = map(gpu);
    expect(m.tiles.map((t) => [t.name, Math.round(t.value / MiB)])).toEqual([
      ["In use", 6963],
      ["Free", 1229],
    ]);
    expect(m.note).toBe("Who holds it is unknown: Windows' counters could not be read.");
  });

  test("no NVIDIA card is no section; before the first read it is reading", () => {
    expect(gpuMemoryMap(null, [], now)).toBeNull();
    expect(gpuMemoryMap({ loading: true }, [], now)).toEqual({ loading: true });
  });
});

describe("the graphics card's pressure strip", () => {
  test("1.2 GB free of 8 GB: 85 % in use is orange, grey words short is orange, shared green", () => {
    const m = map(status(1229, finalWorker()));
    expect(reading(m, "dedicated")).toMatchObject({
      main: "85 %",
      small: "of 8.0 GB",
      tone: "warning",
    });
    expect(reading(m, "grey")).toMatchObject({
      main: "1.2 GB",
      means: "grey words would not start: 307 MB short",
      tone: "warning",
    });
    expect(reading(m, "shared")).toMatchObject({ main: "211 MB", tone: "good" });
  });

  test("95 % in use is red; 1 GB shared is orange", () => {
    const m = map(status(400, finalWorker(), 1100));
    expect(reading(m, "dedicated")?.tone).toBe("critical");
    expect(reading(m, "shared")).toMatchObject({ main: "1.1 GB", tone: "warning" });
  });

  test("the shared counter missing reads — with no colour", () => {
    const m = map(status(1229, finalWorker(), null));
    expect(reading(m, "shared")).toMatchObject({ main: "—", tone: null, series: [] });
    expect(reading(m, "dedicated")?.tone).toBe("warning");
  });

  test("the last hour, a mean a minute; older reads and missing counters are left out", () => {
    const at = (ago: number, free: number, shared: number | null) => ({
      at: now - ago,
      total: TOTAL,
      free,
      shared,
    });
    const history = [
      at(2 * 3_600_000, 0, 0),
      at(125_000, 4096, 100),
      at(121_000, 2048, 300),
      at(5_000, 1024, null),
    ];
    expect(seriesOf(history, now, (p) => p.free)).toEqual([3072, 1024]);
    expect(seriesOf(history, now, (p) => p.shared)).toEqual([200]);
    const m = map(status(1229, finalWorker()), history);
    expect(reading(m, "dedicated")?.series).toEqual([62.5, 87.5]);
  });
});
