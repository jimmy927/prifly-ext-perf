/**
 * The process table, Docker's containers and, on a host on Windows itself,
 * the host's own Windows processes: what the prifly tab and the nanny are
 * made from, read only while someone looks (`index.ts` says when).
 *
 * A host inside WSL reads its own `/proc` and `/sys/fs/cgroup`, at once. A
 * host on Windows itself reads the same files through the shell inside WSL
 * (`wsl-exe.ts`), one read in flight at a time, and its own processes from
 * Windows' process list through the shared PowerShell (`windows.ts`).
 */

import {
  type ContainerInfo,
  type ContainerSnapshot,
  containerInfos,
  DOCKER_INSPECT,
  parseInspect,
  readContainers,
} from "./docker";
import { type ProcSnapshot, readProcs } from "./procs";
import { parsePssRead, pssRead, readPss } from "./pss";
import { keep } from "./ring";
import { hostTreeOf, windowsProcessList } from "./windows";
import { PROCS_READ, parseProcsRead, type WslLinux } from "./wsl-exe";

/** Containers' names and mounts change only when one starts or stops. */
const DOCKER_EVERY = 10_000;
/** The longest a read through WSL may take; one that takes longer ends the shell, and WSL counts as gone. */
const WSL_TIMEOUT = 10_000;
/** The `claude` processes' PSS walks their page tables: at most this often. */
const PSS_EVERY = 10_000;
/** The host's own Windows processes: a slower query than a counter, so every 2 s. */
const WINDOWS_HOST_EVERY = 2_000;

export type TableDeps = {
  /** What reads the WSL VM on a host on Windows itself; null where this host's `/proc` is Linux. */
  wsl: WslLinux | null;
  /** Whether Windows' tools are there to list the host's own processes. */
  windows: boolean;
  /** This host's pid: a Windows pid on a host on Windows itself. */
  hostPid: number;
  log: (event: string, data: { error: string }) => void;
};

export class Tables {
  /** Process tables, newest last. */
  readonly procs: ProcSnapshot[] = [];
  /** Docker's containers, read with the process table while the window is open. */
  readonly containers: ContainerSnapshot[] = [];
  /** What each container is, by id, as Docker last said (`docker.ts`). */
  dockerInfos = new Map<string, ContainerInfo>();
  /** On a host on Windows itself, the host and all it started there; empty elsewhere. */
  readonly windowsHost: ProcSnapshot[] = [];
  /**
   * The PSS of the sessions' `claude` processes, by pid (`pss.ts`), read while
   * the Memory tab is open; a pid it could not read is absent.
   */
  pss = new Map<number, number>();
  private readonly deps: TableDeps;
  private pssAt = 0;
  private pssReading = false;
  private dockerAt = 0;
  private procsReading = false;
  private windowsHostAt = 0;
  private windowsHostReading = false;
  private stopped = false;

  constructor(deps: TableDeps) {
    this.deps = deps;
  }

  /** Whether this host's own Windows processes are read: only on a host on Windows itself. */
  get native(): boolean {
    return this.deps.wsl !== null;
  }

  /** While the window is open: the table and the containers, kept `seconds`, and the host's own processes. */
  readAll(seconds: number, now: number): void {
    const wsl = this.deps.wsl;
    if (wsl === null) {
      keep(this.procs, readProcs(), seconds);
      this.keepContainers(readContainers(), seconds, now);
      return;
    }
    this.readThroughWsl(wsl, seconds, true);
    if (this.deps.windows) this.readWindowsHost(seconds, now);
  }

  /** For the nanny: the table alone, kept `seconds`. */
  readProcs(seconds: number): void {
    const wsl = this.deps.wsl;
    if (wsl === null) keep(this.procs, readProcs(), seconds);
    else this.readThroughWsl(wsl, seconds, false);
  }

