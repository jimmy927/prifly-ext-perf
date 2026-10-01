import { describe, expect, test } from "bun:test";
import { headline, linuxVerdicts, windowsVerdicts } from "../verdict";
import type { WindowsCounters } from "../windows";
import type { LinuxSample } from "../wsl";

const calm = { some: { avg10: 0, avg60: 0 }, full: { avg10: 0, avg60: 0 } };
const GB = 2 ** 30;

function linux(over: Partial<LinuxSample>): LinuxSample {
  return {
    at: 0,
    cores: 16,
    busy: 10,
    runnable: 2,
    load: [1, 1, 1],
    memTotal: 24 * GB,
    memAvailable: 8 * GB,
    swapTotal: 0,
    swapUsed: 0,
    diskRead: 0,
    diskWrite: 0,
    cpu: calm,
    memory: calm,
    io: calm,
    ...over,
  };
}

describe("Linux", () => {
  test("calm is good", () => {
    expect(linuxVerdicts(linux({}))).toEqual({ cpu: "good", memory: "good", disk: "good" });
  });

  test("tasks stalled on CPU 41 % of the time is out of CPU", () => {
    const stalled = { ...calm, some: { avg10: 41, avg60: 20 } };
    expect(linuxVerdicts(linux({ cpu: stalled })).cpu).toBe("critical");
  });

  test("40 % free with stalls of 0.6 % is fine (2026-10-01)", () => {
    const light = { some: { avg10: 1.2, avg60: 1 }, full: { avg10: 0.6, avg60: 0.4 } };
    expect(linuxVerdicts(linux({ memAvailable: 9.2 * GB, memory: light })).memory).toBe("good");
  });

  test("stalls on memory a person would feel are short, thrashing is out", () => {
    const some = { some: { avg10: 25, avg60: 10 }, full: { avg10: 2, avg60: 1 } };
    const full = { some: { avg10: 30, avg60: 20 }, full: { avg10: 8, avg60: 5 } };
    const thrash = { some: { avg10: 60, avg60: 50 }, full: { avg10: 35, avg60: 30 } };
    expect(linuxVerdicts(linux({ memory: some })).memory).toBe("warning");
    expect(linuxVerdicts(linux({ memory: full })).memory).toBe("warning");
    expect(linuxVerdicts(linux({ memory: thrash })).memory).toBe("critical");
  });

  test("under 10 % available is out of memory before anything stalls", () => {
    expect(linuxVerdicts(linux({ memAvailable: 2 * GB })).memory).toBe("critical");
  });

  test("without PSI, a run queue of twice the cores is red", () => {
    expect(linuxVerdicts(linux({ cpu: null, runnable: 32 })).cpu).toBe("critical");
    expect(linuxVerdicts(linux({ cpu: null, runnable: 20 })).cpu).toBe("warning");
  });
});

describe("Windows", () => {
  const info = { name: "W", cores: 16, memTotal: 47 * GB };
  const counters = {
    at: 0,
    busy: 30,
    queue: 0,
    availableMB: 20_000,
    committed: 70,
    pagesOut: 0,
    pageFile: 5,
    diskIdle: 99,
    readLatency: 0.002,
    writeLatency: 0.001,
    diskQueue: 0,
    diskRead: 0,
    diskWrite: 0,
    wslVm: 100,
  } satisfies WindowsCounters;

  test("a queue over two per core is out of CPU", () => {
    expect(windowsVerdicts({ ...counters, queue: 40 }, info).cpu).toBe("critical");
  });

  test("18 % available, 70 % committed and no paging is fine", () => {
    const calmDay = { ...counters, availableMB: 8900, committed: 70, pagesOut: 0 };
    expect(windowsVerdicts(calmDay, info).memory).toBe("good");
  });

  test("under 10 % available is short, under 5 % out", () => {
    expect(windowsVerdicts({ ...counters, availableMB: 4000 }, info).memory).toBe("warning");
    expect(windowsVerdicts({ ...counters, availableMB: 2000 }, info).memory).toBe("critical");
  });

  test("commit charge near the limit is short of memory however much is available", () => {
    expect(windowsVerdicts({ ...counters, committed: 92 }, info).memory).toBe("warning");
    expect(windowsVerdicts({ ...counters, committed: 98 }, info).memory).toBe("critical");
  });

  test("writing to the page file is short of memory", () => {
    expect(windowsVerdicts({ ...counters, pagesOut: 500 }, info).memory).toBe("warning");
    expect(windowsVerdicts({ ...counters, pagesOut: 5000 }, info).memory).toBe("critical");
  });

  test("reads at 30 ms are out of disk", () => {
    expect(windowsVerdicts({ ...counters, readLatency: 0.03 }, info).disk).toBe("critical");
  });
});

test("the headline names the worst first", () => {
  const out = headline([
    { name: "WSL", verdicts: { cpu: "critical", memory: "good", disk: "good" } },
    { name: "Windows", verdicts: { cpu: "critical", memory: "warning", disk: "good" } },
  ]);
  expect(out).toEqual({
    tone: "critical",
    text: "Out of CPU in WSL. Out of CPU in Windows. Short of memory in Windows.",
  });
  expect(
    headline([{ name: "WSL", verdicts: { cpu: "good", memory: "good", disk: "good" } }]).tone,
  ).toBe("good");
});
