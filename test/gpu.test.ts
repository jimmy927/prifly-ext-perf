import { describe, expect, test } from "bun:test";
import {
  GREY_NEEDS_MIB,
  greyState,
  HOLDERS_FRESH_MS,
  parseGpuProcesses,
  parseNvidiaSmi,
  pickLuid,
  readHolders,
  rowsOf,
  shareOut,
  vmRows,
} from "../gpu";
import { type Tone, withGreyWords } from "../verdict";
import { GPU_ADAPTER, parseGpuAdapters } from "../windows";

const NVIDIA = "0x00000000_0x00013915";
const INTEL = "0x00000000_0x000128c5";

describe("nvidia-smi", () => {
  test("a row gives name, total and free", () => {
    expect(parseNvidiaSmi("NVIDIA GeForce RTX 3080 Laptop GPU, 8192, 2305\n")).toEqual({
      name: "GeForce RTX 3080 Laptop GPU",
      total: 8192,
      free: 2305,
    });
  });

  test("nothing, or text that is not a row, is no card", () => {
    expect(parseNvidiaSmi("")).toBeNull();
    expect(parseNvidiaSmi("No devices were found")).toBeNull();
  });
});

describe("GPU adapter counters", () => {
  const header = `"(PDH-CSV 4.0)","\\\\PC\\GPU Adapter Memory(luid_0x00000000_0x000128C5_phys_0)\\Dedicated Usage","\\\\PC\\GPU Adapter Memory(luid_0x00000000_0x00013915_phys_0)\\Dedicated Usage","\\\\PC\\Memory\\Available MBytes"`;
  const line = `"10/08/2026 12:27:03.386","480038912.000000","5992935424.000000","9000"`;

  test("each adapter's usage in MiB by luid", () => {
    const adapters = parseGpuAdapters(header, line);
    expect(adapters?.get(INTEL)).toBeCloseTo(457.8, 1);
    expect(adapters?.get(NVIDIA)).toBeCloseTo(5715.3, 1);
    expect(adapters?.size).toBe(2);
  });

  test("the adapter whose usage is closest to nvidia-smi's used is the card", () => {
    const adapters = parseGpuAdapters(header, line);
    if (adapters === null) throw new Error("no adapters");
    expect(pickLuid(adapters, 8192 - 2305)).toBe(NVIDIA);
    expect(pickLuid(adapters, 300)).toBe(INTEL);
    expect(pickLuid(new Map(), 100)).toBeNull();
  });

  test("a line without the counters has no adapters", () => {
    expect(
      parseGpuAdapters(
        '"(PDH-CSV 4.0)","\\\\PC\\Memory\\Available MBytes"',
        '"10/08/2026 12:27:03.386","9"',
      ),
    ).toBeNull();
    expect(GPU_ADAPTER).toContain("Dedicated Usage");
  });
});

describe("GPU process counters", () => {
  const out = [
    `G|pid_13644_luid_${NVIDIA}_phys_0|${300 * 2 ** 20}`,
    `G|pid_13644_luid_0x00000000_0x00013915_phys_0#2|${500 * 2 ** 20}`,
    `G|pid_13644_luid_0x00000000_0x000128c5_phys_0|${40 * 2 ** 20}`,
    `G|pid_7_luid_0x00000000_0x00013915_phys_0|${100 * 2 ** 20}`,
    "G|not_an_instance|5",
    "P|13644|Chrome",
    "P|7|vmwp",
    "",
  ].join("\r\n");

  test("a pid listed twice on one adapter counts its largest, not the sum", () => {
    const { uses } = parseGpuProcesses(out);
    const mine = uses.filter((u) => u.luid === NVIDIA && u.pid === 13644);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.mib).toBe(500);
  });

  test("another adapter's instances stay under their own luid, and names are resolved", () => {
    const { uses, names } = parseGpuProcesses(out);
    expect(uses.filter((u) => u.luid === INTEL).map((u) => u.pid)).toEqual([13644]);
    expect(uses).toHaveLength(3);
    expect(names.get(13644)).toBe("chrome");
    expect(names.get(7)).toBe("vmwp");
  });

  test("a process counts at most what it has committed", () => {
    // 2026-10-09: NVIDIA Overlay said 34,929 MB dedicated on the 8 GB card, 86 MB committed.
    const { uses } = parseGpuProcesses(
      [
        `G|pid_38264_luid_${NVIDIA}_phys_0|${34929 * 2 ** 20}`,
        `C|pid_38264_luid_${NVIDIA}_phys_0|${86 * 2 ** 20}`,
        `G|pid_7_luid_${NVIDIA}_phys_0|${3820 * 2 ** 20}`,
        `C|pid_7_luid_${NVIDIA}_phys_0|${3890 * 2 ** 20}`,
        `G|pid_9_luid_${NVIDIA}_phys_0|${200 * 2 ** 20}`,
      ].join("\n"),
    );
    const mib = (pid: number) => uses.find((u) => u.pid === pid)?.mib;
    expect(mib(38264)).toBe(86);
    expect(mib(7)).toBe(3820);
    // No committed figure: the dedicated one stands.
    expect(mib(9)).toBe(200);
    expect(uses).toHaveLength(3);
  });
});

