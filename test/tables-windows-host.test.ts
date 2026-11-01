/**
 * The host's own Windows processes: the listing `topProcesses` makes every 10 s
 * for the Memory tab also gives the host's tree (`Tables.keepWindowsHost`), and
 * one read of the list alone, 1 s after the first, gives the rates their second
 * end. `topProcesses` and the list are faked, and the clock is set, so `now`
 * and the samples' `at` agree.
 */

import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { averageProcs } from "../average";
import type { State } from "../state";
import { Tables } from "../tables";
import * as realTop from "../windows-top";
import type { WslLinux } from "../wsl-exe";

const START = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOST_PID = 9000;

/** What `topProcesses` is asked, when, and what it answers next; `fail` rejects it. */
const top = { calls: [] as number[], out: "", fail: false };
mock.module("../windows-top", () => ({
  ...realTop,
  topProcesses: async () => {
    top.calls.push(Date.now());
    if (top.fail) throw new Error("powershell is gone");
    return { processes: [], compressed: null, out: top.out };
  },
}));
const { opened, refreshWhileOpen } = await import("../index");

/** The host's line of `PROCESS_LIST`, with `seconds` of CPU used since it started (100 ns units). */
const listing = (seconds: number) =>
  `${HOST_PID}|8000|639000000000000000|prifly.exe|${seconds * 10_000_000}|300000000|0|0|900000000|prifly.exe`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A host on Windows itself with WSL gone, so only the Windows lists are read; `lists` counts the early reads. */
function host(listFails = false) {
  const lists: number[] = [];
  const logged: string[] = [];
  let cpuSeconds = 0;
  const wsl = { absent: "WSL is not running" } as unknown as WslLinux;
  const tables = new Tables({
    wsl,
    windows: true,
    hostPid: HOST_PID,
    windowsList: async () => {
      lists.push(Date.now());
      if (listFails) throw new Error("no list");
      return listing(cpuSeconds);
    },
    // The per-second read (`windows-host-live.test.ts`): nothing running, so the tree stands.
    windowsLive: async () => "",
    log: (event) => logged.push(event),
  });
  const state = {
    api: { log: (event: string) => logged.push(event) },
    tables,
    windows: { history: [] },
    gpu: { refresh: () => {} },
    topWindowsAt: 0,
    // Never due: the cloud sessions are not what is tested.
    cloudAt: Number.MAX_SAFE_INTEGER,
    compressions: [],
    compressed: null,
    holders: null,
    topWindows: [],
    poolsAt: 0,
  } as unknown as State;
  top.calls = [];
  top.fail = false;
  /** Moves the clock to `s` seconds after the start, with the host having used `cpu` seconds in all. */
  const tick = async (s: number, cpu = cpuSeconds) => {
    setSystemTime(START + s * 1000);
    cpuSeconds = cpu;
    top.out = listing(cpu);
    refreshWhileOpen(state);
    await settle();
  };
  /** The panel finds the window shut and opens it. */
  const open = async (s: number) => {
    setSystemTime(START + s * 1000);
    top.out = listing(cpuSeconds);
    opened(state);
    await settle();
  };
  return { tables, lists, logged, tick, open };
}

afterEach(() => setSystemTime());

