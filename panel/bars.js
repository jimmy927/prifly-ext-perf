// The bars card on the prifly tab: Memory and CPU, each stacked
// by what uses them, split either by kind or by session (the switch above it).

import { $, bytes, el } from "./format.js";

// In the order the bars stack them; each kind's colour is `--k-<key>` in style.css.
const KINDS = [
  ["claude", "claude", "one per session"],
  ["mcp", "MCP servers", "started by each claude"],
  ["tools", "Tools sessions run", "shells, tests, builds"],
  ["containers", "Containers sessions started", "Docker, known by what they mount"],
  ["gates", "Lands and git buttons", "merges, commit hooks and the test gate they run"],
  ["host", "Host", "prifly itself, its intent model and helpers"],
  ["relay", "Relays", "keep sessions alive through a host restart"],
];

/** A segment wider than this share carries its name and value; narrower ones only on hover. */
const LABEL_FROM = 9;

/** A part's colour: `s-<n>` is the nth session's (`--s-<n>`), any other key a kind's (`--k-<key>`). */
const colourOf = (key) => (key.startsWith("s-") ? key : `k-${key}`);

/** One bar's segment: one part's `value`, as its share of `whole`. */
function segment(key, name, value, whole, format) {
  const share = whole > 0 ? (100 * value) / whole : 0;
  const node = el("div", {
    class: `seg ${colourOf(key)}`,
    style: `width:${share}%`,
    title: `${name}: ${format(value)}`,
  });
  if (share > LABEL_FROM) node.append(el("span", {}, `${name} ${format(value)}`));
  return node;
}

/**
 * One bar: `field` of every part of prifly (its kinds, or its sessions),
 * stacked in proportion across the whole of WSL (`machine`: what WSL uses in
 * all, and the parts of it outside prifly that can be named), so prifly's
 * share of it shows; what no one can be named for is "Other programs", and the
 * free part is the empty track.
 */
function stack(parts, label, field, format, machine) {
  const prifly = parts.reduce((total, part) => total + part.use[field], 0);
  const whole = machine.total;
  const segments = parts.map((part) =>
    segment(part.key, part.name, part.use[field], whole, format),
  );
  let named = prifly;
  for (const [key, name, value] of machine.outside) {
    // Capped at what WSL uses: counters read a moment apart can sum a little past it.
    const shown = Math.min(value, Math.max(0, machine.used - named));
    named += shown;
    segments.push(segment(key, name, shown, whole, format));
  }
  segments.push(
    segment("other", "Other programs", Math.max(0, machine.used - named), whole, format),
  );
  const total = `prifly ${format(prifly)} · free ${format(Math.max(0, machine.total - Math.max(machine.used, prifly)))} of ${format(machine.total)}`;
  return el(
    "div",
    { class: "stackrow" },
    el("div", { class: "stacklabel" }, el("b", {}, label), el("span", { class: "num" }, total)),
    el("div", { class: "stack" }, ...segments),
  );
}

/** How many sessions get a colour of their own when the bars are split by session. */
const SESSION_COLOURS = 7;
const SPLIT_KEY = "perf.splitBy";

function savedSplit() {
  try {
    return localStorage.getItem(SPLIT_KEY) === "session" ? "session" : "kind";
  } catch {
    return "kind";
  }
}

/** What the bars are split by, "kind" or "session"; the reader's last choice. */
let splitBy = savedSplit();

/** prifly's usage by kind: one part per kind, in the order the bars stack them. */
function kindParts(report) {
  return KINDS.map(([key, name, how]) => {
    const use = report.kinds[key];
    // Docker hides a container's processes: containers count as one each.
    const count = key === "containers" ? report.containerCount.sessions : use.processes;
    return { key, name, how, use, count };
  });
}

const sumOf = (rows) =>
  rows.reduce(
    (total, u) => ({
      processes: total.processes + u.processes,
      rss: total.rss + u.rss,
      cpu: total.cpu + u.cpu,
    }),
    { processes: 0, rss: 0, cpu: 0 },
  );

// What no session owns (`report.own`), by what it is for; each colour is `--k-<key>`.
const OWN = [
  ["host", "Host", "prifly itself and its short claude calls"],
  ["dictation", "Dictation models", "Parakeet twice and Silero, loaded while dictation is on"],
  ["intent", "Intent model", "reads each message as a question or an instruction"],
  ["gates", "Git buttons", "commits, lands and their hooks"],
];

/**
 * prifly's usage by session: the sessions that weigh most (CPU and memory,
 * each as a share of prifly's) a colour each, the rest as one part, and what
 * no session owns after them, by what it is for.
 */
function sessionParts(report) {
  const total = report.total;
  const weight = (s) => s.cpu / Math.max(total.cpu, 1e-9) + s.rss / Math.max(total.rss, 1);
  const ranked = [...report.sessions].sort((a, b) => weight(b) - weight(a));
  const rest = ranked.slice(SESSION_COLOURS);
  const parts = ranked.slice(0, SESSION_COLOURS).map((s, i) => ({
    key: `s-${i}`,
    name: s.title,
    how: s.doing === "" ? s.state : `${s.state} · ${s.doing}`,
    use: s,
    count: s.processes,
  }));
  if (rest.length > 0) {
    const use = sumOf(rest);
    const how = `${rest.length} more`;
    parts.push({ key: "relay", name: "Other sessions", how, use, count: use.processes });
  }
  for (const [key, name, how] of OWN) {
    const use = report.own[key];
    parts.push({ key, name, how, use, count: use.processes });
  }
  return parts;
}

