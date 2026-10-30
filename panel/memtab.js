// The Memory tab: Windows' memory as a treemap, each tile as big as what it
// holds (`state.memoryMap`, from `memory-map.ts`). Two views of the same
// machine: what Windows has promised (commit, which is what runs out) and what
// sits in RAM now. In the promised view a tile's solid part is what of it is in
// RAM; the striped rest Windows has trimmed out (compressed, in the page file,
// or never touched). A click on a tile says what it is, on the right.

import { $, bytes, el } from "./format.js";

/** Which view is shown, and which tile is picked: kept across the redraw every second. */
let view = "commit";
let picked = null;
let last = null;

/** The tile each view opens on, where it has one. */
const FIRST = { commit: "wsl", ram: "store" };

/** Below this width the detail goes under the map, not beside it. */
const NARROW = 760;
const DETAIL_WIDTH = 330;

/** How far from square a row of `areas` laid along `side` is: the squarified layout keeps it low. */
function worst(areas, side) {
  const total = areas.reduce((s, a) => s + a, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((side * side * max) / (total * total), (total * total) / (side * side * min));
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk 2000): lays `items` (each with
 * a `value`) into the rectangle `r`, rows chosen to keep tiles near square.
 */
export function squarify(items, r) {
  const total = items.reduce((s, i) => s + Math.max(0, i.value), 0);
  if (total <= 0 || r.w <= 0 || r.h <= 0) return [];
  const scale = (r.w * r.h) / total;
  const queue = items
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((item) => ({ item, area: item.value * scale }));
  const out = [];
  let rect = { ...r };
  while (queue.length > 0) {
    const wide = rect.w >= rect.h;
    const side = wide ? rect.h : rect.w;
    const row = [queue.shift()];
    const areas = () => row.map((x) => x.area);
    while (queue.length > 0 && worst([...areas(), queue[0].area], side) <= worst(areas(), side))
      row.push(queue.shift());
    const thick = areas().reduce((s, a) => s + a, 0) / side;
    let at = 0;
    for (const x of row) {
      const len = x.area / thick;
      out.push(
        wide
          ? { item: x.item, x: rect.x, y: rect.y + at, w: thick, h: len }
          : { item: x.item, x: rect.x + at, y: rect.y, w: len, h: thick },
      );
      at += len;
    }
    rect = wide
      ? { x: rect.x + thick, y: rect.y, w: rect.w - thick, h: rect.h }
      : { x: rect.x, y: rect.y + thick, w: rect.w, h: rect.h - thick };
  }
  return out;
}

/** What of a promised tile is in RAM, never more than the tile; null where no counter says. */
const inRam = (item) => (item.ram === undefined ? null : Math.min(item.ram, item.value));

/** A tile's name and size, and in the promised view what of it is in RAM, where it fits. */
function label(item, t) {
  if (t.w <= 70 || t.h <= 30) return null;
  const ram = view === "commit" && item.children === undefined ? inRam(item) : null;
  return el(
    "div",
    { class: "mlabel" },
    el("b", {}, item.name),
    ` ${bytes(item.value)}`,
    ram !== null && ram < 0.95 * item.value ? el("small", {}, `${bytes(ram)} in RAM`) : null,
  );
}

/** One tile: its colour, its children inside it, the part of it in RAM solid and the rest striped. */
function tileNode(t) {
  const { item } = t;
  const ram = inRam(item);
  const node = el("div", {
    class: `mtile ${item.colour}${picked === item.key ? " picked" : ""}${item.children ? " group" : ""}`,
    style: `left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px`,
    title: `${item.name}: ${bytes(item.value)}${ram === null ? "" : ` · ${bytes(ram)} in RAM`}`,
  });
  if (view === "commit" && ram !== null && ram < item.value && !item.children) {
    node.append(el("div", { class: "trimmed", style: `height:${100 * (1 - ram / item.value)}%` }));
  }
  if (item.children && t.w > 40 && t.h > 40) {
    const pad = 18;
    for (const c of squarify(item.children, { x: 2, y: pad, w: t.w - 4, h: t.h - pad - 2 }))
      node.append(tileNode(c));
  }
  const text = label(item, t);
  if (text !== null) node.append(text);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    picked = item.key;
    if (last !== null) drawMemoryTab(last);
  });
  return node;
}

function find(items, key) {
  for (const i of items) {
    if (i.key === key) return i;
    const inner = i.children ? find(i.children, key) : null;
    if (inner !== null) return inner;
  }
  return null;
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

/** The side panel: what the picked tile is, in words. */
function detail(item) {
  if (item === null)
    return el("aside", { class: "mdetail" }, el("p", { class: "muted" }, "Click a tile."));
  const ram = view === "commit" ? inRam(item) : null;
  return el(
    "aside",
    { class: "mdetail" },
    el("h3", {}, item.name),
    el("div", { class: "num big" }, bytes(item.value)),
    ram === null
      ? null
      : el("p", { class: "num" }, `${bytes(ram)} in RAM · ${bytes(item.value - ram)} trimmed out`),
    el("p", {}, item.why),
    item.children ? childTable(item.children) : null,
  );
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
  const room = $("memtab").clientWidth || 1100;
  const narrow = room < NARROW;
  const width = Math.max(280, narrow ? room - 28 : room - DETAIL_WIDTH - 44);
  const height = Math.round(Math.min(520, Math.max(300, width * 0.6)));
  const map = el("div", { class: "mmap", style: `width:${width}px;height:${height}px` });
  for (const t of squarify(items, { x: 0, y: 0, w: width, h: height })) map.append(tileNode(t));
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
      detail(picked === null ? null : find(items, picked)),
    ),
  );
}

/**
 * Draws the tab into `#memtab`. Where there is no Windows (`memoryMap` null)
 * the tab's button is hidden, and the tab, reached by its link, says so.
 */
export function drawMemoryTab(state) {
  last = state;
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
  $("memtab").replaceChildren(mapCard(m, state));
}

/** Draws the tab again, as when it is shown: hidden, it had no width to lay out to. */
export function redrawMemoryTab() {
  if (last !== null) drawMemoryTab(last);
}
