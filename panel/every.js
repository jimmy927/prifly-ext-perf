// How often the Performance window asks, and the line that says so. The page
// asks once per window and every number in the answer is the average over it.

import { $, el } from "./format.js";

const CHOICES = [
  [1, "1 s"],
  [2, "2 s"],
  [5, "5 s"],
  [10, "10 s"],
  [30, "30 s"],
  [60, "1 min"],
  [300, "5 min"],
];
const KEY = "perf-window";
const DEFAULT = 2;

function saved() {
  try {
    const seconds = Number(localStorage.getItem(KEY));
    if (CHOICES.some(([n]) => n === seconds)) return seconds;
  } catch {
    // Storage blocked: the default will do.
  }
  return DEFAULT;
}

function save(seconds) {
  try {
    localStorage.setItem(KEY, String(seconds));
  } catch {
    // Not remembered, then.
  }
}

/** 12 → "12 s", 75 → "1 min 15 s". */
export function clock(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const rest = seconds % 60;
  return `${Math.floor(seconds / 60)} min${rest > 0 ? ` ${rest} s` : ""}`;
}

/**
 * Asks `ask(seconds)` now and then once per window, shows the control in
 * `#every` and the line in `#status`. `ask` resolves with how many seconds the
 * answer covers: less than the window before it has filled.
 */
export function startEvery(ask) {
  let seconds = saved();
  let covered = 0;
  let nextAt = 0;
  let timer = null;

  const line = () => {
    const left = Math.max(0, Math.ceil((nextAt - Date.now()) / 1000));
    const what = covered < seconds ? Math.max(1, Math.round(covered)) : seconds;
    const next = document.hidden || nextAt === 0 ? "" : ` · next in ${clock(left)}`;
    $("status").textContent = `Average of the last ${clock(what)}${next}`;
  };

  const run = async () => {
    clearTimeout(timer);
    nextAt = 0;
    covered = (await ask(seconds)) ?? covered;
    // Nothing to average yet (the first second): ask again at once rather than a window later.
    const wait = covered < 1 ? 1 : seconds;
    nextAt = Date.now() + wait * 1000;
    line();
    // Hidden, it is not asked: the extension then stops reading the process table.
    if (!document.hidden) timer = setTimeout(() => void run(), wait * 1000);
  };

  const buttons = CHOICES.map(([n, label]) => {
    const button = el("button", { type: "button", "data-seconds": String(n) }, label);
    button.addEventListener("click", () => {
      seconds = n;
      save(n);
      mark();
      void run();
    });
    return button;
  });
  const mark = () => {
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.seconds) === seconds));
    }
  };
  $("every").replaceChildren(...buttons);
  mark();

  setInterval(line, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void run();
  });
  void run();
}
