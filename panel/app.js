// The Performance window. Everything comes from `api/status`, asked every
// second (`every.js`) while the page is visible, and every number in it is the
// average over the trailing period. Asking is also what tells the extension the window
// is open, so it reads the process table only then.

import { startEvery } from "./every.js";
import { $, bytes, cores, el, pct, rate, spark } from "./format.js";

let last = null;

function metric(tone, name, main, small, line) {
  return el(
    "div",
    { class: `metric ${tone}` },
    el("span", { class: "dot" }),
    el("span", { class: "name" }, name),
    el("span", { class: "read" }, el("span", { class: "num" }, main), el("small", {}, small)),
    line,
  );
}

function hostCard(title, detail, rows) {
  return el(
    "div",
    { class: "card" },
    el("header", {}, el("h2", {}, title), el("span", {}, detail)),
    ...rows,
  );
}

function history(key, field) {
  return (last?.history ?? []).map((point) => point[key]?.[field] ?? 0);
}

function linuxCard(linux) {
  const s = linux.sample;
  const v = linux.verdicts;
  const waited =
    s.cpu === null ? `${pct(s.busy)} busy` : `Waited for a core ${pct(s.cpu.some)} of the time`;
  const swap = s.swapTotal > 0 ? ` · swap ${bytes(s.swapUsed)} used` : " · no swap";
  return hostCard(linux.name, `${s.cores} cores · ${bytes(s.memTotal)}`, [
    metric(
      v.cpu,
      "CPU",
      `${s.runnable.toFixed(1)} ready to run / ${s.cores} cores`,
      waited,
      spark(history("linux", "cpu"), 100),
    ),
    metric(
      v.memory,
      "Memory",
      `${bytes(s.memAvailable)} free of ${bytes(s.memTotal)}`,
      `All tasks waited for memory ${pct(s.memory?.full ?? 0)} of the time${swap}`,
      spark(history("linux", "memory"), 100),
    ),
    metric(
      v.disk,
      "Disk I/O",
      `${rate(s.diskRead)} read · ${rate(s.diskWrite)} write`,
      `All tasks waited for disk ${pct(s.io?.full ?? 0)} of the time`,
      spark(history("linux", "disk")),
    ),
    metric(
      "neutral",
      "Load",
      s.load.map((n) => n.toFixed(1)).join(" · "),
      "1, 5 and 15 min, for comparison: it also counts tasks waiting on disk",
      spark([]),
    ),
  ]);
}

function windowsRows(c, info, v) {
  const share = c.wslVm === null ? "" : `WSL VM ${pct(c.wslVm / info.cores)} of the machine`;
  const latency = Math.max(c.readLatency ?? 0, c.writeLatency ?? 0) * 1000;
  return [
    metric(
      v.cpu,
      "CPU",
      `${pct(c.busy ?? 0)} busy · ${c.queue ?? 0} waiting`,
      share,
      spark(history("windows", "cpu"), 100),
    ),
    metric(
      v.memory,
      "Memory",
      `${bytes((c.availableMB ?? 0) * 2 ** 20)} available · ${pct(c.committed ?? 0)} committed`,
      `of ${bytes(info.memTotal)}; the WSL VM's share counts as used`,
      spark(history("windows", "memory"), 100),
    ),
    metric(
      v.disk,
      "Disk I/O",
      `${pct(100 - (c.diskIdle ?? 100))} busy · ${latency.toFixed(1)} ms per request`,
      `${rate(c.diskRead ?? 0)} read · ${rate(c.diskWrite ?? 0)} write · queue ${(c.diskQueue ?? 0).toFixed(1)}`,
      spark(history("windows", "disk")),
    ),
    metric(
      "neutral",
      "Paging",
      `${rate((c.pagesOut ?? 0) * 4096)} to the page file`,
      `Page file ${pct(c.pageFile ?? 0)} used`,
      spark([]),
    ),
  ];
}

