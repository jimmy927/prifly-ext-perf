/**
 * Windows' view, read from inside WSL or on Windows itself (`host.ts` says
 * where the tools are): one `typeperf.exe` at a time, always running, that
 * prints the counters below every second as CSV (`windows-sampler.ts`) — about two seconds to start,
 * where a PowerShell per poll would cost that every time. Which processes use the CPU
 * comes from one PowerShell that stays running too (`topProcesses` in
 * `windows-top.ts`), and so,
 * on a host on Windows itself, do the host's own processes (`hostTreeOf`).
 *
 * On a Linux with no Windows around it there is no Windows to read:
 * `windowsTools()` is false and the panel shows Linux alone.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { HOST } from "./host";
import { type HostProcess, hookHostExit, realProcess } from "./host-exit";
import type { ProcReading, ProcSnapshot } from "./procs";
import { ScriptShell, type ShellChild } from "./shell";

const { system32: SYSTEM32, typeperf: TYPEPERF, powershell: POWERSHELL } = HOST;

/** Counter path → field, in the order `typeperf` is given them. */
export const COUNTERS = {
  busy: "\\Processor(_Total)\\% Processor Time",
  // Busy split in two: programs' own code, and the kernel working for them.
  // Windows counts the WSL VM's whole guest, Linux programs included, as
  // kernel time: `\Process(vmmemwsl)\% Privileged Time` equals its
  // `% Processor Time` (263.66 both, 2026-10-29). `cpuSplit` takes it out.
  user: "\\Processor(_Total)\\% User Time",
  privileged: "\\Processor(_Total)\\% Privileged Time",
  queue: "\\System\\Processor Queue Length",
  availableMB: "\\Memory\\Available MBytes",
  committed: "\\Memory\\% Committed Bytes In Use",
  // Commit charge in bytes, and its limit: RAM plus the page file. Near the
  // limit an allocation fails, or the page file has to grow first.
  committedBytes: "\\Memory\\Committed Bytes",
  commitLimit: "\\Memory\\Commit Limit",
  // The kernel's own heaps. A few hundred MB is usual; gigabytes are a leak
  // in a driver or service (`poolTags` names the tag).
  poolPaged: "\\Memory\\Pool Paged Bytes",
  poolNonpaged: "\\Memory\\Pool Nonpaged Bytes",
  pagesOut: "\\Memory\\Pages Output/sec",
  // Soft faults, which never touch the page file. A transition fault is a page
  // Windows trimmed out of a working set (to the standby list, or the
  // compression store) and handed back on the next touch: many a second is
  // Windows squeezing memory. A demand-zero fault is a fresh zeroed page.
  transitionFaults: "\\Memory\\Transition Faults/sec",
  demandZeroFaults: "\\Memory\\Demand Zero Faults/sec",
  pageFile: "\\Paging File(_Total)\\% Usage",
  diskIdle: "\\PhysicalDisk(_Total)\\% Idle Time",
  readLatency: "\\PhysicalDisk(_Total)\\Avg. Disk sec/Read",
  writeLatency: "\\PhysicalDisk(_Total)\\Avg. Disk sec/Write",
  diskQueue: "\\PhysicalDisk(_Total)\\Avg. Disk Queue Length",
  diskRead: "\\PhysicalDisk(_Total)\\Disk Read Bytes/sec",
  diskWrite: "\\PhysicalDisk(_Total)\\Disk Write Bytes/sec",
  // The hypervisor's own view: every hardware thread's run time, whoever ran
  // on it — Windows, the WSL VM, the hypervisor. Windows itself runs on
  // virtual processors once Hyper-V is up, so only this sees the whole machine.
  machine: "\\Hyper-V Hypervisor Logical Processor(_Total)\\% Total Run Time",
  // Bytes of the WSL VM that Windows holds in RAM: what it counts as used for
  // the VM, often far below the VM's size, which is only a ceiling.
  wslVmMem: "\\Process(vmmemwsl)\\Working Set",
  // Summed over cores: 100 is one core.
  wslVm: "\\Process(vmmemwsl)\\% Processor Time",
} as const;
export type Field = keyof typeof COUNTERS;

