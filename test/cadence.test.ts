/**
 * The pace of the reads (`cadence.ts`): every second while the window is open
 * or the chip is not green, every 5 s once nobody has looked and all has been
 * green for a minute — and the chip right and steady through it. Driven
 * through `tick` on a `State` as a host on Windows itself fills it, with
 * `typeperf` and `wsl.exe` faked.
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { FAST, firstPace, IDLE, paceOf, SETTLE } from "../cadence";
import { GpuMonitor } from "../gpu-live";
import { tick } from "../index";
import { newNannyMemory } from "../nanny";
import type { Decoration, ExtensionApi } from "../prifly-api";
import type { State } from "../state";
import { Tables } from "../tables";
import { COUNTERS, type Field, type WindowsCounters } from "../windows";
import { RUN_SECONDS, SLOW_RUN_SECONDS, WindowsSampler } from "../windows-sampler";
import type { LinuxRaw } from "../wsl";
import { parseWslRead, type WslLinux } from "../wsl-exe";

describe("paceOf", () => {
  test("closed and WSL green: a read a second for a minute, then every 5 s", () => {
    let pace = firstPace();
    pace = paceOf(pace, false, true, 1_000);
    expect(pace).toEqual({ every: FAST, quietSince: 1_000 });
    pace = paceOf(pace, false, true, 1_000 + SETTLE - 1);
    expect(pace.every).toBe(FAST);
    pace = paceOf(pace, false, true, 1_000 + SETTLE);
    expect(pace.every).toBe(IDLE);
  });

  test("open, or WSL not green, is a read a second at once, and the minute starts over", () => {
    const idle = { every: IDLE, quietSince: 0 };
    expect(paceOf(idle, true, true, SETTLE * 5)).toEqual({ every: FAST, quietSince: null });
    expect(paceOf(idle, false, false, SETTLE * 5)).toEqual({ every: FAST, quietSince: null });
    const back = paceOf({ every: FAST, quietSince: null }, false, true, SETTLE * 6);
    expect(back).toEqual({ every: FAST, quietSince: SETTLE * 6 });
  });
});

/** A `typeperf` that prints nothing: only its arguments and kills are looked at. */
class FakeTypeperf extends EventEmitter {
  stdout = new PassThrough();
  killed = 0;
  readonly args: string[];
  constructor(args: string[]) {
    super();
    this.args = args;
  }
  kill(): void {
    this.killed++;
  }
}

const sampler = () => {
  const spawned: FakeTypeperf[] = [];
  const windows = new WindowsSampler(1, {
    spawn: (args) => {
      const child = new FakeTypeperf(args);
      spawned.push(child);
      return child;
    },
    later: () => () => {},
    host: { on: () => {}, off: () => {}, listenerCount: () => 0, raise: () => {} } as never,
  });
  // `-si <s> -sc <n>` of the one started last.
  const pace = () => spawned.at(-1)?.args.slice(-4);
  return { windows, spawned, pace };
};

describe("WindowsSampler.setEvery", () => {
  test("ends what runs and starts one at the new pace, a longer run when slower", () => {
    const { windows, spawned, pace } = sampler();
    windows.start();
    expect(pace()).toEqual(["-si", "1", "-sc", String(RUN_SECONDS)]);
    windows.setEvery(5);
    expect(spawned[0]?.killed).toBe(1);
    expect(pace()).toEqual(["-si", "5", "-sc", String(SLOW_RUN_SECONDS / 5)]);
    // The same pace again starts nothing.
    windows.setEvery(5);
    expect(spawned.length).toBe(2);
    windows.setEvery(1);
    expect(spawned[1]?.killed).toBe(1);
    expect(pace()).toEqual(["-si", "1", "-sc", String(RUN_SECONDS)]);
    windows.stop();
  });

  test("before start, or after stop, only the pace changes", () => {
    const { windows, spawned, pace } = sampler();
    windows.setEvery(5);
    expect(spawned.length).toBe(0);
    windows.start();
    expect(pace()?.slice(0, 2)).toEqual(["-si", "5"]);
    windows.stop();
    windows.setEvery(1);
    expect(spawned.length).toBe(1);
  });
});

