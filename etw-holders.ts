/**
 * Which process likely holds an event-tracing leak. A suspended (UWP) process
 * never drains the notifications queued on its event-tracing registrations, so
 * the EtwD and Etwr pool tags grow with it (learn.microsoft.com Q&A "Windows 11
 * severe memory leak in nonpaged pool tag", github.com/unchihugo/FluentFlyout
 * issue 1220). `etwHolders` counts EtwRegistration handles per process; the
 * parsing and the choosing are pure.
 */

import { powershell } from "./windows";

/** A process with many event-tracing registrations, as `etwHolders` read it. */
export type EtwProcess = {
  pid: number;
  name: string;
  registrations: number;
  /** When it started, ms since 1970. */
  startedAt: number;
  /** Every thread is waiting with reason Suspended. */
  suspended: boolean;
};

/** The process judged to hold the leak. */
/** `since` is when the process started (not when it was suspended, which is not read). */
export type EtwHolder = { name: string; pid: number; registrations: number; since: number };

/** Registrations a process must hold, and how long ago it must have started, to be named. */
export const HOLDER_MIN_REGISTRATIONS = 100;
export const HOLDER_MIN_AGE_MS = 3_600_000;

/** How many processes `etwHolders` reports, the most registrations first. */
const HOLDERS_TOP = 10;

/**
 * `E|<pid>|<name>|<registrations>|<start, ms since 1970>|<1 if every thread is
 * suspended>` per line. Null when no line is one: the read failed.
 */
export function parseEtwHolders(out: string): EtwProcess[] | null {
  const found: EtwProcess[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cells = line.split("|");
    if (cells[0] !== "E" || cells.length !== 6) continue;
    const pid = Number(cells[1]);
    const registrations = Number(cells[3]);
    const startedAt = Number(cells[4]);
    if (![pid, registrations, startedAt].every(Number.isFinite)) continue;
    found.push({
      pid,
      name: cells[2] ?? "",
      registrations,
      startedAt,
      suspended: cells[5] === "1",
    });
  }
  return found.length === 0 ? null : found;
}

/**
 * The suspended process, started over an hour ago, with 100 or more
 * registrations, that holds the most; null when none fits.
 */
export function chooseEtwHolder(processes: readonly EtwProcess[], now: number): EtwHolder | null {
  const best = processes
    .filter(
      (p) =>
        p.suspended &&
        p.registrations >= HOLDER_MIN_REGISTRATIONS &&
        p.startedAt > 0 &&
        now - p.startedAt >= HOLDER_MIN_AGE_MS,
    )
    .sort((a, b) => b.registrations - a.registrations)[0];
  if (best === undefined) return null;
  return {
    name: best.name,
    pid: best.pid,
    registrations: best.registrations,
    since: best.startedAt,
  };
}

/**
 * C# for `etwHolders`, all without admin: the type index of EtwRegistration
 * from `NtQueryObject(NULL, ObjectTypesInformation = 3)` (a count, then from
 * offset 8 each OBJECT_TYPE_INFORMATION: 0x68 bytes with the name's
 * UNICODE_STRING first and the TypeIndex byte at 0x5A, followed by the name
 * buffer rounded up to 8), then `NtQuerySystemInformation(
 * SystemExtendedHandleInformation = 64)`: a 16-byte header with the count
 * first, then 40-byte entries with the owner's pid at +8 and the
 * ObjectTypeIndex (UInt16) at +30. 64-bit only. For the busiest processes it
 * says whether every thread waits with reason Suspended.
 */
