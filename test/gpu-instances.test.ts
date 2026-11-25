import { describe, expect, test } from "bun:test";
import { parseGpuProcesses } from "../gpu";

const NVIDIA = "0x00000000_0x00013915";
const INTEL = "0x00000000_0x000128c5";

describe("a pid listed more than once on one adapter", () => {
  const row = (pid: number, luid: string, suffix: string, mib: number) =>
    `L|pid_${pid}_luid_${luid}_phys_0${suffix}|${mib * 2 ** 20}`;

  test("the WSL VM's instances on one adapter add up", () => {
    // 2026-10-10: dictation's final and grey workers each gave vmwp an instance.
    const { uses } = parseGpuProcesses(
      [
        row(13644, NVIDIA, "", 3820),
        row(13644, NVIDIA, "#1", 1598),
        "P|13644|vmwp", // the name comes after the counters
      ].join("\n"),
    );
    expect(uses).toEqual([{ pid: 13644, luid: NVIDIA, mib: 5418 }]);
  });

  test("another process's instances still keep the largest", () => {
    const { uses } = parseGpuProcesses(
      ["P|5|notepad", row(5, NVIDIA, "", 900), row(5, NVIDIA, "#1", 400)].join("\n"),
    );
    expect(uses).toEqual([{ pid: 5, luid: NVIDIA, mib: 900 }]);
  });

  test("the WSL VM's instances on different adapters are not mixed", () => {
    const { uses } = parseGpuProcesses(
      [
        "P|7|vmwp",
        row(7, NVIDIA, "", 3820),
        row(7, NVIDIA, "#1", 1598),
        row(7, INTEL, "", 300),
      ].join("\n"),
    );
    expect(uses.map((u) => [u.luid, u.mib])).toEqual([
      [NVIDIA, 5418],
      [INTEL, 300],
    ]);
  });
});

describe("GPU process counters", () => {
  const out = [
    `L|pid_13644_luid_${NVIDIA}_phys_0|${300 * 2 ** 20}`,
    `L|pid_13644_luid_${NVIDIA}_phys_0#2|${500 * 2 ** 20}`,
    `L|pid_13644_luid_${INTEL}_phys_0|${40 * 2 ** 20}`,
    `L|pid_7_luid_${NVIDIA}_phys_0|${100 * 2 ** 20}`,
    "L|not_an_instance|5",
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

  test("only local usage is read: the compositor's shared surfaces are not its", () => {
    // 2026-11-05: dwm said 11,928 MiB dedicated on the 8 GB card, 678 MiB local.
    const { uses } = parseGpuProcesses(
      [
        `G|pid_2356_luid_${NVIDIA}_phys_0|${11928 * 2 ** 20}`,
        `C|pid_2356_luid_${NVIDIA}_phys_0|${1222 * 2 ** 20}`,
        `L|pid_2356_luid_${NVIDIA}_phys_0|${678 * 2 ** 20}`,
        `L|pid_36532_luid_${NVIDIA}_phys_0|${3507 * 2 ** 20}`,
      ].join("\n"),
    );
    const mib = (pid: number) => uses.find((u) => u.pid === pid)?.mib;
    expect(mib(2356)).toBe(678);
    expect(mib(36532)).toBe(3507);
    expect(uses).toHaveLength(2);
  });
});
