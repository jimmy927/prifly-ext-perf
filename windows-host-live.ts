/**
 * The host's own Windows processes, every second while the window is open:
 * the CPU time and working set of only the pids in the newest tree
 * (`Tables.windowsHost`, from Windows' full process list every 10 s), so
 * their CPU and memory move with the window's 1 s and 2 s periods. The full
 * list still finds the processes that start and end, and keeps their I/O:
 * this read has none.
 */

import { averageProcs } from "./average";
import type { Proc, ProcReading, ProcSnapshot } from "./procs";
import { keep, TOLERANCE } from "./ring";
import { powershell } from "./windows";

/** One read a second, as the window refreshes. */
const LIVE_EVERY = 1_000;
/** A read queued behind the full list may wait that long: one that takes longer fails. */
const LIVE_TIMEOUT = 10_000;
/** Live readings older than the newest tree by this much say nothing now: the tree's own stand. */
const LIVE_STALE = 3_000;

/**
 * A helper `liveRead` compiles once per PowerShell: for each pid, one
 * `OpenProcess`, `GetProcessTimes` and `K32GetProcessMemoryInfo`, about 1 ms
 * for 15 pids. `Get-Process -Id` costs 150 ms of CPU for the same 15: each pid
 * takes its own snapshot of every process on the machine. No single quote in
 * it: it goes inside one.
 */
