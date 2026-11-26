import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerInfo } from "../docker";
import { infoOf } from "../docker";
import { commandStarts } from "../docker-command";
import {
  callsOf,
  readTranscripts,
  type StartCall,
  Starters,
  starterOf,
  transcriptRoots,
  transcriptScan,
} from "../docker-starter";

const HOME = "/home/jimmy";
const S = "e72a42ff-15d0-43cc-8ab2-e21abf990caa";
const OTHER = "0b1c2d3e-0000-4000-8000-000000000001";
const CWD = "/home/jimmy/src/odi.worktrees/odi-298";
const sessions = [
  { id: S, title: "odi-298", cwd: CWD, state: "working" },
  { id: OTHER, title: "other", cwd: "/home/jimmy/src/odi", state: "idle" },
];

// The two containers of 2026-11-26, shaped as Docker's list and `docker inspect` gave them.
const elastic: ContainerInfo = infoOf({
  Id: "a".repeat(64),
  Names: ["/odi-elasticsearch-1"],
  Created: Date.parse("2026-11-26T14:39:28Z") / 1000,
  Labels: {
    "com.docker.compose.project": "odi",
    "com.docker.compose.service": "elasticsearch",
    "com.docker.compose.project.working_dir": "/home/jimmy/src/odi",
  },
  Mounts: [{ Source: "/var/lib/docker/volumes/odi_es/_data" }],
});
const livekit: ContainerInfo = infoOf({
  Id: "b".repeat(64),
  Names: ["/livekit-dev-videocall"],
  Created: "2026-11-26T14:36:15.512345678Z",
  Labels: null,
  Mounts: [],
});

const call = (time: string, command: string, session = S, cwd = CWD): StartCall => ({
  session,
  at: Date.parse(time),
  cwd,
  command,
});
const composeUp = call(
  "2026-11-26T14:39:20Z",
  "cd ~/src/odi && docker compose -f docker-compose.yml -f docker-compose.devel.yml up -d --no-deps elasticsearch 2>&1 | tail -3; sleep 5",
);
const dockerRun = call(
  "2026-11-26T14:36:15Z",
  "docker rm -f livekit-dev-videocall >/dev/null; docker run -d --name livekit-dev-videocall -p 7880:7880 -p 7882:7882/udp livekit/livekit-server:v1.13.11 --dev --bind 0.0.0.0 >/dev/null; sleep 5",
);

describe("Created", () => {
  test("is read from the API's seconds and from inspect's RFC 3339 string", () => {
    expect(elastic.created).toBe(Date.parse("2026-11-26T14:39:28Z"));
    expect(livekit.created).toBe(Date.parse("2026-11-26T14:36:15.512Z"));
    expect(elastic.project).toBe("odi");
    expect(elastic.workingDir).toBe("/home/jimmy/src/odi");
  });
});

describe("who started a container, from the transcripts", () => {
  test("both of today's containers go to the session that ran their commands", () => {
    const calls = [composeUp, dockerRun];
    expect(starterOf(elastic, calls, HOME)).toBe(S);
    expect(starterOf(livekit, calls, HOME)).toBe(S);
  });

  test("a command that only removes the container started nothing", () => {
    const rm = call("2026-11-26T14:36:10Z", "docker rm -f livekit-dev-videocall");
    expect(starterOf(livekit, [rm], HOME)).toBe("");
  });

  test("a call outside the window starts nothing: too early, or after", () => {
    const early = { ...dockerRun, at: Date.parse("2026-11-26T14:33:00Z") };
    const late = { ...dockerRun, at: Date.parse("2026-11-26T14:37:00Z") };
    expect(starterOf(livekit, [early, late], HOME)).toBe("");
  });

  test("of two sessions that match, the later call wins", () => {
    const later = { ...dockerRun, session: OTHER, at: dockerRun.at + 3_000 };
    expect(starterOf(livekit, [dockerRun, later], HOME)).toBe(OTHER);
  });

  test("two sessions at the same instant: no one", () => {
    expect(starterOf(livekit, [dockerRun, { ...dockerRun, session: OTHER }], HOME)).toBe("");
  });

  test("a container with no Created time has no starter", () => {
    const { created: _, ...bare } = livekit;
    expect(starterOf(bare, [dockerRun], HOME)).toBe("");
  });
});

