import { describe, expect, test } from "bun:test";
import { hostOf } from "../host";
import { ScriptShell, type ShellChild } from "../shell";
import type { LinuxRaw } from "../wsl";
import {
  clock,
  decodeWsl,
  duration,
  parseWslRead,
  probeAnswer,
  READ,
  SH_FRAME,
  sections,
  WslLinux,
} from "../wsl-exe";

/** What `READ` printed through `wsl.exe` on the laptop (2026-10-09), cut to four cores and the lines read. */
const BLOB = [
  "==> /proc/stat <==",
  "cpu  2301850 36051495 20827897 245927623 1343319 0 4982611 0 0 0",
  "cpu0 164598 2302793 1596685 14632091 85335 0 2184969 0 0 0",
  "cpu1 184200 1941810 1099908 15647803 124111 0 995455 0 0 0",
  "cpu2 170985 2518832 1550357 14705965 96180 0 374358 0 0 0",
  "cpu3 177363 2068122 1101640 15678941 131107 0 434124 0 0 0",
  "intr 123 4 5",
  "procs_running 4",
  "procs_blocked 0",
  "",
  "==> /proc/meminfo <==",
  "MemTotal:       24608408 kB",
  "MemFree:         1000000 kB",
  "MemAvailable:   11769320 kB",
  "Buffers:         6648000 kB",
  "Cached:          4414000 kB",
  "AnonPages:       9825000 kB",
  "Shmem:             21000 kB",
  "Slab:            2160000 kB",
  "KernelStack:       24000 kB",
  "PageTables:        73000 kB",
  "SwapTotal:       4194304 kB",
  "SwapFree:        4194000 kB",
  "",
  "==> /proc/loadavg <==",
  "16.73 15.35 14.92 4/1749 802620",
  "",
  "==> /proc/vmstat <==",
  "nr_free_pages 12345",
  "pgpgin 3045295362",
  "pgpgout 475630147",
  "",
  "==> /proc/pressure/cpu <==",
  "some avg10=7.99 avg60=15.21 avg300=15.18 total=15142940700",
  "full avg10=0.00 avg60=0.00 avg300=0.00 total=0",
  "",
  "==> /proc/pressure/memory <==",
  "some avg10=0.04 avg60=0.28 avg300=0.29 total=2708562075",
  "full avg10=0.03 avg60=0.26 avg300=0.25 total=2355579096",
  "",
  "==> /proc/pressure/io <==",
  "some avg10=0.07 avg60=0.49 avg300=0.66 total=2912000173",
  "full avg10=0.02 avg60=0.15 avg300=0.28 total=1036196685",
  "",
].join("\n");

