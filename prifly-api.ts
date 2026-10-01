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
  | "dot";

/** One item in a chip's own menu: "Move to Doing" on a Trello card. */
/** One item in a chip's menu: "Move to Doing" on a Trello card, "Destroy box…" on a Vast.ai one. */
export type DecorationAction = {
  id: string;
  /** The menu's words: "Destroy box…". */
  label: string;
  /** Asked before it runs: what it will do and what is lost. */
  confirm?: string | undefined;
  /** Drawn in the danger colour. */
  destructive?: boolean | undefined;
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
};

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

/** One thing a launcher can start a session from: a card, an issue, a ticket. */
export type LaunchChoice = {
  /** The extension's own name for it; handed back when the reader picks it. */
  key: string;
  title: string;
  /** What it is filed under, drawn as a column: a board's list. */
  group?: string;
  /** A line under the title: who is on it, when it is due. */
  detail?: string;
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

/** A session the host knows, for an extension to match its things against. */
export type ExtensionSession = { id: string; title: string; cwd: string; state: string };

export type ExtensionApi = {
  /**
   * Replace everything this extension shows. `bySession` is keyed by a
   * session id or any unique start of one (a label has room for 8 characters);
   * items for an id no session has, and `unclaimed`, go to the status bar.
   */
  show(bySession: Record<string, Decoration[]>, unclaimed: Decoration[]): void;
  /**
   * Carry out an action the reader chose from an item's right-click menu.
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
  /** The chosen one, as a session would start from it, with what was typed into its row. */
  launch?: (launchId: string, key: string, input: string) => Launch | Promise<Launch>;
  /**
   * The session that launch became, once it is running — where a card learns
   * which session is its. Only for a launch the reader went through with.
   */
  launched?: (launchId: string, key: string, sessionId: string) => void | Promise<void>;
  /** An item from a chip's menu, by the decoration's `key`; what it returns is said to the reader. */
  action?: (key: string, actionId: string) => string | undefined | Promise<string | undefined>;
  /**
   * What one of its windows asks for: `panelId` names the manifest's panel.
   * Answered as JSON; a throw becomes a 500 whose body is `{ error }`.
   */
  panel?: (panelId: string, request: PanelRequest) => unknown;
};
