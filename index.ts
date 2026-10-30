/**
 * Performance: whether this machine is out of CPU, memory or disk — inside
 * WSL and on the Windows around it — in green, orange and red, with a chip in
 * the status bar that says so and a window (`panel/`) that shows why. Its
 * second tab is prifly itself: how many processes it runs, for which
 * sessions, how many MCP servers they started, and what each costs.
 *
 * Linux is read every second, always: a few small files, for the chip.
 * Windows' counters come from one `typeperf` at a time, always running. The process
 * table, Docker's containers, Windows' busiest processes and the cloud
 * sessions are read only while the window is open, since nothing else shows them — except that the
 * process table is also read every 5 s whenever WSL's CPU or memory is not
 * green, for the nanny (`nanny.ts`), which names the sessions whose tools
 * cause the load. Every number the window shows is an average over the window
 * it asked for (`average.ts`).
 *
 * A host on Windows itself (`host.ts`) reads Windows the same way, and the WSL
 * VM's Linux through one `wsl.exe` (`wsl-exe.ts`) while WSL runs: the same
 * files a second, and, when the process table is read, that table and the
 * containers' cgroups through the same shell. Its sessions run inside WSL, so
 * the prifly tab and the nanny work from that table; the host's own Windows
 * processes (the host and all it started) come from the shared PowerShell.
 */

import { averageContainers, averageLinux, averageProcs, averageWindows, windowOf } from "./average";
import { ownerOf } from "./docker";
import { GpuMonitor } from "./gpu-live";
import { historyOf } from "./history";
import { holdersOf, withPools } from "./holders";
import { HOST } from "./host";
import { McpConfig } from "./mcp";
import { memoryMap } from "./memory-map";
import { newNannyMemory } from "./nanny";
import { nannyStep } from "./nanny-step";
import { priflyReport, topLinux, type Usage, usageOf } from "./prifly";
import type { Decoration, ExtensionApi, PanelRequest } from "./prifly-api";
import { otherPrograms, windowsPrograms } from "./programs";
import { HOUR, keep } from "./ring";
import { open, type State } from "./state";
import { Tables } from "./tables";
import {
  headline,
  linuxVerdicts,
  type MemoryCheck,
  memoryReasons,
  type Place,
  type Tone,
  type Verdicts,
  windowsMemoryChecks,
  windowsVerdicts,
  withGreyWords,
} from "./verdict";
import {
  cpuSplit,
  stopPowershell,
  type WindowsCounters,
  type WindowsInfo,
  windowsInfo,
  windowsTools,
} from "./windows";
import { compressionGrowth, parsePoolTags, poolTags } from "./windows-memory";
import { WindowsSampler } from "./windows-sampler";
import { topProcesses } from "./windows-top";
import { type LinuxRaw, type LinuxSample, readLinux } from "./wsl";
import { probeWsl, spawnWslShell, WslLinux } from "./wsl-exe";

const EVERY = 1_000;
/** The chip judges the last 10 s whether or not the window is open: it must not flicker. */
const CHIP_WINDOW = 10;
/**
 * The longest window is 5 min, and processes are only read while the window is
 * open, so their samples are kept 5 min and a little over, not the hour of the
 * Linux and Windows ones (a process table is hundreds of entries a second).
 */
const PROCS_KEEP = 310;
const TOP_WINDOWS_EVERY = 10_000;
/** Seconds of compression store readings kept: a minute's growth, and some over. */
const COMPRESSION_KEEP = 300;
/** The kernel pool tags are read at most this often, and only while the window is open. */
const POOLS_EVERY = 10_000;
const CLOUD_EVERY = 5 * 60_000;

let state: State | null = null;

/** Windows' verdicts for counters already averaged, and the memory checks behind its memory colour. */
function windowsJudgedOf(
  info: WindowsInfo | null,
  c: WindowsCounters | null,
): { verdicts: Verdicts; checks: MemoryCheck[] } | null {
  if (c === null || info === null) return null;
  return { verdicts: windowsVerdicts(c, info), checks: windowsMemoryChecks(c, info) };
}

function windowsAverage(current: State, seconds: number, endIndex?: number) {
  return current.windows === null
    ? null
    : averageWindows(current.windows.history, seconds, endIndex);
}

/** What Linux is called: WSL wherever there is a Windows around it, or the host is on Windows. */
function linuxName(current: State): string {
  return current.windows === null && current.wsl === null ? "Linux" : "WSL";
}

function places(
  current: State,
  linux: Verdicts | null,
  windows: ReturnType<typeof windowsJudgedOf>,
): Place[] {
  const out: Place[] = linux === null ? [] : [{ name: linuxName(current), verdicts: linux }];
  if (windows !== null) {
    const why = memoryReasons(windows.checks).map((check) => check.text);
    out.push({ name: "Windows", verdicts: windows.verdicts, memoryReasons: why });
  }
  return out;
}

