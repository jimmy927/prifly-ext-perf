import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type HostProcess, hookHostExit } from "../host-exit";
import { COUNTERS, fromProcess } from "../windows";
import {
  HANDOVER_SAMPLES,
  RUN_SECONDS,
  type SamplerDeps,
  type TypeperfChild,
  WindowsSampler,
} from "../windows-sampler";

const FIELDS = Object.keys(COUNTERS).length;
const HEADER = `"(PDH-CSV 4.0)",${Object.values(COUNTERS)
  .map((path) => `"\\\\PC${path}"`)
  .join(",")}`;
const line = (n: number) =>
  `"10/19/2026 15:00:${String(n % 60).padStart(2, "0")}.000",${Array(FIELDS).fill(`"${n}"`).join(",")}`;

/** A `typeperf` the test drives by hand. */
class FakeTypeperf extends EventEmitter implements TypeperfChild {
  stdout = new PassThrough();
  killed = 0;
  readonly args: string[];
  constructor(args: string[]) {
    super();
    this.args = args;
  }
  kill(): void {
    this.killed++;
  }
  print(text: string): Promise<void> {
    this.stdout.write(`${text}\n`);
    // readline hands lines over on a later turn.
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  async header(): Promise<void> {
    await this.print(HEADER);
  }
  async samples(from: number, count: number): Promise<void> {
    for (let n = from; n < from + count; n++) await this.print(line(n));
  }
  /** What `typeperf -sc` prints and does at its end. */
  async finish(): Promise<void> {
    await this.print("Exiting, please wait...");
    await this.print("The command completed successfully.");
    this.emit("exit", 0);
  }
}

/** A `process` that keeps its listeners and records the signals it is asked to send itself. */
class FakeHost implements HostProcess {
  readonly listeners = new Map<string, (() => void)[]>();
  readonly raised: string[] = [];
  on(event: string, handler: () => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }
  off(event: string, handler: () => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((h) => h !== handler),
    );
  }
  listenerCount(event: string): number {
    return (this.listeners.get(event) ?? []).length;
  }
  raise(signal: NodeJS.Signals): void {
    this.raised.push(signal);
  }
  emit(event: string): void {
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler();
  }
  get total(): number {
    return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0);
  }
}

