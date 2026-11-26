/**
 * Whether a shell command, as a session's Bash tool ran it, starts a given
 * container (`docker-starter.ts` says when a call counts). The command is read
 * crudely, on purpose: split at `;`, `&&`, `|` and newlines, quotes dropped,
 * `cd` followed through the segments, redirections ignored. Only these start a
 * container:
 *  - `docker run` / `docker create` (or `docker container …`) with `--name <name>`
 *    or `--name=<name>` naming it;
 *  - `docker compose` / `docker-compose` `up|start|create|run|restart` of its
 *    compose service, run from its compose project's folder (`working_dir`) —
 *    the folder being `--project-directory`, else the directory of the first
 *    `-f` file, else the `cd` or the call's own cwd — or with `-p` its project's
 *    name; with no service named it starts every service of the project.
 * `docker rm`, `compose down`, `exec`, `logs` and the like start nothing. A
 * service started only as another's dependency is not named, so it is not found.
 */

import { posix } from "node:path";
import type { ContainerInfo } from "./docker";

const SEPARATORS = /\n|;|&&|\|\|?/;
const PREFIXES = new Set(["sudo", "time", "exec", "nohup", "command", "env"]);
/** The flags before the compose subcommand that take a value. */
const COMPOSE_VALUE_FLAGS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--profile",
  "--env-file",
  "--ansi",
  "--progress",
  "--parallel",
]);
/** The flags of `up`, `run` and `create` that take a value, which is no service. */
const SUB_VALUE_FLAGS = new Set([
  "--scale",
  "-t",
  "--timeout",
  "--pull",
  "--wait-timeout",
  "--exit-code-from",
  "--attach",
  "--no-attach",
  "-e",
  "--env",
  "-u",
  "--user",
  "-w",
  "--workdir",
  "--name",
  "--entrypoint",
  "-v",
  "--volume",
  "-p",
  "--publish",
  "-l",
  "--label",
  "--build-arg",
]);
const COMPOSE_STARTS = new Set(["up", "start", "create", "run", "restart"]);

type Compose = {
  sub: string;
  files: string[];
  project: string | undefined;
  projectDir: string | undefined;
  services: string[];
};

function tokensOf(segment: string): string[] {
  const out: string[] = [];
  let skipNext = false;
  for (const token of segment.replace(/["'`]/g, "").trim().split(/\s+/)) {
    const wasRedirect = skipNext;
    // A redirection (`2>&1`, `> out`) is no argument, nor is the file after a bare `>`.
    skipNext = /^\d*>>?$/.test(token);
    if (wasRedirect || /^\d*[<>]/.test(token)) continue;
    const bare = token.replace(/^[({]+/, "");
    if (bare !== "") out.push(bare);
  }
  return out;
}

/** The tokens after the `docker` word, when that is what the segment runs (after `sudo`, `FOO=1`, …). */
function dockerArgs(tokens: string[]): string[] | null {
  let at = 0;
  while (at < tokens.length && (/^\w+=/.test(tokens[at] ?? "") || PREFIXES.has(tokens[at] ?? ""))) {
    at++;
  }
  const first = tokens[at];
  if (first === "docker-compose") return ["compose", ...tokens.slice(at + 1)];
  return first === "docker" ? tokens.slice(at + 1) : null;
}

/** Takes the compose flag `arg` into `found`; how many of the tokens after it were its value (0 or 1). */
function takeFlag(found: Compose, arg: string, next: string | undefined): number {
  const [flag = "", inline] = arg.startsWith("--") ? arg.split("=", 2) : [arg, undefined];
  if (!COMPOSE_VALUE_FLAGS.has(flag)) return 0;
  const given = inline ?? next ?? "";
  if (flag === "-f" || flag === "--file") found.files.push(given);
  else if (flag === "-p" || flag === "--project-name") found.project = given;
  else if (flag === "--project-directory") found.projectDir = given;
  return inline === undefined ? 1 : 0;
}

/** The services a subcommand names: its arguments that are no flag nor a flag's value; `run`'s first alone. */
function servicesOf(sub: string, args: string[]): string[] {
  const services: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (!arg.startsWith("-")) services.push(arg);
    else if (SUB_VALUE_FLAGS.has(arg)) at++;
  }
  return sub === "run" ? services.slice(0, 1) : services;
}

function composeOf(args: string[]): Compose {
  const found: Compose = {
    sub: "",
    files: [],
    project: undefined,
    projectDir: undefined,
    services: [],
  };
  let at = 0;
  while (at < args.length && (args[at] ?? "").startsWith("-")) {
    at += 1 + takeFlag(found, args[at] ?? "", args[at + 1]);
  }
  found.sub = args[at] ?? "";
  found.services = servicesOf(found.sub, args.slice(at + 1));
  return found;
}

/** `--name x` or `--name=x` of a `docker run`/`create`. */
function runName(args: string[]): string | undefined {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (arg === "--name") return args[at + 1];
    if (arg.startsWith("--name=")) return arg.slice("--name=".length);
  }
  return undefined;
}

function expand(path: string, home: string): string {
  return path.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

function composeStarts(compose: Compose, cwd: string, info: ContainerInfo, home: string): boolean {
  if (!COMPOSE_STARTS.has(compose.sub)) return false;
  const first = compose.files[0];
  const dir = expand(
    compose.projectDir ?? (first === undefined ? "." : posix.dirname(expand(first, home))),
    home,
  );
  const folder = posix.resolve(cwd, dir);
  const here =
    (info.workingDir !== undefined && folder === posix.resolve(info.workingDir)) ||
    (compose.project !== undefined && compose.project === info.project);
  if (!here) return false;
  return compose.services.length === 0 || compose.services.includes(info.service ?? "\0");
}

function segmentStarts(tokens: string[], dir: string, info: ContainerInfo, home: string): boolean {
  const args = dockerArgs(tokens);
  if (args === null) return false;
  const [head, ...rest] = args[0] === "container" ? args.slice(1) : args;
  if (head === "compose") return composeStarts(composeOf(rest), dir, info, home);
  return (head === "run" || head === "create") && runName(rest) === info.name;
}

/** Whether `command`, run in `cwd` (`home` for `~`), starts the container `info` describes. */
export function commandStarts(
  command: string,
  cwd: string,
  info: ContainerInfo,
  home: string,
): boolean {
  let dir = cwd;
  for (const segment of command.split(SEPARATORS)) {
    const tokens = tokensOf(segment);
    const target = tokens[1];
    if (tokens[0] === "cd" && target !== undefined && target !== "-") {
      dir = posix.resolve(dir, expand(target, home));
    } else if (segmentStarts(tokens, dir, info, home)) {
      return true;
    }
  }
  return false;
}
