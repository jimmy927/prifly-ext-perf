// What the Memory tab's maps share: the squarified treemap, its tiles and
// their labels, the detail on the right of what a click picked, the layout to
// the tab's width, and the pressure strip of readings with an hour's line.
// Windows' memory (memtab.js) and the graphics card's (gpumem.js) each say
// what their tiles add: memtab the striped part trimmed out of RAM, gpumem
// what grey words need on the free tile.

import { bytes, el, spark } from "./format.js";

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

/** The tile of `key` in `items` or their children; null where there is none. */
export function find(items, key) {
  for (const i of items) {
    if (i.key === key) return i;
    const inner = i.children ? find(i.children, key) : null;
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * A label's measures, as `.mlabel` in memtab.css draws it: px per character
 * of the bold name, of the size after it and of the small line (wide enough
 * for most words of the system font), each line's height, and the room its
 * insets leave across and down.
 */
const FIT = { name: 7.4, size: 6.8, note: 6.3, line: 16, small: 15, across: 12, down: 6 };
/** A group's children start this far down: its label has one line there. */
const GROUP_PAD = 18;

/**
 * How many lines `words` (each `[text, px per char]`) take wrapped to
 * `width`, breaking at spaces and after hyphens as the browser does;
 * Infinity where one piece is wider than the line.
 */
function linesOf(words, width) {
  let lines = 1;
  let at = 0;
  for (const [text, px] of words) {
    for (const piece of text.split(" ").flatMap((w) => w.split(/(?<=-)/))) {
      const w = piece.length * px;
      if (w > width) return Number.POSITIVE_INFINITY;
      const gap = at === 0 ? 0 : px / 2;
      if (at + gap + w > width) {
        lines += 1;
        at = w;
      } else at += gap + w;
    }
  }
  return lines;
}

/**
 * What of a label fits a `w`×`h` tile: "full" (name and size, and the small
 * line under them), "main" (name and size), or "none". A group's label has
 * its one line above its children and no small line.
 */
export function labelFit(name, size, note, w, h, group = false) {
  const across = w - FIT.across;
  const main = linesOf(
    [
      [name, FIT.name],
      [size, FIT.size],
    ],
    across,
  );
  if (group) return main === 1 && h >= GROUP_PAD ? "main" : "none";
  const mainHeight = main * FIT.line + FIT.down;
  if (!(mainHeight <= h)) return "none";
  if (note === null || note === "") return "main";
  const small = linesOf([[note, FIT.note]], across);
  return mainHeight + small * FIT.small <= h ? "full" : "main";
}

/**
 * A tile's name and size, and the map's own line under them (`opts.note`),
 * as much of them as fits (`labelFit`); none where the name does not fit:
 * the hover text and the detail still name it.
 */
function label(item, t, opts) {
  const note = opts.note?.(item) ?? null;
  const size = bytes(item.value);
  const fit = labelFit(item.name, size, note, t.w, t.h, item.children !== undefined);
  if (fit === "none") return null;
  return el(
    "div",
    { class: "mlabel" },
    el("b", {}, item.name),
    ` ${size}`,
    fit === "full" ? el("small", {}, note) : null,
  );
}

/** One tile: its colour, what the map draws on it (`opts.decorate`), its children inside it. */
function tileNode(t, opts) {
  const { item } = t;
  const node = el("div", {
    class: `mtile ${item.colour}${opts.picked === item.key ? " picked" : ""}${item.children ? " group" : ""}`,
    style: `left:${t.x}px;top:${t.y}px;width:${t.w}px;height:${t.h}px`,
    title: opts.title?.(item) ?? `${item.name}: ${bytes(item.value)}`,
  });
  opts.decorate?.(item, node);
  if (item.children && t.w > 40 && t.h > 40) {
    const pad = GROUP_PAD;
    for (const c of squarify(item.children, { x: 2, y: pad, w: t.w - 4, h: t.h - pad - 2 }))
      node.append(tileNode(c, opts));
  }
  const text = label(item, t, opts);
  if (text !== null) node.append(text);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    opts.pick(item.key);
  });
  return node;
}

/**
 * The map's size in `room`, the width its container has: the detail beside
 * it, or under it where the room is narrow.
 */
export function layoutIn(room) {
  const narrow = room < NARROW;
  const width = Math.max(280, narrow ? room - 28 : room - DETAIL_WIDTH - 44);
  const height = Math.round(Math.min(520, Math.max(300, width * 0.6)));
  return { narrow, width, height };
}

/**
 * The treemap of `items` laid out to `width`×`height`. `opts`: `picked`, the
 * picked tile's key; `pick(key)`, called on a click; and, optional, `note`
 * (the label's small line), `title` (the hover text) and `decorate(item,
 * node)`, which draws on a tile.
 */
export function treemap(items, width, height, opts) {
  const map = el("div", { class: "mmap", style: `width:${width}px;height:${height}px` });
  for (const t of squarify(items, { x: 0, y: 0, w: width, h: height }))
    map.append(tileNode(t, opts));
  return map;
}

/**
 * The side panel: what the picked tile is, in words. `extra(item)` gives the
 * lines under its size, `children(list)` the table of its children.
 */
export function detail(item, extra = () => [], children = null) {
  if (item === null)
    return el("aside", { class: "mdetail" }, el("p", { class: "muted" }, "Click a tile."));
  return el(
    "aside",
    { class: "mdetail" },
    el("h3", {}, item.name),
    el("div", { class: "num big" }, bytes(item.value)),
    ...extra(item),
    el("p", {}, item.why),
    item.children && children !== null ? children(item.children) : null,
  );
}

/**
 * A pressure strip: readings side by side (`name`, `main`, `small`, `means`,
 * `tone`, `ceiling`), each with its last hour, `valuesOf(reading)`, as a line.
 * A reading with no counter shows "—" and no colour; no history, an empty line.
 */
export function strip(readings, valuesOf, part) {
  return el(
    "div",
    { class: "card pressure", "data-part": part },
    ...readings.map((r) => {
      const values = valuesOf(r);
      return el(
        "div",
        { class: `pread ${r.tone ?? "neutral"}` },
        el("span", { class: "pname" }, r.name),
        el("span", { class: "pvalue" }, r.main, r.small === "" ? null : el("small", {}, r.small)),
        el("span", { class: "pmeans muted" }, r.means),
        spark(values, Math.max(r.ceiling, ...values)),
      );
    }),
  );
}
