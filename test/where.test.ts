import { expect, test } from "bun:test";
// @ts-expect-error: the panel is plain JavaScript
import { whereModel } from "../panel/where.js";

const GB = 2 ** 30;

const state = (wslVmMem: number | null) => ({
  windows: {
    info: { name: "W", cores: 16, memTotal: 48 * GB },
    counters: { availableMB: 28 * 1024, machine: 10, busy: 10, wslVm: null, wslVmMem },
  },
  linux: { sample: { busy: 5, cores: 8, memTotal: 25 * GB, memAvailable: 15 * GB } },
  prifly: null,
  priflyWindows: null,
  others: {
    linux: [],
    windows: [
      { name: "teams", cpu: 0.2, rss: 3 * GB },
      { name: "tiny", cpu: 0, rss: GB / 10 },
    ],
  },
});

test("Windows' memory is what it uses less the VM's working set, not the VM's whole size", () => {
  // 20 GB used on Windows, 7 GB of it the VM's: 13 GB is Windows' own.
  const m = whereModel(state(7 * GB));
  expect(m.memory.win.used).toBe(13 * GB);
});

test("without the working set, what Linux uses in the VM stands in for it", () => {
  const m = whereModel(state(null));
  expect(m.memory.win.used).toBe(10 * GB);
});

test("the biggest programs are named out of Windows' Other, the small ones stay in it", () => {
  const m = whereModel(state(7 * GB));
  expect(m.memory.win.named).toEqual([{ name: "teams", value: 3 * GB }]);
  expect(m.memory.win.rest).toBe(10 * GB);
  expect(m.memory.win.other).toBe(13 * GB);
});

test("a Windows program's memory segment is its RAM, and carries its commit for the tooltip", () => {
  const s = state(7 * GB);
  s.others.windows = [{ name: "teams", cpu: 2, rss: 3 * GB, commit: 5 * GB }] as never;
  const m = whereModel(s);
  expect(m.memory.win.named).toEqual([{ name: "teams", value: 3 * GB, commit: 5 * GB }]);
  // The CPU row names it too, with no commit.
  expect(m.cpu.win.named).toEqual([{ name: "teams", value: expect.any(Number) }]);
});
