import { describe, expect, test } from "bun:test";
import { headline, memoryReasons, windowsMemoryChecks, windowsVerdicts } from "../verdict";
import { COUNTERS, parseRow, type WindowsCounters } from "../windows";
import { compressionGrowth, parsePoolTags } from "../windows-memory";

const GB = 2 ** 30;
const MB = 2 ** 20;
const info = { name: "W", cores: 16, memTotal: 47 * GB };

/** A calm Windows: 70 % committed, little trimming, pools of a usual size. */
const calm = {
  at: 0,
  busy: 30,
  user: 20,
  privileged: 10,
  queue: 0,
  availableMB: 20_000,
  committed: 70,
  committedBytes: 35 * GB,
  commitLimit: 50 * GB,
  poolPaged: 0.6 * GB,
  poolNonpaged: 0.3 * GB,
  pagesOut: 0,
  transitionFaults: 2000,
  demandZeroFaults: 3000,
  pageFile: 5,
  diskIdle: 99,
  readLatency: 0.002,
  writeLatency: 0.001,
  diskQueue: 0,
  diskRead: 0,
  diskWrite: 0,
  machine: 32,
  wslVmMem: null,
  wslVm: 100,
  standbyCore: null,
  standbyNormal: null,
  standbyReserve: null,
  modified: null,
  free: null,
  poolPagedResident: null,
  cacheResident: null,
} satisfies WindowsCounters;

function judge(c: WindowsCounters) {
  const verdicts = windowsVerdicts(c, info);
  const checks = windowsMemoryChecks(c, info);
  const why = memoryReasons(checks).map((check) => check.text);
  return {
    verdicts,
    checks,
    why,
    headline: headline([{ name: "Windows", verdicts, memoryReasons: why }]),
  };
}

// The peak on 2026-10-29: 96 % of commit, 150k transition faults a second,
// the paged pool at 4.7 GB from a token leak, 6 GB of 47 GB available.
const peak = {
  ...calm,
  availableMB: 6000,
  committed: 96,
  committedBytes: 68 * GB,
  commitLimit: 71 * GB,
  transitionFaults: 150_000,
  demandZeroFaults: 98_000,
  poolPaged: 4.7 * GB,
  poolNonpaged: 0.5 * GB,
};

describe("Windows memory, with its reasons named", () => {
  test("the overloaded peak is out of memory, and the headline names all three reasons", () => {
    const { verdicts, why, headline: h } = judge(peak);
    expect(verdicts.memory).toBe("critical");
    expect(why).toEqual([
      "Windows is trimming 150k pages a second",
      "96 % of commit used",
      "kernel paged pool 4.7 GB, over 2 GB: a driver or service is leaking",
    ]);
    expect(h).toEqual({
      tone: "critical",
      text:
        "Out of memory in Windows: Windows is trimming 150k pages a second, 96 % of commit used, " +
        "kernel paged pool 4.7 GB, over 2 GB: a driver or service is leaking.",
    });
  });

  test("88 % committed, 7 GB available and little trimming is fine, with no reasons", () => {
    const now = { ...calm, committed: 88, availableMB: 7 * 1024, transitionFaults: 4000 };
    const { verdicts, checks, why, headline: h } = judge(now);
    expect(verdicts.memory).toBe("good");
    expect(why).toEqual([]);
    expect(h.text).toBe("Nothing is short: CPU, memory and disk are fine.");
    // Green, the row still says what it judged by.
    expect(checks.map((check) => check.text)).toEqual([
      "88 % of commit used",
      "Windows is trimming 4k pages a second",
      "nothing written to the page file",
      "7.0 GB available",
      "paged pool 0.6 GB",
      "non-paged pool 0.3 GB",
    ]);
  });

  test("commit alone is short, and named", () => {
    const { verdicts, headline: h } = judge({ ...calm, committed: 93 });
    expect(verdicts.memory).toBe("warning");
    expect(h.text).toBe("Short of memory in Windows: 93 % of commit used.");
  });

  test("a pool over 2 GB alone is short, with why", () => {
    const { verdicts, headline: h } = judge({ ...calm, poolNonpaged: 2.5 * GB });
    expect(verdicts.memory).toBe("warning");
    expect(h.text).toBe(
      "Short of memory in Windows: kernel non-paged pool 2.5 GB, over 2 GB: a driver or service is leaking.",
    );
  });

  test("trimming turns orange at 30,000 a second, below the overload's mildest minute", () => {
    expect(judge({ ...calm, transitionFaults: 29_000 }).verdicts.memory).toBe("good");
    // 55k was the recording's 5th percentile, 89k its 25th.
    expect(judge({ ...calm, transitionFaults: 55_000 }).verdicts.memory).toBe("warning");
    expect(judge({ ...calm, transitionFaults: 89_000 }).verdicts.memory).toBe("critical");
  });

  test("missing counters are no checks, never a 0", () => {
    const none = {
      ...calm,
      availableMB: null,
      committed: null,
      pagesOut: null,
      transitionFaults: null,
      poolPaged: null,
      poolNonpaged: null,
    };
    const { verdicts, checks, headline: h } = judge(none);
    expect(checks).toEqual([]);
    expect(verdicts.memory).toBe("good");
    expect(h.tone).toBe("good");
  });

  test("other resources keep their plain sentence beside the reasons", () => {
    const { headline: h } = judge({ ...peak, poolPaged: 0.5 * GB, queue: 40 });
    expect(h.text).toBe(
      "Out of CPU and memory in Windows: Windows is trimming 150k pages a second, 96 % of commit used.",
    );
  });
});

