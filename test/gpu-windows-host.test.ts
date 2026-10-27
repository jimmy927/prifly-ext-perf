import { describe, expect, test } from "bun:test";
import { readHolders, rowsOf, shareOut } from "../gpu";

const NVIDIA = "0x00000000_0x00013915";
const use = (pid: number, mib: number) => ({ pid, luid: NVIDIA, mib });
const names = new Map([
  [1, "dwm"],
  [4, "vmwp"],
  [5, "bun"],
]);
const now = 1_000_000;
const holders = readHolders(
  JSON.stringify({
    at: now,
    holders: [
      {
        pid: 5,
        which: "final",
        label: "Dictation (final)",
        mib: 4000,
        parts: [
          { model: "parakeet-tdt-0.6b", mib: 1800 },
          { model: "whisper turbo", mib: 2200 },
        ],
      },
      { pid: 5, which: "grey", label: "Dictation (grey words)", model: "x", mib: 2000 },
    ],
  }),
  now,
  () => true,
);

describe("a prifly host on Windows itself", () => {
  test("its worker's own process is split into its models, not a bun row", () => {
    const shares = shareOut([use(1, 500), use(4, 300), use(5, 3000)], names, 4000, new Set([5]));
    expect(shares.named.map((s) => s.name)).toEqual(["dwm"]);
    expect(shares.workers?.get(5)).toBe(3000);
    const rows = rowsOf(shares, holders, []);
    expect(rows.map((r) => `${r.where}/${r.name}/${Math.round(r.mib)}`)).toEqual([
      "prifly/Dictation (final)/900",
      "prifly/Dictation (final)/1100",
      "prifly/Dictation (grey words)/1000",
      "WSL/WSL other/300",
      "Windows/Desktop compositor (dwm)/500",
      "Windows/Windows other/200",
    ]);
    expect(rows.reduce((a, r) => a + r.mib, 0)).toBeCloseTo(4000, 6);
  });

  test("a worker that holds more than is used is cut to it, and Windows gets nothing", () => {
    const shares = shareOut([use(1, 500), use(5, 5000)], names, 4000, new Set([5]));
    expect(shares.workers?.get(5)).toBe(4000);
    expect(shares.named).toEqual([]);
    expect(shares.other).toBe(0);
  });

  test("without workers, bun stays a Windows row", () => {
    const shares = shareOut([use(5, 3000)], names, 3000);
    expect(rowsOf(shares, null).map((r) => r.name)).toEqual(["bun"]);
  });
});
