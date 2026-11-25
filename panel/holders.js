// The "Who holds Windows' memory" card on the Memory tab, under the treemap
// (memtab.js), whose promised view it gives as a table: every Windows
// process's commit (its private bytes, in RAM or trimmed out of it), grouped by
// what it is, with what is in RAM beside it, and the commit no process holds.
// Task Manager's Memory column is RAM alone, so a trimmed process looks small.

import { $, bytes, el } from "./format.js";

/** The groups the reader opened, by key: kept across the redraw every second. */
const opened = new Set();

/** How many of a group's processes an opened row lists. */
const LISTED = 12;

let last = null;

/** One group: its name, how many processes, its commit with a bar, and what is in RAM. */
function groupRow(g, widest) {
  const open = opened.has(g.key);
  const bar = el(
    "span",
    { class: "bars" },
    el("b", { style: `width:${Math.round((100 * g.commit) / widest)}%` }),
  );
  const row = el(
    "tr",
    { class: "holder", "aria-expanded": String(open), title: "Show its processes" },
    el("td", {}, el("span", { class: "caret" }, open ? "▾" : "▸"), g.name),
    el("td", { class: "r num" }, String(g.processes.length)),
    el("td", { class: "r num" }, bytes(g.commit), bar),
    el("td", { class: "r num" }, bytes(g.ram)),
  );
  row.addEventListener("click", () => {
    if (opened.has(g.key)) opened.delete(g.key);
    else opened.add(g.key);
    if (last !== null) drawHolders(last);
  });
  if (!open) return [row];
  const shown = g.processes
    .slice(0, LISTED)
    .map((p) =>
      el(
        "tr",
        { class: "held" },
        el("td", {}, `${p.name} `, el("span", { class: "muted" }, `pid ${p.pid}`)),
        el("td"),
        el("td", { class: "r num" }, bytes(p.commit)),
        el("td", { class: "r num" }, bytes(p.ram)),
      ),
    );
  const more = g.processes.length - LISTED;
  if (more > 0) {
    shown.push(
      el("tr", { class: "held" }, el("td", { colspan: "4", class: "muted" }, `and ${more} more`)),
    );
  }
  return [row, ...shown];
}

/** A row for commit no process holds: muted, with what it is under its name. */
function unheldRow(name, how, commit) {
  return el(
    "tr",
    { class: "unheld" },
    el("td", {}, name, el("small", {}, how)),
    el("td", { class: "r none" }, "—"),
    el("td", { class: "r num" }, bytes(commit)),
    el("td", { class: "r none" }, "—"),
  );
}

function body(h) {
  if (h.reading) return [el("p", {}, "Reading Windows' process list…")];
  if (h.error !== "" && h.groups.length === 0) return [el("p", { class: "error" }, h.error)];
  const widest = Math.max(1, ...h.groups.map((g) => g.commit));
  const rows = h.groups.flatMap((g) => groupRow(g, widest));
  if (h.pools !== null) {
    rows.push(
      unheldRow(
        "Kernel pools",
        `Windows' own: paged ${bytes(h.pools.paged)} · non-paged ${bytes(h.pools.nonpaged)}`,
        h.pools.paged + h.pools.nonpaged,
      ),
    );
  }
  if (h.shared !== null) {
    rows.push(
      unheldRow(
        "Shared sections, page tables and the rest",
        "committed, but in no process's own count and no pool",
        h.shared,
      ),
    );
  }
  return [
    el(
      "table",
      { class: "holders" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "What"),
          el("th", { class: "r" }, "Processes"),
          el("th", { class: "r" }, "Committed"),
          el("th", { class: "r" }, "In RAM"),
        ),
      ),
      el("tbody", {}, ...rows),
    ),
  ];
}

/** Draws the card into `#holders`; hidden where there is no Windows (`state.holders` null). */
export function drawHolders(state) {
  last = state;
  const h = state.holders ?? null;
  $("holders").hidden = h === null;
  if (h === null) return;
  const total = h.reading || h.committed === null ? "" : `${bytes(h.committed)} committed · `;
  const detail = `${total}by commit, not RAM: Windows trims what a process holds out of RAM, and it stays committed`;
  $("holders").replaceChildren(
    el(
      "div",
      { class: "card", "data-part": "holders" },
      el("header", {}, el("h2", {}, "Who holds Windows' memory"), el("span", {}, detail)),
      ...body(h),
    ),
  );
}
