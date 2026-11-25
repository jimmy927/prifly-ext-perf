/**
 * Reads the graphics card for the Machine tab's card and the Memory tab's
 * section, only while the window is open, keeping the last hour of `nvidia-smi`
 * reads for the section's sparklines:
 * `nvidia-smi` every 5 s, Windows' per-process counters every 10 s, and
 * prifly's `gpu-holders.json` each time the page asks, from a host in WSL or
 * on Windows (`holdersPlaces`). The sums are in `gpu.ts`.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Card,
  type DxgProcess,
  type GpuProcesses,
  type GpuRow,
  GREY_NEEDS_MIB,
  type Grey,
  greyState,
  parseGpuProcesses,
  parseNvidiaSmi,
  pickLuid,
  readGreyNeeds,
  readHolders,
  rowsOf,
  shareOut,
} from "./gpu";
import type { GpuPoint } from "./gpu-map";
import { HOST } from "./host";
import { HOUR, keep } from "./ring";
import { gpuProcessCounters } from "./windows";
import type { WindowsSampler } from "./windows-sampler";

const SMI_EVERY = 5_000;
const PROCESSES_EVERY = 10_000;
const SMI = ["nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"];
const QUERY = ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"];

/** Where a host publishes `gpu-holders.json`, and whether its pids are Windows' (a host on Windows itself). */
export type HoldersPlace = { path: string; windows: boolean };

const HOLDERS_NAME = "gpu-holders.json";

/**
 * Where prifly's hosts publish their holders: a host in WSL in
 * `~/.local/share/prifly`, a host on Windows in `%LOCALAPPDATA%\prifly\host`,
 * found from WSL under each `/mnt/c/Users/<user>`. The WSL host's file comes first.
 */
export function holdersPlaces(): HoldersPlace[] {
  if (HOST.native) {
    const local = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
    return [{ path: join(local, "prifly", "host", HOLDERS_NAME), windows: true }];
  }
  let users: string[] = [];
  try {
    users = readdirSync("/mnt/c/Users");
  } catch {
    // No Windows around this Linux.
  }
  return [
    { path: join(homedir(), ".local", "share", "prifly", HOLDERS_NAME), windows: false },
    ...users.map((user) => ({
      path: join("/mnt/c/Users", user, "AppData", "Local", "prifly", "host", HOLDERS_NAME),
      windows: true,
    })),
  ];
}

/** What `api/status` carries: loading until the first read; null (no block) where there is no card. */
export type GpuStatus =
  | { loading: true }
  | {
      loading: false;
      name: string;
      total: number;
      free: number;
      greyNeeds: number;
      /** Grey words running, or whether they would start: the holders file first, else free memory. */
      grey: Grey;
      holders: GpuRow[];
      /** Why who holds the card is not known; empty when it is. */
      unknown: string;
      /** The card's shared memory in use (system RAM it borrows), MiB; null where Windows' counters do not give it. */
      shared: number | null;
    };

/** The card's shared memory in use, by Windows' adapter counters for the card's luid; null where not counted. */
function sharedOf(windows: WindowsSampler | null, card: Card): number | null {
  if (windows === null || windows.gpuAdapters === null || windows.gpuShared === null) return null;
  const luid = pickLuid(windows.gpuAdapters, card.total - card.free);
  return luid === null ? null : (windows.gpuShared.get(luid) ?? null);
}

function run(command: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(command, QUERY, { timeout: 5_000 }, (error, stdout) =>
      done(error === null ? stdout : null),
    );
  });
}

/** `nvidia-smi` on PATH, else where WSL keeps it; null when neither answers. */
async function readCard(): Promise<Card | null> {
  for (const command of SMI) {
    const out = await run(command);
    if (out !== null) return parseNvidiaSmi(out);
  }
  return null;
}