describe("sharing the card out", () => {
  const names = new Map([
    [1, "dwm"],
    [2, "chrome"],
    [3, "chrome"],
    [4, "vmwp"],
  ]);
  const use = (pid: number, mib: number) => ({ pid, luid: NVIDIA, mib });
  const total = (s: ReturnType<typeof shareOut>) =>
    s.vm + s.other + s.named.reduce((a, b) => a + b.mib, 0);

  test("Windows figures that overlap are scaled into what the VM leaves; the VM is not", () => {
    const shares = shareOut([use(1, 1000), use(2, 1500), use(3, 1500), use(4, 4000)], names, 6000);
    expect(total(shares)).toBeCloseTo(6000, 6);
    expect(shares.other).toBeCloseTo(0, 6);
    expect(shares.vm).toBe(4000);
    // Two chrome processes are one program.
    expect(shares.named.map((s) => s.name)).toEqual(["chrome", "dwm"]);
    expect(shares.named[0]?.mib).toBeCloseTo(1500, 6);
    expect(shares.named[1]?.mib).toBeCloseTo(500, 6);
  });

  test("the VM never passes what is used, and then Windows gets nothing", () => {
    const shares = shareOut([use(1, 500), use(4, 5000)], names, 4000);
    expect(shares.vm).toBe(4000);
    expect(shares.named).toEqual([]);
    expect(total(shares)).toBeCloseTo(4000, 6);
  });

  test("what no counter owns is Windows other", () => {
    const shares = shareOut([use(1, 500), use(4, 3000)], names, 4000);
    expect(shares.other).toBeCloseTo(500, 6);
    expect(shares.vm).toBe(3000);
    expect(total(shares)).toBeCloseTo(4000, 6);
  });

  test("the rows put prifly and WSL first and are as many MiB as used", () => {
    const shares = shareOut([use(1, 500), use(4, 3000)], names, 4000);
    const rows = rowsOf(shares, null);
    expect(rows.map((r) => `${r.where}/${r.name}`)).toEqual([
      "WSL/prifly (WSL)",
      "Windows/Desktop compositor (dwm)",
      "Windows/Windows other",
    ]);
    expect(rows.reduce((a, r) => a + r.mib, 0)).toBeCloseTo(4000, 6);
  });
});

describe("plain names for Windows holders", () => {
  const share = (name: string) => ({ named: [{ name, mib: 500 }], vm: 0, other: 0 });

  test("a known process gets a plain name and a Why", () => {
    expect(rowsOf(share("dwm"), null)[0]).toMatchObject({
      where: "Windows",
      kind: "g-win",
      name: "Desktop compositor (dwm)",
      what: "Draws every window on the monitors this card drives",
    });
    expect(rowsOf(share("msedgewebview2"), null)[0]).toMatchObject({
      name: "Edge WebView",
      what: "Web views inside apps",
    });
  });

  test("an unknown process keeps its name and has no Why", () => {
    expect(rowsOf(share("chrome"), null)[0]).toMatchObject({
      where: "Windows",
      name: "chrome",
      what: "",
    });
  });

  test("the bun helper is prifly, in its Windows colour", () => {
    const [first, second] = rowsOf(
      {
        named: [
          { name: "chrome", mib: 900 },
          { name: "bun helper", mib: 500 },
        ],
        vm: 0,
        other: 0,
      },
      null,
    );
    expect(first?.kind).toBe("g-win");
    expect(second).toMatchObject({
      where: "prifly",
      kind: "g-win2",
      name: "prifly window (bun Helper)",
      what: "This window's web view",
    });
  });
});

describe("splitting the WSL share", () => {
  const holder = (pid: number, which: string, mib: number) => ({
    pid,
    which,
    label: which,
    model: "m",
    mib,
  });

  test("prifly's holders and what is left of the VM's share as WSL other", () => {
    const rows = vmRows(3000, [holder(1, "final", 1500), holder(2, "intent", 1000)]);
    expect(rows.map((r) => [r.where, r.name, r.mib])).toEqual([
      ["prifly", "final", 1500],
      ["prifly", "intent", 1000],
      ["WSL", "WSL other", 500],
    ]);
  });

  test("holders that sum past the VM's share are scaled down, with no WSL other", () => {
    const rows = vmRows(1000, [holder(1, "final", 1500), holder(2, "grey", 500)]);
    expect(rows.reduce((a, r) => a + r.mib, 0)).toBeCloseTo(1000, 6);
    expect(rows.some((r) => r.name === "WSL other")).toBe(false);
  });

  test("without holders it is one bar, and nothing without a VM share", () => {
    expect(vmRows(900, null).map((r) => r.name)).toEqual(["prifly (WSL)"]);
    expect(vmRows(900, null)[0]?.what).toBe(
      "prifly's models, not split: the host does not publish per-model figures yet",
    );
    expect(vmRows(0, null)).toEqual([]);
  });
});

