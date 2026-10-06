import { describe, expect, test } from "bun:test";
import { parseProcStat } from "../procs";
import { COUNTERS, machineBusy, parseRow, sumByName } from "../windows";
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

  test("/proc/stat gives jiffies, idle with iowait, and the run queue", () => {
    const text = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3\nprocs_running 27\nprocs_blocked 0\n";
    expect(parseStat(text)).toEqual({ total: 1000, idle: 850, runnable: 27 });
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

  test("typeperf's closing words are no row", () => {
    expect(parseRow(header, "Exiting, please wait...", 0)).toBeNull();
  });

  test("processes are summed by name, in cores, busiest first", () => {
    const out = [
      "vmmemwsl|% processor time|1256",
      "msedgewebview2|% processor time|50",
      "msedgewebview2#1|% processor time|30",
      "msedgewebview2#1|working set - private|1000",
      "_total|% processor time|1600",
      "idle|% processor time|200",
    ].join("\r\n");
    expect(sumByName(out)).toEqual([
      { name: "vmmemwsl", cpu: 12.56, memory: 0 },
      { name: "msedgewebview2", cpu: 0.8, memory: 1000 },
    ]);
  });
});
