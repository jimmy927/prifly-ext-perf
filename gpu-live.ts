/**
 * Reads the graphics card for the Machine tab, only while the window is open:
 * `nvidia-smi` every 5 s, Windows' per-process counters every 10 s, and
 * prifly's `gpu-holders.json` each time the page asks. The sums are in `gpu.ts`.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Card,
  type GpuProcesses,
  type GpuRow,
  GREY_NEEDS_MIB,
  parseGpuProcesses,
  parseNvidiaSmi,
  pickLuid,
  readGreyNeeds,
  readHolders,
  rowsOf,
  shareOut,
} from "./gpu";
import { HOST } from "./host";
import { gpuProcessCounters, type WindowsSampler } from "./windows";

const SMI_EVERY = 5_000;
const PROCESSES_EVERY = 10_000;
const SMI = ["nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"];
const QUERY = ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"];

export const HOLDERS_FILE = join(homedir(), ".local", "share", "prifly", "gpu-holders.json");

/** What `api/status` carries: loading until the first read; null (no block) where there is no card. */
export type GpuStatus =
  | { loading: true }
  | {
      loading: false;
      name: string;
      total: number;
      free: number;
      greyNeeds: number;
      holders: GpuRow[];
      /** Why who holds the card is not known; empty when it is. */
      unknown: string;
    };

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

/** The holders file's say: who holds the card, and the free memory grey words start at. */
function holdersFile(path: string) {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { holders: null, greyNeeds: GREY_NEEDS_MIB };
  }
  const now = Date.now();
  return {
    holders: readHolders(text, now, alive),
    greyNeeds: readGreyNeeds(text, now) ?? GREY_NEEDS_MIB,
  };
}

export class GpuMonitor {
  private card: Card | null = null;
  private probed = false;
  private smiAt = 0;
  private processes: (GpuProcesses & { at: number }) | null = null;
  private processesAt = 0;
  private processesFailed = false;
  private readonly holdersPath: string;
  private readonly log: (
    event: string,
    data: Record<string, string | number | boolean | null>,
  ) => void;

  constructor(
    log: (event: string, data: Record<string, string | number | boolean | null>) => void,
    holdersPath = HOLDERS_FILE,
  ) {
    this.log = log;
    this.holdersPath = holdersPath;
  }

  /** Asks again for what is due; never waits. */
  refresh(windows: WindowsSampler | null, now = Date.now()): void {
    if (now - this.smiAt > SMI_EVERY) {
      this.smiAt = now;
      void readCard().then((card) => {
        this.card = card;
        this.probed = true;
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
    const file = holdersFile(this.holdersPath);
    const base = { loading: false as const, ...card, greyNeeds: file.greyNeeds };
    const unknown = (why: string): GpuStatus => ({ ...base, holders: [], unknown: why });
    if (windows === null) return unknown("this is not WSL, so Windows' counters are not read.");
    const used = card.total - card.free;
    const luid = windows.gpuAdapters === null ? null : pickLuid(windows.gpuAdapters, used);
    if (luid === null || this.processesFailed || windows.error !== "")
      return unknown("Windows' counters could not be read.");
    if (this.processes === null) return unknown("still reading Windows' counters…");
    const uses = this.processes.uses.filter((use) => use.luid === luid);
    const shares = shareOut(uses, this.processes.names, used);
    return { ...base, holders: rowsOf(shares, file.holders), unknown: "" };
  }
}
