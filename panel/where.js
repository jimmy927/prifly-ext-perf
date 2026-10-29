// The "Where it goes" card at the top of the Machine tab: CPU and memory over
// the whole machine, each split into Windows and the WSL VM, and in each what
// is prifly's, what is Docker's and what is everything else.

import { $, bytes, cores, el } from "./format.js";

const MIB = 2 ** 20;

/** A segment wider than this share of its group carries its name and value. */
const LABEL_FROM = 5;

/**
 * One resource over the machine. `win` is Windows' side as `{used, vm, prifly}`
 * (what Windows counts as used, how much of that is the WSL VM, and prifly's own
 * Windows processes); `wsl` is the VM's as `{size, used, prifly, docker}`, or null
 * where WSL is not running. Windows' group is what the VM leaves of `total`;
 * the VM's group is `size`, or what it uses where that is more.
 */
function split(total, win, wsl, priflyKnown) {
  let vmGroup = null;
  if (wsl !== null) {
    const width = Math.max(wsl.size, wsl.used);
    // Counters read a moment apart can sum a little past the whole: capped in turn.
    const prifly = priflyKnown ? Math.min(wsl.prifly, wsl.used) : 0;
    const docker = priflyKnown ? Math.min(wsl.docker, wsl.used - prifly) : 0;
    vmGroup = {
      width,
      used: wsl.used,
      prifly,
      docker,
      other: wsl.used - prifly - docker,
      free: width - wsl.used,
    };
  }
  const width = Math.max(0, total - (vmGroup?.width ?? 0));
  const outsideVm = Math.max(0, win.used - win.vm);
  const prifly = Math.min(win.prifly, outsideVm);
  const other = outsideVm - prifly;
  const winGroup = { width, used: outsideVm, prifly, other, free: Math.max(0, width - outsideVm) };
  return { total, win: winGroup, wsl: vmGroup };
}

/** The CPU split: cores, by the hypervisor's count of the machine where Windows has one. */
function cpuSplit(c, info, s, report, mine) {
  const winCpu = Math.min(info.cores, ((c.machine ?? c.busy ?? 0) / 100) * info.cores);
  if (s === null)
    return split(info.cores, { used: winCpu, vm: 0, prifly: mine?.cpu ?? 0 }, null, true);
  const wslCpu = (s.busy / 100) * s.cores;
  // Windows counts the VM as used; `wslVm` is summed over cores, 100 being one.
  const vmCpu = c.wslVm === null ? wslCpu : c.wslVm / 100;
  const wsl = {
    size: wslCpu,
    used: wslCpu,
    prifly: report?.total.cpu ?? 0,
    docker: report?.otherContainers.cpu ?? 0,
  };
  return split(
    info.cores,
    { used: winCpu, vm: vmCpu, prifly: mine?.cpu ?? 0 },
    wsl,
    report !== null,
  );
}

/**
 * The memory split: bytes. Windows counts the VM as used only as far as it holds
 * it in RAM (its working set), not its whole size; where that counter is missing,
 * what Linux uses in the VM stands in for it.
 */
function memorySplit(c, info, s, report, mine) {
  const winMem = Math.max(0, info.memTotal - (c.availableMB ?? 0) * MIB);
  const vm = c.wslVmMem ?? (s === null ? 0 : s.memTotal - s.memAvailable);
  const win = { used: winMem, vm, prifly: mine?.rss ?? 0 };
  const wsl =
    s === null
      ? null
      : {
          size: s.memTotal,
          used: s.memTotal - s.memAvailable,
          prifly: report?.total.rss ?? 0,
          docker: report?.otherContainers.rss ?? 0,
        };
  return split(info.memTotal, win, wsl, report !== null);
}

/** At most this many programs are named in a group's "Other". */
const NAMED = 5;

/** A program is named only where it is at least this share of its group. */
const NAMED_FROM = 0.02;

/**
 * Names the biggest programs in each group's "Other" (`others` by `key`, cores
 * or bytes): each takes its part out of `other`, and `rest` is what is left.
 * Counters read apart can name more than "Other" holds: capped in turn.
 */
