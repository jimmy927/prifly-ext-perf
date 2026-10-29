/**
 * What Windows memory is made of beyond its counters: whether the memory
 * compression store grows, and the kernel pools by tag (`poolTags`), read
 * through the shared PowerShell (`windows.ts`).
 */

import { powershell } from "./windows";

/** The compression store's size at one moment, kept a few minutes to see whether it grows. */
export type CompressionReading = { at: number; bytes: number };

/** The shortest stretch a growth rate is worked out over: two reads 10 s apart say little. */
const GROWTH_MIN_MS = 20_000;

/**
 * How fast the compression store grew over the last minute of `readings`
 * (oldest first), in bytes a minute: negative while it shrinks. Null with
 * less than 20 s of readings to compare.
 */
export function compressionGrowth(readings: readonly CompressionReading[]): number | null {
  const last = readings.at(-1);
  if (last === undefined) return null;
  const first = readings.find((r) => r.at >= last.at - 60_000);
  if (first === undefined || last.at - first.at < GROWTH_MIN_MS) return null;
  return ((last.bytes - first.bytes) / (last.at - first.at)) * 60_000;
}

/** One kernel pool tag: what it holds, in which pool, its bytes and its allocations still live. */
export type PoolTag = {
  tag: string;
  pool: "paged" | "nonpaged";
  bytes: number;
  live: number;
  /** What the tag is, for the few known ones; "" otherwise. */
  meaning: string;
};

/** Tags worth a word. `Toke` is the one that leaked 1.4 GB here (695,000 live tokens, 2026-10-29). */
const POOL_TAG_MEANINGS: Record<string, string> = {
  Toke: "security tokens; a leak when huge",
  SeAt: "security attributes, kept with tokens",
  FMfn: "file names cached by file-system filters (antivirus and the like)",
  EtwD: "event tracing",
  MmSt: "memory manager: mapped-file tables",
  MmCa: "memory manager: control areas of mapped files",
  File: "open file objects",
  Ntff: "NTFS file records",
  CM31: "registry",
  Proc: "process objects",
  Thre: "thread objects",
  Even: "event objects",
  Vad: "virtual address descriptors",
  ConT: "contiguous memory (drivers)",
};

/** How many pool tags `parsePoolTags` keeps, biggest first. */
export const POOL_TAGS_SHOWN = 8;

/**
 * The biggest pool tags from `poolTags`' output, one line per tag:
 * `T|<tag>|<paged allocs>|<paged frees>|<paged bytes>|<non-paged allocs>|<non-paged frees>|<non-paged bytes>`.
 * A tag in both pools counts as two entries. Null when the output holds no
 * tag at all: the read failed.
 */
export function parsePoolTags(out: string, shown = POOL_TAGS_SHOWN): PoolTag[] | null {
  const lines = out.split(/\r?\n/).map(poolTagLine);
  if (lines.every((entries) => entries === null)) return null;
  return lines
    .flatMap((entries) => entries ?? [])
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, shown);
}

/** Allocations and frees are 32-bit counters that wrap: live is their difference, mod 2^32. */
const liveOf = (allocs: number, frees: number): number => (allocs - frees + 2 ** 32) % 2 ** 32;

/** One line of `poolTags`: its entries, one per pool the tag holds bytes in; null for a line that is not one. */
function poolTagLine(line: string): PoolTag[] | null {
  const cells = line.split("|");
  if (cells[0] !== "T" || cells.length !== 8) return null;
  const numbers = cells.slice(2).map(Number);
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [pa = 0, pf = 0, pu = 0, na = 0, nf = 0, nu = 0] = numbers;
  const tag = (cells[1] ?? "").trim();
  const meaning = POOL_TAG_MEANINGS[tag] ?? "";
  const entries: PoolTag[] = [];
  if (pu > 0) entries.push({ tag, pool: "paged", bytes: pu, live: liveOf(pa, pf), meaning });
  if (nu > 0) entries.push({ tag, pool: "nonpaged", bytes: nu, live: liveOf(na, nf), meaning });
  return entries;
}