describe("what starts a container", () => {
  const up = (command: string, cwd = "/home/jimmy/src/odi") =>
    commandStarts(command, cwd, elastic, HOME);

  test("docker run with --name=<name> and with --name <name>", () => {
    expect(commandStarts("docker run -d --name=livekit-dev-videocall x", CWD, livekit, HOME)).toBe(
      true,
    );
    expect(commandStarts("docker run -d --name livekit-dev-videocall x", CWD, livekit, HOME)).toBe(
      true,
    );
    expect(commandStarts("docker run -d --name other x", CWD, livekit, HOME)).toBe(false);
  });

  test("compose naming the service, from the project folder", () => {
    expect(up("docker compose up -d elasticsearch")).toBe(true);
    expect(up("docker-compose up -d elasticsearch")).toBe(true);
    expect(up("docker compose up -d redis")).toBe(false);
  });

  test("compose naming the service in another folder is another project's", () => {
    expect(up("docker compose up -d elasticsearch", "/home/jimmy/src/other")).toBe(false);
  });

  test("compose with no service starts the whole project", () => {
    expect(up("docker compose up -d")).toBe(true);
    expect(up("docker compose up -d", "/home/jimmy/src/other")).toBe(false);
  });

  test("the project's folder from cd, -f or --project-directory, and its name from -p", () => {
    const here = "/home/jimmy/src/other";
    expect(up("cd /home/jimmy/src/odi && docker compose up -d", here)).toBe(true);
    expect(up("docker compose -f ~/src/odi/docker-compose.yml up -d", here)).toBe(true);
    expect(up("docker compose --project-directory=/home/jimmy/src/odi up", here)).toBe(true);
    expect(up("docker compose -p odi up -d", here)).toBe(true);
  });

  test("compose commands that start nothing", () => {
    expect(up("docker compose down")).toBe(false);
    expect(up("docker compose logs elasticsearch")).toBe(false);
    expect(up("docker compose exec elasticsearch curl x")).toBe(false);
  });

  test("a flag's value is no service", () => {
    expect(up("docker compose up -d --scale redis=2 elasticsearch")).toBe(true);
    expect(up("docker compose up -d --pull always redis")).toBe(false);
  });
});

describe("transcript lines", () => {
  const line = (extra: object) =>
    JSON.stringify({
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "docker run --name x y" } }],
      },
      timestamp: "2026-11-26T14:36:15.045Z",
      sessionId: S,
      cwd: CWD,
      ...extra,
    });

  test("a Bash tool_use becomes a call with its time, session and cwd", () => {
    expect(callsOf(line({}))).toEqual([
      {
        session: S,
        at: Date.parse("2026-11-26T14:36:15.045Z"),
        cwd: CWD,
        command: "docker run --name x y",
      },
    ]);
  });

  test("a cut line, a line without docker and other tools are skipped", () => {
    const other = JSON.stringify({
      message: { content: [{ type: "tool_use", name: "Read", input: { command: "docker" } }] },
      timestamp: "2026-11-26T14:36:15Z",
      sessionId: S,
    });
    expect(callsOf(`${line({}).slice(20)}\n${other}\nnot json docker "tool_use"\n`)).toEqual([]);
  });
});