function named(r, others, key) {
  const name = (part, programs) => {
    if (part === null) return;
    part.named = [];
    part.rest = part.other;
    const sorted = [...programs].sort((a, b) => b[key] - a[key]);
    for (const p of sorted.slice(0, NAMED)) {
      const value = Math.min(p[key], part.rest);
      if (!(value >= NAMED_FROM * part.width)) break;
      // A Windows program's memory is its RAM, as the bar is; its commit goes in the tooltip.
      const commit = key === "rss" ? p.commit : undefined;
      part.named.push(
        commit === undefined ? { name: p.name, value } : { name: p.name, value, commit },
      );
      part.rest -= value;
    }
  };
  name(r.win, others.windows);
  name(r.wsl, others.linux);
}

/**
 * What the card draws, from one `api/status`: null where there is no Windows to
 * split (a plain Linux host), `{reading: true}` until Windows has a sample, else the
 * `cpu` and `memory` splits and the facts the table and header need.
 */
export function whereModel(state) {
  const windows = state.windows;
  if (windows === null) return null;
  const { counters, info } = windows;
  if (counters === null || info === null) return { reading: true };
  const s = state.linux?.sample ?? null;
  const report = state.prifly;
  // prifly's own Windows processes, where the host reads them.
  const mine = state.priflyWindows ?? null;
  const others = state.others ?? { linux: [], windows: [] };
  const cpu = cpuSplit(counters, info, s, report, mine);
  const memory = memorySplit(counters, info, s, report, mine);
  named(cpu, others, "cpu");
  named(memory, others, "rss");
  return {
    reading: false,
    info,
    cpu,
    memory,
    running: s !== null,
    known: report !== null,
  };
}

/**
 * One bar's segment: `value` as its share of the group's `whole`; nothing where
 * it is zero. Its tooltip is `title`, or its name and value.
 */
export function segment(colour, name, value, whole, format, title) {
  if (!(value > 0) || !(whole > 0)) return null;
  const node = el("div", {
    class: `seg ${colour}`,
    style: `width:${(100 * value) / whole}%`,
    title: title ?? `${name}: ${format(value)}`,
  });
  if ((100 * value) / whole > LABEL_FROM) node.append(el("span", {}, `${name} ${format(value)}`));
  return node;
}

/** One group of a row: a caption (its name, what is used) over its bar. */
function group(kind, title, used, part, total, parts, format) {
  const segments = parts.map(([colour, name, value, title]) =>
    segment(colour, name, value, part.width, format, title),
  );
  return el(
    "div",
    { class: `group ${kind}`, style: `flex:${(100 * part.width) / total} 1 0` },
    el("div", { class: "cap" }, el("span", {}, title), el("span", { class: "num" }, used)),
    el("div", { class: "stack" }, ...segments),
  );
}

/**
 * A group's named programs as segments, every other one a shade lighter to tell
 * them apart. A Windows program's memory segment is what it holds in RAM; its
 * tooltip gives its commit too, which Windows may have trimmed out of RAM.
 */
const programs = (part) =>
  part.named.map(({ name, value, commit }, i) => [
    `k-prog${i % 2 === 1 ? " alt" : ""}`,
    name,
    value,
    commit === undefined
      ? undefined
      : `${name}: ${bytes(value)} in RAM · ${bytes(commit)} committed by all its processes`,
  ]);

function row(label, r, format, known) {
  const prifly = r.win.prifly + (r.wsl?.prifly ?? 0);
  const free = r.win.free + (r.wsl?.free ?? 0);
  const groups = [
    group(
      "win",
      "Windows",
      `${format(r.win.used)} used`,
      r.win,
      r.total,
      [
        ["k-claude", "prifly", r.win.prifly],
        ...programs(r.win),
        ["k-other", "Other Windows", r.win.rest],
        ["k-free", "free", r.win.free],
      ],
      format,
    ),
  ];
  if (r.wsl !== null) {
    groups.push(
      group(
        "wsl",
        "WSL VM",
        `${format(r.wsl.used)} used`,
        r.wsl,
        r.total,
        [
          ["k-claude", "prifly sessions", r.wsl.prifly],
          ["k-docker", "Docker", r.wsl.docker],
          ...programs(r.wsl),
          ["k-other", known ? "Other WSL" : "In use", r.wsl.rest],
          ["k-vmfree", "free in VM", r.wsl.free],
        ],
        format,
      ),
    );
  }
  const total = `prifly ${format(prifly)} · free ${format(free)} of ${format(r.total)}`;
  return el(
    "div",
    { class: "where-row" },
    el("div", { class: "stacklabel" }, el("b", {}, label), el("span", { class: "num" }, total)),
    el("div", { class: "groups" }, ...groups),
  );
}

