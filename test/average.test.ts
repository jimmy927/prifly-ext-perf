import { expect, test } from "bun:test";
import { averageLinux, averageProcs, averageWindows, windowOf } from "../average";
import type { ProcReading, ProcSnapshot } from "../procs";
import { HOUR, keep, windowEnds } from "../ring";
import type { WindowsCounters } from "../windows";
import type { LinuxRaw } from "../wsl";

const T0 = 1_000_000;

function raw(second: number, over: Partial<LinuxRaw> = {}): LinuxRaw {
  return {
    at: T0 + second * 1000,
    cores: 4,
    total: 0,
    idle: 0,
    kernel: 0,
    pgpgin: 0,
    pgpgout: 0,
    runnable: 1,
    load: [1, 1, 1],
    memTotal: 8000,
    memAvailable: 4000,
    swapTotal: 0,
    swapUsed: 0,
    cpu: null,
    memory: null,
    io: null,
    ...over,
  };
}

/** One read a second for `seconds`, with `make` saying what each one holds. */
function linuxRing(seconds: number, make: (second: number) => Partial<LinuxRaw>): LinuxRaw[] {
  return Array.from({ length: seconds + 1 }, (_, second) => raw(second, make(second)));
}

function reading(pid: number, ticks: number, over: Partial<ProcReading> = {}): ProcReading {
  return { pid, ppid: 1, comm: "p", argv: [], rss: 100, ticks, read: 0, write: 0, ...over };
}

function snapshot(second: number, ...procs: ProcReading[]): ProcSnapshot {
  return { at: T0 + second * 1000, procs: new Map(procs.map((p) => [p.pid, p])) };
}

test("a rate is the counter's change over the window, so a 2 s spike in 30 s counts 1/15", () => {
  // 4 cores, 400 jiffies a second all idle, except seconds 10-11: all busy.
  let total = 0;
  let idle = 0;
  const ring = linuxRing(30, (second) => {
    if (second > 0) {
      total += 400;
      idle += second === 11 || second === 12 ? 0 : 400;
    }
    return { total, idle };
  });
  const average = averageLinux(ring, 30);
  // 800 busy jiffies of 12000: 1/15 of the time, not 100 %.
  expect(average?.value.busy).toBeCloseTo(100 / 15, 6);
  expect(average?.covered).toBe(30);
});

test("disk rates are bytes of the counter's change over the elapsed time", () => {
  const ring = linuxRing(10, (second) => ({
    pgpgin: second * 2,
    pgpgout: second === 10 ? 1000 : 0,
  }));
  const average = averageLinux(ring, 10);
  // 20 kB in 10 s, and 1000 kB written once.
  expect(average?.value.diskRead).toBeCloseTo(2 * 1024, 6);
  expect(average?.value.diskWrite).toBeCloseTo(100 * 1024, 6);
});

test("a window uses the samples inside it, not older ones", () => {
  // Busy for the first 30 s, idle for the last 5.
  let total = 0;
  let idle = 0;
  const ring = linuxRing(35, (second) => {
    if (second > 0) {
      total += 100;
      idle += second > 30 ? 100 : 0;
    }
    return { total, idle };
  });
  expect(averageLinux(ring, 5)?.value.busy).toBe(0);
  expect(averageLinux(ring, 30)?.value.busy).toBeCloseTo((100 * 25) / 30, 6);
});

test("a process born mid-window counts what it used since, over the window", () => {
  const ring = [
    snapshot(0, reading(1, 0)),
    ...Array.from({ length: 30 }, (_, i) =>
      i + 1 < 20
        ? snapshot(i + 1, reading(1, (i + 1) * 100))
        : snapshot(i + 1, reading(1, (i + 1) * 100), reading(2, 1000 + (i - 19) * 100)),
    ),
  ];
  const average = averageProcs(ring, 30);
  const byPid = new Map(average?.value.map((p) => [p.pid, p]));
  // Pid 1 used one core all along.
  expect(byPid.get(1)?.cpu).toBeCloseTo(1, 6);
  // Pid 2's first sample (second 20) is its start: 10 s of one core, spread over 30 s.
  expect(byPid.get(2)?.cpu).toBeCloseTo(10 / 30, 6);
});

test("a process's disk use is its counters' change over the window", () => {
  const ring = [
    snapshot(0, reading(1, 0, { read: 1000, write: 0 })),
    snapshot(5, reading(1, 0, { read: 6000, write: 500 })),
  ];
  const [only] = averageProcs(ring, 5)?.value ?? [];
  expect(only?.read).toBeCloseTo(1000, 6);
  expect(only?.write).toBeCloseTo(100, 6);
});