test("commit bytes, its limit and the pools are read by their own columns, garbage as null", () => {
  const paths = Object.values(COUNTERS);
  const header = `"(PDH-CSV 4.0)",${paths.map((p) => `"\\\\JIMMY-ROG${p}"`).join(",")}`;
  const given: Record<string, string> = {
    [COUNTERS.committed]: "96.2",
    [COUNTERS.committedBytes]: "73014444032",
    [COUNTERS.commitLimit]: "76235669504",
    [COUNTERS.poolPaged]: "5046586572",
    [COUNTERS.poolNonpaged]: "-1",
  };
  const values = paths.map((p) => `"${given[p] ?? "7"}"`);
  const row = parseRow(header, `"10/01/2026 11:01:33.105",${values.join(",")}`, 0);
  expect(row?.committed).toBe(96.2);
  expect(row?.committedBytes).toBe(73014444032);
  expect(row?.commitLimit).toBe(76235669504);
  expect(row?.poolPaged).toBe(5046586572);
  expect(row?.poolNonpaged).toBeNull();
});

describe("kernel pool tags", () => {
  // `poolTags`' output as the C# printed it on the reader's laptop,
  // 2026-10-29 19:30 (abridged; `Vad ` padded as Windows pads it).
  const out = [
    "T|ObSc|45566650|45563993|1266496|0|0|0",
    "T|Toke|9842136|9126895|1556086784|0|0|0",
    "T|FMfn|20117440|17860585|1162870784|0|0|0",
    "T|Ntff|19842401|19580363|368949504|73|58|5760",
    "T|EtwD|1578028|243218|320201920|0|0|0",
    "T|MmSt|33321458|32965646|280750480|0|0|0",
    "T|FMsl|0|0|0|3000000|2588817|190840832",
    "T|File|5000000|4900000|31457280|2000|1000|1048576",
    "T|Vad |0|0|0|3000000|2900000|52428800",
    "",
  ].join("\r\n");

  test("listed biggest first, each pool its own entry, with what the known ones are", () => {
    expect(parsePoolTags(out, 3)).toEqual([
      {
        tag: "Toke",
        pool: "paged",
        bytes: 1556086784,
        live: 715241,
        meaning: "security tokens; a leak when huge",
      },
      {
        tag: "FMfn",
        pool: "paged",
        bytes: 1162870784,
        live: 2256855,
        meaning: "file names cached by file-system filters (antivirus and the like)",
      },
      { tag: "Ntff", pool: "paged", bytes: 368949504, live: 262038, meaning: "NTFS file records" },
    ]);
    const all = parsePoolTags(out, 20) ?? [];
    expect(all.find((t) => t.tag === "FMsl")).toEqual({
      tag: "FMsl",
      pool: "nonpaged",
      bytes: 190840832,
      live: 411183,
      meaning: "",
    });
    // One in both pools is two entries; padding is trimmed.
    expect(all.filter((t) => t.tag === "File").map((t) => t.pool)).toEqual(["paged", "nonpaged"]);
    expect(all.find((t) => t.tag === "Vad")?.live).toBe(100_000);
  });

  test("live allocations survive the 32-bit counters wrapping", () => {
    expect(parsePoolTags("T|Toke|5|4294967290|1000|0|0|0\n")?.[0]?.live).toBe(11);
  });

  test("an output with no pool tag in it is a failed read, not an empty list", () => {
    expect(parsePoolTags("")).toBeNull();
    expect(parsePoolTags("Add-Type: cannot compile\r\n")).toBeNull();
    expect(parsePoolTags("T|Toke|x|1|2|3|4|5\n")).toBeNull();
  });
});

test("the compression store's growth is per minute, over the last minute", () => {
  const reads = [0, 10, 20, 30, 40, 50, 60, 70].map((s) => ({
    at: s * 1000,
    bytes: 1000 * MB + s * 2 * MB,
  }));
  // The minute from 10 s to 70 s: +120 MB.
  expect(compressionGrowth(reads)).toBeCloseTo(120 * MB);
  expect(compressionGrowth(reads.slice(0, 2))).toBeNull();
  expect(compressionGrowth([])).toBeNull();
});