/** A muted dash where a number is not known. */
const NONE = () => el("td", { class: "r num none" }, "—");

/** A table cell: `[cores, bytes]`. */
const cell = ([cpu, memory]) => el("td", { class: "r num" }, `${cores(cpu)} · ${bytes(memory)}`);

/** The two table rows, prifly and everything else, by Windows, WSL and the machine. */
function matrix(m) {
  const { cpu, memory } = m;
  const win = {
    prifly: [cpu.win.prifly, memory.win.prifly],
    other: [cpu.win.other, memory.win.other],
  };
  // Until prifly's table is read, WSL's part of it cannot be told from the rest.
  const wsl =
    cpu.wsl === null || !m.known
      ? { prifly: null, other: null }
      : {
          prifly: [cpu.wsl.prifly, memory.wsl.prifly],
          other: [cpu.wsl.docker + cpu.wsl.other, memory.wsl.docker + memory.wsl.other],
        };
  const wslCell = (both) => {
    if (!m.running) return el("td", { class: "r none" }, "not running");
    return both === null ? NONE() : cell(both);
  };
  // WSL not running adds nothing to the machine; WSL not read leaves it unknown.
  const machine = (w, v) => {
    if (!m.running) return cell(w);
    return v === null ? NONE() : cell([w[0] + v[0], w[1] + v[1]]);
  };
  const docker =
    m.running && m.known
      ? `of which Docker ${cores(cpu.wsl.docker)} · ${bytes(memory.wsl.docker)}`
      : "";
  return [
    el(
      "tr",
      { class: "p" },
      el("td", {}, el("i", { class: "swatch k-claude" }), "prifly"),
      cell(win.prifly),
      wslCell(wsl.prifly),
      machine(win.prifly, wsl.prifly),
      el("td", { class: "r" }, el("a", { href: "#prifly" }, "Sessions, MCP, tools →")),
    ),
    el(
      "tr",
      {},
      el("td", {}, el("i", { class: "swatch k-other" }), "Everything else"),
      cell(win.other),
      wslCell(wsl.other),
      machine(win.other, wsl.other),
      el("td", { class: "r none" }, docker),
    ),
  ];
}

function header(m) {
  const detail =
    m === null || m.reading
      ? ""
      : `the whole machine: ${m.info.cores} cores · ${bytes(m.info.memTotal)}${
          m.running ? ` · the WSL VM is a slice of it (${bytes(m.memory.wsl.width)})` : ""
        }`;
  return el("header", {}, el("h2", {}, "Where it goes"), el("span", {}, detail));
}

/** Draws the card into `#where`; hidden where there is no Windows to split. */
export function drawWhere(state) {
  const m = whereModel(state);
  $("where").hidden = m === null;
  if (m === null) return;
  const body = m.reading
    ? [el("p", {}, "Reading…")]
    : [
        el(
          "div",
          { class: "where-rows" },
          row("CPU", m.cpu, cores, m.known),
          row("Memory", m.memory, bytes, m.known),
        ),
        el(
          "table",
          { class: "matrix" },
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th"),
              el("th", { class: "r" }, "Windows"),
              el("th", { class: "r" }, "WSL"),
              el("th", { class: "r" }, "Machine"),
              el("th"),
            ),
          ),
          el("tbody", {}, ...matrix(m)),
        ),
      ];
  $("where").replaceChildren(
    el("div", { class: "card", "data-part": "where" }, header(m), ...body),
  );
}