const ICON_TONE: Record<Tone, Decoration["tone"]> = {
  good: "good",
  warning: "warning",
  critical: "critical",
};

/** The status-bar item: the Performance button, coloured by the worst of the three. */
function statusItem(current: State, linux: Verdicts | null): Decoration {
  const windows = windowsAverage(current, CHIP_WINDOW);
  const judged = places(current, linux, windowsJudgedOf(current.info, windows?.value ?? null));
  const { tone, text } = headline(judged);
  // The first sentence, without the reasons after its colon (whose "4.7 GB" has a dot of its own).
  const label = tone === "good" ? "Fine" : (text.split(/: |\. |\.$/)[0] ?? text);
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
function showAll(
  current: State,
  linux: Verdicts | null,
  chips: Record<string, Decoration[]>,
): void {
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

function refreshWhileOpen(current: State): void {
  const now = Date.now();
  current.tables.readAll(PROCS_KEEP, now);
  current.gpu.refresh(current.windows, now);
  if (current.windows !== null && now - current.topWindowsAt > TOP_WINDOWS_EVERY) {
    current.topWindowsAt = now;
    topProcesses()
      .then((top) => {
        current.topWindows = top.processes;
        current.compressed = top.compressed;
        if (top.compressed !== null) {
          keep(current.compressions, { at: Date.now(), bytes: top.compressed }, COMPRESSION_KEEP);
        }
        // A host on Windows itself is a Windows process: its own, and its window, are told apart.
        current.holders = holdersOf(top.out, current.tables.native ? process.pid : null);
      })
      .catch((error: unknown) => {
        current.api.log("top_failed", { error: String(error) });
        current.holders = {
          groups: [],
          committed: null,
          pools: null,
          shared: null,
          inProcesses: 0,
          error: `Windows' process list could not be read: ${String(error)}`,
        };
      });
  }
  const latest = current.windows?.history.at(-1);
  // Only while the page shows pool sizes: with no pool counter there is no pools line to drill into.
  if (latest !== undefined && latest.poolPaged !== null && now - current.poolsAt > POOLS_EVERY) {
    current.poolsAt = now;
    poolTags()
      .then((out) => {
        const tags = parsePoolTags(out);
        current.pools = { tags, error: tags === null ? "Windows gave no pool tags" : "" };
      })
      .catch((error: unknown) => {
        current.api.log("pool_tags_failed", { error: String(error) });
        current.pools = { tags: null, error: String(error) };
      });
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
  if (current.wsl === null) keep(current.linux, readLinux(), HOUR);
  else {
    // Its answer lands in the ring a moment later (`activate`).
    current.wsl.poll();
    // No WSL now: what was kept is from before the gap, and says nothing about now.
    if (current.wsl.absent !== "") {
      current.linux.length = 0;
      current.tables.clearWsl();
    }
  }
  if (open(current)) refreshWhileOpen(current);
  const linux = averageLinux(current.linux, CHIP_WINDOW);
  if (linux === null) {
    // Windows alone, once typeperf has printed a line.
    if (current.wsl !== null && windowsAverage(current, CHIP_WINDOW) !== null) {
      showAll(current, null, {});
    }
    return;
  }
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
  const linux: LinuxRaw[] = [];
  const wsl = HOST.native
    ? new WslLinux({
        spawn: spawnWslShell,
        probe: probeWsl,
        onRead: (raw) => keep(linux, raw, HOUR),
      })
    : null;
  const current: State = {
    api,
    linux,
    wsl,
    tables: new Tables({
      wsl,
      windows: windows !== null,
      hostPid: process.pid,
      log: (event, data) => api.log(event, data),
    }),
    windows,
    info: null,
    topWindows: [],
    compressed: null,
    compressions: [],
    holders: null,
    topWindowsAt: 0,
    pools: null,
    poolsAt: 0,
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
    current.wsl?.stop();
    current.tables.stop();
    stopPowershell();
    state = null;
  };
}

/**
 * Linux's block of the page: null with why in `linuxAbsent` when there is no
 * Linux to show (a host on Windows while WSL is not read).
 */
function linuxStatus(current: State, sample: LinuxSample | null) {
  if (sample === null) {
    return { linux: null, linuxAbsent: current.wsl?.absent || "Reading WSL…" };
  }
  const linux = { name: linuxName(current), sample, verdicts: linuxVerdicts(sample) };
  return { linux, linuxAbsent: "" };
}

/**
 * prifly's processes over the window: the report, null where the table is
 * not read (yet, or while a host on Windows has no WSL to read) — the page
 * draws the prifly tab, and its WSL tiles, only from one. A host on Windows
 * itself is not in the table: its own Windows processes are `priflyWindows`,
 * null elsewhere and before their first read, and the report counts them as
 * the host's.
 */
function priflyOf(current: State, seconds: number) {
  const { tables } = current;
  const procs = averageProcs(tables.procs, seconds);
  const sessions = current.api.sessions();
  const containers = averageContainers(tables.containers, seconds, tables.dockerInfos, (info) =>
    ownerOf(info, sessions),
  );
  const windowsHost = tables.native
    ? (averageProcs(tables.windowsHost, seconds)?.value ?? null)
    : null;
  const priflyWindows: Usage | null = windowsHost === null ? null : usageOf(windowsHost);
  // What "Other" is made of in the Where it goes card; WSL's only once prifly's part is known.
  const windows = windowsPrograms(current.topWindows, windowsHost ?? []);
  if (procs === null) {
    return { procs, containers, report: null, priflyWindows, others: { linux: [], windows } };
  }
  const counted = new Set<number>();
  const report = priflyReport(
    procs.value,
    tables.native ? null : process.pid,
    sessions,
    new McpConfig(),
    containers,
    windowsHost === null ? null : { procs: windowsHost, hostPid: process.pid },
    counted,
  );
  const others = { linux: otherPrograms(procs.value, counted), windows };
  return { procs, containers, report, priflyWindows, others };
}

/** Windows' block of the page, from counters already averaged; null where there is no Windows to read. */
function windowsStatus(
  current: State,
  counters: WindowsCounters | null,
  judged: ReturnType<typeof windowsJudgedOf>,
) {
  if (current.windows === null) return null;
  return {
    counters,
    info: current.info,
    // User, Windows' kernel and the WSL VM, as shares of the machine (`cpuSplit`).
    split:
      counters === null || current.info === null ? null : cpuSplit(counters, current.info.cores),
    compressed: current.compressed,
    // Bytes a minute over the last minute; null before a minute of reads.
    compressionGrowth: compressionGrowth(current.compressions),
    verdicts: judged?.verdicts ?? null,
    // Every memory check, green ones too: the Memory row shows why it has its colour.
    memoryChecks: judged?.checks ?? [],
    pools: current.pools,
    error: current.windows.error,
  };
}

/**
 * Who holds Windows' memory: null without Windows, `{reading: true}` until its
 * first read. Its pools are the Memory row's (`counters`), so the two agree.
 */
function holdersStatus(current: State, counters: WindowsCounters | null) {
  if (current.windows === null) return null;
  if (current.holders === null) return { reading: true };
  return withPools(current.holders, counters);
}

/**
 * The Memory tab's two views (`memory-map.ts`): null without Windows (no tab),
 * `{reading: true}` until the counters and Windows' own info are read.
 */
function memoryMapStatus(current: State, counters: WindowsCounters | null) {
  if (current.windows === null) return null;
  const map = memoryMap({
    counters,
    info: current.info,
    holders: current.holders === null ? null : withPools(current.holders, counters),
    tags: current.pools?.tags ?? null,
    compressed: current.compressed,
  });
  return map ?? { reading: true };
}

/** Everything the page shows, each number averaged over the last `seconds`. */
function status(current: State, seconds: number) {
  const linux = averageLinux(current.linux, seconds);
  const windows = windowsAverage(current, seconds);
  if (linux === null && windows === null) throw new Error("No sample yet.");
  const { procs, containers, report, priflyWindows, others } = priflyOf(current, seconds);
  const linuxBlock = linuxStatus(current, linux?.value ?? null);
  const windowsJudged = windowsJudgedOf(current.info, windows?.value ?? null);
  const gpu = current.gpu.status(current.windows);
  const greyOff = gpu !== null && !gpu.loading && gpu.grey === "short";
  return {
    headline: withGreyWords(
      headline(places(current, linuxBlock.linux?.verdicts ?? null, windowsJudged)),
      greyOff,
    ),
    gpu,
    ...linuxBlock,
    // Why the prifly tab is empty: "" wherever the process table is read, and on a
    // host on Windows itself while WSL runs.
    processes: current.wsl?.absent ?? "",
    windows: windowsStatus(current, windows?.value ?? null, windowsJudged),
    history: historyOf(current.linux, current.windows?.history ?? [], current.info, seconds),
    top: { linux: topLinux(procs?.value ?? [], containers, report), windows: current.topWindows },
    holders: holdersStatus(current, windows?.value ?? null),
    memoryMap: memoryMapStatus(current, windows?.value ?? null),
    others,
    prifly: report,
    // A host on Windows itself: its own Windows processes, which `prifly` counts as the host's too.
    priflyWindows,
    cloud: current.cloud,
    window: seconds,
    // A window that has not filled yet says how much it has.
    covered: Math.min(
      linux?.covered ?? Infinity,
      procs?.covered ?? Infinity,
      windows?.covered ?? Infinity,
    ),
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
    current.tables.clear();
    // The store's growth is read only while open: a minute from before the gap says nothing now.
    current.compressions.length = 0;
    refreshWhileOpen(current);
  }
  return status(current, seconds);
}
