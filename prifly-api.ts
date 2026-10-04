/**
 * A copy of prifly's extension contract (apps/desktop-host/src/extensions/api.ts
 * in jimmy927/prifly), kept here so this extension type-checks on its own.
 */

/**
 * What an extension is given, and what it gives back — the whole contract.
 *
 * An extension is a folder with a `prifly-extension.json` manifest and a
 * TypeScript or JavaScript module the host imports:
 *
 *     { "id": "vastai", "name": "Vast.ai boxes", "main": "index.ts",
 *       "description": "…", "version": "0.1.0" }
 *
 * Python tools come from a `pyproject.toml` and `uv.lock` beside it: prifly
 * builds the extension's `.venv` before starting it (`python.ts`).
 *
 * The module exports `activate(api)`, which may return a function the host
 * calls to stop it. It runs inside the host, with the host's rights: enable
 * only extensions you would run yourself.
 */

export type DecorationTone = "good" | "warning" | "critical" | "info" | "muted";

/** A launcher button's glow: its colour, and a line for its hover ("3 open errors"). */
export type LauncherFlag = { tone: DecorationTone; hint?: string };

/** One of the icons the window has: see `DECORATION_ICONS` in `@prifly/wire`. */
export type DecorationIcon =
  | "server"
  | "cpu"
  | "gpu"
  | "hard-drive"
  | "cloud"
  | "box"
  | "zap"
  | "activity"
  | "dollar"
  | "clock"
  | "alert"
  | "check"
  | "link"
  | "chart"
  | "bug"
  | "bug-off"
  | "trello"
  | "dot";

/**
 * One item in a chip's or a machine card's menu: "Move to Doing" on a Trello
 * card, "Destroy box…" on a Vast.ai one.
 */
export type DecorationAction = {
  id: string;
  /** The menu's words: "Destroy box…". */
  label: string;
  /** Asked before it runs: what it will do and what is lost. */
  confirm?: string | undefined;
  /** Drawn in the danger colour. */
  destructive?: boolean | undefined;
  /**
   * Shown greyed out and not choosable: it does not apply now. Send it
   * disabled rather than leaving it out, so the menu's items keep their place.
   */
  disabled?: boolean | undefined;
};

export type Decoration = {
  /** Stable within the extension, so the window keeps an item's place. */
  key: string;
  icon: DecorationIcon;
  /** A few words: "lc-box1 $0.42/h". */
  label: string;
  tone: DecorationTone;
  /** Shown on hover, one line each. */
  details: string[];
  /**
   * What a click on the item opens: a program in a terminal window of
   * prifly's own — `ssh` to a Vast.ai box. Run without a shell, as the reader.
   */
  terminal?: { title: string; command: string[] } | undefined;
  /** Where clicking the chip leads, in the reader's browser; left out, nowhere. */
  url?: string;
  /**
   * The item's menu, from its ▾ and from a right-click. Choosing one calls
   * the module's `action` export, or the handler given to `api.onAction`,
   * with the item's key and the action's id — after asking the reader
   * `confirm`, when it is not "".
   */
  actions?: DecorationAction[] | undefined;
  /**
   * Which of the extension's launchers can show this item whole by its `key`
   * (the module's `open`): a click on the chip then opens it inside prifly and
   * `url` moves to the chip's menu. Left out, the host picks the extension's
   * only launcher when it has one and `open` exists; name it only when there
   * are several.
   */
  launcher?: string | undefined;
  /**
   * The `id` of one of this extension's own panels (manifest `panels`) that
   * the item is the state of. Only for the `unclaimed` items of `show`: the
   * status bar then draws no chip, but that panel's button, its icon coloured
   * by `tone`, its hover holding `label` and `details` (under the panel's
   * description), and a click that opens the panel as before. `icon`, `url`,
   * `terminal` and `actions` are not shown then. An id naming no panel of the
   * extension is shown as an ordinary chip, with a warning in the log; on an
   * item of a session's `bySession` the field changes nothing.
   */
  panel?: string | undefined;
};