const GIB = 2 ** 30;
const kb = (gib: number) => Math.round((gib * GIB) / 1024);

/** What `READ`'s `tail` prints in a 4-core, 24 GiB VM with `available` GiB available. */
const tail = (available: number) =>
  [
    "==> /proc/stat <==",
    "cpu  100 0 50 1000 0 0 0 0 0 0",
    ...[0, 1, 2, 3].map((n) => `cpu${n} 25 0 12 250 0 0 0 0 0 0`),
    "procs_running 1",
    "",
    "==> /proc/meminfo <==",
    `MemTotal:       ${kb(24)} kB`,
    `MemFree:        ${kb(available)} kB`,
    `MemAvailable:   ${kb(available)} kB`,
    "SwapTotal:      0 kB",
    "SwapFree:       0 kB",
    "",
    "==> /proc/loadavg <==",
    "0.5 0.4 0.3 1/500 999",
    "",
  ].join("\n");

const none = Object.fromEntries(Object.keys(COUNTERS).map((f) => [f, null])) as Record<Field, null>;

/**
 * A host on Windows itself, its window closed: `wsl.exe` answers each poll at
 * once with `available` GiB available, and every item the chip is sent is kept.
 */
function host() {
  const linux: LinuxRaw[] = [];
  const polls: number[] = [];
  const shown: Decoration[] = [];
  let available = 15;
  // Windows' kernel paged pool: over 2 GB is orange, whatever else.
  let pool = 1 * GIB;
  const wsl = {
    absent: "",
    poll: (now: number) => {
      polls.push(now);
      const raw = parseWslRead(tail(available), now);
      if (raw !== null) linux.push(raw);
    },
    run: () => Promise.reject(new Error("no process table in this test")),
  } as unknown as WslLinux;
  const { windows, spawned, pace } = sampler();
  const api = {
    log: () => {},
    show: (_chips: unknown, items: Decoration[]) => shown.push(...items),
    sessions: () => [],
    notify: () => {},
    prompt: async () => ({ delivered: true }),
    cloud: { sessions: async () => [] },
  } as unknown as ExtensionApi;
  const state: State = {
    api,
    linux,
    linuxAt: 0,
    pace: firstPace(),
    wsl,
    tables: new Tables({ wsl, windows: true, hostPid: 7000, log: () => {} }),
    windows,
    info: { name: "PC", cores: 16, memTotal: 48 * GIB },
    topWindows: [],
    compressed: null,
    compressions: [],
    holders: null,
    topWindowsAt: 0,
    pools: null,
    poolsAt: 0,
    gpu: new GpuMonitor(
      () => {},
      [],
      async () => null,
    ),
    cloud: null,
    cloudAt: 0,
    askedAt: 0,
    askedWindow: 2,
    chip: "",
    nanny: newNannyMemory(),
    nannyUse: null,
    chipped: "",
  };
  windows.start();
  const start = Date.now();
  /** Ticks every second from `from` to `to` seconds after the start, Windows printing a green line each. */
  const run = (from: number, to: number) => {
    for (let s = from; s <= to; s++) {
      const at = start + s * 1000;
      if (s % windows.every === 0) {
        windows.history.push({ ...none, poolPaged: pool, at } as WindowsCounters);
      }
      tick(state, at);
    }
  };
  const setAvailable = (gib: number) => {
    available = gib;
  };
  const pollsBetween = (from: number, to: number) =>
    polls.filter((at) => at >= start + from * 1000 && at <= start + to * 1000).length;
  const setPool = (gib: number) => {
    pool = gib * GIB;
  };
  return { state, run, pace, spawned, shown, setAvailable, setPool, pollsBetween };
}

const SETTLED = SETTLE / 1000;

