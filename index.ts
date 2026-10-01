/**
 * Performance: whether this machine is out of CPU, memory or disk — inside
 * WSL and on the Windows around it — in green, orange and red, with a chip in
 * the status bar that says so and a window (`panel/`) that shows why. Its
 * second tab is prifly itself: how many processes it runs, for which
 * sessions, how many MCP servers they started, and what each costs.
 *
 * Linux is read every second, always: a few small files, for the chip.
 * Windows' counters come from one `typeperf` that stays running. The process
 * table, Windows' busiest processes and the cloud sessions are read only
 * while the window is open, since nothing else shows them. Every number the
 * window shows is an average over the window it asked for (`average.ts`).
 */

import { averageLinux, averageProcs, averageWindows, windowOf } from "./average";
import { McpConfig } from "./mcp";
import { commandLabel, ownersOf, type PriflyReport, priflyReport } from "./prifly";
import type { Decoration, ExtensionApi, PanelRequest } from "./prifly-api";
import { type Proc, type ProcSnapshot, readProcs } from "./procs";
import { endAt, HOUR, keep, windowEnds } from "./ring";
import { headline, linuxVerdicts, type Tone, type Verdicts, windowsVerdicts } from "./verdict";
import {
  topProcesses,
  type WindowsCounters,
  type WindowsInfo,
  type WindowsProcess,
  WindowsSampler,
  windowsInfo,
  windowsTools,
} from "./windows";
import { type LinuxRaw, type LinuxSample, readLinux } from "./wsl";

const EVERY = 1_000;
/** The chip judges the last 10 s whether or not the window is open: it must not flicker. */
const CHIP_WINDOW = 10;
/**
 * The longest window is 5 min, and processes are only read while the window is
 * open, so their samples are kept 5 min and a little over, not the hour of the
 * Linux and Windows ones (a process table is hundreds of entries a second).
 */
const PROCS_KEEP = 310;
/** The window counts as open while it asked within its own length plus this. */
const OPEN_FOR = 10_000;
const TOP_WINDOWS_EVERY = 10_000;
const CLOUD_EVERY = 5 * 60_000;

/** One point of every sparkline: the average of one window. */
type Point = {
  at: number;
  linux: { cpu: number; memory: number; disk: number };
  windows: { cpu: number; memory: number; disk: number } | null;
};

type State = {
  api: ExtensionApi;
  /** The last hour of reads, one a second. */
  linux: LinuxRaw[];
  /** The last five minutes of process tables, one a second while the window is open. */
  procs: ProcSnapshot[];
  windows: WindowsSampler | null;
  info: WindowsInfo | null;
  topWindows: WindowsProcess[];
  topWindowsAt: number;
  cloud: { recent: number; total: number } | null;
  cloudAt: number;
  askedAt: number;
  /** Seconds of the window it asked for last. */
  askedWindow: number;
  chip: string;
};

let state: State | null = null;

/** Windows' verdicts for counters already averaged. */
function windowsVerdictsOf(info: WindowsInfo | null, c: WindowsCounters | null): Verdicts | null {
  return c === null || info === null ? null : windowsVerdicts(c, info);
}

function windowsAverage(current: State, seconds: number, endIndex?: number) {
  return current.windows === null
    ? null
    : averageWindows(current.windows.history, seconds, endIndex);
}

function places(current: State, linux: Verdicts, windows: Verdicts | null) {
  const out = [{ name: current.windows === null ? "Linux" : "WSL", verdicts: linux }];
  if (windows !== null) out.push({ name: "Windows", verdicts: windows });
  return out;
}

function point(info: WindowsInfo | null, s: LinuxSample, c: WindowsCounters | null): Point {
  const memTotal = info?.memTotal ?? 0;
  return {
    at: s.at,
    linux: {
      cpu: s.cpu?.some.avg10 ?? s.busy,
      memory: s.memTotal > 0 ? 100 * (1 - s.memAvailable / s.memTotal) : 0,
      disk: s.diskRead + s.diskWrite,
    },
    windows:
      c === null
        ? null
        : {
            cpu: c.busy ?? 0,
            memory: memTotal > 0 ? 100 * (1 - ((c.availableMB ?? 0) * 2 ** 20) / memTotal) : 0,
            disk: (c.diskRead ?? 0) + (c.diskWrite ?? 0),
          },
  };
}

/** One point per window, the last 60 that fit in the hour. */
function history(current: State, seconds: number): Point[] {
  return windowEnds(current.linux, seconds).flatMap((index) => {
    const linux = averageLinux(current.linux, seconds, index);
    if (linux === null) return [];
    const ring = current.windows?.history ?? [];
    const windows = windowsAverage(current, seconds, endAt(ring, linux.value.at));
    return [point(current.info, linux.value, windows?.value ?? null)];
  });
}

const ICON_TONE: Record<Tone, Decoration["tone"]> = {
  good: "good",
  warning: "warning",
  critical: "critical",
};