/**
 * What the extension says about one of its Snooze entries (manifest `snooze`)
 * on one session: `enabled` false greys it out; `detail` is the muted text on
 * its right — a short commit when choosable, the reason when not.
 */
export type SnoozeOption = { id: string; enabled: boolean; detail: string };

/** A column of a board, in the order the board has them. */
export type LaunchColumn = { id: string; name: string };

/** The colours a label may wear; see `LABEL_COLOURS` in `@prifly/wire`. */
export type LabelColour =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "grey";

/** What an item says about itself at a glance. */
export type LaunchBadges = {
  comments?: number;
  attachments?: number;
  checklistDone?: number;
  checklistTotal?: number;
  /** A date written as the extension would have it read — "24 Sep" — or "". */
  due?: string;
  dueDone?: boolean;
  dueLate?: boolean;
};

/** How often it happened over one period, as bars, oldest first. */
export type LaunchSpark = {
  /** Its name on the board's period switch: "1h", "24h", "7d". */
  period: string;
  counts: number[];
  /** Everything in the period, for the words beside the bars. */
  total?: number;
};

/** One thing a launcher can start a session from: a card, an issue, a ticket. */
export type LaunchChoice = {
  /** The extension's own name for it; handed back when the reader picks it. */
  key: string;
  title: string;
  /** What it is filed under, drawn as a column: a board's list. */
  group?: string;
  /** A line under the title: who is on it, when it is due. */
  detail?: string;
  /** Where it comes from, in code type, right under the title: a culprit. */
  sub?: string;
  /** How often it happened, one per period; the board switches between them. */
  sparks?: LaunchSpark[];
  tone?: DecorationTone;
  /** Picking it asks this first; what is typed reaches `launch` as `input`. */
  input?: { title: string; placeholder?: string };
  /** Where it lives, for the reader's own browser. */
  url?: string;
  /** Label colours, drawn as stripes across the top of the card. */
  stripes?: LabelColour[];
  /** What its right-click menu offers; answered by this module's `action`. */
  actions?: DecorationAction[];
  /** Who is on it; the window draws initials. */
  people?: string[];
  badges?: LaunchBadges;
  /** A session was already started from it; the board tints the card. */
  started?: boolean;
};

/**
 * What a launcher offers, as a board: the columns, and the items in them.
 * An extension that answers with a plain array has no columns, and the window
 * draws a list — which is what a launcher still being set up should give.
 * Only a board gets the filter field over it: a list of log-in steps has
 * nothing in it to search.
 */
export type LaunchBoard = {
  columns: LaunchColumn[];
  items: LaunchChoice[];
  /** Things to do to the launcher itself: "Switch board…", "Log out". */
  actions?: LaunchChoice[];
};

/** A file on an item: a picture to look at, or something to fetch elsewhere. */
export type LaunchItemFile = {
  /** This extension's own name for it, so two files called image.png are two. */
  id?: string;
  name: string;
  url?: string;
  /** The picture itself, as a `data:` URI, when it could be fetched. */
  data?: string;
  at?: string;
};

/** One thing somebody said on an item, oldest first. Markdown. */
export type LaunchItemNote = { by: string; at?: string; text: string };

/**
 * One item, read whole.
 *
 * The prose is Markdown; what is not prose — where it sits, who is on it,
 * what is attached, what has been said — is kept apart, so the window can lay
 * a ticket out as a ticket rather than as a page of text.
 */
export type LaunchItem = {
  title: string;
  url?: string;
  /** The column it sits in now, by id, and what that column is called. */
  column?: string;
  columnName?: string;
  labels?: { colour: LabelColour; name: string }[];
  people?: string[];
  due?: string;
  dueLate?: boolean;
  /** The description. */
  markdown: string;
  /** Checklists, as `- [x]` task lists under their own headings. */
  checklists?: string;
  files?: LaunchItemFile[];
  notes?: LaunchItemNote[];
};

