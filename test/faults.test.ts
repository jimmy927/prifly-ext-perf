import { describe, expect, test } from "bun:test";
import { faultsOf } from "../faults";
import { pressureOf } from "../pressure";
import { COUNTERS, type Field, type WindowsCounters } from "../windows";

const none = Object.fromEntries(Object.keys(COUNTERS).map((f) => [f, null])) as Record<Field, null>;
const counters = (over: Partial<WindowsCounters>): WindowsCounters => ({ ...none, at: 0, ...over });

// Read live on 2026-10-30, 17:15.
const live = counters({
  pageFaults: 144_774,
  transitionFaults: 29_619,
  demandZeroFaults: 90_540,
  cacheFaults: 6_851,
  pageReads: 5_964,
});
const processes = [
  { name: "claude", faults: 4_879 },
  { name: "nvdisplay.container", faults: 16_989 },
  { name: "svchost", faults: 10_963 },
  { name: "bun", faults: 8_383 },
  { name: "MsMpEng", faults: 1_373 },
  { name: "rest", faults: 4_561 },
];

const textOf = (c: WindowsCounters) => faultsOf(c, null)?.bars.map((b) => b.text);

describe("the faults under the Trimming reading", () => {
  test("live numbers: five bars, each a share of all page faults", () => {
    const faults = faultsOf(live, processes);
    expect(faults?.bars.map((b) => b.text)).toEqual([
      "back from trimming 30k/s",
      "new zeroed pages 91k/s",
      "from the file cache 7k/s",
      "from disk 6k/s",
      "other kinds 19k/s",
    ]);
    const shares = faults?.bars.map((b) => Math.round(b.share * 100));
    expect(shares).toEqual([20, 63, 5, 4, 13]);
    for (const bar of faults?.bars ?? []) expect(bar.means.endsWith(".")).toBe(true);
  });

  test("the line names the three busiest programs and the faults no process counted", () => {
    expect(faultsOf(live, processes)?.most).toBe(
      "Most faults: nvdisplay.container 17k/s · svchost 11k/s · bun 8k/s · 98k/s in no process's counter",
    );
  });

  test("faults in no process's counter are named only above 10 % of all", () => {
    const covered = [{ name: "bun", faults: 135_000 }];
    expect(faultsOf(live, covered)?.most).toBe("Most faults: bun 135k/s");
    const edge = [{ name: "bun", faults: 144_774 * 0.89 }];
    expect(faultsOf(live, edge)?.most).toBe(
      "Most faults: bun 129k/s · 16k/s in no process's counter",
    );
  });

  test("no per-process read yet, no line", () => {
    expect(faultsOf(live, null)?.most).toBeNull();
    expect(faultsOf(live, [])?.most).toBeNull();
  });

  test("a counter missing leaves its bar out", () => {
    expect(textOf({ ...live, cacheFaults: null })).toEqual([
      "back from trimming 30k/s",
      "new zeroed pages 91k/s",
      "from disk 6k/s",
      "other kinds 19k/s",
    ]);
    expect(textOf({ ...live, transitionFaults: null, pageReads: null })).toEqual([
      "new zeroed pages 91k/s",
      "from the file cache 7k/s",
      "other kinds 54k/s",
    ]);
  });

  test("Page Faults/sec missing leaves other kinds out, and the shares are of the kinds read", () => {
    const faults = faultsOf({ ...live, pageFaults: null }, processes);
    expect(faults?.bars.map((b) => b.key)).toEqual(["transition", "zero", "cache", "disk"]);
    // The cache bar overlaps the others, so the other three make the whole.
    const distinct = faults?.bars.filter((b) => b.key !== "cache");
    expect(distinct?.reduce((sum, b) => sum + b.share, 0)).toBeCloseTo(1);
    // Without the total there is nothing to subtract from.
    expect(faults?.most).toBe("Most faults: nvdisplay.container 17k/s · svchost 11k/s · bun 8k/s");
  });

  test("kinds adding to more than the total are clamped: other is 0 and no bar passes the whole", () => {
    const faults = faultsOf(
      counters({ pageFaults: 100, transitionFaults: 80, pageReads: 60 }),
      null,
    );
    expect(faults?.bars.map((b) => [b.key, b.rate])).toEqual([
      ["transition", 80],
      ["disk", 60],
      ["other", 0],
    ]);
    for (const bar of faults?.bars ?? []) expect(bar.share).toBeLessThanOrEqual(1);
  });

  test("all faults at 0, or no counter at all: none", () => {
    expect(
      faultsOf(
        counters({ pageFaults: 0, transitionFaults: 0, demandZeroFaults: 0, cacheFaults: 0 }),
        processes,
      ),
    ).toBeNull();
    expect(faultsOf(counters({}), processes)).toBeNull();
  });

  test("a counter that is NaN or negative never reaches a bar", () => {
    const faults = faultsOf(
      counters({ pageFaults: 1000, transitionFaults: Number.NaN, cacheFaults: -5 }),
      [{ name: "bun", faults: Number.NaN }],
    );
    expect(faults?.bars.map((b) => b.text)).toEqual([
      "from the file cache 0/s",
      "other kinds 1k/s",
    ]);
    expect(faults?.most).toBe("Most faults: 1k/s in no process's counter");
    expect(faults?.most).not.toContain("NaN");
    for (const bar of faults?.bars ?? []) expect(Number.isNaN(bar.share)).toBe(false);
  });
});

describe("the Trimming reading carries them", () => {
  const info = { name: "W", cores: 16, memTotal: 47 * 2 ** 30 };
  test("only the Trimming reading has faults, and only where some were counted", () => {
    const [commit, trimming, free] = pressureOf(live, info, processes);
    expect(commit?.faults).toBeUndefined();
    expect(free?.faults).toBeUndefined();
    expect(trimming?.faults?.bars).toHaveLength(5);
    expect(pressureOf(counters({}), info)[1]?.faults).toBeUndefined();
  });
});
