import { describe, expect, test } from "bun:test";
import { parseProcStat } from "../procs";
import { COUNTERS, cpuSplit, machineBusy, parseRow, type WindowsCounters } from "../windows";
import { compressionOf, sumByName } from "../windows-top";
import { parseMeminfo, parsePressure, parseStat } from "../wsl";

describe("Linux files", () => {
  test("a pressure file gives some and full", () => {
    const text =
      "some avg10=41.50 avg60=12.00 avg300=3.10 total=45743768\n" +
      "full avg10=0.00 avg60=0.10 avg300=0.00 total=0\n";
    expect(parsePressure(text)).toEqual({
      some: { avg10: 41.5, total: 45743768 },
      full: { avg10: 0, total: 0 },
    });
  });

  test("/proc/stat gives jiffies, idle with iowait, interrupts, and the run queue", () => {
    const text = "cpu  100 0 50 800 50 3 7 0 0 0\ncpu0 1 2 3\nprocs_running 27\nprocs_blocked 0\n";
    expect(parseStat(text)).toEqual({ total: 1010, idle: 850, kernel: 10, runnable: 27 });
  });

  test("/proc/meminfo is read as kB", () => {
    const mem = parseMeminfo("MemTotal:       24000000 kB\nMemAvailable:    7700000 kB\n");
    expect(mem.get("MemAvailable")).toBe(7_700_000);
  });

  test("a comm with spaces and brackets does not shift the fields", () => {
    const fields = ["S", "42", ...Array(9).fill("0"), "300", "200", ...Array(8).fill("0"), "1000"];
    const stat = parseProcStat(`123 (tmux: server) (x)) ${fields.join(" ")}`);
    expect(stat).toEqual({ comm: "tmux: server) (x)", ppid: 42, ticks: 500, rssPages: 1000 });
  });
});