test("a process that ended inside the window is not listed, a reused pid never goes negative", () => {
  const ring = [snapshot(0, reading(1, 500), reading(2, 100)), snapshot(2, reading(1, 100))];
  const average = averageProcs(ring, 2);
  expect(average?.value.map((p) => p.pid)).toEqual([1]);
  expect(average?.value[0]?.cpu).toBe(0);
});

test("levels are the mean of the samples in the window", () => {
  const ring = linuxRing(10, (second) => ({
    memAvailable: second * 100,
    runnable: second % 2 === 0 ? 4 : 0,
    load: [second, 0, 0],
  }));
  const average = averageLinux(ring, 4);
  // Seconds 7-10 are inside a window of 4 s ending at 10; second 6 starts it.
  expect(average?.value.memAvailable).toBeCloseTo(850, 6);
  expect(average?.value.runnable).toBeCloseTo(2, 6);
  expect(average?.value.load[0]).toBeCloseTo(8.5, 6);
});

test("time stalled is exact over the window, and stays absent without PSI", () => {
  // Calm but for 2 s fully stalled at seconds 29-30; the kernel's avg10 says 99 throughout.
  const stalled = (second: number) => Math.min(Math.max(second - 28, 0), 2) * 1_000_000;
  const ring = linuxRing(30, (second) => ({
    cpu: {
      some: { avg10: 99, total: stalled(second) },
      full: { avg10: 99, total: stalled(second) / 2 },
    },
  }));
  expect(averageLinux(ring, 30)?.value.cpu?.some).toBeCloseTo(100 / 15, 6);
  expect(averageLinux(ring, 30)?.value.cpu?.full).toBeCloseTo(100 / 30, 6);
  expect(averageLinux(ring, 1)?.value.cpu?.some).toBeCloseTo(100, 6);
  expect(averageLinux(ring, 2)?.value.memory).toBeNull();
});

test("one read has no window yet, so it takes the kernel's last 10 s", () => {
  const ring = [raw(0, { cpu: { some: { avg10: 12, total: 5 }, full: { avg10: 3, total: 1 } } })];
  expect(averageLinux(ring, 30)?.value.cpu).toEqual({ some: 12, full: 3 });
});

test("Windows counters average over the lines that had them", () => {
  const line = (second: number, busy: number | null): WindowsCounters => ({
    at: T0 + second * 1000,
    busy,
    queue: 0,
    availableMB: second * 10,
    committed: null,
    pagesOut: null,
    pageFile: null,
    diskIdle: null,
    readLatency: null,
    writeLatency: null,
    diskQueue: null,
    diskRead: null,
    diskWrite: null,
    machine: null,
    wslVm: null,
  });
  const ring = [line(0, 10), line(1, 20), line(2, null), line(3, 60)];
  const average = averageWindows(ring, 3);
  expect(average?.value.busy).toBeCloseTo(40, 6);
  expect(average?.value.availableMB).toBeCloseTo(20, 6);
  expect(average?.value.committed).toBeNull();
});

test("before a window has filled it averages what there is and says how long that is", () => {
  const ring = linuxRing(8, (second) => ({ total: second * 100, idle: second * 50 }));
  const average = averageLinux(ring, 30);
  expect(average?.covered).toBe(8);
  expect(average?.value.busy).toBeCloseTo(50, 6);
  expect(averageLinux(ring.slice(0, 1), 30)?.covered).toBe(0);
  expect(averageLinux([], 30)).toBeNull();
});

test("a window ends at the sample asked for, so sparklines can look back", () => {
  const ring = linuxRing(20, (second) => ({ memAvailable: second * 10 }));
  const ends = windowEnds(ring, 5);
  // Whole windows ending at 20, 15, 10 and 5 s.
  expect(ends).toEqual([5, 10, 15, 20]);
  expect(averageLinux(ring, 5, 10)?.value.memAvailable).toBeCloseTo(80, 6);
});

test("sparklines keep at most 60 windows, and at most an hour", () => {
  const ring = linuxRing(600, () => ({}));
  expect(windowEnds(ring, 1)).toHaveLength(60);
  expect(windowEnds(ring, 10)).toHaveLength(60);
  expect(windowEnds(ring, 300)).toHaveLength(2);
});

test("the ring forgets what is older than an hour", () => {
  const ring: LinuxRaw[] = [];
  for (let second = 0; second <= HOUR + 5; second += 1) keep(ring, raw(second), HOUR);
  expect(ring).toHaveLength(HOUR + 1);
  expect(ring[0]?.at).toBe(T0 + 5000);
});

test("only the offered windows are accepted", () => {
  for (const ok of ["1", "2", "5", "10", "30", "60", "300"]) expect(windowOf(ok)).toBe(Number(ok));
  expect(windowOf(undefined)).toBe(2);
  for (const bad of ["0", "3", "120", "abc", ""])
    expect(() => windowOf(bad)).toThrow("No such window");
});
