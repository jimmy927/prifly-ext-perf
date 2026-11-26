/**
 * Which session started a container, from what the sessions' transcripts say
 * they ran: the fallback for a container whose paths name no session
 * (`ownerOf` in `docker.ts`) — a `docker run` with no mounts, or a compose
 * project in a folder that is no session's own.
 *
 * Claude Code writes every session's tool calls to
 * `<root>/projects/<cwd, with "/" and "." as "-">/<session id>.jsonl` (the
 * subagents' to `<session id>/subagents/*.jsonl`, under the same session id),
 * one JSON object per line with `timestamp`, `sessionId`, `cwd` and
 * `message.content[]`, whose `tool_use` items named `Bash` carry
 * `input.command`. The file name is `ExtensionSession.id`. Every account's
 * `projects` folder is a symlink to `~/.claude/projects` on this machine, so
 * folders are deduplicated by their real path.
 *
 * A call starts a container when its command does (`docker-command.ts`) and
 * its time is in a window just before the container's Docker `Created` time.
 * Of the sessions with such a call, the one with the latest wins; a tie is
 * no one's. A container's starter never changes, so each is decided once.
 */

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { type ContainerInfo, ownerOf } from "./docker";
import { commandStarts } from "./docker-command";
import type { ExtensionSession } from "./prifly-api";

/**
 * How long before its `Created` a call may be: a compose `up` that pulls an
 * image, or a `docker run` waiting on a permission prompt, creates the
 * container only after that. Two minutes covers a pull of a large image; a
 * longer build is missed (the container stays unowned) rather than risking
 * another session's call matching.
 */
export const BEFORE_CREATED = 120_000;
/** A transcript line is stamped when the model's message ends, `Created` is whole seconds: allow this much after. */
export const AFTER_CREATED = 5_000;
/** The most of a transcript's end read per file. */
export const TAIL_BYTES = 2_000_000;
const CHUNK = 262_144;

/** One Bash call of a session's, from its transcript. */
export type StartCall = { session: string; at: number; cwd: string; command: string };

/**
 * The session that started `info`: of the sessions with a call in the window
 * before its `Created` that starts it, the one whose latest such call is the
 * latest; "" with none, or when two sessions' latest are the same instant.
 */
export function starterOf(
  info: ContainerInfo,
  calls: readonly StartCall[],
  home: string = homedir(),
): string {
  if (info.created === undefined) return "";
  const latest = new Map<string, number>();
  for (const call of calls) {
    if (call.at < info.created - BEFORE_CREATED || call.at > info.created + AFTER_CREATED) continue;
    if (!commandStarts(call.command, call.cwd, info, home)) continue;
    latest.set(call.session, Math.max(latest.get(call.session) ?? 0, call.at));
  }
  const ranked = [...latest].sort((a, b) => b[1] - a[1]);
  const [best, next] = ranked;
  return best === undefined || best[1] === next?.[1] ? "" : best[0];
}

/** The Bash calls in transcript text, one JSON object per line; a line that is not whole JSON is skipped. */
export function callsOf(text: string): StartCall[] {
  // The cheap test first: most lines are not a call that mentions docker.
  return text
    .split("\n")
    .filter((line) => line.includes('"tool_use"') && line.includes("docker"))
    .flatMap(callsOfLine);
}

function callsOfLine(line: string): StartCall[] {
  let entry: TranscriptLine;
  try {
    entry = JSON.parse(line) as TranscriptLine;
  } catch {
    return [];
  }
  const at = Date.parse(entry.timestamp ?? "");
  const session = entry.sessionId;
  if (Number.isNaN(at) || session === undefined) return [];
  return (entry.message?.content ?? []).flatMap((item) => {
    const command = typeof item === "object" && item?.name === "Bash" ? item.input?.command : "";
    return typeof command === "string" && command !== ""
      ? [{ session, at, cwd: entry.cwd ?? "/", command }]
      : [];
  });
}

/**
 * Who started a container: the session its paths name (`ownerOf`), else the
 * one `starter` (`Starters.get`) found in the transcripts — if the host still lists it.
 */
export function containerOwner(
  info: ContainerInfo,
  sessions: ExtensionSession[],
  starter: string,
): string {
  return ownerOf(info, sessions) || (sessions.some((s) => s.id === starter) ? starter : "");
}

type TranscriptLine = {
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  message?: { content?: ({ name?: string; input?: { command?: unknown } } | string)[] };
};

/** A session's folder under `projects`: its cwd with every "/" and "." as "-". */
export const projectFolder = (cwd: string) => cwd.replace(/[/.]/g, "-");

/**
 * The last `TAIL_BYTES` of a file at most, going back by chunks until a whole
 * line is older than `since` (epoch ms); "" when it cannot be read.
 */