describe("gpu-holders.json", () => {
  const now = 10_000_000_000;
  const alive = (pid: number) => pid !== 99;
  const file = (at: number, holders: unknown[], extra: object = {}) =>
    JSON.stringify({ at, holders, ...extra });
  const good = { pid: 1, which: "final", label: "Settled text", model: "parakeet", mib: 2400 };
  const grey = { pid: 2, which: "grey", label: "Grey words", model: "gemma", mib: 1800 };

  test("a fresh file with live pids gives its holders", () => {
    expect(readHolders(file(now - 1000, [good]), now, alive)).toEqual({
      holders: [good],
      greyNeeds: null,
    });
  });

  test("a file older than ten minutes is stale", () => {
    expect(readHolders(file(now - HOLDERS_FRESH_MS - 1, [good]), now, alive)).toBeNull();
  });

  test("a holder whose pid is gone is dropped; with none left the file still stands", () => {
    const dead = { ...good, pid: 99 };
    expect(readHolders(file(now, [good, dead]), now, alive)?.holders).toEqual([good]);
    expect(readHolders(file(now, [dead]), now, alive)?.holders).toEqual([]);
  });

  test("an unknown which stays a holder and nothing breaks", () => {
    const odd = { pid: 2, which: "future-thing", label: "Something new", model: "x", mib: 10 };
    const read = readHolders(file(now, [odd, { pid: "x" }, 5, null]), now, alive);
    expect(read?.holders).toEqual([odd]);
    expect(vmRows(100, read?.holders ?? null)[0]?.kind).toBe("g-wsl");
  });

  test("text that is not the file is no split", () => {
    expect(readHolders("not json", now, alive)).toBeNull();
    expect(readHolders("[]", now, alive)).toBeNull();
    expect(readHolders(JSON.stringify({ holders: [good] }), now, alive)).toBeNull();
  });

  test("greyNeeds is taken when it is a positive number, else left out", () => {
    expect(readHolders(file(now, [], { greyNeeds: 2300 }), now, alive)?.greyNeeds).toBe(2300);
    for (const bad of [0, -5, "2300", null, Number.NaN]) {
      expect(readHolders(file(now, [], { greyNeeds: bad }), now, alive)?.greyNeeds).toBeNull();
    }
  });

  test("a stale file's greyNeeds is not used", () => {
    const stale = file(now - HOLDERS_FRESH_MS - 1, [], { greyNeeds: 3000 });
    expect(readHolders(stale, now, alive)).toBeNull();
  });

  describe("grey words", () => {
    const read = (holders: unknown[], extra: object = {}) =>
      readHolders(file(now, holders, extra), now, alive);

    test("a live grey worker is on, however little is free", () => {
      expect(greyState(read([grey]), 1976, GREY_NEEDS_MIB)).toBe("on");
    });

    test("without one they would start when free memory reaches what they need", () => {
      expect(greyState(read([good]), 2300, 2300)).toBe("fits");
      expect(greyState(null, 5000, GREY_NEEDS_MIB)).toBe("fits");
    });

    test("without one and without room they would not start", () => {
      expect(greyState(null, 1976, GREY_NEEDS_MIB)).toBe("short");
      expect(greyState(read([good]), 1976, GREY_NEEDS_MIB)).toBe("short");
    });

    test("a grey worker whose pid is gone is not on", () => {
      expect(greyState(read([{ ...grey, pid: 99 }]), 1976, GREY_NEEDS_MIB)).toBe("short");
      expect(greyState(read([{ ...grey, pid: 99 }]), 4000, GREY_NEEDS_MIB)).toBe("fits");
    });

    test("a stale file says nothing: the numbers decide", () => {
      const stale = readHolders(file(now - HOLDERS_FRESH_MS - 1, [grey]), now, alive);
      expect(greyState(stale, 1976, GREY_NEEDS_MIB)).toBe("short");
    });

    test("the host's greyNeeds moves the line", () => {
      const needs = read([good], { greyNeeds: 3000 });
      expect(greyState(needs, 2500, needs?.greyNeeds ?? GREY_NEEDS_MIB)).toBe("short");
      expect(greyState(needs, 3000, needs?.greyNeeds ?? GREY_NEEDS_MIB)).toBe("fits");
    });
  });
});

describe("the headline", () => {
  const h = (tone: Tone, text: string) => ({ tone, text });

  test("grey words being off is said when nothing else is short", () => {
    const out = withGreyWords(h("good", "Nothing is short."), true);
    expect(out.tone).toBe("warning");
    expect(out.text).toContain("Grey words would not start");
  });

  test("a real shortage wins, and fitting grey words change nothing", () => {
    const short = h("critical", "Out of CPU in WSL.");
    expect(withGreyWords(short, true)).toBe(short);
    const fine = h("good", "Nothing is short.");
    expect(withGreyWords(fine, false)).toBe(fine);
  });
});