function rig() {
  const host = new FakeHost();
  const spawned: FakeTypeperf[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const deps: SamplerDeps = {
    spawn: (args) => {
      const child = new FakeTypeperf(args);
      spawned.push(child);
      return child;
    },
    later: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    host,
  };
  const sampler = new WindowsSampler(1, deps);
  const live = () => timers.filter((t) => !t.cancelled);
  return { host, spawned, timers, live, sampler };
}

const RUN = RUN_SECONDS; // at one sample a second

describe("WindowsSampler", () => {
  test("starts typeperf bounded to a run of samples", () => {
    const { sampler, spawned } = rig();
    sampler.start();
    const args = spawned[0]?.args ?? [];
    expect(args.slice(-4)).toEqual(["-si", "1", "-sc", String(RUN)]);
    sampler.stop();
  });

  test("keeps one line a second and the hour in history", async () => {
    const { sampler, spawned } = rig();
    sampler.start();
    await spawned[0]?.header();
    await spawned[0]?.samples(1, 3);
    expect(sampler.history.length).toBe(3);
    expect(sampler.latest?.busy).toBe(3);
    sampler.stop();
  });

  test("a normal end after its samples is neither an error nor a 30 s wait", async () => {
    const { sampler, spawned, timers } = rig();
    sampler.start();
    const first = spawned[0];
    await first?.header();
    await first?.samples(1, RUN - HANDOVER_SAMPLES);
    // The next is already up, though it has nothing to show yet.
    expect(spawned.length).toBe(2);
    await first?.samples(RUN - HANDOVER_SAMPLES + 1, HANDOVER_SAMPLES);
    await first?.finish();
    expect(sampler.error).toBe("");
    expect(timers.length).toBe(0);
    expect(spawned.length).toBe(2);
    expect(first?.killed).toBe(0);
    sampler.stop();
  });

  test("the next one's lines count only once the last has ended: no doubled seconds", async () => {
    const { sampler, spawned } = rig();
    sampler.start();
    const [first] = spawned;
    await first?.header();
    await first?.samples(1, RUN - HANDOVER_SAMPLES);
    const second = spawned[1];
    await second?.header();
    await second?.samples(100, 2);
    expect(sampler.history.length).toBe(RUN - HANDOVER_SAMPLES);
    await first?.samples(RUN - HANDOVER_SAMPLES + 1, HANDOVER_SAMPLES);
    await first?.finish();
    await second?.samples(102, 1);
    expect(sampler.history.length).toBe(RUN + 1);
    // Not `busy`: a share past 100 is dropped.
    expect(sampler.latest?.wslVm).toBe(102);
    sampler.stop();
  });

  test("when the next one died while waiting, the last ending starts another at once", async () => {
    const { sampler, spawned, timers } = rig();
    sampler.start();
    const first = spawned[0];
    await first?.header();
    // The next one fails to start before the last ends.
    await first?.samples(1, RUN - 1);
    spawned[1]?.emit("exit", 1);
    await first?.samples(RUN, 1);
    await first?.finish();
    expect(spawned.length).toBe(3);
    expect(timers.length).toBe(0);
    expect(sampler.error).toBe("");
    sampler.stop();
  });

  test("an unexpected exit keeps its error and starts again in 30 s", async () => {
    const { sampler, spawned, live } = rig();
    sampler.start();
    await spawned[0]?.header();
    await spawned[0]?.samples(1, 3);
    spawned[0]?.emit("exit", 1);
    expect(sampler.error).toBe("typeperf ended (1); starting it again in 30 s");
    const [retry] = live();
    expect(retry?.ms).toBe(30_000);
    expect(spawned.length).toBe(1);
    retry?.fn();
    expect(spawned.length).toBe(2);
    sampler.stop();
  });

  test("exit code 0 before its samples is still unexpected", async () => {
    const { sampler, spawned, live } = rig();
    sampler.start();
    await spawned[0]?.header();
    await spawned[0]?.samples(1, 3);
    spawned[0]?.emit("exit", 0);
    expect(sampler.error).toContain("typeperf ended (0)");
    expect(live().length).toBe(1);
    sampler.stop();
  });

  test("killed by a signal it reads as unexpected", () => {
    const { sampler, spawned } = rig();
    sampler.start();
    spawned[0]?.emit("exit", null);
    expect(sampler.error).toBe("typeperf ended (signal); starting it again in 30 s");
    sampler.stop();
  });

  test("an early exit takes the waiting next one down with it", async () => {
    const { sampler, spawned } = rig();
    sampler.start();
    await spawned[0]?.header();
    await spawned[0]?.samples(1, RUN - HANDOVER_SAMPLES);
    spawned[0]?.emit("exit", 1);
    expect(spawned[1]?.killed).toBe(1);
    sampler.stop();
  });

  test("stop kills what runs, cancels the retry and ends no further", async () => {
    const { sampler, spawned, live } = rig();
    sampler.start();
    await spawned[0]?.header();
    await spawned[0]?.samples(1, RUN - HANDOVER_SAMPLES);
    sampler.stop();
    expect(spawned.map((c) => c.killed)).toEqual([1, 1]);
    spawned[0]?.emit("exit", null);
    expect(live().length).toBe(0);
    expect(sampler.error).toBe("");

    const again = rig();
    again.sampler.start();
    again.spawned[0]?.emit("exit", 1);
    again.sampler.stop();
    expect(again.live().length).toBe(0);
  });
});

describe("WindowsSampler when the host ends", () => {
  test("the host's exit kills typeperf", () => {
    const { sampler, spawned, host } = rig();
    sampler.start();
    host.emit("exit");
    expect(spawned[0]?.killed).toBe(1);
  });

  test("SIGTERM and SIGINT kill it, remove themselves and hand the signal back", () => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const { sampler, spawned, host } = rig();
      sampler.start();
      host.emit(signal);
      expect(spawned[0]?.killed).toBe(1);
      expect(host.raised).toEqual([signal]);
      expect(host.total).toBe(0);
      sampler.stop();
    }
  });

  test("a host with its own signal handler keeps the signal", () => {
    const { sampler, spawned, host } = rig();
    host.on("SIGTERM", () => {});
    sampler.start();
    host.emit("SIGTERM");
    expect(spawned[0]?.killed).toBe(1);
    expect(host.raised).toEqual([]);
    sampler.stop();
  });

  test("start and stop leave no listeners behind, however often", () => {
    const { sampler, host } = rig();
    for (let i = 0; i < 5; i++) {
      sampler.start();
      expect(host.total).toBe(3);
      sampler.stop();
      expect(host.total).toBe(0);
    }
    // A retry starting it again does not hook twice.
    sampler.start();
    sampler.start();
    expect(host.total).toBe(3);
    sampler.stop();
    expect(host.total).toBe(0);
  });

  test("a stop after the host's exit does nothing more", () => {
    const { sampler, spawned, host } = rig();
    sampler.start();
    host.emit("exit");
    sampler.stop();
    expect(spawned[0]?.killed).toBe(1);
  });
});

describe("hookHostExit", () => {
  test("calls kill on exit, and not after it was unhooked", () => {
    const host = new FakeHost();
    let kills = 0;
    const unhook = hookHostExit(() => kills++, host);
    host.emit("exit");
    expect(kills).toBe(1);
    unhook();
    host.emit("exit");
    host.emit("SIGTERM");
    expect(kills).toBe(1);
    expect(host.total).toBe(0);
  });

  test("two hooks: only the last to run hands the signal back", () => {
    const host = new FakeHost();
    const a = hookHostExit(() => {}, host);
    const b = hookHostExit(() => {}, host);
    host.emit("SIGINT");
    expect(host.raised).toEqual(["SIGINT"]);
    a();
    b();
  });
});

describe("fromProcess", () => {
  test("a shell's process is killed with the host and unhooked when it ends", () => {
    const host = new FakeHost();
    let killed = 0;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => {
        killed++;
      },
    });
    const shell = fromProcess(child as never, host);
    expect(host.total).toBe(3);
    host.emit("exit");
    expect(killed).toBe(1);
    child.emit("exit", 0, null);
    expect(host.total).toBe(0);
    shell.kill();
    expect(killed).toBe(2);
  });

  test("closing the shell takes the hooks away", () => {
    const host = new FakeHost();
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stdin: new PassThrough(),
      kill: () => {},
    });
    fromProcess(child as never, host).kill();
    expect(host.total).toBe(0);
  });
});