describe("reading the transcripts", () => {
  function fixture(): { home: string; since: number } {
    const home = mkdtempSync(join(tmpdir(), "starter-"));
    const folder = join(home, ".claude/projects/-home-jimmy-src-odi-worktrees-odi-298");
    mkdirSync(join(folder, S, "subagents"), { recursive: true });
    const old = call("2026-11-26T10:00:00Z", "docker run --name old x");
    const text = (c: StartCall) =>
      `${JSON.stringify({
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: c.command } }] },
        timestamp: new Date(c.at).toISOString(),
        sessionId: c.session,
        cwd: c.cwd,
      })}\n`;
    writeFileSync(join(folder, `${S}.jsonl`), text(old) + text(dockerRun));
    writeFileSync(join(folder, S, "subagents", "agent-1.jsonl"), text(composeUp));
    // An account's projects folder is a link to the same one.
    mkdirSync(join(home, ".local/share/prifly/accounts/abc"), { recursive: true });
    symlinkSync(
      join(home, ".claude/projects"),
      join(home, ".local/share/prifly/accounts/abc/projects"),
    );
    const since = Date.parse("2026-11-26T14:00:00Z");
    for (const file of [`${S}.jsonl`, join(S, "subagents", "agent-1.jsonl")]) {
      utimesSync(join(folder, file), since / 1000 + 3600, since / 1000 + 3600);
    }
    return { home, since };
  }

  test("each transcript and its subagents' are read once, though accounts link to one folder", () => {
    const { home, since } = fixture();
    const roots = transcriptRoots(home, "");
    expect(roots).toHaveLength(1);
    const calls = callsOf(readTranscripts(sessions, since, roots));
    // The old call, the run and the subagent's compose call: three, not one per account's link.
    expect(calls).toHaveLength(3);
    expect(starterOf(elastic, calls, HOME)).toBe(S);
    expect(starterOf(livekit, calls, HOME)).toBe(S);
  });

  test("the shell line a Windows host sends into WSL finds the same calls", () => {
    const { home, since } = fixture();
    const out = execFileSync("sh", ["-c", transcriptScan(sessions, since)], {
      env: { ...process.env, HOME: home },
    }).toString();
    const calls = callsOf(out);
    expect(starterOf(elastic, calls, HOME)).toBe(S);
    expect(starterOf(livekit, calls, HOME)).toBe(S);
    expect(calls.filter((c) => c.command.includes("elasticsearch"))).toHaveLength(1);
  });

  test("a session id that is no uuid is never put in the shell line", () => {
    const bad = [{ id: "x'; rm -rf ~; '", title: "", cwd: "/", state: "idle" }];
    expect(transcriptScan(bad, 0)).toBe("true");
  });
});

describe("Starters", () => {
  const infos = new Map([
    [elastic.name, elastic],
    ["x", livekit],
  ]);

  test("reads once for the undecided containers, and never again once decided, none included", async () => {
    let reads = 0;
    const starters = new Starters(
      async () => {
        reads++;
        return `${JSON.stringify({
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: dockerRun.command } }],
          },
          timestamp: new Date(dockerRun.at).toISOString(),
          sessionId: S,
          cwd: CWD,
        })}\n`;
      },
      () => {},
      HOME,
    );
    starters.refresh(infos, sessions, () => false, Date.now());
    await Bun.sleep(10);
    expect(starters.get("x")).toBe(S);
    expect(starters.get(elastic.name)).toBe("");
    starters.refresh(infos, sessions, () => false, Date.now());
    await Bun.sleep(10);
    expect(reads).toBe(1);
  });

  test("a container the paths already name is not looked up, and a failed read is retried later", async () => {
    let reads = 0;
    const errors: string[] = [];
    const starters = new Starters(
      async () => {
        reads++;
        throw new Error("boom");
      },
      (error) => errors.push(error),
      HOME,
    );
    starters.refresh(infos, sessions, () => true, 0);
    expect(reads).toBe(0);
    starters.refresh(infos, sessions, () => false, 0);
    await Bun.sleep(10);
    starters.refresh(infos, sessions, () => false, 1_000);
    expect(reads).toBe(1);
    expect(errors[0]).toContain("boom");
    starters.refresh(infos, sessions, () => false, 61_000);
    expect(reads).toBe(2);
  });
});