/** The Kind | Session switch over the bars; a click is remembered and calls `redraw`. */
export function drawSplit(redraw) {
  const buttons = [
    ["kind", "Kind"],
    ["session", "Session"],
  ].map(([value, label]) => {
    const pressed = String(splitBy === value);
    const button = el("button", { type: "button", "aria-pressed": pressed }, label);
    button.addEventListener("click", () => {
      splitBy = value;
      try {
        localStorage.setItem(SPLIT_KEY, value);
      } catch {
        // Not kept: the choice still holds until the window closes.
      }
      drawSplit(redraw);
      redraw();
    });
    return button;
  });
  $("splitby").replaceChildren(...buttons);
}

/** A number cell, right-aligned; a muted dash when there is nothing to count. */
const numCell = (value, shown) =>
  value > 0 ? el("td", { class: "r num" }, shown) : el("td", { class: "r num none" }, "—");

/** One legend row: a colour, a name with what it is beside it, then processes, CPU and memory. */
function legendRow(colour, name, how, { processes = 0, cpu = 0, rss = 0 }) {
  return el(
    "tr",
    {},
    el("td", { class: "sw" }, el("i", { class: colour })),
    el("td", { class: "who", title: `${name}: ${how}` }, el("b", {}, name), el("small", {}, how)),
    numCell(processes, String(processes)),
    numCell(cpu >= 0.05 ? cpu : 0, cpu.toFixed(1)),
    numCell(rss, bytes(rss)),
  );
}

/** One legend group: a table whose heading row names it and its columns. */
function legendGroup(title, rows) {
  return el(
    "table",
    { class: "lgt" },
    el(
      "colgroup",
      {},
      ...["sw", "who", "p", "c", "m"].map((name) => el("col", { class: `c-${name}` })),
    ),
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        el("th", { colspan: "2" }, title),
        el("th", { class: "r" }, "Proc"),
        el("th", { class: "r" }, "Cores"),
        el("th", { class: "r" }, "Memory"),
      ),
    ),
    el("tbody", {}, ...rows),
  );
}

/**
 * The legend: prifly's parts (its sessions, or its kinds) on the left; on the
 * right what no session owns, and what WSL runs outside prifly down to the free part.
 */
function drawLegend(parts, report, memory, cpu, kernel) {
  const docker = report.otherContainers;
  const prifly = sumOf(parts.map((part) => part.use));
  const row = (part) =>
    legendRow(colourOf(part.key), part.name, part.how, { ...part.use, processes: part.count });
  const own = new Set(OWN.map(([key]) => key));
  const bySession = splitBy === "session";
  const mine = parts.filter((part) => !bySession || !own.has(part.key));
  const owned = bySession ? parts.filter((part) => own.has(part.key)) : [];
  const outside = [
    legendRow("k-docker", "Other containers", "Docker containers no session started", {
      processes: report.containerCount.other,
      cpu: docker.cpu,
      rss: docker.rss,
    }),
    legendRow("k-kernel", "Kernel", "interrupts, charged to no process", { cpu: kernel }),
    legendRow("k-other", "Other programs", "other distros, kernel threads, programs run by hand", {
      cpu: Math.max(0, cpu.used - prifly.cpu - docker.cpu - kernel),
      rss: Math.max(0, memory.used - prifly.rss - docker.rss),
    }),
    legendRow("k-free", "Free", "nobody uses it", {
      cpu: Math.max(0, cpu.total - cpu.used),
      rss: Math.max(0, memory.total - memory.used),
    }),
  ];
  return el(
    "div",
    { class: "legend" },
    legendGroup(bySession ? "Sessions" : "prifly, by kind", mine.map(row)),
    el(
      "div",
      {},
      owned.length > 0 ? legendGroup("prifly, no session", owned.map(row)) : null,
      legendGroup("Outside prifly", outside),
    ),
  );
}

export function drawKinds(report, state) {
  const parts = splitBy === "session" ? sessionParts(report) : kindParts(report);
  const s = state.linux.sample;
  const docker = report.otherContainers;
  // Resident memory overlaps a little (shared pages), so prifly may sum past "used": capped in `stack`.
  const memory = {
    total: s.memTotal,
    used: s.memTotal - s.memAvailable,
    outside: [["docker", "Other containers", docker.rss]],
  };
  const cpu = {
    total: s.cores,
    used: (s.busy / 100) * s.cores,
    outside: [
      ["docker", "Other containers", docker.cpu],
      ["kernel", "Kernel", s.kernel],
    ],
  };
  const legend = drawLegend(parts, report, memory, cpu, s.kernel);
  $("kinds").replaceChildren(
    stack(parts, "Memory", "rss", bytes, memory),
    stack(parts, "CPU", "cpu", (n) => `${n.toFixed(1)} cores`, cpu),
    legend,
  );
}