describe("the host's Windows processes come from the listing of the Memory tab", () => {
  test("open: the tree is filled by the first answer, the second reading comes early, then one listing per 10 s", async () => {
    const { tables, lists, open, tick } = host();
    await open(0);
    expect(top.calls).toEqual([START]);
    expect(tables.windowsHost).toHaveLength(1);
    // Within a second of the first answer: no second reading yet.
    await tick(0);
    expect(lists).toHaveLength(0);
    await tick(1);
    expect(lists).toEqual([START + 1_000]);
    expect(tables.windowsHost).toHaveLength(2);
    // Then nothing but the listing, every 10 s.
    for (let s = 2; s <= 10; s++) await tick(s);
    expect(top.calls).toEqual([START]);
    await tick(11);
    expect(top.calls).toEqual([START, START + 11_000]);
    for (let s = 12; s <= 21; s++) await tick(s);
    expect(top.calls).toHaveLength(2);
    await tick(22);
    expect(top.calls).toHaveLength(3);
    expect(lists).toHaveLength(1);
    expect(tables.windowsHost).toHaveLength(4);
  });

  test("shut and opened again within 10 s: the same again", async () => {
    const { tables, lists, open, tick } = host();
    await open(0);
    await tick(1);
    await tick(3);
    expect(top.calls).toHaveLength(1);
    expect(lists).toHaveLength(1);
    // The panel clears what was kept, and the listing is asked at once, not at 10 s.
    await open(4);
    expect(top.calls).toEqual([START, START + 4_000]);
    expect(tables.windowsHost).toHaveLength(1);
    await tick(4);
    expect(lists).toHaveLength(1);
    await tick(5);
    expect(lists).toEqual([START + 1_000, START + 5_000]);
    expect(tables.windowsHost).toHaveLength(2);
    for (let s = 6; s <= 14; s++) await tick(s);
    expect(top.calls).toHaveLength(2);
    await tick(15);
    expect(top.calls).toHaveLength(3);
  });

  test("a listing without the process list keeps the last tree and is logged", async () => {
    const { tables, logged, open, tick } = host();
    await open(0);
    await tick(1);
    expect(tables.windowsHost).toHaveLength(2);
    // The script's `listerr|` line in place of the list.
    tables.keepWindowsHost("listerr|Access denied", 310);
    expect(tables.windowsHost).toHaveLength(2);
    expect(logged).toEqual(["windows_host_failed"]);
  });

  test("the whole call rejecting keeps the last tree and is logged", async () => {
    const { tables, logged, open, tick } = host();
    await open(0);
    await tick(1);
    top.fail = true;
    await tick(11);
    expect(top.calls).toHaveLength(2);
    expect(tables.windowsHost).toHaveLength(2);
    expect(logged).toEqual(["top_failed"]);
  });

  test("an early read that fails is logged once, not every second", async () => {
    const { tables, logged, lists, open, tick } = host(true);
    await open(0);
    for (let s = 1; s <= 5; s++) await tick(s);
    expect(lists).toHaveLength(1);
    expect(logged).toEqual(["windows_host_failed"]);
    expect(tables.windowsHost).toHaveLength(1);
  });
});

describe("the host's rates are over the real time between readings", () => {
  test("CPU used in 10 s over 10 s, whatever the period asked for", async () => {
    const { tables, open, tick } = host();
    await open(0);
    // One reading has no two ends: no rate yet.
    expect(averageProcs(tables.windowsHost, 2)?.value[0]?.cpu).toBe(0);
    // The early second one, 1 s on, has the host at half a core.
    await tick(1, 0.5);
    expect(averageProcs(tables.windowsHost, 2)?.value[0]?.cpu).toBeCloseTo(0.5, 5);
    // Half a core for the next 10 s.
    await tick(11, 5.5);
    for (const period of [1, 2, 5, 10, 30]) {
      const average = averageProcs(tables.windowsHost, period);
      // A period of 30 s reaches back to the first reading, 11 s.
      expect(average?.covered).toBe(period === 30 ? 11 : 10);
      expect(average?.value[0]?.cpu).toBeCloseTo(0.5, 5);
    }
  });

  test("the samples are kept long enough for a 5 min period", async () => {
    const { tables, open, tick } = host();
    await open(0);
    for (let s = 1; s <= 303; s++) await tick(s, s / 2);
    const average = averageProcs(tables.windowsHost, 300);
    expect(average?.covered).toBeGreaterThanOrEqual(290);
    expect(average?.value[0]?.cpu).toBeCloseTo(0.5, 5);
  });
});