describe("Windows counters", () => {
  const paths = Object.values(COUNTERS);
  const header = `"(PDH-CSV 4.0)",${paths.map((p) => `"\\\\JIMMY-ROG${p}"`).join(",")}`;

  test("a row is read by the header's columns", () => {
    const values = paths.map((_, i) => `"${i + 1}.5"`);
    const row = parseRow(header, `"10/01/2026 11:01:33.105",${values.join(",")}`, 7);
    expect(row?.busy).toBe(1.5);
    expect(row?.wslVm).toBe(paths.length + 0.5);
    expect(row?.at).toBe(7);
  });

  test("the machine's share is the hypervisor's, else Windows' own", () => {
    const values = paths.map((_, i) => `"${i + 1}.5"`);
    const row = parseRow(header, `"10/01/2026 11:01:33.105",${values.join(",")}`, 0);
    if (row === null) throw new Error("no row");
    expect(machineBusy(row)).toBe(paths.indexOf(COUNTERS.machine) + 1.5);
    expect(machineBusy({ ...row, machine: null })).toBe(1.5);
  });

  test("-1 and blanks are null, not zero", () => {
    const values = paths.map((_, i) => (i === 0 ? '"-1"' : '" "'));
    const row = parseRow(header, `"10/01/2026 11:01:33.105",${values.join(",")}`, 0);
    expect(row?.busy).toBeNull();
    expect(row?.queue).toBeNull();
  });

  test("a share past 100 % is dropped, not averaged in", () => {
    const values = paths.map((p) => (p === COUNTERS.machine ? '"4167323.5"' : '"50"'));
    const row = parseRow(header, `"10/01/2026 11:01:33.105",${values.join(",")}`, 0);
    expect(row?.machine).toBeNull();
    expect(row?.wslVm).toBe(50);
  });

  test("typeperf's closing words are no row", () => {
    expect(parseRow(header, "Exiting, please wait...", 0)).toBeNull();
  });

  test("processes are summed by name, in cores, busiest first", () => {
    const out = [
      "c|vmmemwsl|% processor time|1256",
      "c|msedgewebview2|% processor time|50",
      "c|msedgewebview2#1|% processor time|30",
      "c|_total|% processor time|1600",
      "c|idle|% processor time|200",
    ].join("\r\n");
    expect(sumByName(out)).toEqual([
      { name: "vmmemwsl", cpu: 12.56, kernel: 0, commit: 0, ram: 0 },
      { name: "msedgewebview2", cpu: 0.8, kernel: 0, commit: 0, ram: 0 },
    ]);
  });

  test("kernel time is summed by name, in cores; commit and RAM come from the process list", () => {
    const out = [
      "c|docker-desktop|% processor time|92",
      "c|docker-desktop|% privileged time|90",
      "c|bun|% processor time|60",
      "c|bun#1|% processor time|40",
      "c|bun|% privileged time|45",
      "c|bun#1|% privileged time|45",
      "compression|1064304640",
      "memory|77309411328|3221225472|3650722201",
      "0|0|0|System Idle Process|0|8192|0|0||",
      "700|600|639000000000000000|bun.exe|0|3000|0|0|10000|bun test",
      "701|600|639000000000000000|bun.exe|0|500|0|0|3000|bun x",
      // Started after the CPU sample: in the list, not in the counters.
      "702|600|639000000000000000|dwm.exe|0|200|0|0|1650|dwm.exe",
    ].join("\r\n");
    expect(sumByName(out)).toEqual([
      { name: "bun", cpu: 1, kernel: 0.9, commit: 13000, ram: 3500 },
      { name: "docker-desktop", cpu: 0.92, kernel: 0.9, commit: 0, ram: 0 },
      { name: "dwm", cpu: 0, kernel: 0, commit: 1650, ram: 200 },
    ]);
  });

  test("the compression store is its line's bytes, and absent without one", () => {
    expect(compressionOf("bun|% processor time|60\r\ncompression|1064304640\r\n")).toBe(1064304640);
    expect(compressionOf("bun|% processor time|60\r\n")).toBeNull();
    expect(compressionOf("compression|\r\n")).toBeNull();
    expect(compressionOf("compression|-5\r\n")).toBeNull();
  });

  test("user and kernel time are read, and a share past 100 is dropped", () => {
    const values = paths.map((p) =>
      p === COUNTERS.user ? '"30"' : p === COUNTERS.privileged ? '"5000"' : '"7"',
    );
    const row = parseRow(header, `"10/01/2026 11:01:33.105",${values.join(",")}`, 0);
    expect(row?.user).toBe(30);
    expect(row?.privileged).toBeNull();
    expect(row?.transitionFaults).toBe(7);
  });
});

describe("Windows' CPU split", () => {
  const base = Object.fromEntries(Object.keys(COUNTERS).map((field) => [field, null]));
  const counters = (over: Partial<WindowsCounters>): WindowsCounters =>
    ({ ...base, at: 0, ...over }) as WindowsCounters;

  test("the WSL VM's CPU comes out of kernel time (2026-10-29)", () => {
    const split = cpuSplit(counters({ user: 30, privileged: 59, wslVm: 263.66 }), 16);
    expect(split?.user).toBe(30);
    expect(split?.vm).toBeCloseTo(16.48, 2);
    expect(split?.kernel).toBeCloseTo(42.52, 2);
  });

  test("without WSL there is no VM part and kernel time is as Windows counts it", () => {
    expect(cpuSplit(counters({ user: 30, privileged: 59, wslVm: null }), 16)).toEqual({
      user: 30,
      kernel: 59,
      vm: null,
    });
  });

  test("a VM share past kernel time, read a moment apart, leaves Windows' kernel at 0", () => {
    const split = cpuSplit(counters({ user: 30, privileged: 10, wslVm: 400 }), 16);
    expect(split).toEqual({ user: 30, kernel: 0, vm: 10 });
  });

  test("no user or kernel time is no split", () => {
    expect(cpuSplit(counters({ user: null, privileged: 59, wslVm: 100 }), 16)).toBeNull();
    expect(cpuSplit(counters({ user: 30, privileged: null, wslVm: 100 }), 16)).toBeNull();
  });
});
