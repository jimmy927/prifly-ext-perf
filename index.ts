/**
 * Performance: whether this machine is out of CPU, memory or disk — inside
 * WSL and on the Windows around it — in green, orange and red, with a chip in
 * the status bar that says so and a window (`panel/`) that shows why. Its
 * second tab is prifly itself: how many processes it runs, for which
 * sessions, how many MCP servers they started, and what each costs.
 *
 * Linux is read every second, always: a few small files, for the chip.
 * Windows' counters come from one `typeperf` that stays running. The process
 * table, Docker's containers, Windows' busiest processes and the cloud
 * sessions are read only while the window is open, since nothing else shows them — except that the
 * process table is also read every 5 s whenever WSL's CPU or memory is not
 * green, for the nanny (`nanny.ts`), which names the sessions whose tools
 * cause the load. Every number the window shows is an average over the window
 * it asked for (`average.ts`).
 */

import { averageContainers, averageLinux, averageProcs, averageWindows, windowOf } from "./average";
import {
  type Container,
  type ContainerInfo,
  type ContainerSnapshot,
  containerInfos,
  ownerOf,
  readContainers,
} from "./docker";
import { GpuMonitor } from "./gpu-live";
import { McpConfig } from "./mcp";
import { decide, type NannyMemory, type NannySession, type Notice, newNannyMemory } from "./nanny";
import {
  commandLabel,
  ownerIdsOf,
  ownersOf,
  type PriflyReport,
  priflyReport,
  type ToolUse,
  toolUseOf,
} from "./prifly";
import type { Decoration, ExtensionApi, PanelRequest } from "./prifly-api";
import { type Proc, type ProcSnapshot, readProcs } from "./procs";
import { endAt, HOUR, keep, windowEnds } from "./ring";
import {
  headline,
  linuxVerdicts,
  type Tone,
  type Verdicts,
  windowsVerdicts,
  withGreyWords,
} from "./verdict";
import {
  machineBusy,
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
/** While only the nanny reads them: every 5 s, 30 s kept, and averaged over the 30 s. */
const NANNY_EVERY = 5_000;
const NANNY_KEEP = 30;
/** A table older than this is from before a gap, and says nothing about now. */
const NANNY_STALE = 15_000;
/** The fewest seconds a table must span for its rates to mean anything. */
const NANNY_MIN_SPAN = 3;
/** The window asks every second; it counts as open while it asked within this. */
const OPEN_FOR = 10_000;
const TOP_WINDOWS_EVERY = 10_000;
/** Containers' names and mounts change only when one starts or stops. */
const DOCKER_EVERY = 10_000;
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
  /** Docker's containers, read with the process table. */
  containers: ContainerSnapshot[];
  /** What each container is, by id, as Docker last said (`docker.ts`). */
  dockerInfos: Map<string, ContainerInfo>;
  dockerAt: number;
  windows: WindowsSampler | null;
  info: WindowsInfo | null;
  topWindows: WindowsProcess[];
  topWindowsAt: number;
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
      cpu: s.cpu?.some ?? s.busy,
      memory: s.memTotal > 0 ? 100 * (1 - s.memAvailable / s.memTotal) : 0,
      disk: s.diskRead + s.diskWrite,
    },
    windows:
      c === null
        ? null
        : {
            cpu: machineBusy(c),
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

/** The status-bar item: the Performance button, coloured by the worst of the three. */
function statusItem(current: State, linux: Verdicts): Decoration {
  const windows = windowsAverage(current, CHIP_WINDOW);
  const judged = places(current, linux, windowsVerdictsOf(current.info, windows?.value ?? null));
  const { tone, text } = headline(judged);
  const label = tone === "good" ? "Fine" : (text.split(".")[0] ?? text);
  const details = judged.map(
    ({ name, verdicts }) =>
      `${name}: CPU ${verdicts.cpu}, memory ${verdicts.memory}, disk ${verdicts.disk}`,
  );
  return {
    key: "perf",
    icon: "activity",
    label,
    tone: ICON_TONE[tone],
    // The label is the headline's first sentence: repeated only when there is more to it.
    details: text === `${label}.` ? details : [text, ...details],
    // Drawn as the Performance button's own colour, not a chip beside it.
    panel: "perf",
  };
}

/**
 * Everything this extension shows, in one call, since `show` replaces it all:
 * the status-bar item, unclaimed, and the nanny's chips on their sessions.
 * Sent again only when something in it changed.
 */
function showAll(current: State, linux: Verdicts, chips: Record<string, Decoration[]>): void {
  const item = statusItem(current, linux);
  const key = JSON.stringify([item, chips]);
  if (key === current.chip) return;
  current.chip = key;
  const ids = Object.keys(chips).sort().join(",");
  if (ids !== current.chipped) {
    current.chipped = ids;
    current.api.log("nanny_chips", { sessions: ids, count: Object.keys(chips).length });
  }
  current.api.show(chips, [item]);
}

function open(current: State): boolean {
  return Date.now() - current.askedAt < OPEN_FOR;
}

function refreshWhileOpen(current: State): void {
  keep(current.procs, readProcs(), PROCS_KEEP);
  const containers = readContainers();
  keep(current.containers, containers, PROCS_KEEP);
  const now = Date.now();
  // Docker is asked only when a container runs: with none there may be no Docker to ask.
  if (containers.containers.size > 0 && now - current.dockerAt > DOCKER_EVERY) {
    current.dockerAt = now;
    containerInfos()
      .then((infos) => {
        current.dockerInfos = infos;
      })
      // Until Docker answers, the containers go by their ids.
      .catch((error: unknown) => current.api.log("docker_failed", { error: String(error) }));
  }
  current.gpu.refresh(current.windows, now);
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

/**
 * While WSL's CPU or memory is not green and the window is closed, nobody else
 * reads the process table: read it every 5 s, and keep 30 s of it. After a
 * gap the old tables would stretch the average over the gap, so they go.
 */
function readForNanny(current: State, verdicts: Verdicts, now: number): void {
  if (verdicts.cpu === "good" && verdicts.memory === "good") return;
  const last = current.procs.at(-1);
  if (last !== undefined && now - last.at < NANNY_EVERY - 250) return;
  if (last !== undefined && now - last.at > NANNY_STALE) current.procs.length = 0;
  keep(current.procs, readProcs(), NANNY_KEEP);
}

/**
 * Each session's tools, and the cores no session owns, from the process table
 * averaged over its last 30 s. Worked out once per table, not once a second.
 * Null while the table is missing, stale or too short for its rates to mean
 * anything: a nanny that cannot see says nothing.
 */
function nannyUse(current: State, now: number): State["nannyUse"] {
  const last = current.procs.at(-1);
  if (last === undefined || now - last.at > NANNY_STALE) return null;
  if (current.nannyUse?.at === last.at) return current.nannyUse;
  const procs = averageProcs(current.procs, NANNY_KEEP);
  if (procs === null || procs.covered < NANNY_MIN_SPAN) return null;
  // The machine's busy cores over the same stretch, less every process some session owns:
  // what is left is Docker, Windows-side work, or something started by hand.
  const linux = averageLinux(current.linux, procs.covered);
  const owners = ownerIdsOf(procs.value);
  const owned = procs.value.reduce((sum, p) => sum + (owners.has(p.pid) ? p.cpu : 0), 0);
  const busy = linux === null ? 0 : (linux.value.busy * linux.value.cores) / 100;
  current.nannyUse = {
    at: last.at,
    use: toolUseOf(procs.value, current.api.sessions(), new McpConfig()),
    unowned: Math.max(0, busy - owned),
  };
  return current.nannyUse;
}

/** The sessions the host knows that run tools, with their state as it is now. */
function nannySessions(current: State, now: number): { sessions: NannySession[]; unowned: number } {
  const data = nannyUse(current, now);
  if (data === null) return { sessions: [], unowned: 0 };
  const sessions = current.api.sessions().flatMap((session) => {
    const use = data.use.get(session.id);
    return use === undefined
      ? []
      : [{ id: session.id, title: session.title, state: session.state, ...use }];
  });
  return { sessions, unowned: data.unowned };
}

/** Tells a session to ease off. A failure is logged, never thrown: the nanny must go on. */
async function sendNotice(current: State, notice: Notice): Promise<void> {
  current.api.log("nanny_notice", { session: notice.session, text: notice.text });
  try {
    const { delivered } = await current.api.prompt(notice.session, notice.text);
    if (!delivered) current.api.log("nanny_notice_failed", { session: notice.session });
  } catch (error) {
    current.api.log("nanny_notice_failed", { session: notice.session, error: String(error) });
  }
}

/** One second of the nanny: judge, carry out what it decided, and return the chips to show. */
function nannyStep(current: State, linux: LinuxSample, verdicts: Verdicts) {
  const now = Date.now();
  if (!open(current)) readForNanny(current, verdicts, now);
  const { sessions, unowned } = nannySessions(current, now);
  const decision = decide(
    current.nanny,
    {
      verdicts,
      psi: { cpu: linux.cpu?.some ?? 0, memory: linux.memory?.full ?? 0 },
      cores: linux.cores,
      memTotal: linux.memTotal,
      sessions,
      unowned,
    },
    now,
  );
  current.nanny = decision.memory;
  for (const notice of decision.notices) void sendNotice(current, notice);
  if (decision.notify !== null) {
    const { text, session } = decision.notify;
    current.api.log("nanny_notify", { text, session: session ?? null });
    const tone = "warning";
    current.api.notify(text, session === undefined ? { tone } : { tone, session });
  }
  return decision.chips;
}

function tick(current: State): void {
  keep(current.linux, readLinux(), HOUR);
  if (open(current)) refreshWhileOpen(current);
  const linux = averageLinux(current.linux, CHIP_WINDOW);
  if (linux === null) return;
  const verdicts = linuxVerdicts(linux.value);
  showAll(current, verdicts, nannyStep(current, linux.value, verdicts));
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
    containers: [],
    dockerInfos: new Map(),
    dockerAt: 0,
    windows,
    info: null,
    topWindows: [],
    topWindowsAt: 0,
    gpu: new GpuMonitor((event, data) => api.log(event, data)),
    cloud: null,
    cloudAt: 0,
    askedAt: 0,
    askedWindow: 0,
    chip: "",
    nanny: newNannyMemory(),
    nannyUse: null,
    chipped: "",
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

/**
 * The busiest processes this Linux sees and Docker's busiest containers, each
 * with the session it works for.
 */
function topLinux(table: Proc[], containers: Container[], report: PriflyReport | null) {
  const owners = ownersOf(table, report?.sessions ?? []);
  const titles = new Map((report?.sessions ?? []).map((row) => [row.id, row.title]));
  const procs = table.map((proc) => ({
    pid: proc.pid,
    what: commandLabel(proc.argv.length > 0 ? proc.argv : [proc.comm]),
    session: owners.get(proc.pid) ?? "",
    cpu: proc.cpu,
    rss: proc.rss,
    disk: proc.read + proc.write,
  }));
  const docker = containers.map((container) => ({
    pid: 0,
    what: `container ${container.name}`,
    session: titles.get(container.session) ?? "",
    cpu: container.cpu,
    rss: container.memory,
    disk: 0,
  }));
  return [...procs, ...docker]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 8)
    .filter((row) => row.cpu >= 0.05);
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
  const sessions = current.api.sessions();
  const containers = averageContainers(current.containers, seconds, current.dockerInfos, (info) =>
    ownerOf(info, sessions),
  );
  const report =
    procs === null ? null : priflyReport(table, process.pid, sessions, new McpConfig(), containers);
  const gpu = current.gpu.status(current.windows);
  const greyOff = gpu !== null && !gpu.loading && gpu.grey === "short";
  return {
    headline: withGreyWords(headline(places(current, linuxJudged, windowsJudged)), greyOff),
    gpu,
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
    top: { linux: topLinux(table, containers, report), windows: current.topWindows },
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
    current.containers.length = 0;
    refreshWhileOpen(current);
  }
  return status(current, seconds);
}
