/**
 * Windows' view, read from inside WSL: one `typeperf.exe` that stays running
 * and prints the counters below every two seconds as CSV — about a second to
 * start once, where a PowerShell per poll would cost that every time. Which
 * processes use the CPU comes from PowerShell, and only while the window is
 * open (`topProcesses`).
 *
 * Outside WSL there is no Windows to read: `windowsTools()` is null and the
 * panel shows Linux alone.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const SYSTEM32 = "/mnt/c/Windows/System32";
const TYPEPERF = `${SYSTEM32}/typeperf.exe`;
const POWERSHELL = `${SYSTEM32}/WindowsPowerShell/v1.0/powershell.exe`;

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
  // Summed over cores: 100 is one core.
  wslVm: "\\Process(vmmemwsl)\\% Processor Time",
} as const;
export type Field = keyof typeof COUNTERS;

/** One line of counters; a counter Windows could not read is null. */
export type WindowsCounters = { at: number } & Record<Field, number | null>;

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

/** Keeps one `typeperf` running and the latest line it printed; starts it again if it ends. */
export class WindowsSampler {
  latest: WindowsCounters | null = null;
  error = "";
  private child: ChildProcess | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly everySeconds: number;

  constructor(everySeconds: number) {
    this.everySeconds = everySeconds;
  }

  start(): void {
    const child = spawn(TYPEPERF, [...Object.values(COUNTERS), "-si", String(this.everySeconds)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
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

function powershell(script: string, timeout: number): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      POWERSHELL,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout, maxBuffer: 4 << 20 },
      (error, stdout) => (error === null ? done(stdout) : fail(error)),
    );
  });
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
