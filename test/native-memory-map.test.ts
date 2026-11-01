/**
 * The Memory tab's WSL VM tile on a host on Windows itself: the `State` built
 * as `activate` fills it there (Linux through a `wsl.exe -e sh` that the test
 * answers by hand, Windows' process list as `topProcesses` prints it), and
 * the page's `status` read from it. On 2026-10-30 the reader's host had
 * `wsl.exe -e sh` time out on every read, so no Linux sample ever arrived and
 * the tile stayed whole without a word of why.
 */

import { describe, expect, test } from "bun:test";
import { firstPace } from "../cadence";
import { GpuMonitor } from "../gpu-live";
import { holdersOf } from "../holders";
import { status } from "../index";
import type { Tile } from "../memory-map";
import { newNannyMemory } from "../nanny";
import type { ExtensionApi } from "../prifly-api";
import type { ShellChild } from "../shell";
import type { State } from "../state";
import { Tables } from "../tables";
import { COUNTERS, type Field, type WindowsCounters } from "../windows";
import { WindowsSampler } from "../windows-sampler";
import type { LinuxRaw } from "../wsl";
import { WslLinux } from "../wsl-exe";

const GIB = 2 ** 30;
const HOST_PID = 7000;

/** A `wsl.exe -e sh` the test answers by hand, or never. */
class FakeSh implements ShellChild {
  written: string[] = [];
  private data: ((chunk: string) => void)[] = [];
  write(text: string): void {
    this.written.push(text);
  }
  kill(): void {}
  onData(listener: (chunk: string) => void): void {
    this.data.push(listener);
  }
  onExit(): void {}
  answer(output: string): void {
    const id = /<<END-([^>]+)>>/.exec(this.written.at(-1) ?? "")?.[1] ?? "";
    for (const listener of this.data) listener(`${output}<<END-${id}>>\r\n`);
  }
}

const settle = (ms = 5) => new Promise((done) => setTimeout(done, ms));

const kb = (gib: number) => Math.round((gib * GIB) / 1024);

/** What `READ`'s `tail` prints in a 24 GiB VM, with the CRLFs wsl.exe may add. */
const TAIL = [
  "==> /proc/stat <==",
  "cpu  100 0 50 1000 0 0 0 0 0 0",
  "cpu0 100 0 50 1000 0 0 0 0 0 0",
  "procs_running 2",
  "",
  "==> /proc/meminfo <==",
  `MemTotal:       ${kb(23.5)} kB`,
  `MemFree:        ${kb(1.1)} kB`,
  `MemAvailable:   ${kb(15)} kB`,
  `Buffers:        ${kb(10.7)} kB`,
  `Cached:         ${kb(2.6)} kB`,
  `Shmem:          ${kb(0.01)} kB`,
  `AnonPages:      ${kb(5)} kB`,
  `Slab:           ${kb(3.4)} kB`,
  `SReclaimable:   ${kb(3)} kB`,
  `SUnreclaim:     ${kb(0.4)} kB`,
  `KernelStack:    ${kb(0.02)} kB`,
  `PageTables:     ${kb(0.06)} kB`,
  `VmallocUsed:    ${kb(0.1)} kB`,
  `SwapTotal:      0 kB`,
  `SwapFree:       0 kB`,
  "",
  "==> /proc/loadavg <==",
  "0.5 0.4 0.3 1/500 999",
  "",
].join("\r\n");

const none = Object.fromEntries(Object.keys(COUNTERS).map((f) => [f, null])) as Record<Field, null>;

const COUNTED: WindowsCounters = {
  ...none,
  at: 0,
  availableMB: 9 * 1024,
  committedBytes: 70 * GIB,
  commitLimit: 75 * GIB,
  poolPaged: 4 * GIB,
  poolNonpaged: 1 * GIB,
  poolPagedResident: 3 * GIB,
  wslVmMem: 9 * GIB,
  standbyCore: 0.5 * GIB,
  standbyNormal: 6.5 * GIB,
  standbyReserve: 1.5 * GIB,
  free: 0.5 * GIB,
  modified: 0.25 * GIB,
  cacheResident: 0.75 * GIB,
};