describe("the host", () => {
  test("inside WSL, Windows' tools are under /mnt/c and Linux is this /proc", () => {
    const host = hostOf("linux", { SystemRoot: "D:\\Elsewhere" });
    expect(host.native).toBe(false);
    expect(host.typeperf).toBe("/mnt/c/Windows/System32/typeperf.exe");
    expect(host.powershell).toBe("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
  });

  test("on Windows, the tools are in %SystemRoot%\\System32", () => {
    const host = hostOf("win32", { SystemRoot: "D:\\WINDOWS\\" });
    expect(host.native).toBe(true);
    expect(host.typeperf).toBe("D:\\WINDOWS\\System32\\typeperf.exe");
    expect(host.powershell).toBe("D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(host.wsl).toBe("D:\\WINDOWS\\System32\\wsl.exe");
    expect(host.system32).toBe("D:\\WINDOWS\\System32");
  });

  test("on Windows without SystemRoot, C:\\Windows", () => {
    expect(hostOf("win32", {}).typeperf).toBe("C:\\Windows\\System32\\typeperf.exe");
  });
});

describe("a read through wsl.exe", () => {
  test("tail's output splits into each file's text", () => {
    const files = sections(BLOB);
    expect([...files.keys()]).toEqual([
      "stat",
      "meminfo",
      "loadavg",
      "vmstat",
      "pressure/cpu",
      "pressure/memory",
      "pressure/io",
    ]);
    expect(files.get("loadavg")?.trim()).toBe("16.73 15.35 14.92 4/1749 802620");
  });

  test("parses into the sample wsl.ts makes from /proc, with the VM's cores", () => {
    const raw = parseWslRead(BLOB, 1234) as LinuxRaw;
    expect(raw).toEqual({
      at: 1234,
      cores: 4,
      total: 2301850 + 36051495 + 20827897 + 245927623 + 1343319 + 4982611,
      idle: 245927623 + 1343319,
      kernel: 4982611,
      pgpgin: 3045295362,
      pgpgout: 475630147,
      runnable: 4,
      load: [16.73, 15.35, 14.92],
      memTotal: 24608408 * 1024,
      memAvailable: 11769320 * 1024,
      swapTotal: 4194304 * 1024,
      swapUsed: (4194304 - 4194000) * 1024,
      // The fields the Memory tab splits the WSL VM's tile by, through the same parser.
      meminfo: {
        memFree: 1000000 * 1024,
        buffers: 6648000 * 1024,
        cached: 4414000 * 1024,
        shmem: 21000 * 1024,
        anonPages: 9825000 * 1024,
        slab: 2160000 * 1024,
        pageTables: 73000 * 1024,
        kernelStack: 24000 * 1024,
      },
      cpu: { some: { avg10: 7.99, total: 15142940700 }, full: { avg10: 0, total: 0 } },
      memory: {
        some: { avg10: 0.04, total: 2708562075 },
        full: { avg10: 0.03, total: 2355579096 },
      },
      io: {
        some: { avg10: 0.07, total: 2912000173 },
        full: { avg10: 0.02, total: 1036196685 },
      },
    });
  });

  test("CRLF line ends read the same", () => {
    expect(parseWslRead(BLOB.replace(/\n/g, "\r\n"), 1)).toEqual(parseWslRead(BLOB, 1));
  });

  test("a kernel without PSI has no pressure", () => {
    const raw = parseWslRead(BLOB.split("==> /proc/pressure/cpu")[0] ?? "", 1);
    expect(raw?.cpu).toBeNull();
    expect(raw?.io).toBeNull();
    expect(raw?.memTotal).toBe(24608408 * 1024);
  });

  test("output without /proc/stat is no read", () => {
    expect(parseWslRead("sh: tail: not found\n", 1)).toBeNull();
    expect(parseWslRead("", 1)).toBeNull();
  });

  test("an interop error line before the files reads the same", () => {
    const stale = "<3>WSL (1234) ERROR: UtilAcceptVsock:273: accept4 failed 110\n";
    expect(parseWslRead(stale + BLOB, 1)).toEqual(parseWslRead(BLOB, 1));
    expect(parseWslRead(stale, 1)).toBeNull();
  });
});

describe("asking wsl.exe whether WSL runs", () => {
  test("UTF-16 output loses its NULs", () => {
    const utf16 = Buffer.from("Ubuntu\r\n", "utf16le");
    expect(decodeWsl(utf16)).toBe("Ubuntu");
  });

  test("a running distro is a yes", () => {
    expect(probeAnswer(null, "Ubuntu")).toBe("");
  });

  test("none running, or wsl.exe failing, is a no with why", () => {
    expect(probeAnswer(null, "")).toBe("WSL is not running on this host.");
    expect(probeAnswer({ code: 1 }, "There are no running distributions.")).toBe(
      "WSL is not running: There are no running distributions.",
    );
  });

  test("WSL's own error line on stale interop is no distro", () => {
    const stale = "<3>WSL (1234) ERROR: UtilAcceptVsock:273: accept4 failed 110";
    expect(probeAnswer(null, stale)).toBe(`WSL answered with an error: ${stale}`);
    expect(probeAnswer({ code: 1 }, stale)).toBe(`WSL answered with an error: ${stale}`);
    // A distro named beside it is still a yes: the shell's own time limit catches a hang.
    expect(probeAnswer(null, `${stale}\nUbuntu-20.04`)).toBe("");
  });
});

/** A `wsl.exe -e sh` the test answers by hand. */
class FakeSh implements ShellChild {
  written: string[] = [];
  killed = false;
  private data: ((chunk: string) => void)[] = [];
  private exit: ((reason: string) => void)[] = [];
  write(text: string): void {
    this.written.push(text);
  }
  kill(): void {
    this.killed = true;
  }
  onData(listener: (chunk: string) => void): void {
    this.data.push(listener);
  }
  onExit(listener: (reason: string) => void): void {
    this.exit.push(listener);
  }
  /** Prints what `sh` would for the last command: its output, then the marker it echoes. */
  answer(output: string): void {
    const id = /<<END-([^>]+)>>/.exec(this.written.at(-1) ?? "")?.[1] ?? "";
    for (const listener of this.data) listener(`${output}<<END-${id}>>\n`);
  }
  end(reason: string): void {
    for (const listener of this.exit) listener(reason);
  }
}

const settle = () => new Promise((done) => setTimeout(done, 5));

describe("the sh frame", () => {
  test("sends the command as it is, then echoes the end marker", async () => {
    const child = new FakeSh();
    const shell = new ScriptShell(() => child, SH_FRAME);
    const answer = shell.run(READ, 1000);
    const line = child.written[0] ?? "";
    expect(line.startsWith(`${READ}; echo '<<END-`)).toBe(true);
    expect(line.endsWith(">>'\n")).toBe(true);
    // One line: sh runs it as soon as it has read it.
    expect(line.split("\n")).toHaveLength(2);
    child.answer(BLOB);
    expect(await answer).toBe(BLOB);
  });
});

/** A `wsl.exe --list --running` that never answers. */
const HANG = null;

/**
 * A `WslLinux` over fakes: `probeAnswers` in turn (`HANG` for a probe that
 * never settles, "" after the last), and shells made by `makeChild`.
 */
function setup(
  probeAnswers: (string | null)[],
  options: { readTimeout?: number; probeTimeout?: number; makeChild?: () => FakeSh } = {},
) {
  const children: FakeSh[] = [];
  const reads: LinuxRaw[] = [];
  let probes = 0;
  const wsl = new WslLinux({
    spawn: () => {
      const child = (options.makeChild ?? (() => new FakeSh()))();
      children.push(child);
      return child;
    },
    probe: () => {
      const answer = probeAnswers[probes++];
      return answer === HANG ? new Promise<string>(() => {}) : Promise.resolve(answer ?? "");
    },
    onRead: (raw) => reads.push(raw),
    ...(options.readTimeout === undefined ? {} : { readTimeout: options.readTimeout }),
    ...(options.probeTimeout === undefined ? {} : { probeTimeout: options.probeTimeout }),
  });
  return { wsl, children, reads, probes: () => probes };
}

/** What `absent` says after `why`, for a next try a minute after the last failure. */
const retrying = (why: string) =>
  new RegExp(
    `^${why.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; asking again at \\d\\d:\\d\\d:\\d\\d\\.$`,
  );

/** The poll that comes once the minute after a failure is up. */
const MINUTE_ON = () => Date.now() + 61_000;

describe("WslLinux", () => {
  test("asks whether WSL runs, then reads it through one shell, one read at a time", async () => {
    const { wsl, children, reads } = setup([""]);
    wsl.poll();
    await settle();
    expect(children).toHaveLength(0);
    wsl.poll();
    expect(children).toHaveLength(1);
    wsl.poll();
    // Still waiting for the first answer: no second command.
    expect(children[0]?.written).toHaveLength(1);
    children[0]?.answer(BLOB);
    await settle();
    expect(reads).toHaveLength(1);
    expect(reads[0]?.cores).toBe(4);
    expect(wsl.absent).toBe("");
    wsl.poll();
    children[0]?.answer(BLOB);
    await settle();
    expect(reads).toHaveLength(2);
    expect(children).toHaveLength(1);
  });

  test("no WSL running: says why, starts no shell, and asks again only after a minute", async () => {
    const { wsl, children, probes } = setup(["WSL is not running on this host."]);
    wsl.poll();
    await settle();
    expect(wsl.absent).toMatch(retrying("WSL is not running on this host"));
    wsl.poll();
    await settle();
    expect(probes()).toBe(1);
    expect(children).toHaveLength(0);
    wsl.poll(Date.now() + 61_000);
    await settle();
    expect(probes()).toBe(2);
  });

  test("a shell that dies is a gone WSL with its reason, asked about again later", async () => {
    const { wsl, children, probes } = setup(["", ""]);
    wsl.poll();
    await settle();
    wsl.poll();
    children[0]?.end("exit 1: The Windows Subsystem for Linux instance has terminated.");
    await settle();
    expect(wsl.absent).toMatch(
      retrying(
        "WSL's shell ended (exit 1: The Windows Subsystem for Linux instance has terminated.)",
      ),
    );
    wsl.poll();
    await settle();
    expect(probes()).toBe(1);
    wsl.poll(Date.now() + 61_000);
    await settle();
    wsl.poll(Date.now() + 61_000);
    expect(children).toHaveLength(2);
  });

  test("a shell that dies between reads is not respawned", async () => {
    const { wsl, children, reads, probes } = setup(["", ""]);
    wsl.poll();
    await settle();
    wsl.poll();
    children[0]?.answer(BLOB);
    await settle();
    expect(reads).toHaveLength(1);
    // `wsl --shutdown` while no read is in flight.
    children[0]?.end("exit 1: The Windows Subsystem for Linux instance has terminated.");
    await settle();
    expect(wsl.absent).toMatch(
      retrying(
        "WSL's shell ended (exit 1: The Windows Subsystem for Linux instance has terminated.)",
      ),
    );
    wsl.poll();
    await settle();
    // No new wsl.exe, which would boot the VM again, and no probe before the minute is up.
    expect(children).toHaveLength(1);
    expect(probes()).toBe(1);
  });

  test("output that is no read is a failure, not a sample", async () => {
    const { wsl, children, reads } = setup([""]);
    wsl.poll();
    await settle();
    wsl.poll();
    children[0]?.answer("sh: tail: not found\n");
    await settle();
    expect(reads).toHaveLength(0);
    expect(wsl.absent).toStartWith("WSL: no /proc/stat in what it printed");
    expect(children[0]?.killed).toBe(true);
  });

  test("stop ends the shell", async () => {
    const { wsl, children } = setup([""]);
    wsl.poll();
    await settle();
    wsl.poll();
    wsl.stop();
    await settle();
    expect(children[0]?.killed).toBe(true);
    wsl.poll(Date.now() + 61_000);
    expect(children).toHaveLength(1);
  });
});

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A `wsl.exe` that Windows will not end: its kill throws, and it never exits. */
class StuckSh extends FakeSh {
  override kill(): void {
    this.killed = true;
    throw new Error("Access is denied.");
  }
}

describe("WslLinux once WSL stops answering (stale interop, accept4 failed 110)", () => {
  test("says how long in plain words", () => {
    expect(duration(10_000)).toBe("10 s");
    expect(duration(20)).toBe("20 ms");
    expect(clock(new Date(2026, 9, 29, 14, 5, 30).getTime())).toBe("14:05:30");
  });

  test("a shell that hangs is killed, and a new one reads once WSL answers again", async () => {
    const { wsl, children, reads, probes } = setup(["", ""], { readTimeout: 20 });
    wsl.poll();
    await settle();
    expect(wsl.absent).toBe("WSL runs; reading it…");
    // The read that never comes back.
    wsl.poll();
    await wait(40);
    expect(children[0]?.killed).toBe(true);
    expect(wsl.absent).toMatch(retrying("WSL did not answer for 20 ms"));
    expect(reads).toHaveLength(0);
    // Nothing stays held: before the minute is up nothing is asked, after it WSL is.
    wsl.poll();
    await settle();
    expect(probes()).toBe(1);
    wsl.poll(MINUTE_ON());
    await settle();
    expect(probes()).toBe(2);
    wsl.poll();
    expect(children).toHaveLength(2);
    // The old shell answering late counts for nothing; the new one's answer is read.
    children[0]?.answer(BLOB);
    children[1]?.answer(BLOB);
    await settle();
    expect(reads).toHaveLength(1);
    expect(wsl.absent).toBe("");
    wsl.poll();
    children[1]?.answer(BLOB);
    await settle();
    expect(reads).toHaveLength(2);
  });

  test("a wsl.exe --list --running that hangs is a no within its limit, and asked again", async () => {
    const { wsl, children, reads, probes } = setup([HANG, ""], { probeTimeout: 20 });
    wsl.poll();
    await settle();
    expect(wsl.absent).toBe("Looking for WSL…");
    await wait(40);
    expect(wsl.absent).toMatch(retrying("wsl.exe --list --running did not answer for 20 ms"));
    expect(children).toHaveLength(0);
    wsl.poll(MINUTE_ON());
    expect(wsl.absent).toBe("wsl.exe --list --running did not answer for 20 ms; asking again now…");
    await settle();
    expect(probes()).toBe(2);
    wsl.poll();
    children[0]?.answer(BLOB);
    await settle();
    expect(reads).toHaveLength(1);
    expect(wsl.absent).toBe("");
  });

  test("a wsl.exe whose kill never ends it holds up nothing: the next one still starts", async () => {
    let made = 0;
    const makeChild = () => (made++ === 0 ? new StuckSh() : new FakeSh());
    const { wsl, children, reads } = setup(["", ""], { readTimeout: 20, makeChild });
    wsl.poll();
    await settle();
    wsl.poll();
    await wait(40);
    expect(children[0]?.killed).toBe(true);
    expect(wsl.absent).toMatch(retrying("WSL did not answer for 20 ms"));
    wsl.poll(MINUTE_ON());
    await settle();
    wsl.poll();
    expect(children).toHaveLength(2);
    children[1]?.answer(BLOB);
    await settle();
    expect(reads).toHaveLength(1);
  });

  test("a script that times out in the same shell is WSL gone at once, not at the next read", async () => {
    const { wsl, children } = setup([""]);
    wsl.poll();
    await settle();
    wsl.poll();
    children[0]?.answer(BLOB);
    await settle();
    expect(wsl.absent).toBe("");
    await expect(wsl.run("ps", 20)).rejects.toThrow("script timed out after 20 ms");
    expect(children[0]?.killed).toBe(true);
    expect(wsl.absent).toMatch(retrying("WSL did not answer for 20 ms"));
    // And says so to whoever asks next, without a wsl.exe of its own.
    await expect(wsl.run("ps", 20)).rejects.toThrow("WSL did not answer for 20 ms");
    expect(children).toHaveLength(1);
  });
});