const ETW_HOLDER_SOURCE = `
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
public static class PriflyEtwHolders {
  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int needed);
  [DllImport("ntdll.dll")]
  static extern int NtQueryObject(IntPtr handle, int infoClass, IntPtr buffer, int length, out int needed);
  const int Mismatch = unchecked((int)0xC0000004);
  static int TypeIndex() {
    int length = 1 << 20;
    for (int attempt = 0; attempt < 6; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        int needed;
        int status = NtQueryObject(IntPtr.Zero, 3, buffer, length, out needed);
        if (status == Mismatch) { length = Math.Max(length * 2, needed + 65536); continue; }
        if (status != 0) throw new Exception("NtQueryObject: 0x" + status.ToString("X8"));
        int count = Marshal.ReadInt32(buffer);
        long at = buffer.ToInt64() + 8;
        for (int i = 0; i < count; i++) {
          IntPtr p = new IntPtr(at);
          int len = (ushort)Marshal.ReadInt16(p);
          int max = (ushort)Marshal.ReadInt16(p, 2);
          string name = Marshal.PtrToStringUni(Marshal.ReadIntPtr(p, 8), len / 2);
          if (name == "EtwRegistration") return Marshal.ReadByte(p, 0x5A);
          at += 0x68 + ((max + 7) & ~7);
        }
        throw new Exception("no EtwRegistration object type");
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
    throw new Exception("NtQueryObject: the type list kept growing");
  }
  static Dictionary<long, int> Counts(int typeIndex) {
    int length = 16 << 20;
    for (int attempt = 0; attempt < 8; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        int needed;
        int status = NtQuerySystemInformation(64, buffer, length, out needed);
        if (status == Mismatch) { length = Math.Max(length * 2, needed + (1 << 20)); continue; }
        if (status != 0) throw new Exception("NtQuerySystemInformation: 0x" + status.ToString("X8"));
        long count = Marshal.ReadInt64(buffer);
        long start = buffer.ToInt64() + 16;
        Dictionary<long, int> per = new Dictionary<long, int>();
        for (long i = 0; i < count; i++) {
          IntPtr e = new IntPtr(start + i * 40);
          if ((ushort)Marshal.ReadInt16(e, 30) != typeIndex) continue;
          long pid = Marshal.ReadInt64(e, 8);
          int n; per.TryGetValue(pid, out n); per[pid] = n + 1;
        }
        return per;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
    throw new Exception("NtQuerySystemInformation: the handle list kept growing");
  }
  public static string Read(int top) {
    if (IntPtr.Size != 8) throw new Exception("64-bit Windows only");
    Dictionary<long, int> per = Counts(TypeIndex());
    StringBuilder out_ = new StringBuilder();
    foreach (KeyValuePair<long, int> kv in per.OrderByDescending(k => k.Value).Take(top)) {
      try {
        using (Process p = Process.GetProcessById((int)kv.Key)) {
          long started = new DateTimeOffset(p.StartTime).ToUnixTimeMilliseconds();
          int threads = 0, suspended = 0;
          foreach (ProcessThread t in p.Threads) {
            threads++;
            if (t.ThreadState == System.Diagnostics.ThreadState.Wait && t.WaitReason == ThreadWaitReason.Suspended) suspended++;
          }
          out_.Append("E|").Append(kv.Key).Append('|').Append(p.ProcessName.Replace('|', '?')).Append('|')
            .Append(kv.Value).Append('|').Append(started).Append('|')
            .Append(threads > 0 && suspended == threads ? 1 : 0).Append('\\n');
        }
      } catch (Exception) { }
    }
    return out_.ToString();
  }
}
`;

/** `etwHolders`' script: the C# is compiled once per PowerShell. */
export const ETW_HOLDER_SCRIPT =
  "if (-not ('PriflyEtwHolders' -as [type])) { Add-Type -TypeDefinition @'\n" +
  ETW_HOLDER_SOURCE +
  `\n'@ }\n[PriflyEtwHolders]::Read(${HOLDERS_TOP})`;

/**
 * The processes with the most EtwRegistration handles, for `parseEtwHolders`.
 * One pass over the system's handle table: never in a loop (`index.ts` reads
 * it at most every 5 minutes, and only while an event-tracing tag grows).
 */
export function etwHolders(): Promise<string> {
  return powershell(ETW_HOLDER_SCRIPT, 30_000);
}
