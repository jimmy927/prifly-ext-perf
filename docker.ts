/**
 * Docker's containers, which the process table cannot show: Docker Desktop
 * runs them in a distro of its own, so their processes are invisible from this
 * one (`procs.ts`). The WSL VM has one kernel and one cgroup tree, though, and
 * this distro sees all of it under `/sys/fs/cgroup`: each container's CPU and
 * memory are its cgroup's counters, in `docker/<id>` (Docker Desktop) or
 * `system.slice/docker-<id>.scope` (Docker Engine under systemd).
 *
 * What each container is — its name, and the paths it mounts — comes from
 * Docker's API on its socket, every 10 s. The paths say which session started
 * it: a mount of a session's scratchpad names the session outright, and a
 * mount or compose project inside one session's folder points at that
 * session. Docker Desktop reports mounts by its own paths
 * (`/run/desktop/mnt/host/wsl/…`) and keeps the WSL paths in
 * `desktop.docker.io/binds/<n>/Source` labels.
 */

import { readdirSync, readFileSync } from "node:fs";
import type { ExtensionSession } from "./prifly-api";

/** One container's counters as one read saw them. */
export type ContainerReading = {
  id: string;
  /** CPU time used since it started, microseconds. */
  usage: number;
  /** Memory in use, bytes: the cgroup's, less file cache it can drop (as `docker stats` counts it). */
  memory: number;
};

/** Every container's counters as one read saw them; rates come from two of these (`average.ts`). */
export type ContainerSnapshot = { at: number; containers: Map<string, ContainerReading> };

/** One container over a window, with the session that started it. */
export type Container = {
  id: string;
  name: string;
  /** Cores in use over the window. */
  cpu: number;
  memory: number;
  /** The id of the session that started it, or "" when no one session did. */
  session: string;
};

/** Where Docker Desktop and Docker Engine under systemd put containers' cgroups. */
const ROOTS = ["/sys/fs/cgroup/docker", "/sys/fs/cgroup/system.slice"];
const CGROUP = /^(?:docker-)?([0-9a-f]{64})(?:\.scope)?$/;

/** `usage_usec` from a cgroup's `cpu.stat`. */
export function parseCpuStat(text: string): number {
  return Number(/^usage_usec (\d+)/m.exec(text)?.[1] ?? 0);
}

/** A field of a cgroup's `memory.stat`, bytes. */
export function memoryStat(text: string, field: string): number {
  return Number(new RegExp(`^${field} (\\d+)`, "m").exec(text)?.[1] ?? 0);
}

function readOne(dir: string, id: string): ContainerReading | null {
  try {
    const current = Number(readFileSync(`${dir}/memory.current`, "utf8"));
    const inactive = memoryStat(readFileSync(`${dir}/memory.stat`, "utf8"), "inactive_file");
    return {
      id,
      usage: parseCpuStat(readFileSync(`${dir}/cpu.stat`, "utf8")),
      memory: Math.max(0, current - inactive),
    };
  } catch (error) {
    // Stopped between the listing and the read.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Reads every running container's cgroup now; none where there is no Docker. */
export function readContainers(): ContainerSnapshot {
  const containers = new Map<string, ContainerReading>();
  for (const root of ROOTS) {
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const id = CGROUP.exec(name)?.[1];
      if (id === undefined) continue;
      const one = readOne(`${root}/${name}`, id);
      if (one !== null) containers.set(id, one);
    }
  }
  return { at: Date.now(), containers };
}

/** The part of Docker's `GET /containers/json` this reads. */
export type ApiContainer = {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string> | null;
  Mounts?: { Source?: string }[] | null;
};

/** What a container is: its name, and the paths on this side it mounts or was composed from. */
export type ContainerInfo = { name: string; paths: string[] };

const BIND_LABEL = /^desktop\.docker\.io\/binds\/\d+\/Source$/;
const COMPOSE_LABELS = [
  "com.docker.compose.project.working_dir",
  "com.docker.compose.project.config_files",
];

export function infoOf(api: ApiContainer): ContainerInfo {
  const labels = api.Labels ?? {};
  const paths = [
    ...Object.entries(labels)
      .filter(([key]) => BIND_LABEL.test(key))
      .map(([, value]) => value),
    ...COMPOSE_LABELS.flatMap((key) => (labels[key] ?? "").split(",")),
    // Docker Desktop's own paths say nothing about this side; Docker Engine's are this side's.
    ...(api.Mounts ?? []).map((mount) => mount.Source ?? ""),
  ].filter((path) => path.startsWith("/") && !path.startsWith("/run/desktop/"));
  const name = (api.Names?.[0] ?? api.Id.slice(0, 12)).replace(/^\//, "");
  return { name, paths: [...new Set(paths)] };
}

/** A Claude Code scratchpad: `/tmp/claude-<uid>/<project>/<session id>/…`. */
const SCRATCHPAD =
  /\/claude-\d+\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/;

const inside = (path: string, folder: string) =>
  folder !== "" && (path === folder || path.startsWith(`${folder.replace(/\/$/, "")}/`));

/**
 * The session that started a container, from its paths: one that mounts a
 * session's scratchpad is that session's. Else the session whose folder holds
 * one of its paths most closely — but only when that folder is one session's
 * alone: a stack in a checkout that several sessions share is none of theirs.
 * "" when no session fits.
 */
export function ownerOf(info: ContainerInfo, sessions: ExtensionSession[]): string {
  const ids = new Set(sessions.map((session) => session.id));
  for (const path of info.paths) {
    const id = SCRATCHPAD.exec(path)?.[1];
    if (id !== undefined && ids.has(id)) return id;
  }
  let best = "";
  for (const path of info.paths) {
    for (const session of sessions) {
      if (inside(path, session.cwd) && session.cwd.length > best.length) best = session.cwd;
    }
  }
  const owners = sessions.filter((session) => session.cwd === best);
  return best !== "" && owners.length === 1 ? (owners[0]?.id ?? "") : "";
}

/** Docker's API socket: `DOCKER_HOST` when it names one, else the usual place. */
function socketPath(): string {
  const host = process.env["DOCKER_HOST"] ?? "";
  return host.startsWith("unix://") ? host.slice("unix://".length) : "/var/run/docker.sock";
}

/** Asks Docker what each running container is. Rejects where there is no Docker to ask. */
export async function containerInfos(): Promise<Map<string, ContainerInfo>> {
  const response = await fetch("http://docker/containers/json", {
    unix: socketPath(),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Docker answered ${response.status}`);
  const list = (await response.json()) as ApiContainer[];
  return new Map(list.map((api) => [api.Id, infoOf(api)]));
}
