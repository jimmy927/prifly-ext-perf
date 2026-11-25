// The Memory tab's graphics card section, under Windows' treemap: the card's
// dedicated memory as a treemap of who holds it (`state.gpuMap`, from
// `gpu-map.ts`: prifly's model workers a tile per model, the WSL VM's
// remainder, each Windows program, and free) and a pressure strip above it.
// The free tile marks, dashed, what dictation's grey words need to start.
// Same treemap, detail and strip as Windows' (treemap.js).

import { $, el } from "./format.js";
import { detail, find, layoutIn, strip, treemap } from "./treemap.js";

/** The picked tile, kept across the redraw every second; the free tile until the reader picks. */
let picked = "gpu:free";
let last = null;

const size = (n) => {
  const mib = n / 2 ** 20;
  return mib >= 1000 ? `${(mib / 1024).toFixed(1)} GB` : `${Math.round(mib)} MB`;
};

/** On the free tile, what grey words need to start, dashed: past its top where free is short of it. */
function needMark(item, node) {
  const grey = item.grey;
  if (grey === undefined || grey.state === "on") return;
  const short = grey.needs > item.value;
  node.classList.add(short ? "gshort" : "gfits");
  const height = Math.min(100, (100 * grey.needs) / item.value);
  node.append(el("div", { class: "gneed", style: `height:${height}%` }));
}

function legend(g) {
  if (g.grey === "on") return el("div", { class: "mlegend" }, "Grey words are on.");
  return el(
    "div",
    { class: "mlegend" },
    el("span", { class: "sw gdash" }),
    `on the free tile, the ${size(g.greyNeeds)} grey words need to start`,
  );
}

function mapCard(g) {
  if (find(g.tiles, picked) === null) picked = g.tiles[0]?.key ?? null;
  const { narrow, width, height } = layoutIn($("gpumem").clientWidth || 1100);
  const map = treemap(g.tiles, width, height, {
    picked,
    pick: (key) => {
      picked = key;
      if (last !== null) drawGpuMemory(last);
    },
    note: (item) => item.grey?.label ?? null,
    decorate: needMark,
  });
  return el(
    "div",
    { class: "card", "data-part": "gpumem" },
    el(
      "header",
      {},
      el("h2", {}, "Graphics card memory"),
      el("span", {}, `${g.name} · ${size(g.total - g.free)} in use of ${size(g.total)}`),
    ),
    g.note === "" ? null : el("p", { class: "mnote muted" }, g.note),
    el(
      "div",
      { class: `mbody${narrow ? " narrow" : ""}` },
      el("div", {}, map, legend(g)),
      detail(picked === null ? null : find(g.tiles, picked), (item) => [
        el("p", { class: "num" }, item.sub),
      ]),
    ),
  );
}

/**
 * Draws the section into `#gpumem`: a line where there is no NVIDIA card or
 * until the first read, else the strip and the treemap.
 */
export function drawGpuMemory(state) {
  last = state;
  const g = state.gpuMap ?? null;
  const into = $("gpumem");
  if (into === null) return;
  if (g === null) {
    into.replaceChildren(el("p", { class: "muted" }, "No NVIDIA graphics card on this machine."));
    return;
  }
  if (g.loading) {
    into.replaceChildren(el("p", { class: "muted" }, "Reading the graphics card…"));
    return;
  }
  into.replaceChildren(
    strip(g.readings, (r) => r.series, "gpupressure"),
    mapCard(g),
  );
}
