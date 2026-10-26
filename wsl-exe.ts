/**
 * The WSL VM's Linux, read from a host that runs on Windows itself: one
 * `wsl.exe -e sh` that stays running, sent one fixed command a second over
 * its stdin (`tail` of the same `/proc` files `wsl.ts` reads, each under a
 * `==> /proc/… <==` header), whose output goes through `wsl.ts`'s parsers.
 * No `\\wsl.localhost`, and no process started per read but the `tail`.
 * While someone looks, the same shell also reads the process table and
 * Docker's cgroups (`PROCS_READ`, through `tables.ts`) and asks the `docker`
 * inside WSL what each container is.
 *
 * `wsl.exe` would boot the WSL VM if it is not running, and keep it from
 * shutting down while it runs: so it is started only once
 * `wsl.exe --list --running` names a distro, asked again every minute while it
 * names none, and when the shell dies (`wsl --shutdown`, say).
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  type ContainerReading,
  type ContainerSnapshot,
  cgroupIdOf,
  containerReadingOf,
  ROOTS,
} from "./docker";
import { HOST } from "./host";
import { type ProcReading, type ProcSnapshot, readingOf } from "./procs";
import { type Frame, ScriptShell, type ShellChild } from "./shell";
import { coresOf, type LinuxFiles, type LinuxRaw, parsePressure, rawOf } from "./wsl";

/** The files a read needs, in one `tail`; a pressure file a kernel lacks is left out quietly. */
export const READ =
  "tail -n +1 /proc/stat /proc/meminfo /proc/loadavg /proc/vmstat " +
  "/proc/pressure/cpu /proc/pressure/memory /proc/pressure/io 2>/dev/null";

/** The command as it is, then the end marker `ScriptShell` waits for. */
export const SH_FRAME: Frame = (id, script) => `${script}; echo '<<END-${id}>>'\n`;

const READ_TIMEOUT = 10_000;
const PROBE_EVERY = 60_000;

/** `tail`'s output split into each file's text, by its `==> /proc/<name> <==` header. */
export function sections(out: string): Map<string, string> {
  const files = new Map<string, string>();
  const parts = out.replace(/\r/g, "").split(/^==> \/proc\/(\S+) <==\n/m);
  for (let at = 1; at + 1 < parts.length; at += 2) {
    files.set(parts[at] ?? "", parts[at + 1] ?? "");
  }
  return files;
}

/** One read of the WSL VM from `READ`'s output; null when a file it must have is missing. */
export function parseWslRead(out: string, at: number): LinuxRaw | null {
  const files = sections(out);
  const stat = files.get("stat");
  const meminfo = files.get("meminfo");
  if (stat === undefined || meminfo === undefined) return null;
  const pressure = (name: string) => {
    const text = files.get(`pressure/${name}`);
    return text === undefined ? null : parsePressure(text);
  };
  const linux: LinuxFiles = {
    stat,
    meminfo,
    loadavg: files.get("loadavg") ?? "",
    vmstat: files.get("vmstat") ?? "",
    cpu: pressure("cpu"),
    memory: pressure("memory"),
    io: pressure("io"),
  };
  return rawOf(linux, at, coresOf(stat));
}

/**
 * The process table and Docker's cgroups, in one `head` each, for a host on
 * Windows itself: every process's `stat`, `io` and `cmdline`, and each
 * container's cgroup counters, each file under a `==> <path> <==` header.
 * Two processes a read, not three per pid. A `cmdline` keeps its NULs, and is
 * cut at 4 KiB: a `claude`'s system prompt is tens of KiB and says nothing
 * about what it is. A file that is not ours to read (another user's `io`), or
 * whose process ended, is left out quietly. The `echo` between the two is the
 * newline `head` puts between files, so the cgroups' first header starts a line.
 */
export const PROCS_READ =
  "(cd /proc && head -vc 4096 -- [0-9]*/stat [0-9]*/io [0-9]*/cmdline 2>/dev/null; echo; " +
  "cd /sys/fs/cgroup 2>/dev/null && head -vc 65536 -- " +
  ["docker/*", "system.slice/docker-*.scope"]
    .flatMap((dir) => ["cpu.stat", "memory.current", "memory.stat"].map((f) => `${dir}/${f}`))
    .join(" ") +
  " 2>/dev/null)";

