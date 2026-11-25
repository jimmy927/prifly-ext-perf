/**
 * What the extension keeps between seconds (`index.ts`), and whether the
 * window counts as open.
 */

import type { Pace } from "./cadence";
import type { GpuMonitor } from "./gpu-live";
import type { Holders } from "./holders";
import type { NannyMemory } from "./nanny";
import type { ToolUse } from "./prifly";
import type { ExtensionApi } from "./prifly-api";
import type { Tables } from "./tables";
import type { PoolLeaks } from "./verdict";
import type { WindowsInfo } from "./windows";
import type { CompressionReading, PoolReading, PoolTag } from "./windows-memory";
import type { WindowsSampler } from "./windows-sampler";
import type { WindowsProcess } from "./windows-top";
import type { LinuxRaw } from "./wsl";
import type { WslLinux } from "./wsl-exe";

export type State = {
  api: ExtensionApi;
  /**
   * The last hour of reads, one a second, or one every 5 s while nobody looks
   * and WSL is green (`cadence.ts`); empty while a host on Windows has no WSL to read.
   */
  linux: LinuxRaw[];
  /** When Linux was last asked for. */
  linuxAt: number;
  /** How often Linux and Windows are read now (`cadence.ts`). */
  pace: Pace;
  /** On a host on Windows itself, what reads the WSL VM; null where Linux is this host's `/proc`. */
  wsl: WslLinux | null;
  /**
   * The process tables (the last five minutes, one a second, while the window
   * is open), Docker's containers, and a host on Windows' own processes.
   */
  tables: Tables;
  windows: WindowsSampler | null;
  info: WindowsInfo | null;
  topWindows: WindowsProcess[];
  /** The memory compression store's bytes, read with `topWindows`; null until read, or where it cannot be. */
  compressed: number | null;
  /** The compression store's size at each read, the last few minutes, to see whether it grows. */
  compressions: CompressionReading[];
  /** Who holds Windows' memory, read with `topWindows` (`holders.ts`); null until read. */
  holders: Holders | null;
  topWindowsAt: number;
  /**
   * The biggest kernel pool tags (`poolTags`), read while the window is open
   * and Windows gives pool sizes, and every minute while shut with a pool
   * over 2 GB (`readPools`); `tags` is null with why in `error` when the
   * read failed. Null before the first read.
   */
  pools: { tags: PoolTag[] | null; error: string } | null;
  poolsAt: number;
  /** Every pool tag over 1 MB at each read, the last 30 minutes: what growth is worked out from. */
  poolHistory: PoolReading[];
  /** What is known of the pool leak now (`PoolLeaks`); unknown until 5 minutes of readings. */
  leaks: PoolLeaks;
  /** When the event-tracing holder was last looked for. */
  etwHolderAt: number;
  /** The graphics card, read while the window is open (`gpu-live.ts`). */
  gpu: GpuMonitor;
  cloud: { recent: number; total: number } | null;
  cloudAt: number;
  askedAt: number;
  /** Seconds of the window it asked for last. */
  askedWindow: number;
  /** What the status bar and the session chips show now, as a key: sent again only when it changes. */
  chip: string;
  /** What the nanny remembers between seconds (`nanny.ts`). */
  nanny: NannyMemory;
  /** Each session's tools, from the latest process table the nanny averaged. */
  nannyUse: { at: number; use: Map<string, ToolUse>; unowned: number } | null;
  /** The sessions with a chip now, to log only when they change. */
  chipped: string;
};

/** The window asks every second; it counts as open while it asked within this. */
const OPEN_FOR = 10_000;

export function open(current: State): boolean {
  return Date.now() - current.askedAt < OPEN_FOR;
}