/**
 * What a chosen thing becomes: the New session form, filled in — or, with an
 * empty prompt, nothing at all. An empty one leaves the chooser open, says
 * `message` and lists again, which is how a row can log the reader in or
 * choose which board to show instead of starting a session.
 */
export type Launch = {
  /** The session's first prompt — everything it needs to start. */
  prompt: string;
  /** Where to work; left out, the reader chooses as usual. */
  cwd?: string;
  /** A suggested name for the session and its worktree. */
  name?: string;
  /** A line for the chooser, whether or not a session follows. */
  message?: string;
  /**
   * Pictures for the session's opening message — the screenshots on the card,
   * carried into the first turn rather than left as paths to open. png, jpeg,
   * gif or webp, base64, at most twenty.
   */
  images?: { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }[];
};

/**
 * A request from one of the extension's own windows (`panels` in the
 * manifest): the page fetched `api/<path>` beside itself. `query` is the
 * URL's query; `body` a POST's JSON, or null.
 */
export type PanelRequest = {
  path: string;
  query: Record<string, string>;
  body: unknown;
};

/** A cloud session of one of the Claude accounts connected to prifly. */
export type CloudSessionInfo = {
  id: string;
  /** The account that created it, and the only one that can read it back. */
  account: string;
  title: string;
  /** The repository its sandbox cloned, `https://github.com/o/r`, or "". */
  repo: string;
  model: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
};

/** The sessions on Anthropic's side, for an extension that reports on them. */
export type ExtensionCloud = {
  /** Every cloud session of every connected account; an account that cannot be read is left out. */
  sessions(): Promise<CloudSessionInfo[]>;
  /**
   * A cloud session's transcript: Claude Code's own stored lines, the same
   * shape as a local `~/.claude/projects` JSONL file's, oldest first.
   */
  transcript(account: string, sessionId: string): Promise<unknown[]>;
};

/** One plan limit of an account, as prifly's usage poller last read it. */
export type AccountLimitInfo = {
  /** The statusline's name: "5h" (5-hour session), "7d" (weekly, all models), "7F" … (weekly, one model). */
  label: string;
  /** "5-hour session", "Weekly, all models", "Weekly, Fable only". */
  title: string;
  /** Of the limit spent, 0–100 (can exceed 100). */
  usedPercent: number;
  /** When the window reopens, epoch ms; null when unknown. */
  resetsAt: number | null;
  /** The window's length in ms. */
  windowMs: number;
};

/**
 * The "Reset for free" offer (claude.ai Settings → Usage): free weekly-limit
 * resets on top of the plan. `left` sums every live grant's `resets_left`;
 * `usableNow`/`endsAt` are the soonest-expiring one's.
 */
export type AccountFreeReset = {
  left: number;
  usableNow: boolean;
  /** Epoch ms. */
  endsAt: number;
};

/** A Claude account prifly holds, with its limits. */
export type AccountInfo = {
  /** The login's email — stable across local and cloud, what readings are keyed by. */
  email: string;
  /** What the reader calls it; the email when they named it nothing. */
  label: string;
  /** New local sessions start on this account (the "new sessions" star in the accounts UI). */
  startsNewSessions: boolean;
  /** When its limits were last read successfully, epoch ms; null before the first good read. */
  readAt: number | null;
  /** Its limits as of `readAt`; [] before the first good read. */
  limits: AccountLimitInfo[];
  /** Its free resets as of `readAt`; null with none, or not read yet. */
  freeResets: AccountFreeReset | null;
};

/** A session the host knows, for an extension to match its things against. */
export type ExtensionSession = { id: string; title: string; cwd: string; state: string };

/**
 * One machine an extension offers sessions to use — a rented Vast.ai box —
 * keyed within the extension the way a `Decoration` is. `os`/`arch`/`access`/
 * `notes`/`trust`/`capabilities`/`ownerSession` left out take `Machine`'s own
 * defaults (see `@prifly/wire`): `os` "other", `trust` "ask-first".
 */