/** `topProcesses`' output: the memory line and `PROCESS_LIST`'s rows, the VM as Windows names it. */
const TOP = [
  `memory|${70 * GIB}|${4 * GIB}|${1 * GIB}`,
  `4242|4|0|vmmemWSL|0|${9 * GIB}|0|0|${24 * GIB}|`,
  `${HOST_PID}|1|0|bun.exe|0|${1 * GIB}|0|0|${2 * GIB}|C:\\prifly\\bun.exe host.ts`,
].join("\r\n");

/** A host on Windows itself, its window open on the Memory tab, Linux read through `shell`. */
function nativeState(shell: FakeSh, readTimeout: number) {
  const linux: LinuxRaw[] = [];
  const wsl = new WslLinux({
    spawn: () => shell,
    probe: async () => "",
    onRead: (raw) => linux.push(raw),
    readTimeout,
  });
  const windows = new WindowsSampler(1, {
    spawn: () => {
      throw new Error("no typeperf in a test");
    },
    later: () => () => {},
    host: process as never,
  });
  const now = Date.now();
  windows.history.push({ ...COUNTED, at: now - 1000 }, { ...COUNTED, at: now });
  const api = {
    log: () => {},
    show: () => {},
    sessions: () => [],
    cloud: { sessions: async () => [] },
  } as unknown as ExtensionApi;
  const state: State = {
    api,
    linux,
    linuxAt: now,
    pace: firstPace(),
    wsl,
    tables: new Tables({ wsl, windows: true, hostPid: HOST_PID, log: () => {} }),
    windows,
    info: { name: "JIMMY-ROG", cores: 16, memTotal: 48 * GIB },
    topWindows: [],
    compressed: 4 * GIB,
    compressions: [],
    holders: holdersOf(TOP, HOST_PID),
    topWindowsAt: now,
    pools: null,
    poolsAt: now,
    gpu: new GpuMonitor(
      () => {},
      [],
      async () => null,
    ),
    cloud: null,
    cloudAt: now,
    askedAt: now,
    askedWindow: 2,
    chip: "",
    nanny: newNannyMemory(),
    nannyUse: null,
    chipped: "",
  };
  return { state, wsl };
}

type Map = { commit: Tile[]; ram: Tile[] };
const mapOf = (state: State) => (status(state, 2, true).memoryMap as unknown as Map | null) ?? null;
const find = (tiles: Tile[] | undefined, key: string) => tiles?.find((t) => t.key === key);

describe("the WSL VM's tile on a host on Windows itself", () => {
  test("once Linux is read through wsl.exe, the tile is a group in both views", async () => {
    const shell = new FakeSh();
    const { state, wsl } = nativeState(shell, 10_000);
    wsl.poll();
    await settle();
    wsl.poll();
    shell.answer(TAIL);
    await settle();
    expect(wsl.absent).toBe("");
    const map = mapOf(state);
    const vm = find(map?.commit, "wsl");
    expect(vm?.value).toBe(24 * GIB);
    expect(vm?.children?.map((t) => t.key)).toContain("wsl:cache");
    expect(find(map?.ram, "wslram")?.children?.map((t) => t.key)).toContain("ram:wsl:cache");
  });

  test("WSL that never answers: the tile is whole, and its detail says why in both views", async () => {
    const shell = new FakeSh();
    const { state, wsl } = nativeState(shell, 20);
    wsl.poll();
    await settle();
    wsl.poll();
    await settle(60);
    expect(wsl.absent).toStartWith("WSL did not answer for");
    const map = mapOf(state);
    const vm = find(map?.commit, "wsl");
    expect(vm?.children).toBeUndefined();
    expect(vm?.why).toContain("It is not split by what Linux holds: WSL did not answer for");
    const ram = find(map?.ram, "wslram");
    expect(ram?.children).toBeUndefined();
    expect(ram?.why).toContain("It is not split by what Linux holds: WSL did not answer for");
  });

  test("before WSL's first read: the tile says it is being read", async () => {
    const shell = new FakeSh();
    const { state, wsl } = nativeState(shell, 10_000);
    wsl.poll();
    await settle();
    const vm = find(mapOf(state)?.commit, "wsl");
    expect(vm?.children).toBeUndefined();
    expect(vm?.why).toContain("It is not split by what Linux holds: WSL runs; reading it…");
  });
});
