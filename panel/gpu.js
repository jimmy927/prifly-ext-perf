// The graphics card: who holds its memory, as one bar, and what grey words need of it.

import { el } from "./format.js";

const mib = (n) => (n >= 1000 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);

function segment(kind, size, total, title) {
  return el("b", { class: kind, style: `width:${(100 * size) / total}%`, title });
}

function bar(gpu) {
  const used = gpu.total - gpu.free;
  // Who holds it is unknown: the used part is one stretch, not guessed at.
  const parts =
    gpu.unknown === ""
      ? gpu.holders.map((h) => segment(h.kind, h.mib, gpu.total, `${h.name} ${mib(h.mib)}`))
      : [segment("g-unknown", used, gpu.total, `In use ${mib(used)}`)];
  parts.push(el("b", { class: "free", style: `width:${(100 * gpu.free) / gpu.total}%` }));
  const need = el("i", {
    class: "need",
    style: `left:${(100 * (gpu.total - gpu.greyNeeds)) / gpu.total}%`,
    title: "Grey words start when free memory reaches this line",
  });
  return el("div", { class: "gpubar" }, ...parts, need);
}

function holderRow(h) {
  return el(
    "tr",
    {},
    el("td", {}, el("span", { class: `sw ${h.kind}` }), h.where),
    el("td", {}, h.name),
    el("td", { class: "muted" }, h.what),
    el("td", { class: "r num" }, mib(h.mib)),
  );
}

function table(holders) {
  const head = ["Where", "What", "Why", "Memory"].map((text, i) =>
    el("th", { class: i === 3 ? "r" : "" }, text),
  );
  return el(
    "table",
    {},
    el("thead", {}, el("tr", {}, ...head)),
    el("tbody", {}, ...holders.map(holderRow)),
  );
}

function header(detail) {
  return el("header", {}, el("h2", {}, "Graphics card"), el("span", {}, detail));
}

function metric(gpu) {
  const short = gpu.free < gpu.greyNeeds;
  const verdict = short
    ? `Grey words off: ${mib(gpu.greyNeeds - gpu.free)} short of the ${mib(gpu.greyNeeds)} they need`
    : "Grey words fit";
  return el(
    "div",
    { class: `metric ${short ? "warning" : "good"}` },
    el("span", { class: "dot" }),
    el("span", { class: "name" }, "Memory"),
    el(
      "span",
      { class: "read" },
      el("span", { class: "num" }, `${mib(gpu.free)} free of ${mib(gpu.total)}`),
      el("small", {}, verdict),
    ),
    el("span"),
  );
}

/** The card, or null where there is no NVIDIA card; `{loading: true}` until the first read. */
export function gpuCard(gpu) {
  if (gpu === null || gpu === undefined) return null;
  if (gpu.loading) {
    return el("div", { class: "card gpu" }, header(""), el("p", {}, "Reading the graphics card…"));
  }
  const bottom =
    gpu.unknown === ""
      ? table(gpu.holders)
      : el("p", {}, `Who holds it is unknown: ${gpu.unknown}`);
  return el(
    "div",
    { class: "card gpu" },
    header(`${gpu.name} · ${mib(gpu.total)}`),
    metric(gpu),
    el("div", { class: "gpurow" }, bar(gpu)),
    bottom,
  );
}
