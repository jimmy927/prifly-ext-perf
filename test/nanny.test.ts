import { describe, expect, test } from "bun:test";
import {
  COOLDOWN,
  decide,
  GREEN_FOR,
  type NannyInput,
  type NannyMemory,
  type NannySession,
  NOTICE_AFTER,
  newNannyMemory,
} from "../nanny";
import type { Tone } from "../verdict";

const T0 = 1_000_000;
const GB = 2 ** 30;

function session(id: string, over: Partial<NannySession> = {}): NannySession {
  return {
    id,
    title: id,
    state: "working",
    cores: 0.1,
    rss: 0.1 * GB,
    doing: "bun test",
    pid: 4242,
    ...over,
  };
}

function input(
  verdicts: { cpu?: Tone; memory?: Tone },
  sessions: NannySession[],
  over: Partial<NannyInput> = {},
): NannyInput {
  return {
    verdicts: { cpu: "good", memory: "good", disk: "good", ...verdicts },
    psi: { cpu: 62, memory: 31 },
    cores: 16,
    memTotal: 32 * GB,
    sessions,
    unowned: 0,
    ...over,
  };
}

/** Calls `decide` once a second from `from` to `to` seconds, with the same input; returns the last and what was sent. */
function run(memory: NannyMemory, given: NannyInput, from: number, to: number) {
  let last = decide(memory, given, T0 + from * 1000);
  const notices = [...last.notices];
  const notifies = last.notify === null ? [] : [last.notify];
  for (let second = from + 1; second <= to; second += 1) {
    last = decide(last.memory, given, T0 + second * 1000);
    notices.push(...last.notices);
    if (last.notify !== null) notifies.push(last.notify);
  }
  return { last, notices, notifies };
}

const heavy = session("aaaaaaaa", { cores: 6.4, doing: "bun test --parallel", pid: 1538273 });

describe("notices", () => {
  const red = input({ cpu: "critical" }, [heavy]);

  test("red for 29 s is no notice, 30 s is", () => {
    const early = run(newNannyMemory(), red, 0, NOTICE_AFTER / 1000 - 1);
    expect(early.notices).toEqual([]);
    const later = run(early.last.memory, red, NOTICE_AFTER / 1000, NOTICE_AFTER / 1000);
    expect(later.notices).toHaveLength(1);
  });

  test("the text names the load, the program and what to do", () => {
    const { notices } = run(newNannyMemory(), red, 0, 45);
    expect(notices).toEqual([
      {
        session: "aaaaaaaa",
        text:
          "prifly's Performance extension: WSL has been out of CPU for 30 s (PSI cpu some 62 %). " +
          "This session's tools use 6.4 of 16 cores: `bun test --parallel` (pid 1538273). " +
          "Please let it finish without starting more heavy work. If it is a benchmark, a long build " +
          "or a training run, stop it and offer the reader a rented machine (`mcp__prifly__machines`). " +
          "Reply briefly; no need to ask the reader about this notice.",
      },
    ]);
  });

  test("a break in the red starts the 30 s again", () => {
    const first = run(newNannyMemory(), red, 0, 20);
    const broken = decide(first.last.memory, input({ cpu: "warning" }, [heavy]), T0 + 21_000);
    const again = run(broken.memory, red, 22, 22 + 28);
    expect(again.notices).toEqual([]);
    expect(run(again.last.memory, red, 51, 52).notices).toHaveLength(1);
  });

  test("a session that is idle, ended or waiting is never messaged", () => {
    for (const state of ["idle", "ended", "waiting"]) {
      const given = input({ cpu: "critical" }, [{ ...heavy, state }]);
      expect(run(newNannyMemory(), given, 0, 120).notices).toEqual([]);
    }
  });

  test("only the heaviest session is told, and not the next when it is idle", () => {
    const second = session("bbbbbbbb", { cores: 3 });
    const busy = input({ cpu: "critical" }, [second, heavy]);
    expect(run(newNannyMemory(), busy, 0, 40).notices.map((n) => n.session)).toEqual(["aaaaaaaa"]);
    const idle = input({ cpu: "critical" }, [second, { ...heavy, state: "idle" }]);
    expect(run(newNannyMemory(), idle, 0, 40).notices).toEqual([]);
  });

  test("a session is told at most once in 10 min", () => {
    const first = run(newNannyMemory(), red, 0, 30);
    expect(first.notices).toHaveLength(1);
    const during = run(first.last.memory, red, 31, COOLDOWN / 1000 + 29);
    expect(during.notices).toEqual([]);
    const after = run(during.last.memory, red, COOLDOWN / 1000 + 30, COOLDOWN / 1000 + 30);
    expect(after.notices).toHaveLength(1);
  });

  test("a session using under a core is not blamed", () => {
    const light = input({ cpu: "critical" }, [session("aaaaaaaa", { cores: 0.9 })]);
    expect(run(newNannyMemory(), light, 0, 60).notices).toEqual([]);
  });

  test("memory has its own wording and figure, and blames the session holding most of it", () => {
    const hog = session("bbbbbbbb", { cores: 0.2, rss: 12.3 * GB, doing: "vitest", pid: 77 });
    const given = input({ memory: "critical" }, [heavy, hog]);
    const { notices } = run(newNannyMemory(), given, 0, 30);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.session).toBe("bbbbbbbb");
    expect(notices[0]?.text).toContain(
      "WSL has been out of memory for 30 s (PSI memory full 31 %)",
    );
    expect(notices[0]?.text).toContain("use 12.3 of 32.0 GB: `vitest` (pid 77)");
  });
});