const HELPER = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class PriflyHostLive {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public uint cb; public uint faults; public UIntPtr peakWorkingSet; public UIntPtr workingSet;
    public UIntPtr a; public UIntPtr b; public UIntPtr c; public UIntPtr d; public UIntPtr pagefile; public UIntPtr peakPagefile;
  }
  [DllImport("kernel32.dll")] static extern bool K32GetProcessMemoryInfo(IntPtr handle, out Counters counters, uint cb);
  public static string Read(int[] pids) {
    var lines = new StringBuilder();
    foreach (var pid in pids) {
      // PROCESS_QUERY_LIMITED_INFORMATION. No such pid: ended. Access denied: not ours to read.
      IntPtr handle = OpenProcess(0x1000, false, pid);
      if (handle == IntPtr.Zero) {
        if (Marshal.GetLastWin32Error() == 5) lines.Append(pid).Append("|||0\\n");
        continue;
      }
      try {
        uint code; long created, exited, kernel, user; Counters memory;
        // Ended, its pid still held by a handle somewhere: 259 is STILL_ACTIVE.
        if (GetExitCodeProcess(handle, out code) && code != 259) continue;
        if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) {
          lines.Append(pid).Append("|||0\\n");
          continue;
        }
        ulong workingSet = K32GetProcessMemoryInfo(handle, out memory, (uint)Marshal.SizeOf(typeof(Counters))) ? memory.workingSet.ToUInt64() : 0;
        // FILETIME counts 100 ns from 1601: as Unix milliseconds.
        lines.Append(pid).Append("|").Append(created / 10000 - 11644473600000).Append("|").Append(kernel + user).Append("|").Append(workingSet).Append("\\n");
      } finally {
        CloseHandle(handle);
      }
    }
    return lines.ToString();
  }
}`;

/**
 * `pid|started (Unix ms)|kernel+user time (100 ns)|working set` of each of
 * `pids` still running. A process whose times are not ours to read has the
 * start and time empty; one that ended is not there. The helper is compiled
 * on the first call (`Add-Type`, about 1.5 s, once per PowerShell); should
 * that fail, a `liveerr|` line says why, once, and the reads go through
 * .NET's own one snapshot of every process instead, about 18 ms each.
 */
export function liveRead(pids: readonly number[]): string {
  const list = `@(${pids.join(",")})`;
  return (
    "if (-not ('PriflyHostLive' -as [type]) -and -not $global:priflyHostLiveTried) { " +
    "$global:priflyHostLiveTried = $true; " +
    `try { Add-Type -TypeDefinition '${HELPER}' } catch { 'liveerr|' + ($_.Exception.Message -replace '[\\r\\n]+', ' ') } }; ` +
    `if ('PriflyHostLive' -as [type]) { [PriflyHostLive]::Read(${list}) } else { ` +
    `$ids = @{}; foreach ($i in ${list}) { $ids[$i] = 1 }; ` +
    // One process whose times throw (a protected one) must not cut the answer short.
    "foreach ($p in [Diagnostics.Process]::GetProcesses()) { if ($ids.ContainsKey($p.Id)) { try { " +
    "[string]::Format([Globalization.CultureInfo]::InvariantCulture, '{0}|{1}|{2}|{3}', $p.Id, " +
    "$(if ($p.StartTime) { ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } else { '' }), " +
    "$(if ($p.StartTime) { $p.TotalProcessorTime.Ticks } else { '' }), $p.WorkingSet64) } catch { [string]$p.Id + '|||0' } } } }"
  );
}

/** One process of `liveRead`'s output: null start and ticks where they could not be read. */
export type LiveRow = { pid: number; started: number | null; ticks: number | null; rss: number };

/** `liveRead`'s output, by pid. */
export function parseLiveRead(out: string): Map<number, LiveRow> {
  const rows = new Map<number, LiveRow>();
  for (const line of out.split(/\r?\n/)) {
    const [pid, started, time, workingSet] = line.trim().split("|");
    if (workingSet === undefined || !/^\d+$/.test(pid ?? "")) continue;
    rows.set(Number(pid), {
      pid: Number(pid),
      started: started === "" ? null : Number(started),
      // Windows counts 100 ns; a reading counts ticks of 10 ms, as `hostTreeOf`'s do.
      ticks: time === "" ? null : Number(time) / 100_000,
      rss: Number(workingSet) || 0,
    });
  }
  return rows;
}

/**
 * One per-second read: a reading for each of the tree's processes still
 * running, made from the tree's row (ppid, name, command line, I/O) with the
 * time and working set of now. `answered` is the pids whose fate it knows:
 * read, ended, or someone else's since (a reused pid); one whose times it
 * could not read is not in it. `tree` is when that tree was read. `reborn`
 * is the pids found to be another process than at the reads before
 * (`WindowsHostLive.forgetReused`): the tree's rate for them is two processes'.
 */
export type LiveSnapshot = ProcSnapshot & {
  tree: number;
  answered: ReadonlySet<number>;
  reborn: Set<number>;
};

/**
 * The live snapshot of `rows`, read at `at` for the pids of `tree`. A process
 * that started after the tree was read is not the tree's: Windows reused an
 * ended one's pid.
 */
export function liveSnapshotOf(
  tree: ProcSnapshot,
  rows: Map<number, LiveRow>,
  at: number,
): LiveSnapshot {
  const procs = new Map<number, ProcReading>();
  const answered = new Set<number>();
  for (const [pid, reading] of tree.procs) {
    const row = rows.get(pid);
    if (row !== undefined && (row.started === null || row.ticks === null)) continue;
    answered.add(pid);
    if (row === undefined || row.ticks === null || (row.started ?? 0) > tree.at) continue;
    procs.set(pid, { ...reading, ticks: row.ticks, rss: row.rss });
  }
  return { at, procs, tree: tree.at, answered, reborn: new Set() };
}

/**
 * The per-second reads, newest last in `ring`: one at a time, the first once
 * a tree is there, none once `stop` is called; `clear` drops what was kept
 * and what is in flight.
 */
export class WindowsHostLive {
  readonly ring: LiveSnapshot[] = [];
  /** Each pid's start as the reads found it: one that changed is another process. */
  private readonly started = new Map<number, number>();
  private readonly run: (script: string, timeout: number) => Promise<string>;
  private readonly log: (event: string, data: { error: string }) => void;
  /** The host's own pid, the tree's root: running while it reads, so an answer without it failed. */
  private readonly hostPid: number;
  private at = 0;
  private reading = false;
  /** Counts `clear` calls: a read that lands after one is dropped. */
  private generation = 0;
  private stopped = false;

  constructor(
    hostPid: number,
    log: (event: string, data: { error: string }) => void,
    run: (script: string, timeout: number) => Promise<string> = powershell,
  ) {
    this.hostPid = hostPid;
    this.log = log;
    this.run = run;
  }

  /** While the window is open, every second: `liveRead` of the newest tree's pids, kept `seconds`. */
  read(trees: readonly ProcSnapshot[], seconds: number, now: number): void {
    const tree = trees.at(-1);
    if (this.reading || this.stopped || tree === undefined || tree.procs.size === 0) return;
    if (now - this.at < LIVE_EVERY - TOLERANCE) return;
    this.at = now;
    this.reading = true;
    const generation = this.generation;
    this.run(liveRead([...tree.procs.keys()]), LIVE_TIMEOUT)
      .then((out) => {
        const helper = /^liveerr\|(.*)$/m.exec(out)?.[1]?.trim();
        if (helper !== undefined) this.log("windows_host_live_helper_failed", { error: helper });
        if (this.stopped || generation !== this.generation) return;
        const rows = parseLiveRead(out);
        // Empty or cut short (the script threw): not every process ended, so the trees stand.
        if (!rows.has(this.hostPid)) {
          throw new Error(`no row for the host (${this.hostPid}): ${out.slice(0, 200)}`);
        }
        const snapshot = liveSnapshotOf(tree, rows, Date.now());
        this.forgetReused(rows, snapshot);
        keep(this.ring, snapshot, seconds);
      })
      .catch((error: unknown) => this.log("windows_host_live_failed", { error: String(error) }))
      .finally(() => {
        this.reading = false;
      });
  }

  /** The window closed (or a gap): what was kept, and a read in flight, say nothing now. */
  clear(): void {
    this.ring.length = 0;
    this.started.clear();
    this.at = 0;
    this.generation += 1;
  }

  /** No answer that lands after this is kept. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * A pid that started anew since the last read is another process: its
   * readings kept so far are the old one's, and would make a rate of two.
   */
  private forgetReused(rows: Map<number, LiveRow>, snapshot: LiveSnapshot): void {
    for (const pid of snapshot.procs.keys()) {
      const started = rows.get(pid)?.started ?? 0;
      const before = this.started.get(pid);
      if (before !== undefined && before !== started) {
        for (const old of this.ring) old.procs.delete(pid);
        snapshot.reborn.add(pid);
      }
      this.started.set(pid, started);
    }
  }
}

/**
 * The host's processes over the window, for the prifly tab: who they are,
 * and their I/O, from the trees (`averageProcs` over the full list's
 * snapshots: I/O over the real time between two of them, so never a spike or
 * a drop to 0 at a short period); their CPU and working set from the
 * per-second reads, wherever a process has two of those. A process the
 * newest per-second read, after the tree, found ended (or reused) is gone;
 * one it has not asked about yet stands as the tree has it. Null before the
 * first tree.
 */
export function averageHost(
  trees: readonly ProcSnapshot[],
  live: readonly LiveSnapshot[],
  seconds: number,
): Proc[] | null {
  const full = averageProcs(trees, seconds);
  const tree = trees.at(-1);
  if (full === null || tree === undefined) return null;
  const end = live.at(-1);
  if (end === undefined || end.at < tree.at - LIVE_STALE) return full.value;
  const fast = new Map((averageProcs(live, seconds)?.value ?? []).map((proc) => [proc.pid, proc]));
  const value: Proc[] = [];
  for (const proc of full.value) {
    const merged = mergedProc(proc, fast.get(proc.pid), live, tree);
    if (merged !== null) value.push(merged);
  }
  return value;
}

/** One process of `averageHost`: `proc` as the trees have it, `now` as the per-second reads do; null for one that ended. */
function mergedProc(
  proc: Proc,
  now: Proc | undefined,
  live: readonly LiveSnapshot[],
  tree: ProcSnapshot,
): Proc | null {
  const end = live.at(-1);
  if (end === undefined) return proc;
  if (now === undefined) {
    // Asked after the tree was read, and not running: it ended since.
    return end.at > tree.at && end.answered.has(proc.pid) ? null : proc;
  }
  if (live.at(-2)?.procs.has(proc.pid)) return { ...proc, rss: now.rss, cpu: now.cpu };
  // Read once so far: no rate of its own yet, so the tree's; none for a reused pid, whose tree rate spans two processes.
  return { ...proc, rss: now.rss, cpu: end.reborn.has(proc.pid) ? 0 : proc.cpu };
}
