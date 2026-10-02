// The MCP card on the prifly tab: each server, what its copies cost, and
// which repositories' sessions run them.

import { $, bytes, el, line } from "./format.js";

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

/** A session's repository: a worktree counts with the checkout it was made from. */
function repoOf(cwd) {
  const home = cwd.replace(/^\/home\/[^/]+/, "~");
  const tree = home.match(/^(.*)\.worktrees\/[^/]+/);
  if (tree) return tree[1];
  const agent = home.match(/^(.*)\/\.claude\/worktrees\/[^/]+/);
  return agent ? agent[1] : home;
}

/** Under a server: which repositories run its copies, most first, with the sessions named. */
function mcpWhere(m, sessions) {
  const by = new Map();
  for (const s of sessions) {
    if (!s.mcp.includes(m.name)) continue;
    const repo = repoOf(s.cwd);
    by.set(repo, [...(by.get(repo) ?? []), s]);
  }
  const each = m.copies > 0 ? m.rss / m.copies : 0;
  return [...by]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([repo, list]) =>
      el(
        "div",
        { class: "line where" },
        el(
          "span",
          {},
          el("b", {}, repo),
          " ",
          el(
            "span",
            { class: "chip" },
            `${list.length} ${list.length === 1 ? "session" : "sessions"}`,
          ),
        ),
        el("span", { class: "num" }, bytes(each * list.length)),
        el("span", { class: "how" }, list.map((s) => s.title).join(" · ")),
      ),
    );
}

export function drawMcp(report) {
  const rows = report.mcp.flatMap((m) => [mcpLine(m), ...mcpWhere(m, report.sessions)]);
  $("mcp").replaceChildren(...(rows.length > 0 ? rows : [el("p", {}, "No MCP servers run here.")]));
}
