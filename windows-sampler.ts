/**
 * The one `typeperf.exe` at a time that prints Windows' counters (`windows.ts`)
 * every second, and the last hour of what it printed.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { HOST } from "./host";
import { type HostProcess, hookHostExit, realProcess } from "./host-exit";
import { HOUR, keep } from "./ring";
import { COUNTERS, GPU_ADAPTER, parseGpuAdapters, parseRow, type WindowsCounters } from "./windows";

/** The parts of a started `typeperf` the sampler uses; tests give it a fake. */
export type TypeperfChild = {
  stdout: Readable | null;
  kill(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
};

/** What the sampler needs from outside; the defaults are the real ones. */
export type SamplerDeps = {
  spawn(args: string[]): TypeperfChild;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  later(fn: () => void, ms: number): () => void;
  host: HostProcess;
};

const realDeps: SamplerDeps = {
  spawn: (args) =>
    spawn(HOST.typeperf, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
  later: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  host: realProcess,
};

/**
 * How long one `typeperf` runs before it ends by itself (`-sc`). Nothing needs
 * to be alive for that to work: a `typeperf` whose host died without a word
 * (SIGKILL) while something still held its pipe kept running for days, and
 * now ends within this long.
 */
export const RUN_SECONDS = 50;

/**
 * Samples before the end at which the next `typeperf` is started. One takes
 * about two seconds to print its header and a third to print a line, so
 * starting it this early has it ready when the last one ends and the
 * one-a-second series has no gap.
 */
export const HANDOVER_SAMPLES = 5;

const RESTART_AFTER = 30_000;

/** One `typeperf`: its header, and how many lines it has printed. */
type Run = { child: TypeperfChild; header: string; samples: number };

/**
 * Keeps one `typeperf` running at a time and the last hour of the lines it
 * printed (the panel averages over them). Each ends by itself after
 * `RUN_SECONDS` and the next, started a few samples before, takes over; that
 * is not a failure. One that ends early, or without printing its samples, is:
 * the error says so and it is started again in 30 s.
 *
 * The host does not call `stop` when it exits, so the `typeperf` is also
 * killed by the host's exit and its SIGTERM and SIGINT (`host-exit.ts`).
 */
export class WindowsSampler {
  latest: WindowsCounters | null = null;
  readonly history: WindowsCounters[] = [];
  /** The graphics adapters' memory in use now, MiB by luid; null where Windows has no such counters. */
  gpuAdapters: Map<string, number> | null = null;
  error = "";
  /** The one whose lines are kept. */
  private current: Run | null = null;
  /** Started before `current` ends; its lines are kept once it has. */
  private next: Run | null = null;
  private cancelRetry: (() => void) | null = null;
  private unhook: (() => void) | null = null;
  private stopped = false;

  private readonly everySeconds: number;
  private readonly runSamples: number;
  private readonly deps: SamplerDeps;

  constructor(everySeconds: number, deps: SamplerDeps = realDeps) {
    this.everySeconds = everySeconds;
    this.runSamples = Math.max(HANDOVER_SAMPLES + 1, Math.round(RUN_SECONDS / everySeconds));
    this.deps = deps;
  }

  start(): void {
    this.stopped = false;
    this.unhook ??= hookHostExit(() => this.stop(), this.deps.host);
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.unhook?.();
    this.unhook = null;
    for (const run of [this.current, this.next]) run?.child.kill();
    this.current = null;
    this.next = null;
  }

  private launch(): void {
    const child = this.deps.spawn([
      ...Object.values(COUNTERS),
      GPU_ADAPTER,
      "-si",
      String(this.everySeconds),
      "-sc",
      String(this.runSamples),
    ]);
    const run: Run = { child, header: "", samples: 0 };
    if (this.current === null) this.current = run;
    else this.next = run;
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on("line", (line) => this.read(run, line));
    }
    child.on("error", (error) => {
      this.error = `typeperf: ${error.message}`;
    });
    child.on("exit", (code) => this.ended(run, code));
  }

  private read(run: Run, line: string): void {
    if (line.startsWith('"(PDH-CSV')) {
      run.header = line;
      return;
    }
    if (run.header === "") return;
    // The lines after the samples ("Exiting, please wait...") do not start with a quote.
    if (line.startsWith('"')) run.samples++;
    if (run === this.current && run.samples === this.runSamples - HANDOVER_SAMPLES) {
      if (this.next === null && !this.stopped) this.launch();
    }
    // The next one's lines are the same seconds as the current one's: dropped until it takes over.
    if (run !== this.current) return;
    const row = parseRow(run.header, line, Date.now());
    if (row !== null) {
      this.latest = row;
      this.gpuAdapters = parseGpuAdapters(run.header, line);
      keep(this.history, row, HOUR);
      this.error = "";
    }
  }

  private ended(run: Run, code: number | null): void {
    if (this.next === run) {
      this.next = null;
      return;
    }
    if (this.current !== run) return;
    this.current = null;
    if (this.stopped) return;
    if (code === 0 && run.samples >= this.runSamples) {
      // Its samples are done: the next takes over, or starts now if it did not get to.
      this.current = this.next;
      this.next = null;
      if (this.current === null) this.launch();
      return;
    }
    const waiting = this.next;
    this.next = null;
    waiting?.child.kill();
    this.error = `typeperf ended (${code ?? "signal"}); starting it again in 30 s`;
    this.cancelRetry = this.deps.later(() => {
      this.cancelRetry = null;
      this.launch();
    }, RESTART_AFTER);
  }
}
