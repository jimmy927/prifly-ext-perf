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

  test("15 % available is short of memory", () => {
    expect(windowsVerdicts({ ...counters, availableMB: 7218 }, info).memory).toBe("warning");
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
