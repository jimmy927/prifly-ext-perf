// How the Performance window writes numbers and builds its elements.

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

/** One row of a card: a title, a number on the right and a muted line under both. */
export function line(title, count, how) {
  return el(
    "div",
    { class: "line" },
    el("span", {}, ...title),
    el("span", { class: "num" }, count),
    how && el("span", { class: "how" }, how),
  );
}

/** In 1024s, as Windows and `.wslconfig` count: a 24 GB limit reads 24 GB. */
export function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value >= 100 || unit === 0 ? Math.round(value).toString() : value.toPrecision(2);
  return `${shown} ${units[unit]}`;
}

export const rate = (n) => (n < 1000 ? "0" : `${bytes(n)}/s`);
export const pct = (n) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
export const cores = (n) => (n < 0.05 ? "0" : `${n.toFixed(1)} cores`);

/** A five-minute line of `values`, scaled to `max` (or to its own peak). */
export function spark(values, max) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", "0 0 132 28");
  if (values.length < 2) return svg;
  const top = max ?? Math.max(...values, 1);
  const step = 132 / (values.length - 1);
  const d = values
    .map(
      (v, i) =>
        `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${(26 - (24 * Math.min(v, top)) / top).toFixed(1)}`,
    )
    .join(" ");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