/** The status-bar chip: shown again only when what it says changed. */
function showChip(current: State): void {
  const linux = averageLinux(current.linux, CHIP_WINDOW);
  if (linux === null) return;
  const windows = windowsAverage(current, CHIP_WINDOW);
  const judged = places(
    current,
    linuxVerdicts(linux.value),
    windowsVerdictsOf(current.info, windows?.value ?? null),
  );
  const { tone, text } = headline(judged);
  const label = tone === "good" ? "Fine" : (text.split(".")[0] ?? text);
  const details = judged.map(
    ({ name, verdicts }) =>
      `${name}: CPU ${verdicts.cpu}, memory ${verdicts.memory}, disk ${verdicts.disk}`,
  );
  const key = `${tone}|${label}|${details.join("|")}`;
  if (key === current.chip) return;
  current.chip = key;
  current.api.show({}, [
    {
      key: "perf",
      icon: "activity",
      label,
      tone: ICON_TONE[tone],
      // The label is the headline's first sentence: repeated only when there is more to it.
      details: text === `${label}.` ? details : [text, ...details],
      // Drawn as the Performance button's own colour, not a chip beside it.
      panel: "perf",
    },
  ]);
}

function open(current: State): boolean {
  return Date.now() - current.askedAt < current.askedWindow * 1000 + OPEN_FOR;
}

function refreshWhileOpen(current: State): void {
  keep(current.procs, readProcs(), PROCS_KEEP);
  const now = Date.now();
  if (current.windows !== null && now - current.topWindowsAt > TOP_WINDOWS_EVERY) {
    current.topWindowsAt = now;
    topProcesses()
      .then((top) => {
        current.topWindows = top;
      })
      .catch((error: unknown) => current.api.log("top_failed", { error: String(error) }));
  }
  if (now - current.cloudAt > CLOUD_EVERY) {
    current.cloudAt = now;
    current.api.cloud
      .sessions()
      .then((sessions) => {
        const hour = Date.now() - 3_600_000;
        current.cloud = {
          recent: sessions.filter((s) => s.updatedAt > hour).length,
          total: sessions.length,
        };
      })
      .catch((error: unknown) => current.api.log("cloud_failed", { error: String(error) }));
  }
}

function tick(current: State): void {
  keep(current.linux, readLinux(), HOUR);
  showChip(current);
  if (open(current)) refreshWhileOpen(current);
}

async function learnWindows(current: State): Promise<void> {
  try {
    current.info = await windowsInfo();
  } catch (error) {
    current.api.log("windows_info_failed", { error: String(error) });
    setTimeout(() => void learnWindows(current), 60_000);
  }
}

export function activate(api: ExtensionApi): () => void {
  const windows = windowsTools() ? new WindowsSampler(EVERY / 1000) : null;
  const current: State = {
    api,
    linux: [],
    procs: [],
    windows,
    info: null,
    topWindows: [],
    topWindowsAt: 0,
    cloud: null,
    cloudAt: 0,
    askedAt: 0,
    askedWindow: 0,
    chip: "",
  };
  state = current;
  if (windows !== null) {
    windows.start();
    void learnWindows(current);
  }
  tick(current);
  const timer = setInterval(() => tick(current), EVERY);
  return () => {
    clearInterval(timer);
    windows?.stop();
    state = null;
  };
}

/** The busiest processes this Linux sees, each with the session it works for. */
function topLinux(table: Proc[], report: PriflyReport | null) {
  const owners = ownersOf(table, report?.sessions ?? []);
  return [...table]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .filter((proc) => proc.cpu >= 0.05)
    .map((proc) => ({
      pid: proc.pid,
      what: commandLabel(proc.argv.length > 0 ? proc.argv : [proc.comm]),
      session: owners.get(proc.pid) ?? "",
      cpu: proc.cpu,
      rss: proc.rss,
      disk: proc.read + proc.write,
    }));
}

/** Everything the page shows, each number averaged over the last `seconds`. */
function status(current: State, seconds: number) {
  const linux = averageLinux(current.linux, seconds);
  if (linux === null) throw new Error("No sample yet.");
  const procs = averageProcs(current.procs, seconds);
  const table = procs?.value ?? [];
  const windows = windowsAverage(current, seconds);
  const linuxJudged = linuxVerdicts(linux.value);
  const windowsJudged = windowsVerdictsOf(current.info, windows?.value ?? null);
  const report =
    procs === null
      ? null
      : priflyReport(table, process.pid, current.api.sessions(), new McpConfig());
  return {
    headline: headline(places(current, linuxJudged, windowsJudged)),
    linux: {
      name: current.windows === null ? "Linux" : "WSL",
      sample: linux.value,
      verdicts: linuxJudged,
    },
    windows:
      current.windows === null
        ? null
        : {
            counters: windows?.value ?? null,
            info: current.info,
            verdicts: windowsJudged,
            error: current.windows.error,
          },
    history: history(current, seconds),
    top: { linux: topLinux(table, report), windows: current.topWindows },
    prifly: report,
    cloud: current.cloud,
    window: seconds,
    // A window that has not filled yet says how much it has.
    covered: Math.min(linux.covered, procs?.covered ?? Infinity, windows?.covered ?? Infinity),
  };
}

export function panel(_panelId: string, request: PanelRequest): unknown {
  const current = state;
  if (current === null) throw new Error("Performance is not running.");
  if (request.path !== "status") throw new Error(`No such request: ${request.path}`);
  const seconds = windowOf(request.query["window"]);
  const wasOpen = open(current);
  current.askedAt = Date.now();
  current.askedWindow = seconds;
  // Opened just now: what was kept is from before a gap, so start the processes afresh.
  if (!wasOpen) {
    current.procs.length = 0;
    refreshWhileOpen(current);
  }
  return status(current, seconds);
}