/**
 * C# for `poolTags`: `NtQuerySystemInformation(SystemPoolTagInformation = 22)`,
 * which needs no admin. Its answer is SYSTEM_POOLTAG_INFORMATION { ULONG Count;
 * SYSTEM_POOLTAG TagInfo[] }, each SYSTEM_POOLTAG { UCHAR Tag[4]; ULONG
 * PagedAllocs; ULONG PagedFrees; SIZE_T PagedUsed; ULONG NonPagedAllocs; ULONG
 * NonPagedFrees; SIZE_T NonPagedUsed }: 40 bytes on 64-bit, the array after
 * 8 (SIZE_T alignment); 28 and 4 on 32-bit. The buffer grows on
 * STATUS_INFO_LENGTH_MISMATCH (0xC0000004). Tags under `min` bytes in both
 * pools are left out, so a few hundred lines cross the pipe, not thousands.
 */
const POOL_TAG_SOURCE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PriflyPoolTags {
  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int needed);
  public static string Read(long min) {
    int length = 1 << 20;
    for (int attempt = 0; attempt < 6; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        int needed;
        int status = NtQuerySystemInformation(22, buffer, length, out needed);
        if (status == unchecked((int)0xC0000004)) { length = Math.Max(length * 2, needed + 65536); continue; }
        if (status != 0) throw new Exception("NtQuerySystemInformation: 0x" + status.ToString("X8"));
        bool wide = IntPtr.Size == 8;
        int size = wide ? 40 : 28;
        int start = wide ? 8 : 4;
        int count = Marshal.ReadInt32(buffer);
        StringBuilder out_ = new StringBuilder();
        for (int i = 0; i < count; i++) {
          IntPtr at = IntPtr.Add(buffer, start + i * size);
          char[] tag = new char[4];
          for (int k = 0; k < 4; k++) {
            byte b = Marshal.ReadByte(at, k);
            tag[k] = b >= 32 && b < 127 && b != 124 ? (char)b : '?';
          }
          long pagedAllocs = (uint)Marshal.ReadInt32(at, 4);
          long pagedFrees = (uint)Marshal.ReadInt32(at, 8);
          long pagedUsed = wide ? Marshal.ReadInt64(at, 16) : (uint)Marshal.ReadInt32(at, 12);
          long nonAllocs = (uint)Marshal.ReadInt32(at, wide ? 24 : 16);
          long nonFrees = (uint)Marshal.ReadInt32(at, wide ? 28 : 20);
          long nonUsed = wide ? Marshal.ReadInt64(at, 32) : (uint)Marshal.ReadInt32(at, 24);
          if (pagedUsed < min && nonUsed < min) continue;
          out_.Append("T|").Append(new string(tag)).Append('|')
            .Append(pagedAllocs).Append('|').Append(pagedFrees).Append('|').Append(pagedUsed).Append('|')
            .Append(nonAllocs).Append('|').Append(nonFrees).Append('|').Append(nonUsed).Append('\\n');
        }
        return out_.ToString();
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
    throw new Exception("NtQuerySystemInformation: the pool tag list kept growing");
  }
}
`;

/**
 * The kernel pools by tag, for `parsePoolTags`. The C# is compiled once per
 * PowerShell: a type, once added, stays for the life of the shell.
 */
export function poolTags(): Promise<string> {
  return powershell(POOL_TAG_SCRIPT, 20_000);
}

/** `poolTags`' script: tags of 1 MB or more in either pool. */
export const POOL_TAG_SCRIPT =
  "if (-not ('PriflyPoolTags' -as [type])) { Add-Type -TypeDefinition @'\n" +
  POOL_TAG_SOURCE +
  "\n'@ }\n[PriflyPoolTags]::Read(1048576)";
