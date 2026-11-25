/**
 * The End it button's host side: which holder the status carries, which
 * request may end a pid, and what the headline says after. The PowerShell is
 * a fake: no test ends a process.
 */

import { describe, expect, test } from "bun:test";
import {
  type EndableHolder,
  endableHolder,
  endBlock,
  endCurrentHolder,
  endError,
  endedText,
  endHolder,
  endScript,
  mayEnd,
} from "../end-holder";
import type { EtwHolder } from "../etw-holders";
import type { PoolLeaks } from "../verdict";
import type { PoolGrowth } from "../windows-memory";

const HOLDER: EtwHolder = { name: "SystemSettings", pid: 4242, registrations: 639, since: 1 };
const NAMED: EndableHolder = { pid: 4242, name: "SystemSettings" };
const growth = (tag: string): PoolGrowth[] => [
  { tag, pool: "nonpaged", bytes: 1, live: 1, perMinute: 1000, meaning: "" },
];

describe("endableHolder (what api/status carries beside the headline)", () => {
  test("the holder when an event-tracing tag grows and one was picked", () => {
    expect(endableHolder({ growth: growth("Etwr"), holder: HOLDER })).toEqual(NAMED);
    expect(endableHolder({ growth: growth("EtwD"), holder: HOLDER })).toEqual(NAMED);
  });
  test("null when only another tag grows, none grows, or it is unknown", () => {
    expect(endableHolder({ growth: growth("Toke"), holder: HOLDER })).toBeNull();
    expect(endableHolder({ growth: [], holder: HOLDER })).toBeNull();
    expect(endableHolder({ growth: null, holder: HOLDER })).toBeNull();
    expect(endableHolder(null)).toBeNull();
  });
  test("null when none was picked", () => {
    expect(endableHolder({ growth: growth("Etwr"), holder: null })).toBeNull();
  });
});

describe("mayEnd (never a pid on a request's word)", () => {
  test("the current holder's pid and name pass", () => {
    expect(mayEnd({ pid: 4242, name: "SystemSettings" }, NAMED)).toEqual({
      ok: true,
      holder: NAMED,
    });
  });
  test("another pid is refused", () => {
    const answer = mayEnd({ pid: 4, name: "SystemSettings" }, NAMED);
    expect(answer.ok).toBe(false);
  });
  test("the same pid with another name is refused", () => {
    expect(mayEnd({ pid: 4242, name: "explorer" }, NAMED).ok).toBe(false);
  });
  test("nobody named now, or a request without a pid, is refused", () => {
    expect(mayEnd({ pid: 4242, name: "SystemSettings" }, null).ok).toBe(false);
    expect(mayEnd({ name: "SystemSettings" }, NAMED).ok).toBe(false);
    expect(mayEnd({ pid: "4242", name: "SystemSettings" }, NAMED).ok).toBe(false);
    expect(mayEnd(null, NAMED).ok).toBe(false);
  });
});

describe("the texts", () => {
  test("ended, in local time", () => {
    expect(endedText("SystemSettings", new Date(2026, 10, 25, 9, 5))).toBe(
      "SystemSettings was ended at 09:05 (local time); Windows frees its memory over the next minutes. Windows may start it again.",
    );
  });
  test("what the script said becomes an error, or none", () => {
    expect(endError("ended\r\n", NAMED)).toBeNull();
    expect(endError("gone", NAMED)).toBeNull();
    expect(endError("error:Access is denied", NAMED)).toBe(
      "Could not end SystemSettings: Access is denied",
    );
    expect(endError("other:chrome", NAMED)).toBe(
      "Pid 4242 is chrome now, not SystemSettings: not ended.",
    );
    expect(endError("", NAMED)).toContain("Could not end SystemSettings");
  });
  test("the script ends the pid, checks its name and waits for it to exit", () => {
    const script = endScript({ pid: 4242, name: "It's.exe" });
    expect(script).toContain("Stop-Process -Id 4242 -Force");
    expect(script).toContain("HasExited");
    expect(script).toContain("'It''s'");
  });
});

describe("endHolder", () => {
  const logged: [string, Record<string, string | number | boolean | null>][] = [];
  const log = (event: string, data: Record<string, string | number | boolean | null>) =>
    logged.push([event, data]);

  test("runs the script for the named holder and says when it ended", async () => {
    const scripts: string[] = [];
    const text = await endHolder(
      { pid: 4242, name: "SystemSettings" },
      NAMED,
      log,
      new Date(2026, 10, 25, 14, 30),
      async (script) => {
        scripts.push(script);
        return "ended";
      },
    );
    expect(text).toStartWith("SystemSettings was ended at 14:30");
    expect(scripts).toHaveLength(1);
    expect(logged.at(-1)?.[0]).toBe("end_holder");
  });
  test("runs nothing for a pid that is not the holder", async () => {
    let ran = false;
    const run = async () => {
      ran = true;
      return "ended";
    };
    await expect(
      endHolder({ pid: 4, name: "SystemSettings" }, NAMED, log, new Date(), run),
    ).rejects.toThrow("not the process named now");
    expect(ran).toBe(false);
    expect(logged.at(-1)?.[0]).toBe("end_holder_refused");
  });
  test("a failure rejects with why", async () => {
    await expect(
      endHolder({ pid: 4242, name: "SystemSettings" }, NAMED, log, new Date(), async () => {
        return "error:Access is denied";
      }),
    ).rejects.toThrow("Could not end SystemSettings: Access is denied");
    await expect(
      endHolder({ pid: 4242, name: "SystemSettings" }, NAMED, log, new Date(), async () => {
        throw new Error("PowerShell timed out");
      }),
    ).rejects.toThrow("PowerShell timed out");
  });
});

describe("the status block and the state after ending", () => {
  const stateOf = () => ({
    leaks: { growth: growth("Etwr"), holder: HOLDER } as PoolLeaks,
    etwHolderAt: 0,
    api: { log: () => {} },
  });

  test("the status carries the holder only while an event-tracing tag grows", () => {
    expect(endBlock(stateOf().leaks)).toEqual({ endHolder: NAMED, holderEnded: null });
    expect(endBlock({ growth: growth("Toke"), holder: HOLDER }).endHolder).toBeNull();
  });
  test("after ending, the holder is cleared, the sentence kept and the next read 5 minutes on", async () => {
    const current = stateOf();
    const before = Date.now();
    const { text } = await endCurrentHolder(
      current,
      { pid: 4242, name: "SystemSettings" },
      async () => "ended",
    );
    expect(current.leaks.holder).toBeNull();
    expect(endBlock(current.leaks)).toEqual({ endHolder: null, holderEnded: text });
    expect(current.etwHolderAt).toBeGreaterThanOrEqual(before);
  });
  test("a refused or failed ending leaves the holder named", async () => {
    const current = stateOf();
    await expect(
      endCurrentHolder(current, { pid: 1, name: "SystemSettings" }, async () => "ended"),
    ).rejects.toThrow();
    await expect(
      endCurrentHolder(
        current,
        { pid: 4242, name: "SystemSettings" },
        async () => "error:Access is denied",
      ),
    ).rejects.toThrow("Access is denied");
    expect(current.leaks.holder).toEqual(HOLDER);
    expect(current.etwHolderAt).toBe(0);
  });
});
