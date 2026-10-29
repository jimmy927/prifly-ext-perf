// Windows memory on the Machine tab: commit charge as the headline, every
// check it was judged by, the paging row's soft faults and compression store,
// and the kernel pools with their biggest tags.

import { bytes, el, pct, perSecond, rate } from "./format.js";

const GiB = 2 ** 30;

/** "1.0 GB, +120 MB/min": the compression store's size, and how fast it grew over the last minute. */
function compressionRead(compressed, growth) {
  if (growth === null || growth === undefined) return bytes(compressed);
  const sign = growth < 0 ? "−" : "+";
  return `${bytes(compressed)}, ${sign}${bytes(Math.abs(growth))}/min`;
}

/** The paging row's reading: page-file writes, and the trimming that never reaches the page file. */
export function pagingRead(c, compressed, growth) {
  const faults =
    c.transitionFaults === null ? "" : ` · ${perSecond(c.transitionFaults)} transition faults`;
  const small = [
    `Page file ${pct(c.pageFile ?? 0)} used`,
    c.demandZeroFaults === null ? null : `${perSecond(c.demandZeroFaults)} demand-zero faults`,
    compressed === null ? null : `compression store ${compressionRead(compressed, growth)}`,
  ];
  return {
    main: `${rate((c.pagesOut ?? 0) * 4096)} to the page file${faults}`,
    small: small.filter((part) => part !== null).join(" · "),
  };
}

/**
 * The memory row's reading: commit charge against its limit (RAM plus the page
 * file), which is what runs out; available memory under it. A reading Windows
 * did not give is left out, never shown as 0.
 */
export function memoryRead(c, info) {
  const limitKnown = c.committedBytes !== null && c.commitLimit !== null && c.commitLimit > 0;
  const share = c.committed ?? (limitKnown ? (100 * c.committedBytes) / c.commitLimit : null);
  const percent = share === null ? "" : `${Math.round(share)} %`;
  const main = limitKnown
    ? `${Math.round(c.committedBytes / GiB)} of ${Math.round(c.commitLimit / GiB)} GB committed · ${percent}`
    : share === null
      ? ""
      : `${percent} committed`;
  const available = c.availableMB === null ? "" : `${bytes(c.availableMB * 2 ** 20)} available `;
  return {
    main,
    small: `${available}of ${bytes(info.memTotal)} RAM; the WSL VM's share counts as used`,
  };
}

/** Every check Windows memory was judged by, each with its colour: why the row is green, orange or red. */
export function memoryChecks(checks) {
  if (checks.length === 0) return [];
  return [
    el(
      "div",
      { class: "checks" },
      ...checks.map((check) => el("span", { class: `check ${check.tone}` }, check.text)),
    ),
  ];
}

/** Whether the pool-tag list is open: null follows the default, open while a pool is over 2 GB. */
let poolsOpen = null;

function poolTagTable(tags) {
  return el(
    "table",
    {},
    ...tags.map((t) =>
      el(
        "tr",
        {},
        el("td", { class: "num" }, t.tag),
        el("td", {}, t.pool === "paged" ? "paged" : "non-paged"),
        el("td", { class: "r num" }, bytes(t.bytes)),
        el("td", { class: "r num" }, `${t.live.toLocaleString("en-US")} live`),
        el("td", { class: "muted" }, t.meaning),
      ),
    ),
  );
}

/** What the pool-tag list holds: the tags, or why there are none yet. */
function poolTagBody(pools) {
  if (pools === null) return el("p", { class: "muted" }, "Reading the pool tags…");
  if (pools.tags === null)
    return el("p", { class: "muted" }, `Could not read the pool tags: ${pools.error}`);
  if (pools.tags.length === 0) return el("p", { class: "muted" }, "No tag holds 1 MB.");
  return poolTagTable(pools.tags);
}

/** The biggest kernel pool tags, under the pools row: read every 10 s while the window is open. */
function poolTagList(pools, abnormal) {
  const open = poolsOpen ?? abnormal;
  const summary = el("summary", {}, "Biggest pool tags");
  // A click, not `toggle`: the list is drawn anew every second, and `toggle` fires for that too.
  summary.addEventListener("click", () => {
    poolsOpen = !open;
  });
  const details = el("details", { class: "pooltags" }, summary, poolTagBody(pools));
  details.open = open;
  return details;
}

/**
 * The kernel pools row: both pools' sizes, orange over 2 GB with why, and the
 * biggest tags under it. Null where Windows gave neither pool's size.
 */
export function poolsRead(c, checks, pools) {
  if (c.poolPaged === null && c.poolNonpaged === null) return null;
  const over = checks.filter(
    (ck) => (ck.what === "poolPaged" || ck.what === "poolNonpaged") && ck.tone !== "good",
  );
  const sizes = [
    c.poolPaged === null ? null : `paged ${bytes(c.poolPaged)}`,
    c.poolNonpaged === null ? null : `non-paged ${bytes(c.poolNonpaged)}`,
  ].filter((part) => part !== null);
  return {
    tone: over.length > 0 ? "warning" : "good",
    main: sizes.join(" · "),
    small:
      over.length > 0
        ? over.map((ck) => ck.text).join(" · ")
        : "Windows' kernel heaps; a few hundred MB each is usual, over 2 GB is a leak",
    below: [poolTagList(pools, over.length > 0)],
  };
}