export type ExtensionMachine = {
  key: string;
  kind?: "machine" | "provider" | "service";
  label: string;
  os?: string;
  arch?: string;
  /** The argv that runs a command there: `["ssh","root@1.2.3.4","-p","2222"]`. */
  exec?: string[];
  access?: string;
  trust?: "ask-first" | "use-freely";
  notes?: string;
  capabilities?: {
    name: string;
    state?: "present" | "absent" | "unknown";
    version?: string;
    detail?: string;
    probe?: string;
  }[];
  /** The session (or its first 8 characters) that rented or owns it, for whom it is use-freely. */
  ownerSession?: string;
  /** A line under the machine's name: "jimmy · leased until 14:30 · 1h 40m left". */
  status?: { text: string; tone?: DecorationTone };
  /**
   * The card's ▾ menu. Choosing one calls the extension's action handler
   * (`api.onAction` / the module's `action` export) with this machine's `key`
   * and the action's id, after asking `confirm` when it is not "".
   */
  actions?: DecorationAction[];
};

/** What `api.dialog` shows: see there. */
export type DialogSpec = {
  sessionId?: string;
  title: string;
  description?: string;
  text: string;
  rows?: number;
  hint?: string;
  resetTo?: string;
  confirm: string;
  checkbox?: DialogCheckbox;
  /** Number fields in one row in place of the textarea (`text` is then unused). */
  numbers?: DialogNumber[];
};
export type DialogCheckbox = { label: string; checked?: boolean };
export type DialogNumber = {
  key: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
};
/** A dialog with a checkbox, confirmed. */
export type DialogAnswer = { text: string; checked: boolean };
/** A dialog with number fields, confirmed: each value by its `key`, clamped to its min/max. */
export type DialogNumbersAnswer = DialogAnswer & { numbers: Record<string, number> };

/** An amount the reader confirms with the row (a rental's budget). */
export type PickAmount = {
  /** "Budget for this rental" */
  label: string;
  /** "$" */
  prefix: string;
  /** The session's suggestion; the reader may change it. */
  value: number;
  /** One line under the field: how the suggestion was made, what it means. */
  hint: string;
  /**
   * Recompute one column from the amount as the reader types: each row's
   * `column` cell becomes `amount / Number(row[rateColumn])` with `unit`,
   * and its header "Hours in <prefix><amount>".
   */
  perRow?: { column: string; rateColumn: string; unit: string };
  /**
   * A soft limit on the amount. Only where `api.features` includes
   * "pick-amount-limit": an older prifly refuses the unknown field.
   */
  limit?: {
    /** The largest amount within the limit. */
    max: number;
    /** A line always shown under the hint (the credit breakdown). */
    text: string;
    /** The warning shown once the typed amount is above `max`. */
    over: string;
    /** The label of the checkbox the reader must tick to go past `max`. */
    ack: string;
  };
};

/** What an extension tool asks the reader: prifly's pick card, optionally with an amount. */
export type ExtensionPick = {
  title: string;
  columns: string[];
  rows: string[][];
  /** The button's word, default "Choose". */
  action?: string;
  amount?: PickAmount;
};

/** The reader's answer: the row and, when the pick had one, the amount they confirmed. Null: none of these. */
export type ExtensionPickAnswer = { row: number; amount: number | null } | null;

export type ExtensionToolContext = {
  /** The full id of the session that called the tool. */
  session: string;
  /** Show a pick card in that session and wait for the reader. */
  pick(request: ExtensionPick): Promise<ExtensionPickAnswer>;
  /** Aborted when the session or the call goes away. */
  signal: AbortSignal;
};

export type ExtensionTool = {
  /** `^[a-z][a-z0-9_]{0,47}$`; the session sees it as `mcp__prifly__<name>`. */
  name: string;
  description: string;
  /** A JSON Schema object for the arguments. */
  inputSchema: Record<string, unknown>;
  /** The text the tool returns. A throw is returned as an MCP tool error with its message. */
  call(args: Record<string, unknown>, ctx: ExtensionToolContext): Promise<string>;
};

