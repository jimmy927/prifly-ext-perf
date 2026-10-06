// The bars card on the prifly tab: Memory, CPU and Processes, each stacked
// by what uses them, split either by kind or by session (the switch above it).

import { $, bytes, cores, el } from "./format.js";

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
 * stacked in proportion. With `machine` — what
 * WSL uses in all, and the parts of it outside prifly that can be named — the
 * bar is the whole of WSL, so prifly's share of it shows; what no one can be
 * named for is "Other programs", and the free part is the empty track.
 */
function stack(parts, label, field, format, machine) {
  const prifly = parts.reduce((total, part) => total + part.use[field], 0);
  const whole = machine === undefined ? prifly : machine.total;
  const segments = parts.map((part) =>
    segment(part.key, part.name, part.use[field], whole, format),
  );
  if (machine !== undefined) {
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
  }
  const total =
    machine === undefined
      ? format(prifly)
      : `prifly ${format(prifly)} · free ${format(Math.max(0, machine.total - Math.max(machine.used, prifly)))} of ${format(machine.total)}`;
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

/** One legend row: a colour, a name, what it is, and its numbers. */
function legendRow(colour, name, how, numbers) {
  return el(
    "div",
    { class: "lg" },
    el("i", { class: colour }),
    el("span", {}, el("b", {}, name), el("small", {}, how)),
    numbers === "" ? el("span") : el("span", { class: "num" }, numbers),
  );
}

export function drawKinds(report, state) {
  const parts = splitBy === "session" ? sessionParts(report) : kindParts(report);
  const s = state.linux.sample;
  const docker = report.otherContainers;
  const legend = el(
    "div",
    { class: "legend" },
    ...parts.map((part) =>
      legendRow(
        colourOf(part.key),
        part.name,
        part.how,
        splitBy === "session"
          ? `${part.count} · ${cores(part.use.cpu)} · ${bytes(part.use.rss)}`
          : `${part.count} · ${bytes(part.use.rss)}`,
      ),
    ),
    legendRow(
      "k-docker",
      "Other containers",
      "Docker containers no session started",
      `${report.containerCount.other} · ${bytes(docker.rss)}`,
    ),
    legendRow("k-kernel", "Kernel", "interrupts, charged to no process", cores(s.kernel)),
    legendRow(
      "k-other",
      "Other programs",
      "the rest of WSL: other distros, kernel threads, programs run by hand",
      "",
    ),
    legendRow("k-free", "Free", "memory and CPU nobody uses", ""),
  );
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
  $("kinds").replaceChildren(
    stack(parts, "Memory", "rss", bytes, memory),
    stack(parts, "CPU", "cpu", (n) => `${n.toFixed(1)} cores`, cpu),
    stack(parts, "Processes", "processes", String),
    legend,
  );
}
