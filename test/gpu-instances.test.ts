import { describe, expect, test } from "bun:test";
import { parseGpuProcesses } from "../gpu";

const NVIDIA = "0x00000000_0x00013915";
const INTEL = "0x00000000_0x000128c5";

describe("a pid listed more than once on one adapter", () => {
  const row = (kind: "G" | "C", pid: number, luid: string, suffix: string, mib: number) =>
    `${kind}|pid_${pid}_luid_${luid}_phys_0${suffix}|${mib * 2 ** 20}`;

  test("the WSL VM's instances on one adapter add up, dedicated and committed", () => {
    // 2026-10-10: dictation's final and grey workers each gave vmwp an instance.
    const { uses } = parseGpuProcesses(
      [
        row("G", 13644, NVIDIA, "", 3820),
        row("G", 13644, NVIDIA, "#1", 1598),
        row("C", 13644, NVIDIA, "", 3830),
        row("C", 13644, NVIDIA, "#1", 1600),
        "P|13644|vmwp", // the name comes after the counters
      ].join("\n"),
    );
    expect(uses).toEqual([{ pid: 13644, luid: NVIDIA, mib: 5418 }]);
  });

  test("another process's instances still keep the largest", () => {
    const { uses } = parseGpuProcesses(
      [
        "P|5|notepad",
        row("G", 5, NVIDIA, "", 900),
        row("G", 5, NVIDIA, "#1", 400),
        row("C", 5, NVIDIA, "", 950),
        row("C", 5, NVIDIA, "#1", 450),
      ].join("\n"),
    );
    expect(uses).toEqual([{ pid: 5, luid: NVIDIA, mib: 900 }]);
  });

  test("the WSL VM's instances on different adapters are not mixed", () => {
    const { uses } = parseGpuProcesses(
      [
        "P|7|vmwp",
        row("G", 7, NVIDIA, "", 3820),
        row("G", 7, NVIDIA, "#1", 1598),
        row("G", 7, INTEL, "", 300),
      ].join("\n"),
    );
    expect(uses.map((u) => [u.luid, u.mib])).toEqual([
      [NVIDIA, 5418],
      [INTEL, 300],
    ]);
  });
});