  /**
   * While the Memory tab is open: the PSS of `pids` (the `claude` processes),
   * at most every 10 s, through the shell inside WSL on a host on Windows
   * itself. A read that fails is logged and leaves the RSS to stand in.
   */
  readPss(pids: readonly number[], now: number): void {
    if (this.pssReading || now - this.pssAt < PSS_EVERY) return;
    this.pssAt = now;
    const wsl = this.deps.wsl;
    if (pids.length === 0) {
      this.pss = new Map();
      return;
    }
    if (wsl === null) {
      this.pss = readPss(pids);
      return;
    }
    if (wsl.absent !== "") return;
    this.pssReading = true;
    wsl
      .run(pssRead(pids), WSL_TIMEOUT)
      .then((out) => {
        if (wsl.absent === "" && !this.stopped) this.pss = parsePssRead(out);
      })
      .catch((error: unknown) => {
        if (wsl.absent === "") this.deps.log("wsl_pss_failed", { error: String(error) });
      })
      .finally(() => {
        this.pssReading = false;
      });
  }

  /** The Memory tab is closed: no PSS is read, and what was is let go of. */
  clearPss(): void {
    this.pss = new Map();
    this.pssAt = 0;
  }

  /** Forgets what was kept: it is from before a gap, and says nothing about now. */
  clear(): void {
    this.procs.length = 0;
    this.containers.length = 0;
    this.windowsHost.length = 0;
    this.clearPss();
  }

  /** WSL is gone: its table and containers go, the host's own Windows processes stay. */
  clearWsl(): void {
    this.procs.length = 0;
    this.containers.length = 0;
    this.clearPss();
  }

  /** No answer that lands after this is kept. */
  stop(): void {
    this.stopped = true;
  }

  private keepContainers(containers: ContainerSnapshot, seconds: number, now: number): void {
    keep(this.containers, containers, seconds);
    // Docker is asked only when a container runs: with none there may be no Docker to ask.
    if (containers.containers.size === 0 || now - this.dockerAt <= DOCKER_EVERY) return;
    this.dockerAt = now;
    const wsl = this.deps.wsl;
    const infos =
      wsl === null ? containerInfos() : wsl.run(DOCKER_INSPECT, WSL_TIMEOUT).then(parseInspect);
    infos
      .then((found) => {
        this.dockerInfos = found;
      })
      // Until Docker answers, the containers go by their ids.
      .catch((error: unknown) => this.deps.log("docker_failed", { error: String(error) }));
  }

  /**
   * The table, and with `containers` the containers' counters, through the
   * shell inside WSL; at most one read in flight. A read that fails while WSL
   * still counts as running is logged; the table goes when WSL does (`index.ts`).
   */
  private readThroughWsl(wsl: WslLinux, seconds: number, containers: boolean): void {
    if (this.procsReading || wsl.absent !== "") return;
    this.procsReading = true;
    wsl
      .run(PROCS_READ, WSL_TIMEOUT)
      .then((out) => {
        const read = parseProcsRead(out, Date.now());
        if (read.procs.procs.size === 0) {
          throw new Error(`no process in what it printed: ${out.slice(0, 200)}`);
        }
        // WSL went while it read: what it read says nothing about now.
        if (wsl.absent !== "" || this.stopped) return;
        keep(this.procs, read.procs, seconds);
        if (containers) this.keepContainers(read.containers, seconds, Date.now());
      })
      .catch((error: unknown) => {
        if (wsl.absent === "") this.deps.log("wsl_procs_failed", { error: String(error) });
      })
      .finally(() => {
        this.procsReading = false;
      });
  }

  /** The host and every process under it, from Windows' process list, every 2 s. */
  private readWindowsHost(seconds: number, now: number): void {
    if (this.windowsHostReading || now - this.windowsHostAt < WINDOWS_HOST_EVERY) return;
    this.windowsHostAt = now;
    this.windowsHostReading = true;
    windowsProcessList()
      .then((out) => {
        if (!this.stopped) {
          keep(this.windowsHost, hostTreeOf(out, this.deps.hostPid, Date.now()), seconds);
        }
      })
      .catch((error: unknown) => this.deps.log("windows_host_failed", { error: String(error) }))
      .finally(() => {
        this.windowsHostReading = false;
      });
  }
}