describe("the pace in the running extension", () => {
  test("closed and green: after a minute, WSL and typeperf every 5 s, and the chip sent once", () => {
    const h = host();
    h.run(0, SETTLED - 1);
    expect(h.pollsBetween(0, SETTLED - 1)).toBe(SETTLED);
    expect(h.pace()?.slice(0, 2)).toEqual(["-si", "1"]);
    h.run(SETTLED, SETTLED + 30);
    expect(h.state.pace.every).toBe(IDLE);
    expect(h.pace()?.slice(0, 2)).toEqual(["-si", "5"]);
    // One read every 5 s after the change, not 30.
    expect(h.pollsBetween(SETTLED + 1, SETTLED + 30)).toBe(6);
    // Green throughout, and sent once: it never flickered.
    expect(h.shown.map((item) => item.tone)).toEqual(["good"]);
    h.state.windows?.stop();
  });

  test("the window opening is a read a second at once, typeperf included", () => {
    const h = host();
    h.run(0, SETTLED + 2);
    expect(h.state.pace.every).toBe(IDLE);
    h.state.askedAt = Date.now();
    const before = h.pollsBetween(0, SETTLED + 3);
    h.run(SETTLED + 3, SETTLED + 3);
    // Read on that very tick, though it was not due at the slower pace.
    expect(h.pollsBetween(0, SETTLED + 3)).toBe(before + 1);
    expect(h.pace()?.slice(0, 2)).toEqual(["-si", "1"]);
    h.run(SETTLED + 4, SETTLED + 8);
    expect(h.pollsBetween(SETTLED + 4, SETTLED + 8)).toBe(5);
    h.state.windows?.stop();
  });

  test("WSL out of memory: the chip turns red within 10 s, as at a read a second, and reads are every second again", () => {
    const h = host();
    h.run(0, SETTLED + 2);
    expect(h.state.pace.every).toBe(IDLE);
    h.setAvailable(1);
    // The 10 s the chip judges are red once two reads 5 s apart are; a read a
    // second needs all ten of its reads red.
    h.run(SETTLED + 3, SETTLED + 12);
    expect(h.shown.at(-1)?.tone).toBe("critical");
    expect(h.shown.at(-1)?.label).toBe("Out of memory in WSL");
    expect(h.state.pace.every).toBe(FAST);
    expect(h.pace()?.slice(0, 2)).toEqual(["-si", "1"]);
    h.run(SETTLED + 13, SETTLED + 17);
    expect(h.pollsBetween(SETTLED + 13, SETTLED + 17)).toBe(5);
    // Green again: a read a second for a whole minute before it slows.
    h.setAvailable(15);
    h.run(SETTLED + 18, SETTLED + 40);
    expect(h.shown.at(-1)?.tone).toBe("good");
    expect(h.state.pace.every).toBe(FAST);
    h.state.windows?.stop();
  });

  test("Windows that stays orange slows down too, its chip sent once", () => {
    const h = host();
    h.setPool(5.2);
    h.run(0, SETTLED + 30);
    expect(h.state.pace.every).toBe(IDLE);
    expect(h.pace()?.slice(0, 2)).toEqual(["-si", "5"]);
    expect(h.shown.map((item) => item.tone)).toEqual(["warning"]);
    expect(h.shown[0]?.label).toBe("Short of memory in Windows");
    h.state.windows?.stop();
  });

  test("Windows turning orange while slow: the chip says so within 10 s, and once", () => {
    const h = host();
    h.run(0, SETTLED + 2);
    expect(h.state.pace.every).toBe(IDLE);
    h.setPool(5.2);
    h.run(SETTLED + 3, SETTLED + 12);
    expect(h.shown.at(-1)?.tone).toBe("warning");
    // Only the chip reads Windows while nobody looks: no faster for it.
    expect(h.state.pace.every).toBe(IDLE);
    h.run(SETTLED + 13, SETTLED + 60);
    // Its words follow the pool's average up; its colour changed once.
    const tones = h.shown.map((item) => item.tone);
    expect(tones.filter((tone, at) => tone !== tones[at - 1])).toEqual(["good", "warning"]);
    h.state.windows?.stop();
  });
});