/**
 * The counters that are a share of one whole, 0–100. Such a counter can read
 * millions for one line (after sleep, or when a counter restarts), and one
 * such line made the panel's mean over a minute 666,000 cores: it is dropped.
 */
const SHARES: ReadonlySet<Field> = new Set([
  "busy",
  "user",
  "privileged",
  "committed",
  "pageFile",
  "diskIdle",
  "machine",
]);

/** One line of counters; a counter Windows could not read is null. */
export type WindowsCounters = { at: number } & Record<Field, number | null>;

/** Share of the machine busy, 0–100: the hypervisor's count, else Windows' own where it has none. */
export const machineBusy = (c: WindowsCounters): number => c.machine ?? c.busy ?? 0;

/**
 * Windows' busy time as shares of the machine, 0–100: programs' own code
 * (`user`), Windows' own kernel (`kernel`), and the WSL VM's guest (`vm`),
 * which Windows counts as kernel time and is taken out of it here. `vm` is
 * null without WSL (no vmmemwsl), and the kernel is then as Windows counts it.
 * The VM's share is capped at the kernel time it is part of: the counters are
 * read a moment apart. Null where Windows gave no user or kernel time.
 */
export function cpuSplit(
  c: WindowsCounters,
  cores: number,
): { user: number; kernel: number; vm: number | null } | null {
  if (c.user === null || c.privileged === null || cores <= 0) return null;
  // `wslVm` is summed over cores: 100 is one core.
  const vm = c.wslVm === null ? null : Math.min(c.wslVm / cores, c.privileged);
  return { user: c.user, kernel: Math.max(0, c.privileged - (vm ?? 0)), vm };
}

/** Every graphics adapter's dedicated memory in use, read next to the others; the `*` is each adapter's luid. */
export const GPU_ADAPTER = "\\GPU Adapter Memory(*)\\Dedicated Usage";

