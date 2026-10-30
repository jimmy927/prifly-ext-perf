/**
 * Proportional set size: a process's resident memory with each page it shares
 * divided among the processes that share it (`/proc/<pid>/smaps_rollup`'s
 * `Pss:`), so the `claude` of every session, which share their program's
 * pages, add up to what they really hold. Reading it walks the process's page
 * tables, so it is read only for the `claude` processes, only while the Memory
 * tab is open, and at most every 10 s (`tables.ts`). A host on Windows itself
 * reads the same files through the shell inside WSL (`PSS_READ`).
 */

import { readFileSync } from "node:fs";
import { headSections } from "./wsl-exe";

/** `Pss:` from a `smaps_rollup`'s text, bytes; null where it has none. */
export function parsePss(text: string): number | null {
  const kb = /^Pss:\s+(\d+) kB/m.exec(text)?.[1];
  return kb === undefined ? null : Number(kb) * 1024;
}

/**
 * Each of `pids`' PSS, read from this host's `/proc`. A process that is
 * another user's, that ended, or whose file cannot be read for any other
 * reason is left out: its RSS stands in for it.
 */
export function readPss(pids: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const pid of pids) {
    let text: string;
    try {
      text = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    } catch {
      continue;
    }
    const pss = parsePss(text);
    if (pss !== null) out.set(pid, pss);
  }
  return out;
}

/** The command that prints `pids`' `smaps_rollup`, each under its `==> <pid>/smaps_rollup <==` header. */
export function pssRead(pids: readonly number[]): string {
  const files = pids
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((p) => `${p}/smaps_rollup`);
  return `(cd /proc && head -v -- ${files.join(" ")} 2>/dev/null)`;
}

/** What `pssRead` printed: each pid's PSS, those it could not read left out. */
export function parsePssRead(out: string): Map<number, number> {
  const pss = new Map<number, number>();
  for (const [path, text] of headSections(out.replace(/\r/g, ""))) {
    const pid = Number(/^(\d+)\/smaps_rollup$/.exec(path)?.[1] ?? Number.NaN);
    const bytes = parsePss(text);
    if (!Number.isNaN(pid) && bytes !== null) pss.set(pid, bytes);
  }
  return pss;
}