/** Added to `ExtensionApi`. Absent on an older prifly: call it as `api.tools?.register(...)`. */
export type ExtensionToolsApi = {
  /**
   * Replace every tool this extension serves. A name another extension or
   * prifly owns, or an `inputSchema` that is not `type: "object"`, is refused
   * and logged. A session reads the tool list when it connects: one already
   * running sees a change only after it reconnects.
   */
  register(tools: ExtensionTool[]): void;
};

/** Added to `ExtensionApi`. Absent on an older prifly: call it as `api.vault?.read(...)`. */
export type ExtensionVaultApi = {
  /**
   * The token of the vault entry `name`, an `api-token` entry the reader keeps
   * in prifly's vault (Settings → Vault). Null — so the extension falls back
   * to its own way of finding a key — when there is no such entry, it is
   * another kind, the manifest's `vault` list does not name it, or its level
   * is not 1: level 2 and 4 ask the reader on a session's card, which an
   * extension has none of, and level 3 is a fence. Read it each time it is
   * needed rather than keeping it: an entry the reader changes or fences
   * takes effect on the next read.
   */
  read(name: string): Promise<string | null>;
};

export type ExtensionApi = {
  /**
   * What this prifly accepts beyond the first version, by name: "pick-amount-limit"
   * (`limit` on a `ctx.pick` amount). Absent on a prifly that predates the list.
   */
  features?: readonly string[];
  /** The vault's API tokens this extension's manifest names under `vault`; see there. */
  vault?: ExtensionVaultApi;
  /**
   * MCP tools this extension serves to every session, as
   * `mcp__prifly__<name>` (`mcp/extension-tools.ts`). Only while it is running.
   */
  tools?: ExtensionToolsApi;
  /**
   * Replace everything this extension shows. `bySession` is keyed by a
   * session id or any unique start of one (a label has room for 8 characters);
   * items for an id no session has, and `unclaimed`, go to the status bar.
   */
  show(bySession: Record<string, Decoration[]>, unclaimed: Decoration[]): void;
  /**
   * Replace the extension's entries in each session's Snooze submenu, the
   * whole map each time. Keyed like `show`'s `bySession`; an entry the manifest
   * declares but a session's list leaves out is not offered on that session.
   */
  snoozeOptions(bySession: Record<string, SnoozeOption[]>): void;
  /**
   * Make the launcher `launchId`'s button glow in `tone`'s colour, `hint`
   * added to its hover — something waiting behind it, such as open errors.
   * Null puts it out.
   */
  flag(launchId: string, flag: LauncherFlag | null): void;
  /**
   * Tell the reader something that cannot wait for them to look at a chip:
   * "lc-box3 is destroyed in 15 min unless its lease is extended". Shown as a
   * notice in the window until dismissed — and by the OS, where the window
   * may raise its notifications and does not have the focus — under the
   * extension's name, in `tone`'s colour ("info" when left out). `session`, a
   * session id or any unique start of one, makes a click on it open that
   * session. Also a line in the host's log, under `ext.<id>.notify`.
   */
  notify(text: string, options?: { tone?: DecorationTone; session?: string }): void;
  /**
   * Replace every machine this extension offers sessions to use, the whole
   * list each time — its rented boxes, and a `provider`-kind machine for
   * itself when it can rent more. Ids are namespaced `ext:<extension id>:<key>`
   * before a session sees them, so an extension needs only its own `key` to
   * be unique.
   */
  machines: { report(items: ExtensionMachine[]): void };
  /**
   * Carry out an action the reader chose from an item's right-click menu, or
   * from the ▾ on one of this extension's machine cards (its machine `key`).
   * What it returns is shown to them ("Destroyed lc-box1"); what it throws is
   * shown as the failure. One handler per extension; a second call replaces it.
   */
  onAction(handler: (key: string, action: string) => Promise<string> | string): void;
  /** The sessions on this machine the host knows now. */
  sessions(): ExtensionSession[];
  /** A line in the host's log, under `ext.<id>.<event>`. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  /** The extension's own folder: where it keeps its config. */
  folder: string;
  /**
   * The folders its programs are in, first on the PATH of every session
   * prifly runs: its manifest's `bin`, and the `bin` of the `.venv` prifly
   * builds from its `pyproject.toml` and `uv.lock` (prifly brings uv and the
   * Python; the extension ships neither).
   */
  paths: readonly string[];
  /** The cloud sessions of the accounts connected to prifly, read with their own tokens. */
  cloud: ExtensionCloud;
  /**
   * Every Claude account prifly holds limits for — local logins and cloud-only
   * logins, one entry per email — as the host's pollers last read them. No
   * call leaves the machine: it answers from what the pollers already hold,
   * so asking often costs nothing and shows a new reading at most every poll.
   */
  accounts(): AccountInfo[];
  /** Sends `text` into the session as a <prifly-notice> (shown as prifly's, not the user's); resumes it first if it ended. Clears any snooze on it. */
  prompt(sessionId: string, text: string): Promise<{ delivered: boolean }>;
  /** Snoozes the session until `until` (epoch ms), or until the extension wakes it when `until` is null. `label` replaces "Back at …" in the Snoozed list, e.g. "Until 77257ba3 is live". `null` as the whole argument clears the snooze. */
  snooze(sessionId: string, snooze: { until: number | null; label?: string } | null): void;
  /**
   * Opens a modal dialog in the window over that session; resolves with the
   * edited text on confirm, null on cancel/close. With `checkbox`, a labelled
   * box (unchecked unless `checked`) sits between the hint and the buttons,
   * and it resolves with `{ text, checked }` instead. With `numbers`, labelled
   * number inputs replace the textarea and it resolves with
   * `{ text, checked, numbers }`, `numbers` keyed by each field's `key`.
   */
  dialog(spec: DialogSpec & { numbers: DialogNumber[] }): Promise<DialogNumbersAnswer | null>;
  dialog(spec: DialogSpec & { checkbox: DialogCheckbox }): Promise<DialogAnswer | null>;
  dialog(spec: DialogSpec): Promise<string | null>;
};