const ADAPTER_COLUMN =
  /GPU Adapter Memory\(luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+(?:#\d+)?\)\\Dedicated Usage$/i;

/**
 * The adapters' dedicated memory in use, in MiB, by luid (`0x…_0x…`), from one
 * `typeperf` line. An adapter with several physical parts, or listed twice
 * (`#2`), counts its largest. Null when the line has no such column: no GPU
 * counters on this Windows.
 */
export function parseGpuAdapters(header: string, line: string): Map<string, number> | null {
  const names = cells(header);
  const values = cells(line);
  if (values.length < 2 || Number.isNaN(Date.parse(values[0] ?? ""))) return null;
  const adapters = new Map<string, number>();
  names.forEach((name, column) => {
    const luid = ADAPTER_COLUMN.exec(name)?.[1]?.toLowerCase();
    const bytes = Number(values[column]);
    if (luid === undefined || !Number.isFinite(bytes) || bytes < 0) return;
    adapters.set(luid, Math.max(adapters.get(luid) ?? 0, bytes / 2 ** 20));
  });
  return adapters.size > 0 ? adapters : null;
}

export type WindowsInfo = { name: string; cores: number; memTotal: number };

export function windowsTools(): boolean {
  return existsSync(TYPEPERF) && existsSync(POWERSHELL);
}

function cells(line: string): string[] {
  return line.trim().replace(/^"|"$/g, "").split('","');
}

/**
 * A `typeperf` data line, read by the header's columns: a counter Windows
 * left out or marked -1 (an instance that does not exist, such as vmmemwsl
 * before WSL has a VM) is null rather than a misread neighbour.
 */
export function parseRow(header: string, line: string, at: number): WindowsCounters | null {
  const names = cells(header);
  const values = cells(line);
  if (values.length < 2 || Number.isNaN(Date.parse(values[0] ?? ""))) return null;
  // A line with more or fewer values than the header has columns (an adapter of
  // `GPU_ADAPTER` come or gone) would put each value under a neighbour's name.
  if (values.length !== names.length) return null;
  const row = { at } as WindowsCounters;
  for (const [field, path] of Object.entries(COUNTERS) as [Field, string][]) {
    const column = names.findIndex((name) => name.toLowerCase().endsWith(path.toLowerCase()));
    const raw = column < 0 ? undefined : values[column];
    row[field] = possible(field, raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw));
  }
  return row;
}

/** A counter's value, or null where it cannot be: negative, or a share past 100 (a hair over is rounding). */
function possible(field: Field, value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (!SHARES.has(field)) return value;
  return value > 101 ? null : Math.min(value, 100);
}

/**
 * What the one `powershell.exe` runs: read a line `<id> <script in base64>`
 * from stdin, run the script, print `<<END-id>>` after its output (and
 * `<<ERR-id>>message` before that if it threw). `-Command -` would not do: it
 * reads stdin to the end before it runs anything. Output is UTF-8 without a
 * byte order mark, so a process name outside the OEM code page is not mangled.
 */
const LOOP = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $at = $line.IndexOf(' ')
  $id = $line.Substring(0, $at)
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($at + 1)))
    & ([scriptblock]::Create($text))
  } catch {
    Write-Output ("\`n<<ERR-" + $id + ">>" + $_.Exception.Message)
  }
  Write-Output ("\`n<<END-" + $id + ">>")
}
`;

/**
 * The one `powershell.exe` this process uses, started on the first script.
 * Starting one per script made a console flash up on the Windows desktop
 * every few seconds.
 */
const shell = new ScriptShell(() =>
  fromProcess(
    spawn(
      POWERSHELL,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(LOOP, "utf16le").toString("base64"),
      ],
      // A Windows folder: the WSL one it would inherit from inside WSL is a UNC path cmd.exe dislikes.
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, cwd: SYSTEM32 },
    ),
  ),
);

/**
 * A started process as the shell's child. The host's exit ends it too, so a
 * PowerShell does not outlive a host that never called `stopPowershell`.
 */
export function fromProcess(child: ChildProcess, host: HostProcess = realProcess): ShellChild {
  child.stdout?.setEncoding("utf8");
  // A write to a child that has ended must not crash the extension.
  child.stdin?.on("error", () => {});
  const unhook = hookHostExit(() => {
    child.kill();
  }, host);
  child.on("exit", unhook);
  return {
    write: (text) => {
      child.stdin?.write(text, "utf8");
    },
    kill: () => {
      unhook();
      child.kill();
    },
    onData: (listener) => {
      child.stdout?.on("data", listener);
    },
    onExit: (listener) => {
      child.on("error", (error) => listener(error.message));
      child.on("exit", (code, signal) => listener(`exit ${code ?? signal}`));
    },
  };
}

/** Runs a PowerShell script in the shared shell, one at a time; its stdout, or an error. */
export function powershell(script: string, timeout: number): Promise<string> {
  return shell.run(script, timeout);
}

/** Ends the shared PowerShell; a later script starts a new one. */
export function stopPowershell(): void {
  shell.close();
}

/** The machine's name, logical cores and memory, asked once. */
export async function windowsInfo(): Promise<WindowsInfo> {
  const out = await powershell(
    "$c = Get-CimInstance Win32_ComputerSystem; " +
      "@{ name = $c.Name; cores = $c.NumberOfLogicalProcessors; mem = $c.TotalPhysicalMemory } | ConvertTo-Json -Compress",
    20_000,
  );
  const parsed = JSON.parse(out) as { name?: string; cores?: number; mem?: number };
  return { name: parsed.name ?? "Windows", cores: parsed.cores ?? 1, memTotal: parsed.mem ?? 0 };
}

/**
 * Graphics memory by process: every `GPU Process Memory` instance's dedicated
 * usage (`G|pid_13644_luid_…_phys_0|bytes`) and total committed (`C|…|bytes`),
 * and every process's name (`P|pid|name`), for `parseGpuProcesses` (`gpu.ts`).
 */
export function gpuProcessCounters(): Promise<string> {
  return powershell(
    "(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage','\\GPU Process Memory(*)\\Total Committed').CounterSamples | " +
      "% { [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}|{1}|{2}', $(if ($_.Path -like '*committed') { 'C' } else { 'G' }), $_.InstanceName, $_.CookedValue) }; " +
      "Get-Process | % { 'P|' + $_.Id + '|' + $_.ProcessName }",
    20_000,
  );
}

/**
 * Every Windows process, one line each:
 * `pid|parent pid|created (ticks)|name|kernel+user time (100 ns)|working set|read|written|commit|command line`.
 * The command line goes last, as it may hold a `|`. Commit is the process's
 * private bytes (`PrivateMemorySize64`, Task Manager's "Commit size"), from
 * `Get-Process` by pid: empty for a process that ended between the two.
 */
export const PROCESS_LIST =
  "$commit = @{}; foreach ($p in Get-Process) { $commit[[int]$p.Id] = $p.PrivateMemorySize64 }; " +
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,KernelModeTime,UserModeTime,WorkingSetSize,ReadTransferCount,WriteTransferCount,CommandLine | " +
  "% { [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}', " +
  "$_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.Ticks } else { 0 }), $_.Name, " +
  "$_.KernelModeTime + $_.UserModeTime, $_.WorkingSetSize, $_.ReadTransferCount, $_.WriteTransferCount, " +
  "$commit[[int]$_.ProcessId], ($_.CommandLine -replace '[\\r\\n]+', ' ')) }";

/** Every Windows process (`PROCESS_LIST`), for `hostTreeOf`. */
export function windowsProcessList(): Promise<string> {
  return powershell(PROCESS_LIST, 20_000);
}

/** A process of `PROCESS_LIST`: a reading, when it started, and its commit in bytes. */
export type WindowsRow = ProcReading & { created: number; commit: number };

/** One line of `PROCESS_LIST`; null for a line that is not one. A field Windows left empty is 0. */
function windowsRowOf(line: string): WindowsRow | null {
  const cells = line.split("|");
  if (cells.length < 10 || !/^\d+$/.test(cells[0] ?? "")) return null;
  const [pid, ppid, created, , time, workingSet, read, write, commit] = cells.map(
    (cell) => Number(cell) || 0,
  );
  const command = cells.slice(9).join("|").trim();
  return {
    pid: pid ?? 0,
    ppid: ppid ?? 0,
    comm: (cells[3] ?? "").replace(/\.exe$/i, ""),
    argv: command === "" ? [] : splitCommandLine(command),
    rss: workingSet ?? 0,
    ticks: (time ?? 0) / 100_000,
    read: read ?? 0,
    write: write ?? 0,
    created: created ?? 0,
    commit: commit ?? 0,
  };
}

/** A Windows command line as arguments: split at spaces outside quotes, the quotes dropped. */
export function splitCommandLine(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

/** Every process of `PROCESS_LIST`'s output, by pid. */
export function windowsRowsOf(out: string): Map<number, WindowsRow> {
  const rows = new Map<number, WindowsRow>();
  for (const line of out.split(/\r?\n/)) {
    const row = windowsRowOf(line);
    if (row !== null) rows.set(row.pid, row);
  }
  return rows;
}

/**
 * Each process's children, by its pid. The idle process, its own parent, is
 * no one's child, and nor is a process that started before its parent:
 * Windows reuses a dead parent's pid, so that one is someone else.
 */
export function childrenOf(rows: Map<number, WindowsRow>): Map<number, WindowsRow[]> {
  const children = new Map<number, WindowsRow[]>();
  for (const row of rows.values()) {
    if (row.pid === row.ppid) continue;
    const parent = rows.get(row.ppid);
    if (parent !== undefined && row.created < parent.created) continue;
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  return children;
}

/**
 * The host (`hostPid`) and every process under it, from `windowsProcessList`'s
 * output, as process readings `averageProcs` can average: CPU in ticks of
 * 10 ms (Windows counts 100 ns), memory as the working set, and read and
 * written as all I/O, which on Windows is not disk alone. A child must have
 * started after its parent: Windows reuses a dead parent's pid, so one that
 * did not is someone else's. Empty when the host is not in the list.
 */
export function hostTreeOf(out: string, hostPid: number, at: number): ProcSnapshot {
  const rows = windowsRowsOf(out);
  const procs = new Map<number, ProcReading>();
  const host = rows.get(hostPid);
  if (host === undefined) return { at, procs };
  const children = childrenOf(rows);
  const stack = [host];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { created: _created, commit: _commit, ...reading } = next;
    procs.set(next.pid, reading);
    for (const child of children.get(next.pid) ?? []) {
      if (!procs.has(child.pid)) stack.push(child);
    }
  }
  return { at, procs };
}
