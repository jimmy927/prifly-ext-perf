// The period the Performance window averages over, and the line that says so.
// The page asks every second whatever the period, and every number in the
// answer is the average of the trailing period: it moves every second and
// still holds still, since each answer shares all but a second with the last.

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

/** The page asks this often, whatever the period. */
const REPAINT_MS = 1000;

/**
 * Asks `ask(seconds)` now and then every second, shows the control in
 * `#every` and the line in `#status`. `ask` resolves with how many seconds the
 * answer covers: less than the period before it has filled.
 */
export function startEvery(ask) {
  let seconds = saved();
  let covered = 0;
  let timer = null;

  const line = () => {
    // Samples land a few ms either side of the second: 9.6 s of a 10 s period is all of it.
    const filled = covered >= seconds - 0.5;
    const what = filled ? seconds : Math.max(1, Math.round(covered));
    $("status").textContent = filled
      ? `Average of the trailing ${clock(what)}, updated every second`
      : `Average of the last ${clock(what)}`;
  };

  const run = async () => {
    clearTimeout(timer);
    covered = (await ask(seconds)) ?? covered;
    line();
    // Hidden, it is not asked: the extension then stops reading the process table.
    if (!document.hidden) timer = setTimeout(() => void run(), REPAINT_MS);
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

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void run();
  });
  void run();
}
