/**
 * Performance: whether this machine is out of CPU, memory or disk — inside
 * WSL and on the Windows around it — in green, orange and red, with a chip in
 * the status bar that says so and a window (`panel/`) that shows why. Its
 * second tab is prifly itself: how many processes it runs, for which
 * sessions, how many MCP servers they started, and what each costs.
 *
 * Linux is read every two seconds, always: a few small files, for the chip.
 * Windows' counters come from one `typeperf` that stays running. The process
 * table, Windows' busiest processes and the cloud sessions are read only
 * while the window is open, since nothing else shows them.
 */

import { McpConfig } from "./mcp";
import { commandLabel, ownersOf, type PriflyReport, priflyReport } from "./prifly";
import type { Decoration, ExtensionApi, PanelRequest } from "./prifly-api";
import { type Proc, ProcSampler } from "./procs";
import { headline, linuxVerdicts, type Tone, type Verdicts, windowsVerdicts } from "./verdict";
import {
  topProcesses,
  type WindowsInfo,
  type WindowsProcess,
  WindowsSampler,
  windowsInfo,
  windowsTools,
} from "./windows";
import { type LinuxSample, LinuxSampler } from "./wsl";

const EVERY = 2_000;
/** Five minutes of samples, for the sparklines. */
const KEEP = 150;
/** The window counts as open while it asked within this long. */
const OPEN_FOR = 10_000;
const TOP_WINDOWS_EVERY = 10_000;
const CLOUD_EVERY = 5 * 60_000;

/** One point of every sparkline. */
type Point = {
  at: number;
  linux: { cpu: number; memory: number; disk: number };
  windows: { cpu: number; memory: number; disk: number } | null;
};

type State = {
  api: ExtensionApi;
  linux: LinuxSampler;
  procs: ProcSampler;
  windows: WindowsSampler | null;
  info: WindowsInfo | null;
  last: LinuxSample | null;
  history: Point[];
  table: Proc[];
  report: PriflyReport | null;
  topWindows: WindowsProcess[];
  topWindowsAt: number;
  cloud: { recent: number; total: number } | null;
  cloudAt: number;
  askedAt: number;
  chip: string;
};

let state: State | null = null;

function windowsVerdictsOf(current: State): Verdicts | null {
  const counters = current.windows?.latest;
  if (counters === undefined || counters === null || current.info === null) return null;
  return windowsVerdicts(counters, current.info);
}

function places(current: State, linux: Verdicts) {
  const windows = windowsVerdictsOf(current);
  const out = [{ name: current.windows === null ? "Linux" : "WSL", verdicts: linux }];
  if (windows !== null) out.push({ name: "Windows", verdicts: windows });
  return out;
}

function point(current: State, s: LinuxSample): Point {
  const c = current.windows?.latest ?? null;
  const memTotal = current.info?.memTotal ?? 0;
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

const ICON_TONE: Record<Tone, Decoration["tone"]> = {
  good: "good",
  warning: "warning",
  critical: "critical",
};

/** The status-bar chip: shown again only when what it says changed. */
function showChip(current: State, linux: Verdicts): void {
  const judged = places(current, linux);
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
    { key: "perf", icon: "activity", label, tone: ICON_TONE[tone], details: [text, ...details] },
  ]);
}

function open(current: State): boolean {
  return Date.now() - current.askedAt < OPEN_FOR;
}

function refreshWhileOpen(current: State): void {
  current.table = current.procs.sample();
  current.report = priflyReport(
    current.table,
    process.pid,
    current.api.sessions(),
    new McpConfig(),
  );
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
  const sample = current.linux.sample();
  current.last = sample;
  current.history.push(point(current, sample));
  if (current.history.length > KEEP) current.history.shift();
  showChip(current, linuxVerdicts(sample));
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
    linux: new LinuxSampler(),
    procs: new ProcSampler(),
    windows,
    info: null,
    last: null,
    history: [],
    table: [],
    report: null,
    topWindows: [],
    topWindowsAt: 0,
    cloud: null,
    cloudAt: 0,
    askedAt: 0,
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
function topLinux(current: State) {
  const owners = ownersOf(current.table, current.report?.sessions ?? []);
  return [...current.table]
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

function status(current: State) {
  const linux = current.last;
  if (linux === null) throw new Error("No sample yet.");
  const linuxJudged = linuxVerdicts(linux);
  const windowsJudged = windowsVerdictsOf(current);
  return {
    headline: headline(places(current, linuxJudged)),
    linux: {
      name: current.windows === null ? "Linux" : "WSL",
      sample: linux,
      verdicts: linuxJudged,
    },
    windows:
      current.windows === null
        ? null
        : {
            counters: current.windows.latest,
            info: current.info,
            verdicts: windowsJudged,
            error: current.windows.error,
          },
    history: current.history,
    top: { linux: topLinux(current), windows: current.topWindows },
    prifly: current.report,
    cloud: current.cloud,
    every: EVERY,
  };
}

export function panel(_panelId: string, request: PanelRequest): unknown {
  const current = state;
  if (current === null) throw new Error("Performance is not running.");
  if (request.path !== "status") throw new Error(`No such request: ${request.path}`);
  const wasOpen = open(current);
  current.askedAt = Date.now();
  // Opened just now: read the processes at once rather than at the next tick.
  if (!wasOpen) refreshWhileOpen(current);
  return status(current);
}
