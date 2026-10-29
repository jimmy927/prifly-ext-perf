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
 * names none, and when the shell dies (`wsl --shutdown`, say) or stops
 * answering (stale interop): every `wsl.exe` call has a time limit, so the
 * reads come back on their own once WSL answers again.
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
import { type Frame, ScriptShell, ScriptTimeout, type ShellChild } from "./shell";
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
 * A line WSL prints about itself rather than a distro's name, such as
 * `<3>WSL (1234) ERROR: UtilAcceptVsock:273: accept4 failed 110` once its
 * interop sockets have gone stale.
 */
const WSL_ERROR = /^<\d+>WSL \(|\bERROR\b/;

/**
 * Whether `wsl.exe --list --running --quiet` named a distro: "" when it did,
 * else why there is no WSL to read. An error line of WSL's own is no distro.
 */
export function probeAnswer(error: { code?: unknown } | null, out: string): string {
  const lines = out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (error === null && lines.some((line) => !WSL_ERROR.test(line))) return "";
  const errors = lines.filter((line) => WSL_ERROR.test(line));
  if (errors.length > 0) return `WSL answered with an error: ${errors.join(" ")}`;
  return out === "" ? "WSL is not running on this host." : `WSL is not running: ${out}`;
}

/** How long `wsl.exe --list --running` may take before it counts as no answer. */
export const PROBE_TIMEOUT = 10_000;

/** "10 s", or "250 ms" under a second. */
export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
}

/**
 * Asks `wsl.exe` whether a distro runs; "" when one does. Settles within
 * `PROBE_TIMEOUT` whatever `wsl.exe` does: `execFile` answers only once the
 * child's pipes close, which a `wsl.exe` hung on stale interop may never let
 * happen, so its own timer kills the child and answers without waiting.
 */
export function probeWsl(): Promise<string> {
  if (!existsSync(HOST.wsl)) return Promise.resolve("There is no WSL on this host.");
  return new Promise((done) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(why);
    };
    const child = execFile(
      HOST.wsl,
      ["--list", "--running", "--quiet"],
      { env: { ...process.env, WSL_UTF8: "1" }, encoding: "buffer", windowsHide: true },
      (error, stdout) => finish(probeAnswer(error, decodeWsl(stdout))),
    );
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      finish(`wsl.exe --list --running did not answer for ${duration(PROBE_TIMEOUT)}`);
    }, PROBE_TIMEOUT);
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
  /** How long a read may take; `READ_TIMEOUT` but in tests. */
  readTimeout?: number;
  /** How long `probe` may take before it counts as no answer; `PROBE_TIMEOUT` but in tests. */
  probeTimeout?: number;
};

/** A time of day as the reader's clock shows it, "14:05:30". */
export function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/** `probe`'s answer, or `why` once `ms` have gone by without one: a probe never holds up the next. */
function within(probe: Promise<string>, ms: number, why: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<string>((done) => {
    timer = setTimeout(() => done(why), ms);
  });
  return Promise.race([probe, late]).finally(() => clearTimeout(timer));
}

/**
 * Reads the WSL VM once a second through one `wsl.exe -e sh`, at most one read
 * in flight; `poll` is called every second and never waits.
 *
 * Every step is bounded, so WSL that stops answering (stale interop sockets,
 * `accept4 failed 110`) is read again once it answers: a read or a script that
 * takes too long kills its `wsl.exe` without waiting for it to exit and counts
 * as WSL gone; a probe that takes too long is a no; and in a minute the next
 * probe starts a new shell whatever became of the old one.
 */
export class WslLinux {
  /** Why the WSL VM is not read now; "" while it is. */
  private why = "Looking for WSL…";
  private readonly deps: WslDeps;
  private readonly readTimeout: number;
  private readonly probeTimeout: number;
  private shell: ScriptShell | null = null;
  private busy = false;
  private probing = false;
  /** When WSL is asked about next; 0 while that is not waited for. */
  private probeAt = 0;
  private stopped = false;

  constructor(deps: WslDeps) {
    this.deps = deps;
    this.readTimeout = deps.readTimeout ?? READ_TIMEOUT;
    this.probeTimeout = deps.probeTimeout ?? PROBE_TIMEOUT;
  }

  /** Why the WSL VM is not read now, and when it is asked about again; "" while it is read. */
  get absent(): string {
    if (this.why === "" || this.probeAt === 0) return this.why;
    const why = this.why.replace(/\.$/, "");
    if (this.probing) return `${why}; asking again now…`;
    return `${why}; asking again at ${clock(this.probeAt)}.`;
  }

  poll(now = Date.now()): void {
    if (this.busy || this.stopped) return;
    const shell = this.shell;
    if (shell === null) {
      if (now < this.probeAt) return;
      this.busy = true;
      this.probing = true;
      const late = `wsl.exe --list --running did not answer for ${duration(this.probeTimeout)}`;
      within(this.deps.probe(), this.probeTimeout, late)
        .then((why) => {
          this.probing = false;
          if (this.stopped) return;
          if (why !== "") {
            this.gone(why);
            return;
          }
          this.why = "WSL runs; reading it…";
          this.probeAt = 0;
          this.shell = this.newShell();
        })
        .catch((error: unknown) => this.gone(`WSL: ${messageOf(error)}`))
        .finally(() => {
          this.busy = false;
          this.probing = false;
        });
      return;
    }
    this.busy = true;
    shell
      .run(READ, this.readTimeout)
      .then((out) => {
        const raw = parseWslRead(out, Date.now());
        if (raw === null) throw new Error(`no /proc/stat in what it printed: ${out.slice(0, 200)}`);
        this.why = "";
        this.deps.onRead(raw);
      })
      .catch((error: unknown) => {
        // Already gone (the shell ended, or `stop`): the first reason stands.
        if (this.shell !== shell) return;
        this.gone(failureOf(error));
      })
      .finally(() => {
        this.busy = false;
      });
  }

  /**
   * Runs `script` in the same shell, after what it already runs; its output.
   * Rejects while WSL is not read, so it never starts a `wsl.exe` of its own.
   * A script that times out ends the shell, and so counts as WSL gone at once.
   */
  run(script: string, timeout: number): Promise<string> {
    const shell = this.shell;
    if (shell === null || this.why !== "") return Promise.reject(new Error(this.absent));
    return shell.run(script, timeout).catch((error: unknown) => {
      if (error instanceof ScriptTimeout && this.shell === shell) this.gone(failureOf(error));
      throw error;
    });
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
        if (this.shell === shell) this.gone(`WSL's shell ended (${reason})`);
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

  /**
   * WSL cannot be read: say why, end the shell, and ask again in a minute.
   * The shell's `wsl.exe` is killed and let go of, not waited for: one whose
   * kill never ends it holds up nothing, as the next start is a new shell.
   */
  private gone(why: string): void {
    this.why = why;
    this.probeAt = Date.now() + PROBE_EVERY;
    const shell = this.shell;
    this.shell = null;
    shell?.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a read through the shell failed, in the reader's words. */
function failureOf(error: unknown): string {
  if (error instanceof ScriptTimeout) return `WSL did not answer for ${duration(error.ms)}`;
  return `WSL: ${messageOf(error)}`;
}