function windowsCard(windows) {
  const info = windows.info;
  const detail =
    info === null ? "" : `${info.name} · ${info.cores} cores · ${bytes(info.memTotal)}`;
  if (windows.counters === null || info === null || windows.verdicts === null) {
    const why = windows.error !== "" ? windows.error : "Starting typeperf, a few seconds…";
    return hostCard("Windows", detail, [el("p", {}, why)]);
  }
  return hostCard("Windows", detail, windowsRows(windows.counters, info, windows.verdicts));
}

function topRow(where, what, cpu, memory, disk) {
  return el(
    "tr",
    {},
    el("td", {}, where),
    el("td", {}, what),
    el("td", { class: "r num" }, cpu),
    el("td", { class: "r num" }, memory),
    el("td", { class: "r num" }, disk),
  );
}

function drawTop(state) {
  const rows = [
    ...state.top.linux.map((p) =>
      topRow(
        state.linux.name,
        p.session === "" ? p.what : `${p.what} — ${p.session}`,
        cores(p.cpu),
        bytes(p.rss),
        rate(p.disk),
      ),
    ),
    ...state.top.windows
      .filter((p) => p.cpu >= 0.05)
      .map((p) => topRow("Windows", p.name, cores(p.cpu), bytes(p.memory), "")),
  ];
  const empty = el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Nothing is busy."));
  $("top").replaceChildren(...(rows.length > 0 ? rows : [empty]));
}

function drawMachine(state) {
  $("verdict").className = `verdict ${state.headline.tone}`;
  $("headline").textContent = state.headline.text;
  const cards = [linuxCard(state.linux)];
  if (state.windows !== null) cards.push(windowsCard(state.windows));
  $("hosts").replaceChildren(...cards);
  drawTop(state);
}

function tile(key, value, detail, tone = "") {
  return el(
    "div",
    { class: `tile ${tone}` },
    el("div", { class: "k" }, key),
    el("div", { class: "v" }, value),
    el("div", { class: "d" }, detail),
  );
}

const WORKING = new Set(["working", "starting"]);

function drawTiles(report, state) {
  const working = report.sessions.filter((s) => WORKING.has(s.state)).length;
  const waiting = report.sessions.filter((s) => s.state === "waiting").length;
  const idle = report.sessions.filter((s) => s.state === "idle").length;
  const copies = report.mcp.reduce((sum, m) => sum + m.copies, 0);
  const cloud = state.cloud === null ? "" : ` · ${state.cloud.recent} cloud this hour`;
  const k = report.kinds;
  $("tiles").replaceChildren(
    tile("Processes", String(report.total.processes), `for ${report.sessions.length} sessions`),
    tile("Sessions", `${working} working`, `${waiting} waiting for you · ${idle} idle${cloud}`),
    tile(
      "MCP server copies",
      String(copies),
      `${k.mcp.processes} processes · ${bytes(k.mcp.rss)}`,
      copies > report.mcp.length ? "warning" : "",
    ),
    tile(
      "Memory",
      bytes(report.total.rss),
      `of ${bytes(state.linux.sample.memTotal)} in ${state.linux.name}`,
    ),
    tile(
      "CPU / disk",
      cores(report.total.cpu),
      `${rate(report.total.read)} read · ${rate(report.total.write)} write`,
    ),
  );
}

function line(title, count, how) {
  return el(
    "div",
    { class: "line" },
    el("span", {}, ...title),
    el("span", { class: "num" }, count),
    how && el("span", { class: "how" }, how),
  );
}

// In the order the bars stack them; each kind's colour is `--k-<key>` in style.css.
const KINDS = [
  ["claude", "claude", "one per session"],
  ["mcp", "MCP servers", "started by each claude"],
  ["tools", "Tools sessions run", "shells, tests, builds"],
  ["host", "Host", "prifly itself, its intent model and helpers"],
  ["relay", "Relays", "keep sessions alive through a host restart"],
];

/** A segment wider than this share carries its name and value; narrower ones only on hover. */
const LABEL_FROM = 9;

/** One bar: `field` of every kind, stacked in proportion. */
function segment(key, name, value, whole, format) {
  const share = whole > 0 ? (100 * value) / whole : 0;
  const node = el("div", {
    class: `seg k-${key}`,
    style: `width:${share}%`,
    title: `${name}: ${format(value)}`,
  });
  if (share > LABEL_FROM) node.append(el("span", {}, `${name} ${format(value)}`));
  return node;
}

