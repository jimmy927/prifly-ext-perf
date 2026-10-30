import { expect, test } from "bun:test";
import { parsePss, parsePssRead, pssRead } from "../pss";

const ROLLUP = [
  "5aeba4f5c000-7ffe03669000 ---p 00000000 00:00 0                          [rollup]",
  "Rss:              190000 kB",
  "Pss:              155000 kB",
  "Pss_Anon:         120000 kB",
  "",
].join("\n");

test("PSS is the Pss: line, not Pss_Anon:, in bytes", () => {
  expect(parsePss(ROLLUP)).toBe(155000 * 1024);
  expect(parsePss("Rss: 1 kB\n")).toBeNull();
});

test("through wsl.exe: one head of the pids' smaps_rollup, each under its header", () => {
  expect(pssRead([12, 34])).toBe(
    "(cd /proc && head -v -- 12/smaps_rollup 34/smaps_rollup 2>/dev/null)",
  );
  // 34 is another user's: head prints no section for it, and its RSS stands in.
  const out = `==> 12/smaps_rollup <==\r\n${ROLLUP.replace(/\n/g, "\r\n")}`;
  expect(parsePssRead(out)).toEqual(new Map([[12, 155000 * 1024]]));
});
