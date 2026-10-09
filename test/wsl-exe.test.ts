import { describe, expect, test } from "bun:test";
import { hostOf } from "../host";
import { ScriptShell, type ShellChild } from "../shell";
import type { LinuxRaw } from "../wsl";
import {
  decodeWsl,
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

function setup(probeAnswers: string[]) {
  const children: FakeSh[] = [];
  const reads: LinuxRaw[] = [];
  let probes = 0;
  const wsl = new WslLinux({
    spawn: () => {
      const child = new FakeSh();
      children.push(child);
      return child;
    },
    probe: async () => probeAnswers[probes++] ?? "",
    onRead: (raw) => reads.push(raw),
  });
  return { wsl, children, reads, probes: () => probes };
}

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
    expect(wsl.absent).toBe("WSL is not running on this host.");
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
    expect(wsl.absent).toBe(
      "WSL: shell ended: exit 1: The Windows Subsystem for Linux instance has terminated.",
    );
    wsl.poll();
    await settle();
    expect(probes()).toBe(1);
    wsl.poll(Date.now() + 61_000);
    await settle();
    wsl.poll(Date.now() + 61_000);
    expect(children).toHaveLength(2);
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