export type ExtensionModule = {
  activate: (api: ExtensionApi) => (() => void) | undefined | Promise<(() => void) | undefined>;
  /**
   * What the launcher `launchId` offers now, narrowed by what the reader has
   * typed. Called on every keystroke's worth of typing, so answer from what is
   * already in hand rather than asking the network each time.
   */
  choices?: (
    launchId: string,
    query: string,
  ) => LaunchChoice[] | LaunchBoard | Promise<LaunchChoice[] | LaunchBoard>;
  /** One item, written out: its text, its conversation, its pictures. */
  open?: (launchId: string, key: string) => LaunchItem | Promise<LaunchItem>;
  /** An item dragged into another column, by that column's `id`. */
  move?: (launchId: string, key: string, column: string) => void | Promise<void>;
  /**
   * The chosen one, as a session would start from it, with what was typed into
   * its row. `again` is true when the reader asked for it from a session that
   * was already started from this item — another one, on purpose.
   */
  launch?: (
    launchId: string,
    key: string,
    input: string,
    how: { again: boolean },
  ) => Launch | Promise<Launch>;
  /**
   * The session that launch became, once it is running — where a card learns
   * which session is its. Only for a launch the reader went through with.
   */
  launched?: (launchId: string, key: string, sessionId: string) => void | Promise<void>;
  /** The reader chose the Snooze entry `entryId` on that session; only called while its option is enabled. */
  snooze?: (entryId: string, sessionId: string) => void | Promise<void>;
  /** An item from a chip's menu, by the decoration's `key`; what it returns is said to the reader. */
  action?: (key: string, actionId: string) => string | undefined | Promise<string | undefined>;
  /**
   * What one of its windows asks for: `panelId` names the manifest's panel.
   * Answered as JSON; a throw becomes a 500 whose body is `{ error }`.
   */
  panel?: (panelId: string, request: PanelRequest) => unknown;
};
