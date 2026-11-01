/**
 * The host's own Windows processes every second (`windows-host-live.ts`): the
 * pids of the newest tree read once a second, their CPU and working set
 * averaged from those reads, their I/O from the trees. The PowerShell is
 * faked, and the clock is set, so `now` and the samples' `at` agree.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ProcReading, ProcSnapshot } from "../procs";
import { keep } from "../ring";
import { Tables } from "../tables";
import {
  averageHost,
  type LiveRow,
  liveRead,
  parseLiveRead,
  WindowsHostLive,
} from "../windows-host-live";
import type { WslLinux } from "../wsl-exe";

const START = Date.UTC(2026, 10, 1, 12, 0, 0);
const HOST_PID = 9000;
const CHILD = 9100;
/** When both started: long before any read. */
const STARTED = START - 3_600_000;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A tree reading: `cpu` seconds used, `io` bytes read and written. */
const reading = (pid: number, cpu: number, io = 0): ProcReading => ({
  pid,
  ppid: pid === HOST_PID ? 8000 : HOST_PID,
  comm: pid === HOST_PID ? "prifly" : "msedgewebview2",
  argv: [`${pid}.exe`],
  rss: 100,
  ticks: cpu * 100,
  read: io,
  write: io,
});

const treeAt = (s: number, procs: ProcReading[]): ProcSnapshot => ({
  at: START + s * 1000,
  procs: new Map(procs.map((proc) => [proc.pid, proc])),
});

/** `liveRead`'s line for a process that has used `cpu` seconds and holds `rss` bytes. */
const line = (pid: number, cpu: number, rss = 200, started = STARTED) =>
  `${pid}|${started}|${cpu * 10_000_000}|${rss}`;

/** The pids a `liveRead` script asks for. */
const pidsOf = (script: string) =>
  (/\[PriflyHostLive\]::Read\(@\(([\d,]*)\)\)/.exec(script)?.[1] ?? "").split(",").map(Number);

/** A live reader whose PowerShell answers `answer(pids)`; `asked` holds each call's pids and time. */
function live(answer: (pids: number[]) => string = () => "") {
  const asked: { at: number; pids: number[] }[] = [];
  const logged: string[] = [];
  const reader = new WindowsHostLive(
    HOST_PID,
    (event, data) => logged.push(`${event}: ${data.error}`),
    async (script) => {
      const pids = pidsOf(script);
      asked.push({ at: Date.now(), pids });
      return answer(pids);
    },
  );
  return { reader, asked, logged };
}

/** Moves the clock to `s` s after the start and lets the reader read the trees. */
async function tickAt(reader: WindowsHostLive, trees: ProcSnapshot[], s: number) {
  setSystemTime(START + s * 1000);
  reader.read(trees, 310, Date.now());
  await settle();
}

afterEach(() => setSystemTime());

describe("what the read asks and what it says", () => {
  test("the script asks the helper for exactly the pids given", () => {
    expect(pidsOf(liveRead([9000, 9100, 9200]))).toEqual([9000, 9100, 9200]);
  });

  test("a line each: start, CPU in ticks of 10 ms, working set; empty where not ours to read", () => {
    const rows = parseLiveRead(
      `liveerr|csc is gone\r\n${line(9000, 2, 4096)}\r\n9100|||0\r\n\r\n<<END-1>>`,
    );
    expect([...rows.values()]).toEqual<LiveRow[]>([
      { pid: 9000, started: STARTED, ticks: 200, rss: 4096 },
      { pid: 9100, started: null, ticks: null, rss: 0 },
    ]);
  });
});

