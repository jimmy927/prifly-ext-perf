/**
 * The host's own Windows processes (`Tables.readWindowsHost`): a CIM and
 * process query that costs the shared PowerShell and WMI, read at once when
 * the window opens and then at most every 10 s. `windowsList` is faked, and
 * the clock is set, so `now` and the samples' `at` agree.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { averageProcs } from "../average";
import { Tables } from "../tables";
import type { WslLinux } from "../wsl-exe";

const START = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOST_PID = 9000;

/** The host's line of `PROCESS_LIST`, with `seconds` of CPU used since it started (100 ns units). */
const listing = (seconds: number) =>
  `${HOST_PID}|8000|639000000000000000|prifly.exe|${seconds * 10_000_000}|300000000|0|0|900000000|prifly.exe`;

/** A host on Windows itself with WSL gone, so only the Windows list is read; `calls` counts its queries. */
function tables() {
  const calls: number[] = [];
  let cpuSeconds = 0;
  const wsl = { absent: "WSL is not running" } as unknown as WslLinux;
  const reads = new Tables({
    wsl,
    windows: true,
    hostPid: HOST_PID,
    windowsList: async () => {
      calls.push(Date.now());
      return listing(cpuSeconds);
    },
    log: () => {},
  });
  /** Moves the clock to `s` seconds after the start, with the host having used `cpu` seconds in all. */
  const tick = async (s: number, cpu = cpuSeconds) => {
    setSystemTime(START + s * 1000);
    cpuSeconds = cpu;
    reads.readAll(310, Date.now());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { reads, calls, tick };
}

afterEach(() => setSystemTime());

describe("the host's Windows processes are read every 10 s", () => {
  test("a read on the tick the window opens, none for 10 s, then one", async () => {
    const { reads, calls, tick } = tables();
    await tick(0);
    expect(calls).toEqual([START]);
    // The prifly tab has the host at once.
    expect(reads.windowsHost).toHaveLength(1);
    for (let s = 1; s < 10; s++) await tick(s);
    expect(calls).toEqual([START]);
    await tick(10);
    expect(calls).toEqual([START, START + 10_000]);
    for (let s = 11; s < 20; s++) await tick(s);
    expect(calls).toHaveLength(2);
    await tick(20);
    expect(calls).toHaveLength(3);
  });

  test("shut and opened again within 10 s: read at once", async () => {
    const { reads, calls, tick } = tables();
    await tick(0);
    await tick(1);
    expect(calls).toHaveLength(1);
    // The panel finds the window shut and opens it: it clears what was kept (`panel` in `index.ts`).
    reads.clear();
    await tick(3);
    expect(calls).toEqual([START, START + 3_000]);
    expect(reads.windowsHost).toHaveLength(1);
    await tick(12);
    expect(calls).toHaveLength(2);
    await tick(13);
    expect(calls).toHaveLength(3);
  });

  test("a read still in flight is not asked again", async () => {
    let release: (out: string) => void = () => {};
    let asked = 0;
    const reads = new Tables({
      wsl: { absent: "gone" } as unknown as WslLinux,
      windows: true,
      hostPid: HOST_PID,
      windowsList: () => {
        asked += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
      log: () => {},
    });
    reads.readAll(310, START);
    reads.readAll(310, START + 20_000);
    expect(asked).toBe(1);
    release(listing(0));
  });
});

describe("the host's rates are over the real time between reads", () => {
  test("CPU used in 10 s over 10 s, whatever the period asked for", async () => {
    const { reads, tick } = tables();
    await tick(0, 100);
    // One read has no two ends: no rate yet, as before.
    expect(averageProcs(reads.windowsHost, 2)?.value[0]?.cpu).toBe(0);
    // Half a core for 10 s.
    await tick(10, 105);
    for (const period of [1, 2, 5, 10, 30]) {
      const host = averageProcs(reads.windowsHost, period);
      expect(host?.covered).toBe(10);
      expect(host?.value[0]?.cpu).toBeCloseTo(0.5, 5);
    }
  });

  test("the samples are kept long enough for a 5 min period", async () => {
    const { reads, tick } = tables();
    for (let s = 0; s <= 300; s += 10) await tick(s, s / 2);
    const host = averageProcs(reads.windowsHost, 300);
    expect(host?.covered).toBe(300);
    expect(host?.value[0]?.cpu).toBeCloseTo(0.5, 5);
  });
});
