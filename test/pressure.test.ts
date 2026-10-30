import { describe, expect, test } from "bun:test";
import { historyOf } from "../history";
import { pressureOf, reallyFree } from "../pressure";
import { TRIMMING_CRITICAL, TRIMMING_WARNING } from "../verdict";
import { COUNTERS, type Field, type WindowsCounters } from "../windows";

const GB = 2 ** 30;
const none = Object.fromEntries(Object.keys(COUNTERS).map((f) => [f, null])) as Record<Field, null>;
const counters = (over: Partial<WindowsCounters>): WindowsCounters => ({ ...none, at: 0, ...over });
const info = (gb: number) => ({ name: "W", cores: 16, memTotal: gb * GB });

/** Standby plus free that add up to `total` GB, `empty` of it free. */
const ram = (total: number, empty: number) => ({
  standbyCore: 0,
  standbyNormal: (total - empty) * GB,
  standbyReserve: 0,
  free: empty * GB,
  availableMB: total * 1024,
});

describe("the pressure strip", () => {
  test("91 %, 11k/s and 9.1 GB free of 47 GB: orange, green, green", () => {
    const c = counters({
      committed: 91,
      commitLimit: 75 * GB,
      transitionFaults: 11_000,
      ...ram(9.1, 0.4),
    });
    const [commit, trimming, free] = pressureOf(c, info(47));
    expect([commit?.main, commit?.small, commit?.tone]).toEqual(["91 %", "of 75.0 GB", "warning"]);
    expect([trimming?.main, trimming?.tone]).toEqual(["11k pages/s", "good"]);
    expect([free?.main, free?.small, free?.tone]).toEqual(["9.1 GB", "0.4 GB empty", "good"]);
  });

  test("96 %, 150k/s and 1.5 GB free of 16 GB: orange, red, orange", () => {
    const c = counters({
      committed: 96,
      commitLimit: 20 * GB,
      transitionFaults: 150_000,
      ...ram(1.5, 0.1),
    });
    expect(pressureOf(c, info(16)).map((r) => r.tone)).toEqual(["warning", "critical", "warning"]);
  });

  test("the bands are the verdict's own", () => {
    const trimming = (n: number) =>
      pressureOf(counters({ transitionFaults: n }), info(47))[1]?.tone;
    expect(trimming(TRIMMING_WARNING - 1)).toBe("good");
    expect(trimming(TRIMMING_WARNING)).toBe("warning");
    expect(trimming(TRIMMING_CRITICAL)).toBe("critical");
    const commit = (n: number) => pressureOf(counters({ committed: n }), info(47))[0]?.tone;
    expect([commit(89), commit(90), commit(96.9), commit(97)]).toEqual([
      "good",
      "warning",
      "warning",
      "critical",
    ]);
  });

  test("a missing counter reads — with no colour, never 0 or NaN", () => {
    const readings = pressureOf(counters({}), info(47));
    expect(readings.map((r) => [r.main, r.small, r.tone])).toEqual([
      ["—", "", null],
      ["—", "", null],
      ["—", "", null],
    ]);
  });

  test("without a commit limit or the standby counters the number stands alone", () => {
    const c = counters({ committed: 50, availableMB: 8192 });
    const [commit, , free] = pressureOf(c, info(47));
    expect(commit?.small).toBe("");
    expect([free?.main, free?.small, free?.tone]).toEqual(["8.0 GB", "", "good"]);
    expect(reallyFree(counters({}))).toBeNull();
  });
});

describe("the strip's history", () => {
  test("a point carries the three series, null where the counter is missing", () => {
    const lines = [
      counters({ at: 1000, committed: 80, transitionFaults: 500, availableMB: 2048 }),
      counters({ at: 2000, committed: 82, transitionFaults: 700, availableMB: 2048 }),
    ];
    const [point] = historyOf([], lines, info(47), 10);
    expect(point?.windows?.committed).toBe(81);
    expect(point?.windows?.trimming).toBe(600);
    expect(point?.windows?.free).toBe(2 * GB);
    const [bare] = historyOf([], [counters({ at: 1000 })], info(47), 10);
    expect(bare?.windows).toMatchObject({ committed: null, trimming: null, free: null });
  });
});
