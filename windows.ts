/**
 * Windows' view, read from inside WSL or on Windows itself (`host.ts` says
 * where the tools are): one `typeperf.exe` that stays running and prints the
 * counters below every second as CSV — about a second to start once, where a
 * PowerShell per poll would cost that every time. Which processes use the CPU
 * comes from one PowerShell that stays running too (`topProcesses`).
 *
 * On a Linux with no Windows around it there is no Windows to read:
 * `windowsTools()` is false and the panel shows Linux alone.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { HOST } from "./host";
import { HOUR, keep } from "./ring";
import { ScriptShell, type ShellChild } from "./shell";

const { system32: SYSTEM32, typeperf: TYPEPERF, powershell: POWERSHELL } = HOST;

/** Counter path → field, in the order `typeperf` is given them. */
export const COUNTERS = {
  busy: "\\Processor(_Total)\\% Processor Time",
  queue: "\\System\\Processor Queue Length",
  availableMB: "\\Memory\\Available MBytes",
  committed: "\\Memory\\% Committed Bytes In Use",
  pagesOut: "\\Memory\\Pages Output/sec",
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
  // Summed over cores: 100 is one core.
  wslVm: "\\Process(vmmemwsl)\\% Processor Time",
} as const;
export type Field = keyof typeof COUNTERS;

/** One line of counters; a counter Windows could not read is null. */
export type WindowsCounters = { at: number } & Record<Field, number | null>;

/** Share of the machine busy, 0–100: the hypervisor's count, else Windows' own where it has none. */
export const machineBusy = (c: WindowsCounters): number => c.machine ?? c.busy ?? 0;

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

export type WindowsProcess = { name: string; cpu: number; memory: number };

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
  const row = { at } as WindowsCounters;
  for (const [field, path] of Object.entries(COUNTERS) as [Field, string][]) {
    const column = names.findIndex((name) => name.toLowerCase().endsWith(path.toLowerCase()));
    const raw = column < 0 ? undefined : values[column];
    const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    row[field] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return row;
}

/**
 * Keeps one `typeperf` running and the last hour of the lines it printed (the
 * panel averages over them); starts it again if it ends.
 */
export class WindowsSampler {
  latest: WindowsCounters | null = null;
  readonly history: WindowsCounters[] = [];
  /** The graphics adapters' memory in use now, MiB by luid; null where Windows has no such counters. */
  gpuAdapters: Map<string, number> | null = null;
  error = "";
  private child: ChildProcess | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly everySeconds: number;

  constructor(everySeconds: number) {
    this.everySeconds = everySeconds;
  }

  start(): void {
    const child = spawn(
      TYPEPERF,
      [...Object.values(COUNTERS), GPU_ADAPTER, "-si", String(this.everySeconds)],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.child = child;
    let header = "";
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith('"(PDH-CSV')) {
        header = line;
        return;
      }
      if (header === "") return;
      const row = parseRow(header, line, Date.now());
      if (row !== null) {
        this.latest = row;
        this.gpuAdapters = parseGpuAdapters(header, line);
        keep(this.history, row, HOUR);
        this.error = "";
      }
    });
    child.on("error", (error) => {
      this.error = `typeperf: ${error.message}`;
    });
    child.on("exit", (code) => {
      this.child = null;
      if (this.stopped) return;
      this.error = `typeperf ended (${code ?? "signal"}); starting it again in 30 s`;
      this.retry = setTimeout(() => this.start(), 30_000);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.retry !== null) clearTimeout(this.retry);
    this.child?.kill();
  }
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

export function fromProcess(child: ChildProcess): ShellChild {
  child.stdout?.setEncoding("utf8");
  // A write to a child that has ended must not crash the extension.
  child.stdin?.on("error", () => {});
  return {
    write: (text) => {
      child.stdin?.write(text, "utf8");
    },
    kill: () => {
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
 * What uses Windows' CPU now: every process's CPU over two seconds, in cores,
 * with its private memory. Instances of one program (#1, #2) are added up.
 */
export async function topProcesses(): Promise<WindowsProcess[]> {
  const out = await powershell(
    "(Get-Counter '\\Process(*)\\% Processor Time','\\Process(*)\\Working Set - Private' -SampleInterval 2 -MaxSamples 1).CounterSamples | " +
      // Invariant culture: a Swedish Windows writes 12,5 otherwise.
      "% { [string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}|{1}|{2}', $_.InstanceName, $_.Path.Split('\\')[-1], $_.CookedValue) }",
    20_000,
  );
  return sumByName(out);
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

export function sumByName(out: string): WindowsProcess[] {
  const byName = new Map<string, WindowsProcess>();
  for (const line of out.split(/\r?\n/)) {
    const [instance, counter, value] = line.split("|");
    if (instance === undefined || counter === undefined || value === undefined) continue;
    const name = instance.replace(/#\d+$/, "");
    if (name === "_total" || name === "idle") continue;
    const entry = byName.get(name) ?? { name, cpu: 0, memory: 0 };
    if (counter.startsWith("% processor")) entry.cpu += Number(value) / 100;
    else entry.memory += Number(value);
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => b.cpu - a.cpu).slice(0, 8);
}