export function tailSince(path: string, since: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(path).size;
    let length = Math.min(size, CHUNK);
    for (;;) {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      const firstWhole = text.indexOf("\n") + 1;
      const stamp = /"timestamp":"([^"]+)"/.exec(
        text.slice(firstWhole, text.indexOf("\n", firstWhole)),
      );
      const older = stamp !== null && Date.parse(stamp[1] ?? "") < since;
      if (length >= size || length >= TAIL_BYTES || older) {
        return length >= size ? text : text.slice(firstWhole);
      }
      length = Math.min(size, length * 2, TAIL_BYTES);
    }
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/** The folders holding transcripts, each once: `~/.claude`, `CLAUDE_CONFIG_DIR`, and every prifly account's. */
export function transcriptRoots(
  home: string,
  configDir = process.env["CLAUDE_CONFIG_DIR"] ?? "",
): string[] {
  const accounts = `${home}/.local/share/prifly/accounts`;
  let names: string[] = [];
  try {
    names = readdirSync(accounts);
  } catch {
    // No prifly accounts folder on this machine.
  }
  const roots = [
    `${home}/.claude/projects`,
    ...(configDir === "" ? [] : [`${configDir}/projects`]),
    ...names.map((name) => `${accounts}/${name}/projects`),
  ];
  const real = new Set<string>();
  for (const root of roots) {
    try {
      real.add(realpathSync(root));
    } catch {
      // Not there on this machine.
    }
  }
  return [...real];
}

/** `ExtensionSession.id`s are uuids; one that is not is never put in a command. */
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * For a host on Windows itself: one shell line, run inside WSL, that prints the
 * `docker` tool calls of `sessions`' transcripts changed since `since` (their
 * ends, `TAIL_BYTES` each; the first line of a tail may be cut and is skipped).
 * The transcripts are found by file name across `projects`, as a Windows
 * host does not know their folders; nothing is read across `\\wsl.localhost`.
 * `find` does not follow a symlinked account folder (here all link to
 * `~/.claude/projects`, which would be walked seven times, 2 s against 0.3 s);
 * an account folder that is a real one is walked, and `sort -u` drops repeats.
 */
export function transcriptScan(sessions: readonly ExtensionSession[], since: number): string {
  const ids = sessions.map((session) => session.id).filter((id) => SESSION_ID.test(id));
  if (ids.length === 0) return "true";
  const names = ids
    .flatMap((id) => [`-name '${id}.jsonl'`, `-path '*/${id}/subagents/*.jsonl'`])
    .join(" -o ");
  const roots = '"$HOME/.claude/projects" "$HOME"/.local/share/prifly/accounts/*/projects';
  return (
    `find ${roots} -maxdepth 4 -type f -newermt @${Math.floor(since / 1000)} \\( ${names} \\) -print0 2>/dev/null` +
    ` | xargs -0 -r realpath -z | sort -zu | xargs -0 -r tail -q -c ${TAIL_BYTES}` +
    " | grep -a '\"tool_use\".*docker'; true"
  );
}

function subagentFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => `${dir}/${name}`);
  } catch {
    return [];
  }
}

/**
 * The same for this machine: the lines of the `docker` tool calls in the
 * transcripts of `sessions` changed since `since`. Reads only each file's end.
 */
export function readTranscripts(
  sessions: readonly ExtensionSession[],
  since: number,
  roots: readonly string[],
): string {
  const out: string[] = [];
  for (const session of sessions) {
    for (const root of roots) {
      const folder = `${root}/${projectFolder(session.cwd)}`;
      const own = `${folder}/${session.id}`;
      for (const path of [`${own}.jsonl`, ...subagentFiles(`${own}/subagents`)]) {
        try {
          if (statSync(path).mtimeMs < since) continue;
        } catch {
          continue;
        }
        out.push(tailSince(path, since));
      }
    }
  }
  return out.join("\n");
}

/** Reads the transcripts' `docker` lines for sessions, since a time: this machine's, or WSL's through the shell. */
export type TranscriptReader = (sessions: ExtensionSession[], since: number) => Promise<string>;

/** After a failed read, how long before the next. */
const RETRY = 60_000;

/**
 * Finds the starter of containers whose paths name none, and remembers it:
 * a container's starter never changes, so each is decided once — "" too —
 * and a container that has gone is forgotten. One read at a time, of all the
 * undecided containers together, and only transcripts changed since the oldest
 * one's window began.
 */
export class Starters {
  private readonly decided = new Map<string, string>();
  private reading = false;
  private retryAt = 0;

  private readonly read: TranscriptReader;
  private readonly log: (error: string) => void;
  private readonly home: string;

  constructor(read: TranscriptReader, log: (error: string) => void, home: string = homedir()) {
    this.read = read;
    this.log = log;
    this.home = home;
  }

  /** The session that started container `id`, "" when none or not decided yet. */
  get(id: string): string {
    return this.decided.get(id) ?? "";
  }

  /**
   * Looks for the starters of the containers in `infos` (by id) that `owned`
   * does not name and that are not decided. The answer lands later, in `get`.
   */
  refresh(
    infos: ReadonlyMap<string, ContainerInfo>,
    sessions: ExtensionSession[],
    owned: (info: ContainerInfo) => boolean,
    now: number,
  ): void {
    for (const id of this.decided.keys()) if (!infos.has(id)) this.decided.delete(id);
    if (this.reading || now < this.retryAt || sessions.length === 0) return;
    const todo = [...infos].filter(
      ([id, info]) => !this.decided.has(id) && info.created !== undefined && !owned(info),
    );
    if (todo.length === 0) return;
    const since = Math.min(...todo.map(([, info]) => info.created ?? now)) - BEFORE_CREATED;
    this.reading = true;
    this.read(sessions, since)
      .then((text) => {
        const calls = callsOf(text);
        for (const [id, info] of todo) this.decided.set(id, starterOf(info, calls, this.home));
      })
      .catch((error: unknown) => {
        this.log(`reading transcripts for container owners: ${String(error)}`);
        this.retryAt = now + RETRY;
      })
      .finally(() => {
        this.reading = false;
      });
  }
}