describe("chips", () => {
  test("none while everything is green", () => {
    const { last } = run(newNannyMemory(), input({}, [heavy]), 0, 10);
    expect(last.chips).toEqual({});
  });

  test("a session using cores gets one in the verdict's tone", () => {
    const warm = decide(newNannyMemory(), input({ cpu: "warning" }, [heavy]), T0);
    expect(warm.chips["aaaaaaaa"]).toEqual([
      expect.objectContaining({
        key: "nanny",
        icon: "activity",
        tone: "warning",
        panel: "perf",
        label: "Using 6.4 of 16 cores: bun test --parallel",
        details: [
          expect.stringContaining("short of CPU"),
          "Busiest program: bun test --parallel (pid 1538273)",
          "Not told by the nanny yet.",
        ],
      }),
    ]);
    const hot = decide(newNannyMemory(), input({ cpu: "critical" }, [heavy]), T0);
    expect(hot.chips["aaaaaaaa"]?.[0]?.tone).toBe("critical");
  });

  test("the details say when the session was last told", () => {
    const hot = input({ cpu: "critical" }, [heavy]);
    const { last } = run(newNannyMemory(), hot, 0, 90);
    expect(last.chips["aaaaaaaa"]?.[0]?.details.at(-1)).toBe("Told by the nanny 60 s ago.");
  });

  test("only the top 3 are chipped, heaviest first", () => {
    const five = [2, 5, 3, 1.5, 4].map((cores, i) => session(`s${i}`, { cores }));
    const { chips } = decide(newNannyMemory(), input({ cpu: "warning" }, five), T0);
    expect(Object.keys(chips).sort()).toEqual(["s1", "s2", "s4"]);
  });

  test("a session under 1 core, or under 10 % of the RAM, is not chipped", () => {
    const light = session("light", { cores: 0.99, rss: 0.09 * 32 * GB });
    const cpu = decide(newNannyMemory(), input({ cpu: "warning" }, [light]), T0);
    expect(cpu.chips).toEqual({});
    const memory = decide(newNannyMemory(), input({ memory: "warning" }, [light]), T0);
    expect(memory.chips).toEqual({});
    const exact = session("exact", { cores: 1 });
    expect(
      Object.keys(decide(newNannyMemory(), input({ cpu: "warning" }, [exact]), T0).chips),
    ).toEqual(["exact"]);
  });

  test("memory chips go by RAM held, not cores", () => {
    const hog = session("hog", { cores: 0, rss: 4 * GB, doing: "vitest" });
    const { chips } = decide(newNannyMemory(), input({ memory: "critical" }, [heavy, hog]), T0);
    expect(Object.keys(chips)).toEqual(["hog"]);
    expect(chips["hog"]?.[0]?.label).toBe("Using 4.0 of 32.0 GB: vitest");
  });

  test("they stay through 59 s of green and go at 60 s", () => {
    const hot = decide(newNannyMemory(), input({ cpu: "critical" }, [heavy]), T0);
    const green = input({}, [heavy]);
    const held = run(hot.memory, green, 1, 1 + GREEN_FOR / 1000 - 1);
    expect(Object.keys(held.last.chips)).toEqual(["aaaaaaaa"]);
    const gone = decide(held.last.memory, green, T0 + 1000 + GREEN_FOR);
    expect(gone.chips).toEqual({});
  });

  test("a flicker back to orange restarts the 60 s", () => {
    const hot = decide(newNannyMemory(), input({ cpu: "critical" }, [heavy]), T0);
    const green = input({}, [heavy]);
    const some = run(hot.memory, green, 1, 50);
    const back = decide(some.last.memory, input({ cpu: "warning" }, [heavy]), T0 + 51_000);
    // Green again from second 52: 59 s later the chip is still there, 60 s later it is gone.
    const again = run(back.memory, green, 52, 52 + 59);
    expect(Object.keys(again.last.chips)).toEqual(["aaaaaaaa"]);
    expect(decide(again.last.memory, green, T0 + 52_000 + 60_000).chips).toEqual({});
  });
});

