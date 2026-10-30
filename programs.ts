// What "Other" is made of in the Where it goes card: the programs outside
// prifly, in WSL and in Windows, by name.

import type { Proc } from "./procs";

/**
 * A program outside prifly, its processes added up: cores and resident memory,
 * and on Windows its commit (`windowsPrograms`).
 */
export type Program = { name: string; cpu: number; rss: number; commit?: number };

/** How many programs `otherPrograms` keeps by each of CPU and memory. */
const PROGRAMS = 8;

/** The busiest by CPU and the biggest by memory of `programs`, each once. */
export function biggest(programs: Program[]): Program[] {
  const byCpu = [...programs].sort((a, b) => b.cpu - a.cpu).slice(0, PROGRAMS);
  const byRss = [...programs].sort((a, b) => b.rss - a.rss).slice(0, PROGRAMS);
  return [...new Set([...byCpu, ...byRss])];
}

/**
 * What uses WSL besides prifly, by program: the processes `priflyReport` did
 * not count (`counted`), summed by the kernel's name for them. Docker's
 * containers are not among them: their processes are hidden from this table.
 */
export function otherPrograms(procs: Proc[], counted: Set<number>): Program[] {
  const byName = new Map<string, Program>();
  for (const proc of procs) {
    if (counted.has(proc.pid) || proc.argv.length === 0) continue;
    const entry = byName.get(proc.comm) ?? { name: proc.comm, cpu: 0, rss: 0 };
    entry.cpu += proc.cpu;
    entry.rss += proc.rss;
    byName.set(proc.comm, entry);
  }
  return biggest([...byName.values()]);
}

/**
 * What uses Windows besides prifly and the WSL VM, by program: Windows' own
 * count of each (`topProcesses`), less what prifly's own Windows processes
 * (`mine`) use under the same name. Its memory is its working set, what it
 * holds in RAM, as the card's bar is RAM; `commit` is all its processes'
 * commit, prifly's included, for the card to say beside it.
 */
export function windowsPrograms(
  top: { name: string; cpu: number; ram: number; commit: number }[],
  mine: Proc[],
): Program[] {
  const ours = new Map<string, Program>();
  for (const proc of mine) {
    const name = proc.comm.toLowerCase().replace(/\.exe$/, "");
    const entry = ours.get(name) ?? { name, cpu: 0, rss: 0 };
    entry.cpu += proc.cpu;
    entry.rss += proc.rss;
    ours.set(name, entry);
  }
  const programs = top
    .filter((p) => !/^vmmem/.test(p.name))
    .map((p) => ({
      name: p.name,
      cpu: Math.max(0, p.cpu - (ours.get(p.name)?.cpu ?? 0)),
      rss: Math.max(0, p.ram - (ours.get(p.name)?.rss ?? 0)),
      commit: p.commit,
    }));
  return biggest(programs);
}