/**
 * `head`'s output split into each file's text, by its `==> <path> <==` header,
 * less the newline `head` puts between files. A command line that holds such
 * a header on a line of its own would cut its file short; only one written to
 * fool this could.
 */
export function headSections(out: string): Map<string, string> {
  const files = new Map<string, string>();
  const parts = out.split(/^==> (.+) <==\n/m);
  for (let at = 1; at + 1 < parts.length; at += 2) {
    files.set(parts[at] ?? "", (parts[at + 1] ?? "").replace(/\n$/, ""));
  }
  return files;
}

/** One read of the process table and the containers from `PROCS_READ`'s output. */
export function parseProcsRead(
  out: string,
  at: number,
): { procs: ProcSnapshot; containers: ContainerSnapshot } {
  const files = headSections(out);
  return {
    procs: { at, procs: procsOf(files) },
    containers: { at, containers: containersOf(files) },
  };
}

function procsOf(files: Map<string, string>): Map<number, ProcReading> {
  const procs = new Map<number, ProcReading>();
  for (const [path, stat] of files) {
    const pid = Number(/^(\d+)\/stat$/.exec(path)?.[1] ?? Number.NaN);
    const cmdline = files.get(`${pid}/cmdline`);
    // Not a stat, or it ended between its stat and its command line: read again next time.
    if (Number.isNaN(pid) || cmdline === undefined) continue;
    const reading = readingOf(pid, stat, cmdline, files.get(`${pid}/io`) ?? null);
    if (reading !== null) procs.set(pid, reading);
  }
  return procs;
}

function containersOf(files: Map<string, string>): Map<string, ContainerReading> {
  const containers = new Map<string, ContainerReading>();
  for (const [path, cpuStat] of files) {
    const [root, name, file] = path.split("/");
    const id = cgroupIdOf(name ?? "");
    const current = files.get(`${root}/${name}/memory.current`);
    const stat = files.get(`${root}/${name}/memory.stat`);
    if (file !== "cpu.stat" || id === null || !ROOTS.includes(root ?? "")) continue;
    // Stopped between its files: read again next time.
    if (current === undefined || stat === undefined) continue;
    containers.set(id, containerReadingOf(id, cpuStat, current, stat));
  }
  return containers;
}

/** `wsl.exe`'s output: UTF-16 unless `WSL_UTF8` took, so the NULs go either way. */
export function decodeWsl(out: Buffer | string): string {
  return out.toString().replace(/\0/g, "").replace(/\r/g, "").trim();
}

/**
 * Whether `wsl.exe --list --running --quiet` named a distro: "" when it did,
 * else why there is no WSL to read.
 */
export function probeAnswer(error: { code?: unknown } | null, out: string): string {
  if (error === null && out.split("\n").some((line) => line.trim() !== "")) return "";
  return out === "" ? "WSL is not running on this host." : `WSL is not running: ${out}`;
}

/** Asks `wsl.exe` whether a distro runs; "" when one does. */
export function probeWsl(): Promise<string> {
  if (!existsSync(HOST.wsl)) return Promise.resolve("There is no WSL on this host.");
  return new Promise((done) => {
    execFile(
      HOST.wsl,
      ["--list", "--running", "--quiet"],
      {
        env: { ...process.env, WSL_UTF8: "1" },
        encoding: "buffer",
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout) => done(probeAnswer(error, decodeWsl(stdout))),
    );
  });
}

