// What uses Windows' CPU now and who holds its memory: one script in the shared
// PowerShell (`windows.ts`) every 10 s while the window is open, and what its
// output says by program. `holders.ts` groups the same output by what each
// process is.

import { PROCESS_LIST, powershell, windowsRowsOf } from "./windows";

/**
 * A program's processes added up: cores busy, of them cores in the kernel, its
 * commit (private bytes, in RAM or not) and its working set (what is in RAM).
 */
export type WindowsProcess = {
  name: string;
  cpu: number;
  kernel: number;
  commit: number;
  ram: number;
};

/**
 * `topProcesses`' answer: the processes, the compression store's size in
 * bytes (null where it was not read), and what the script printed, for
 * `holdersOf`.
 */
export type WindowsTop = { processes: WindowsProcess[]; compressed: number | null; out: string };

/**
 * What uses Windows' CPU now, and who holds its memory, in one script: every
 * process's CPU over two seconds, in cores, and of it the kernel's (`c|…`
 * lines); the memory compression store's size, the working set of the
 * `Memory Compression` process, which the Process counters leave out; the
 * committed bytes and the kernel's two pools
 * (`memory|committed|paged|non-paged`); and every process as
 * `windowsProcessList` prints it, with its commit. The memory counters and the
 * process list fail apart from the CPU (`memerr|…`, `listerr|…`).
 */
export async function topProcesses(): Promise<WindowsTop> {
  const out = await powershell(
    // A process that ends mid-sample makes Get-Counter say "data in one of the
    // performance counter samples is not valid" and still return the rest:
    // silenced, so it is not taken for a failure.
    "(Get-Counter '\\Process(*)\\% Processor Time','\\Process(*)\\% Privileged Time' -SampleInterval 2 -MaxSamples 1 -ErrorAction SilentlyContinue).CounterSamples | " +
      // Invariant culture: a Swedish Windows writes 12,5 otherwise.
      "% { [string]::Format([Globalization.CultureInfo]::InvariantCulture, 'c|{0}|{1}|{2}', $_.InstanceName, $_.Path.Split('\\')[-1], $_.CookedValue) }; " +
      "Get-Process -Name 'Memory Compression' -ErrorAction SilentlyContinue | % { 'compression|' + $_.WorkingSet64 }; " +
      "try { $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property CommittedBytes,PoolPagedBytes,PoolNonpagedBytes; " +
      "[string]::Format([Globalization.CultureInfo]::InvariantCulture, 'memory|{0}|{1}|{2}', $m.CommittedBytes, $m.PoolPagedBytes, $m.PoolNonpagedBytes) } " +
      "catch { 'memerr|' + $_.Exception.Message }; " +
      `try { ${PROCESS_LIST} } catch { 'listerr|' + $_.Exception.Message }`,
    20_000,
  );
  return { processes: sumByName(out), compressed: compressionOf(out), out };
}

/** The compression store's bytes from `topProcesses`' `compression|<bytes>` line; null without one. */
export function compressionOf(out: string): number | null {
  const digits = /^compression\|(\d+)\s*$/m.exec(out)?.[1];
  return digits === undefined ? null : Number(digits);
}

/**
 * `topProcesses`' processes by program, busiest first: CPU and kernel time in
 * cores from its `c|` lines, instances of one program (#1, #2) added up; commit
 * and working set from its process list, by the same lower-case name without
 * `.exe`. A process that ended between the two reads is in one and not the
 * other: its program counts 0 for what the other would have said.
 */
export function sumByName(out: string): WindowsProcess[] {
  const byName = new Map<string, WindowsProcess>();
  const entry = (name: string) => {
    const found = byName.get(name) ?? { name, cpu: 0, kernel: 0, commit: 0, ram: 0 };
    byName.set(name, found);
    return found;
  };
  for (const line of out.split(/\r?\n/)) {
    const [kind, instance, counter, value] = line.split("|");
    if (kind !== "c" || instance === undefined || counter === undefined) continue;
    const name = instance.replace(/#\d+$/, "");
    if (name === "_total" || name === "idle") continue;
    const cores = (Number(value) || 0) / 100;
    if (counter.startsWith("% processor")) entry(name).cpu += cores;
    else if (counter.startsWith("% privileged")) entry(name).kernel += cores;
  }
  for (const row of windowsRowsOf(out).values()) {
    // The idle process: no program.
    if (row.pid === 0) continue;
    const program = entry(row.comm.toLowerCase());
    program.commit += row.commit;
    program.ram += row.rss;
  }
  return [...byName.values()].sort((a, b) => b.cpu - a.cpu);
}