describe("telling the reader", () => {
  test("after 3 min red, linked to the top session, and then not again for 10 min", () => {
    const red = input({ cpu: "critical" }, [heavy]);
    const early = run(newNannyMemory(), red, 0, 179);
    expect(early.notifies).toEqual([]);
    const at = run(early.last.memory, red, 180, 180);
    expect(at.notifies).toHaveLength(1);
    expect(at.notifies[0]?.session).toBe("aaaaaaaa");
    expect(at.notifies[0]?.text).toContain("out of CPU for 3 min");
    const during = run(at.last.memory, red, 181, 180 + COOLDOWN / 1000 - 1);
    expect(during.notifies).toEqual([]);
    expect(
      run(during.last.memory, red, 180 + COOLDOWN / 1000, 180 + COOLDOWN / 1000).notifies,
    ).toHaveLength(1);
  });

  test("load nobody owns tells the reader after 3 min, and no session", () => {
    const given = input({ cpu: "critical" }, [session("aaaaaaaa", { cores: 2 })], { unowned: 9.1 });
    const early = run(newNannyMemory(), given, 0, 179);
    expect(early.notices).toEqual([]);
    expect(early.notifies).toEqual([]);
    const { notifies } = run(early.last.memory, given, 180, 180);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]?.session).toBeUndefined();
    expect(notifies[0]?.text).toBe(
      "WSL has been busy for 3 min. 9.1 of 16 cores are used outside prifly, by Docker, " +
        "Windows-side tools or something started by hand. Sessions may feel slower.",
    );
  });

  test("unowned load below the top session's does not count", () => {
    const given = input({ cpu: "critical" }, [heavy], { unowned: 2 });
    const { notices, notifies } = run(newNannyMemory(), given, 0, 30);
    expect(notices).toHaveLength(1);
    expect(notifies).toEqual([]);
  });

  test("memory red for 3 min tells the reader too", () => {
    const hog = session("hog", { rss: 12 * GB });
    const { notifies } = run(newNannyMemory(), input({ memory: "critical" }, [hog]), 0, 180);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]?.text).toContain("out of memory");
    expect(notifies[0]?.session).toBe("hog");
  });

  test("orange alone says nothing to the reader or a session", () => {
    const { notices, notifies } = run(newNannyMemory(), input({ cpu: "warning" }, [heavy]), 0, 600);
    expect(notices).toEqual([]);
    expect(notifies).toEqual([]);
  });
});