/** The shell's side of one `wsl.exe -e sh`; the start of its stderr goes into the reason it ended. */
function shellChild(child: ChildProcess): ShellChild {
  child.stdout?.setEncoding("utf8");
  // A write to a child that has ended must not crash the extension.
  child.stdin?.on("error", () => {});
  // Bytes, decoded once at the end: a UTF-16 character may be cut between chunks.
  let stderrBytes = Buffer.alloc(0);
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrBytes.length < 600)
      stderrBytes = Buffer.concat([stderrBytes, chunk]).subarray(0, 600);
  });
  return {
    write: (text) => {
      child.stdin?.write(text, "utf8");
    },
    kill: () => {
      child.kill();
    },
    onData: (listener) => {
      child.stdout?.on("data", listener);
    },
    onExit: (listener) => {
      child.on("error", (error) => listener(error.message));
      child.on("exit", (code, signal) => {
        const stderr = decodeWsl(stderrBytes);
        listener(`exit ${code ?? signal}${stderr === "" ? "" : `: ${stderr}`}`);
      });
    },
  };
}

export function spawnWslShell(): ShellChild {
  return shellChild(
    spawn(HOST.wsl, ["-e", "sh"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: HOST.system32,
    }),
  );
}

export type WslDeps = {
  spawn: () => ShellChild;
  /** "" when a distro runs, else why WSL cannot be read. */
  probe: () => Promise<string>;
  onRead: (raw: LinuxRaw) => void;
};

/**
 * Reads the WSL VM once a second through one `wsl.exe -e sh`, at most one read
 * in flight; `poll` is called every second and never waits.
 */
export class WslLinux {
  /** Why the WSL VM is not read now; "" while it is. */
  absent = "Looking for WSL…";
  private readonly deps: WslDeps;
  private shell: ScriptShell | null = null;
  private busy = false;
  private probeAt = 0;
  private stopped = false;

  constructor(deps: WslDeps) {
    this.deps = deps;
  }

  poll(now = Date.now()): void {
    if (this.busy || this.stopped) return;
    const shell = this.shell;
    if (shell === null) {
      if (now < this.probeAt) return;
      this.busy = true;
      this.deps
        .probe()
        .then((why) => {
          if (why !== "") this.gone(why);
          else if (!this.stopped) this.shell = this.newShell();
        })
        .catch((error: unknown) => this.gone(`WSL: ${String(error)}`))
        .finally(() => {
          this.busy = false;
        });
      return;
    }
    this.busy = true;
    shell
      .run(READ, READ_TIMEOUT)
      .then((out) => {
        const raw = parseWslRead(out, Date.now());
        if (raw === null) throw new Error(`no /proc/stat in what it printed: ${out.slice(0, 200)}`);
        this.absent = "";
        this.deps.onRead(raw);
      })
      .catch((error: unknown) => {
        // Already gone (the shell ended, or `stop`): the first reason stands.
        if (this.shell !== shell) return;
        this.gone(`WSL: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.busy = false;
      });
  }

  /**
   * Runs `script` in the same shell, after what it already runs; its output.
   * Rejects while WSL is not read, so it never starts a `wsl.exe` of its own.
   * A script that times out ends the shell, and so counts as WSL gone.
   */
  run(script: string, timeout: number): Promise<string> {
    const shell = this.shell;
    if (shell === null || this.absent !== "") return Promise.reject(new Error(this.absent));
    return shell.run(script, timeout);
  }

  /**
   * A shell that starts one `wsl.exe` and never another: `ScriptShell` would
   * start a new one on the next read after the old one ended, and that would
   * boot a VM that `wsl --shutdown` just stopped. Its end, between reads or
   * during one, is WSL gone, asked about again in a minute.
   */
  private newShell(): ScriptShell {
    let started = false;
    const shell = new ScriptShell(() => {
      if (started) throw new Error("the shell ended; WSL is asked about again first");
      started = true;
      const child = this.deps.spawn();
      child.onExit((reason) => {
        if (this.shell === shell) this.gone(`WSL: shell ended: ${reason}`);
      });
      return child;
    }, SH_FRAME);
    return shell;
  }

  stop(): void {
    this.stopped = true;
    this.shell?.close();
    this.shell = null;
  }

  /** WSL cannot be read: end the shell, say why, and ask again in a minute. */
  private gone(why: string): void {
    this.absent = why;
    const shell = this.shell;
    this.shell = null;
    shell?.close();
    this.probeAt = Date.now() + PROBE_EVERY;
  }
}