/**
 * One bar: `field` of every kind, stacked in proportion. With `machine` — what
 * the rest of WSL uses and what is free — the bar is the whole of WSL, so
 * prifly's share of it shows; the free part is the empty track.
 */
function stack(report, label, field, format, machine) {
  const prifly = KINDS.reduce((total, [key]) => total + report.kinds[key][field], 0);
  const whole = machine === undefined ? prifly : machine.total;
  const segments = KINDS.map(([key, name]) =>
    segment(key, name, report.kinds[key][field], whole, format),
  );
  if (machine !== undefined) {
    const other = Math.max(0, machine.used - prifly);
    segments.push(segment("other", "Other programs", other, whole, format));
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

function drawKinds(report, state) {
  const legend = el(
    "div",
    { class: "legend" },
    ...KINDS.map(([key, name, how]) => {
      const u = report.kinds[key];
      return el(
        "div",
        { class: "lg" },
        el("i", { class: `k-${key}` }),
        el("span", {}, el("b", {}, name), el("small", {}, how)),
        el("span", { class: "num" }, `${u.processes} · ${bytes(u.rss)}`),
      );
    }),
    el(
      "div",
      { class: "lg" },
      el("i", { class: "k-other" }),
      el("span", {}, el("b", {}, "Other programs"), el("small", {}, "the rest of WSL")),
      el("span"),
    ),
    el(
      "div",
      { class: "lg" },
      el("i", { class: "k-free" }),
      el("span", {}, el("b", {}, "Free"), el("small", {}, "memory and CPU nobody uses")),
      el("span"),
    ),
  );
  const s = state.linux.sample;
  // Resident memory overlaps a little (shared pages), so prifly may sum past "used": capped in `stack`.
  const memory = { total: s.memTotal, used: s.memTotal - s.memAvailable };
  const cpu = { total: s.cores, used: (s.busy / 100) * s.cores };
  $("kinds").replaceChildren(
    stack(report, "Memory", "rss", bytes, memory),
    stack(report, "CPU", "cpu", (n) => `${n.toFixed(1)} cores`, cpu),
    stack(report, "Processes", "processes", String),
    legend,
  );
}

function mcpLine(m) {
  if (m.transport === "http") {
    return line(
      [el("b", {}, m.name), " ", el("span", { class: "chip" }, "shared")],
      "0 extra",
      "HTTP: one server for every session",
    );
  }
  const chip = el(
    "span",
    { class: `chip ${m.copies > 1 ? "many" : ""}` },
    `${m.copies} ${m.copies === 1 ? "copy" : "copies"}`,
  );
  const where = {
    user: "~/.claude.json, every project",
    local: "~/.claude.json, one folder",
    project: ".mcp.json",
    running: "not in a config read here",
  }[m.scope];
  const how = `stdio: one copy per session · ${where}${m.copies > 1 ? " · one shared HTTP server would do" : ""}`;
  return line([el("b", {}, m.name), " ", chip], `${m.processes} · ${bytes(m.rss)}`, how);
}

function drawMcp(report) {
  const rows = report.mcp.map(mcpLine);
  $("mcp").replaceChildren(...(rows.length > 0 ? rows : [el("p", {}, "No MCP servers run here.")]));
}

function sessionRow(s, maxCpu) {
  const state = el(
    "span",
    { class: `state ${WORKING.has(s.state) ? "working" : ""}` },
    el("i"),
    s.state,
  );
  const bar = el(
    "span",
    { class: "bars" },
    el("b", { style: `width:${Math.round((100 * s.cpu) / maxCpu)}%` }),
  );
  const counts = new Map();
  for (const name of s.mcp) counts.set(name, (counts.get(name) ?? 0) + 1);
  const chips = [...counts].map(([name, n]) =>
    el("span", { class: "chip" }, n > 1 ? `${name} ×${n}` : name),
  );
  return el(
    "tr",
    {},
    el("td", {}, s.title),
    el("td", {}, state),
    el("td", { class: "r num" }, String(s.processes)),
    el("td", { class: "r num" }, s.cpu.toFixed(1), bar),
    el("td", { class: "r num" }, bytes(s.rss)),
    el("td", { class: "r num" }, `${rate(s.read)} / ${rate(s.write)}`),
    el("td", {}, ...(chips.length > 0 ? chips : [el("span", { class: "muted" }, "none")])),
    el("td", {}, s.doing === "" ? el("span", { class: "muted" }, "—") : s.doing),
  );
}

function group(title, rows) {
  if (rows.length === 0) return [];
  const rss = rows.reduce((sum, s) => sum + s.rss, 0);
  const procs = rows.reduce((sum, s) => sum + s.processes, 0);
  return [
    el(
      "tr",
      { class: "group" },
      el("td", { colspan: "8" }, `${title} · ${rows.length} — ${procs} processes, ${bytes(rss)}`),
    ),
  ];
}

function drawSessions(report, state) {
  const maxCpu = Math.max(1, ...report.sessions.map((s) => s.cpu));
  const working = report.sessions.filter((s) => WORKING.has(s.state));
  const waiting = report.sessions.filter((s) => s.state === "waiting");
  const idle = report.sessions.filter((s) => s.state === "idle");
  const other = report.sessions.filter(
    (s) => !WORKING.has(s.state) && s.state !== "waiting" && s.state !== "idle",
  );
  const rows = [];
  for (const [title, list] of [
    ["Working", working],
    ["Waiting for you", waiting],
    ["Idle at their prompt", idle],
    ["Other", other],
  ]) {
    rows.push(...group(title, list), ...list.map((s) => sessionRow(s, maxCpu)));
  }
  if (state.cloud !== null) {
    const text = `Cloud · ${state.cloud.recent} active this hour, ${state.cloud.total} in all — they run on Anthropic's machines, with no processes here`;
    rows.push(el("tr", { class: "group" }, el("td", { colspan: "8" }, text)));
  }
  $("sessions").replaceChildren(...rows);
}

function drawPrifly(state) {
  const report = state.prifly;
  if (report === null) return;
  drawTiles(report, state);
  drawKinds(report, state);
  drawMcp(report);
  drawSessions(report, state);
}

function draw(state) {
  last = state;
  $("error").hidden = true;
  drawMachine(state);
  drawPrifly(state);
}

/** Asks for the trailing period's averages and draws them; resolves with the seconds they cover. */
async function refresh(seconds) {
  try {
    const response = await fetch(`api/status?window=${seconds}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? response.statusText);
    draw(body);
    return body.covered;
  } catch (error) {
    $("error").hidden = false;
    $("error").textContent = String(error.message ?? error);
    return undefined;
  }
}

function showTab(tab) {
  for (const section of document.querySelectorAll("section")) section.hidden = section.id !== tab;
  for (const button of document.querySelectorAll(".tab"))
    button.setAttribute("aria-selected", String(button.dataset.tab === tab));
}

for (const button of document.querySelectorAll(".tab")) {
  button.addEventListener("click", () => {
    location.hash = button.dataset.tab;
  });
}
addEventListener("hashchange", () =>
  showTab(location.hash.slice(1) === "prifly" ? "prifly" : "machine"),
);
showTab(location.hash.slice(1) === "prifly" ? "prifly" : "machine");

const LOOK = {
  "--background": "--bg",
  "--foreground": "--fg",
  "--card": "--card",
  "--muted": "--muted",
  "--muted-foreground": "--muted-fg",
  "--border": "--border",
  "--accent": "--accent",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};
addEventListener("message", (event) => {
  if (event.data?.type !== "prifly-look") return;
  document.documentElement.classList.toggle("dark", event.data.dark === true);
  for (const [theirs, ours] of Object.entries(LOOK)) {
    const value = event.data.tokens?.[theirs];
    if (typeof value === "string" && value !== "")
      document.documentElement.style.setProperty(ours, value);
  }
  if (last !== null) draw(last);
});

startEvery(refresh);
