// The Memory tab: Windows' memory as a treemap, each tile as big as what it
// holds (`state.memoryMap`, from `memory-map.ts`). Two views of the same
// machine: what Windows has promised (commit, which is what runs out) and what
// sits in RAM now. In the promised view a tile's solid part is what of it is in
// RAM; the striped rest Windows has trimmed out (compressed, in the page file,
// or never touched). A click on a tile says what it is, on the right. The
// treemap, the detail and the strip are treemap.js's, shared with the graphics
// card's section under it (gpumem.js).

import { $, bytes, el } from "./format.js";
import { drawGpuMemory } from "./gpumem.js";
import { detail, find, layoutIn, strip, treemap } from "./treemap.js";

/** Which view is shown, and which tile is picked: kept across the redraw every second. */
let view = "commit";
let picked = null;
let last = null;

/** The tile each view opens on, where it has one. */
const FIRST = { commit: "wsl", ram: "store" };

/** What of a promised tile is in RAM, never more than the tile; null where no counter says. */
const inRam = (item) => (item.ram === undefined ? null : Math.min(item.ram, item.value));

/** The label's small line: in the promised view, what of a tile is in RAM where it is not all of it. */
function ramNote(item) {
  const ram = view === "commit" && item.children === undefined ? inRam(item) : null;
  return ram !== null && ram < 0.95 * item.value ? `${bytes(ram)} in RAM` : null;
}

/** In the promised view, the part of a tile trimmed out of RAM, striped. */
function trimmed(item, node) {
  const ram = inRam(item);
  if (view === "commit" && ram !== null && ram < item.value && !item.children) {
    node.append(el("div", { class: "trimmed", style: `height:${100 * (1 - ram / item.value)}%` }));
  }
}

function title(item) {
  const ram = inRam(item);
  return `${item.name}: ${bytes(item.value)}${ram === null ? "" : ` · ${bytes(ram)} in RAM`}`;
}

/** The picked tile's children, a row each: name, size and, promised, what is in RAM. */
function childTable(children) {
  return el(
    "table",
    {},
    ...children.map((c) =>
      el(
        "tr",
        {},
        el("td", {}, c.name),
        el("td", { class: "r num" }, bytes(c.value)),
        el(
          "td",
          { class: "r num muted" },
          view === "commit" && inRam(c) !== null ? `${bytes(inRam(c))} in RAM` : "",
        ),
      ),
    ),
  );
}

/** Under the picked tile's size, promised: what of it is in RAM and what is trimmed out. */
function ramLines(item) {
  const ram = view === "commit" ? inRam(item) : null;
  return ram === null
    ? []
    : [el("p", { class: "num" }, `${bytes(ram)} in RAM · ${bytes(item.value - ram)} trimmed out`)];
}

/** The header's line: promised against the limit, or RAM in use and available. */
function totals(m) {
  if (view === "commit") {
    if (m.committed === null) return "";
    if (m.limit === null) return `${bytes(m.committed)} promised`;
    const file =
      m.limit > m.ramTotal
        ? ` (${bytes(m.ramTotal)} RAM + ${bytes(m.limit - m.ramTotal)} page file)`
        : "";
    return `${bytes(m.committed)} promised of a ${bytes(m.limit)} limit${file}`;
  }
  if (m.available === null) return `${bytes(m.ramTotal)} of RAM`;
  return `${bytes(m.ramTotal)} of RAM: ${bytes(m.ramTotal - m.available)} in use, ${bytes(m.available)} available`;
}

function legend(m) {
  if (view === "commit") {
    return el(
      "div",
      { class: "mlegend" },
      el("span", { class: "sw solid" }),
      "in RAM",
      el("span", { class: "sw striped" }),
      "trimmed out of RAM: compressed, in the page file, or never touched",
    );
  }
  const scaled =
    m.scale !== null && m.scale < 1
      ? `Programs' working sets are scaled to ${Math.round(m.scale * 100)} % so that the map adds up to RAM in use: a page several programs share counts once for each of them.`
      : "Each tile is physical memory.";
  return el("div", { class: "mlegend" }, scaled);
}

function viewButton(key, text, state) {
  const b = el("button", { type: "button", "aria-pressed": String(view === key) }, text);
  b.addEventListener("click", () => {
    view = key;
    picked = null;
    drawMemoryTab(state);
  });
  return b;
}

/** The treemap card for `m`, laid out to the tab's width. */
function mapCard(m, state) {
  const items = view === "commit" ? m.commit : m.ram;
  if (picked === null || find(items, picked) === null)
    picked = find(items, FIRST[view]) === null ? (items[0]?.key ?? null) : FIRST[view];
  const { narrow, width, height } = layoutIn($("memtab").clientWidth || 1100);
  const map = treemap(items, width, height, {
    picked,
    pick: (key) => {
      picked = key;
      if (last !== null) drawMemoryTab(last);
    },
    note: ramNote,
    title,
    decorate: trimmed,
  });
  return el(
    "div",
    { class: "card", "data-part": "memtab" },
    el(
      "header",
      {},
      el("h2", {}, "Windows memory"),
      el(
        "fieldset",
        { class: "every mview", "aria-label": "View" },
        viewButton("commit", "Promised (commit)", state),
        viewButton("ram", "In RAM now", state),
      ),
      el("span", {}, totals(m)),
    ),
    m.note === "" ? null : el("p", { class: "mnote muted" }, m.note),
    el(
      "div",
      { class: `mbody${narrow ? " narrow" : ""}` },
      el("div", {}, map, legend(m)),
      detail(picked === null ? null : find(items, picked), ramLines, childTable),
    ),
  );
}

/** The history field each reading's sparkline draws (history.ts). */
const SERIES = { commit: "committed", trimming: "trimming", free: "free" };

/**
 * The pressure strip: three readings of how hard Windows works to make room,
 * each coloured as the memory verdict colours it, with the last hour beside it.
 */
function pressureStrip(m, state) {
  const valuesOf = (r) =>
    (state.history ?? [])
      .map((point) => point.windows?.[SERIES[r.key]])
      .filter((v) => typeof v === "number");
  return strip(m.pressure ?? [], valuesOf, "pressure");
}

/** Windows' part of the tab: the strip and the treemap, or a line on why there are none. */
function drawWindows(state) {
  const m = state.memoryMap ?? null;
  $("memory-tab").hidden = m === null;
  if (m === null) {
    $("memtab").replaceChildren(
      el("p", { class: "muted" }, "There is no Windows on this machine."),
    );
    return;
  }
  if (m.reading) {
    $("memtab").replaceChildren(el("p", { class: "muted" }, "Reading Windows' memory…"));
    return;
  }
  $("memtab").replaceChildren(pressureStrip(m, state), mapCard(m, state));
}

/**
 * Draws the tab: Windows' memory into `#memtab` and the graphics card's under
 * it. Where there is no Windows (`memoryMap` null) the tab's button is
 * hidden, and the tab, reached by its link, says so.
 */
export function drawMemoryTab(state) {
  last = state;
  drawWindows(state);
  drawGpuMemory(state);
}

/** Draws the tab again, as when it is shown: hidden, it had no width to lay out to. */
export function redrawMemoryTab() {
  if (last !== null) drawMemoryTab(last);
}