describe("one read a second, of the newest tree's pids", () => {
  test("open: no read before the first tree; then one a second with its pids", async () => {
    const reads: number[][] = [];
    const tables = new Tables({
      wsl: { absent: "WSL is not running" } as unknown as WslLinux,
      windows: true,
      hostPid: HOST_PID,
      windowsList: () => new Promise<string>(() => {}),
      windowsLive: async (script) => {
        reads.push(pidsOf(script));
        return "";
      },
      log: () => {},
    });
    for (let s = 0; s < 3; s++) {
      setSystemTime(START + s * 1000);
      tables.readAll(310, Date.now());
      await settle();
    }
    expect(reads).toEqual([]);
    // `topProcesses`' listing lands: the host and its child.
    tables.keepWindowsHost(
      `${HOST_PID}|8000|1|prifly.exe|0|1|0|0|1|prifly.exe\n${CHILD}|${HOST_PID}|2|msedgewebview2.exe|0|1|0|0|1|x`,
      310,
    );
    for (let s = 3; s < 6; s++) {
      setSystemTime(START + s * 1000);
      tables.readAll(310, Date.now());
      await settle();
    }
    expect(reads.map((pids) => pids.sort())).toEqual([
      [HOST_PID, CHILD],
      [HOST_PID, CHILD],
      [HOST_PID, CHILD],
    ]);
    // The window closes and opens again: nothing is read until a tree is there again.
    tables.clear();
    setSystemTime(START + 7_000);
    tables.readAll(310, Date.now());
    await settle();
    expect(reads).toHaveLength(3);
  });

  test("the fallback's process whose times throw is a row of its own, not the end of the answer", () => {
    expect(liveRead([1])).toContain("catch { [string]$p.Id + '|||0' }");
  });

  test("asked twice in the same second, it reads once", async () => {
    const { reader, asked } = live();
    const trees = [treeAt(0, [reading(HOST_PID, 0)])];
    await tickAt(reader, trees, 1);
    await tickAt(reader, trees, 1.2);
    await tickAt(reader, trees, 2);
    expect(asked.map((call) => call.at)).toEqual([START + 1_000, START + 2_000]);
  });

  test("a read still in flight is not asked again: that second is skipped", async () => {
    let release: (out: string) => void = () => {};
    let calls = 0;
    const reader = new WindowsHostLive(
      HOST_PID,
      () => {},
      () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    );
    const trees = [treeAt(0, [reading(HOST_PID, 0)])];
    await tickAt(reader, trees, 1);
    await tickAt(reader, trees, 2);
    await tickAt(reader, trees, 3);
    expect(calls).toBe(1);
    release(line(HOST_PID, 1));
    await settle();
    await tickAt(reader, trees, 4);
    expect(calls).toBe(2);
    expect(reader.ring).toHaveLength(1);
  });

  test("closed: a read in flight is dropped when it lands; stopped: nothing is read", async () => {
    let release: (out: string) => void = () => {};
    let calls = 0;
    const reader = new WindowsHostLive(
      HOST_PID,
      () => {},
      () => {
        calls += 1;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    );
    const trees = [treeAt(0, [reading(HOST_PID, 0)])];
    await tickAt(reader, trees, 1);
    reader.clear();
    release(line(HOST_PID, 1));
    await settle();
    expect(reader.ring).toHaveLength(0);
    reader.stop();
    await tickAt(reader, trees, 3);
    expect(calls).toBe(1);
  });

  test("a helper that would not compile is logged, and the read still counts", async () => {
    const { reader, logged } = live(() => `liveerr|csc is gone\n${line(HOST_PID, 1)}`);
    await tickAt(reader, [treeAt(0, [reading(HOST_PID, 0)])], 1);
    expect(logged).toEqual(["windows_host_live_helper_failed: csc is gone"]);
    expect(reader.ring[0]?.procs.get(HOST_PID)?.ticks).toBe(100);
  });
});

describe("the prifly tab's numbers", () => {
  /** The host using half a core, its child a quarter, both read every second up to `until`. */
  async function running(until: number) {
    let now = 0;
    const { reader } = live((pids) =>
      pids.map((pid) => line(pid, (pid === HOST_PID ? 0.5 : 0.25) * now, 1000 + now)).join("\n"),
    );
    // The trees, 10 s apart: the host's I/O 1 MB a second.
    const trees: ProcSnapshot[] = [];
    keep(trees, treeAt(0, [reading(HOST_PID, 0, 0), reading(CHILD, 0, 0)]), 310);
    for (let s = 1; s <= until; s++) {
      if (s % 10 === 0) {
        keep(
          trees,
          treeAt(s, [reading(HOST_PID, 0.5 * s, s * 1e6), reading(CHILD, 0.25 * s, 0)]),
          310,
        );
      }
      now = s;
      await tickAt(reader, trees, s);
    }
    return { reader, trees };
  }

  test("CPU over a 1 s period comes from the per-second reads, memory from the newest", async () => {
    const { reader, trees } = await running(14);
    const host = averageHost(trees, reader.ring, 1);
    const byPid = new Map(host?.map((proc) => [proc.pid, proc]));
    expect(byPid.get(HOST_PID)?.cpu).toBeCloseTo(0.5, 5);
    expect(byPid.get(CHILD)?.cpu).toBeCloseTo(0.25, 5);
    expect(byPid.get(HOST_PID)?.rss).toBe(1014);
    // Who it is comes from the tree.
    expect(byPid.get(HOST_PID)?.comm).toBe("prifly");
    expect(byPid.get(CHILD)?.ppid).toBe(HOST_PID);
  });

  test("I/O is the trees' own, over the real time between two: no spike, no drop to 0", async () => {
    const { reader, trees } = await running(14);
    for (const period of [1, 2, 5, 10]) {
      const host = averageHost(trees, reader.ring, period)?.find((proc) => proc.pid === HOST_PID);
      expect(host?.read).toBeCloseTo(1e6, 0);
      expect(host?.cpu).toBeCloseTo(0.5, 5);
    }
  });
});

describe("processes that change, come, go, or cannot be read", () => {
  test("CPU that changes shows the next second, not 10 s on", async () => {
    let cpu = 0;
    const { reader } = live((pids) => pids.map((pid) => line(pid, cpu)).join("\n"));
    const trees = [treeAt(0, [reading(HOST_PID, 0)])];
    for (let s = 1; s <= 5; s++) await tickAt(reader, trees, s);
    expect(averageHost(trees, reader.ring, 1)?.[0]?.cpu).toBe(0);
    // A whole core, from second 5 to 6.
    cpu = 1;
    await tickAt(reader, trees, 6);
    expect(averageHost(trees, reader.ring, 1)?.[0]?.cpu).toBeCloseTo(1, 5);
    expect(averageHost(trees, reader.ring, 5)?.[0]?.cpu).toBeCloseTo(0.2, 5);
  });

  test("a process read once so far has the tree's CPU, not 0", async () => {
    const { reader } = live((pids) => pids.map((pid) => line(pid, 7)).join("\n"));
    const trees = [treeAt(0, [reading(HOST_PID, 0)]), treeAt(2, [reading(HOST_PID, 1)])];
    await tickAt(reader, trees, 2.5);
    expect(averageHost(trees, reader.ring, 2)?.[0]?.cpu).toBeCloseTo(0.5, 5);
  });

  test("a process that ended is dropped at the next read, with no spike", async () => {
    let childAlive = true;
    const { reader } = live((pids) =>
      pids
        .filter((pid) => pid !== CHILD || childAlive)
        .map((pid) => line(pid, 0.5 * 3))
        .join("\n"),
    );
    const trees = [treeAt(0, [reading(HOST_PID, 0), reading(CHILD, 0)])];
    await tickAt(reader, trees, 1);
    await tickAt(reader, trees, 2);
    childAlive = false;
    await tickAt(reader, trees, 3);
    const host = averageHost(trees, reader.ring, 1);
    expect(host?.map((proc) => proc.pid)).toEqual([HOST_PID]);
    for (const proc of host ?? []) expect(proc.cpu).toBeLessThan(1);
  });

  test("a pid Windows gave to a process started after the tree is not the tree's", async () => {
    let reused = false;
    const { reader } = live((pids) =>
      pids
        .map((pid) =>
          pid === CHILD && reused
            ? line(pid, 900, 5, START + 2_500)
            : line(pid, pid === CHILD ? 1 : 0),
        )
        .join("\n"),
    );
    const trees = [treeAt(0, [reading(HOST_PID, 0), reading(CHILD, 0)])];
    await tickAt(reader, trees, 1);
    await tickAt(reader, trees, 2);
    reused = true;
    await tickAt(reader, trees, 3);
    expect(averageHost(trees, reader.ring, 2)?.map((proc) => proc.pid)).toEqual([HOST_PID]);
    // The next tree has the new process under the host: its rate starts afresh, from its own reads.
    keep(trees, treeAt(3.5, [reading(HOST_PID, 0), reading(CHILD, 900)]), 310);
    await tickAt(reader, trees, 4);
    // Read once as the new process: the trees' rate would be 900 s of CPU spanning two processes.
    const once = averageHost(trees, reader.ring, 5)?.find((proc) => proc.pid === CHILD);
    expect(once?.cpu).toBe(0);
    await tickAt(reader, trees, 5);
    const child = averageHost(trees, reader.ring, 5)?.find((proc) => proc.pid === CHILD);
    expect(child?.cpu).toBe(0);
  });

  test("an empty answer, or one without the host, is a failed read: every process stands", async () => {
    for (const answer of [
      () => "",
      (pids: number[]) =>
        pids
          .filter((pid) => pid !== HOST_PID)
          .map((pid) => line(pid, 1))
          .join("\n"),
    ]) {
      const { reader, logged } = live(answer);
      const trees = [treeAt(0, [reading(HOST_PID, 0), reading(CHILD, 0)])];
      await tickAt(reader, trees, 1);
      await tickAt(reader, trees, 2);
      expect(reader.ring).toHaveLength(0);
      expect(logged).toHaveLength(2);
      expect(logged[0]).toStartWith("windows_host_live_failed: Error: no row for the host (9000)");
      expect(
        averageHost(trees, reader.ring, 1)
          ?.map((proc) => proc.pid)
          .sort(),
      ).toEqual([HOST_PID, CHILD]);
    }
  });

  test("a process whose times are not ours to read stands as the tree has it", async () => {
    const { reader } = live((pids) =>
      pids.map((pid) => (pid === CHILD ? `${pid}|||0` : line(pid, 1))).join("\n"),
    );
    const trees = [
      treeAt(0, [reading(HOST_PID, 0), reading(CHILD, 0)]),
      treeAt(1, [reading(HOST_PID, 0), reading(CHILD, 0.5)]),
    ];
    await tickAt(reader, trees, 1.5);
    await tickAt(reader, trees, 2.5);
    const child = averageHost(trees, reader.ring, 1)?.find((proc) => proc.pid === CHILD);
    expect(child?.cpu).toBeCloseTo(0.5, 5);
    expect(child?.rss).toBe(100);
  });

  test("with no per-second read lately, the trees stand alone", async () => {
    const { reader } = live((pids) => pids.map((pid) => line(pid, 100)).join("\n"));
    const trees = [treeAt(0, [reading(HOST_PID, 0)])];
    await tickAt(reader, trees, 1);
    await tickAt(reader, trees, 2);
    keep(trees, treeAt(10, [reading(HOST_PID, 5)]), 310);
    expect(averageHost(trees, reader.ring, 1)?.[0]?.cpu).toBeCloseTo(0.5, 5);
    expect(averageHost([], reader.ring, 1)).toBeNull();
  });
});