/** Whether a pid is alive: by `/proc` inside WSL; on Windows itself, where there is none, by asking. */
function alive(pid: number): boolean {
  if (!HOST.native) return existsSync(`/proc/${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive, but not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The WSL processes that have `/dev/dxg` open, found by the symlinks in
 * `/proc/<pid>/fd`; null where there is no `/proc` to look in. Processes that
 * vanish or are not ours to look into are skipped. Only this distro's
 * processes are seen: those in other distros, Docker Desktop's included, are
 * not in its `/proc`, though their GPU memory is in the VM's figure. With no
 * local process but prifly's workers to show for it, it is counted into the
 * workers.
 */
export async function scanDxg(proc = "/proc"): Promise<DxgProcess[] | null> {
  if (HOST.native) return null;
  let pids: string[];
  try {
    pids = (await readdir(proc)).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return null;
  }
  const found = await Promise.all(
    pids.map(async (pid): Promise<DxgProcess | null> => {
      try {
        for (const fd of await readdir(`${proc}/${pid}/fd`)) {
          if ((await readlink(`${proc}/${pid}/fd/${fd}`).catch(() => "")) !== "/dev/dxg") continue;
          const name = (await readFile(`${proc}/${pid}/comm`, "utf8").catch(() => "")).trim();
          return { pid: Number(pid), name: name || "process" };
        }
      } catch {
        // Gone, or not ours to look into.
      }
      return null;
    }),
  );
  return found.flatMap((p) => (p === null ? [] : [p]));
}

/**
 * The holders files' say: who holds the card, whether those are Windows
 * processes, and the free memory grey words start at. The first place with a
 * live holder wins. A Windows pid is alive while Windows lists it (`names`,
 * from its counters); before those are read, the file's freshness has to do.
 */
function holdersFile(places: HoldersPlace[], names: Map<number, string> | null) {
  const now = Date.now();
  const windowsAlive = (pid: number) => (names === null ? true : names.has(pid));
  let greyNeeds: number | null = null;
  for (const place of places) {
    let text: string;
    try {
      text = readFileSync(place.path, "utf8");
    } catch {
      continue;
    }
    greyNeeds ??= readGreyNeeds(text, now);
    const holders = readHolders(text, now, place.windows ? windowsAlive : alive);
    if (holders !== null) {
      return {
        holders,
        windows: place.windows,
        greyNeeds: readGreyNeeds(text, now) ?? GREY_NEEDS_MIB,
      };
    }
  }
  return { holders: null, windows: false, greyNeeds: greyNeeds ?? GREY_NEEDS_MIB };
}

export class GpuMonitor {
  private card: Card | null = null;
  /** One point per `nvidia-smi` read, the last hour: the Memory tab's sparklines. */
  readonly history: GpuPoint[] = [];
  private probed = false;
  private smiAt = 0;
  private processes: (GpuProcesses & { at: number }) | null = null;
  private processesAt = 0;
  private processesFailed = false;
  private dxg: DxgProcess[] | null = null;
  private dxgAt = 0;
  private scanning = false;
  private readonly scan: () => Promise<DxgProcess[] | null>;
  private readonly holdersPlaces: HoldersPlace[];
  private readonly log: (
    event: string,
    data: Record<string, string | number | boolean | null>,
  ) => void;

  constructor(
    log: (event: string, data: Record<string, string | number | boolean | null>) => void,
    places = holdersPlaces(),
    scan: () => Promise<DxgProcess[] | null> = scanDxg,
  ) {
    this.log = log;
    this.scan = scan;
    this.holdersPlaces = places;
  }

  /** Asks again for what is due; never waits. */
  refresh(windows: WindowsSampler | null, now = Date.now()): void {
    if (now - this.smiAt > SMI_EVERY) {
      this.smiAt = now;
      void readCard().then((card) => {
        this.card = card;
        this.probed = true;
        if (card === null) return;
        const point = { at: Date.now(), total: card.total, free: card.free };
        keep(this.history, { ...point, shared: sharedOf(windows, card) }, HOUR);
      });
    }
    if (this.card !== null && !this.scanning && now - this.dxgAt > PROCESSES_EVERY) {
      this.dxgAt = now;
      this.scanning = true;
      void this.scan()
        .then(
          (found) => {
            this.dxg = found;
          },
          () => {
            this.dxg = null;
          },
        )
        .finally(() => {
          this.scanning = false;
        });
    }
    if (windows === null || this.card === null || now - this.processesAt <= PROCESSES_EVERY) return;
    this.processesAt = now;
    gpuProcessCounters()
      .then((out) => {
        this.processes = { ...parseGpuProcesses(out), at: Date.now() };
        this.processesFailed = false;
      })
      .catch((error: unknown) => {
        this.processesFailed = true;
        this.log("gpu_processes_failed", { error: String(error) });
      });
  }

  /** The block for `api/status`: null where there is no NVIDIA card. */
  status(windows: WindowsSampler | null): GpuStatus | null {
    if (!this.probed) return { loading: true };
    const card = this.card;
    if (card === null) return null;
    // The file does not depend on Windows' counters: grey is known without them.
    const file = holdersFile(this.holdersPlaces, this.processes?.names ?? null);
    const grey = greyState(file.holders, card.free, file.greyNeeds);
    const shared = sharedOf(windows, card);
    const base = { loading: false as const, ...card, greyNeeds: file.greyNeeds, grey, shared };
    const unknown = (why: string): GpuStatus => ({ ...base, holders: [], unknown: why });
    if (windows === null) return unknown("this is not WSL, so Windows' counters are not read.");
    const used = card.total - card.free;
    const luid = windows.gpuAdapters === null ? null : pickLuid(windows.gpuAdapters, used);
    if (luid === null || this.processesFailed || windows.error !== "")
      return unknown("Windows' counters could not be read.");
    if (this.processes === null) return unknown("still reading Windows' counters…");
    const uses = this.processes.uses.filter((use) => use.luid === luid);
    // Workers of a host on Windows are Windows processes of their own, not in the VM's share.
    const workers = new Set(file.windows ? (file.holders ?? []).map((h) => h.pid) : []);
    const shares = shareOut(uses, this.processes.names, used, workers);
    return { ...base, holders: rowsOf(shares, file.holders, this.dxg), unknown: "" };
  }
}
