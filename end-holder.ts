/**
 * The End it button beside the headline's holder sentence: it ends the
 * suspended process that holds the event-tracing registrations. Only the
 * process the panel names now may be ended, never a pid taken from a request on
 * its word. The deciding and the texts are pure; the ending goes through the
 * shared PowerShell, which the tests replace with a fake.
 */

import type { EtwHolder } from "./etw-holders";
import type { PoolLeaks } from "./verdict";
import { powershell } from "./windows";
import { isEtwTag } from "./windows-memory";

/** The holder the panel may offer to end: a pid and the name it had when it was read. */
export type EndableHolder = { pid: number; name: string };

/** What `api/status` carries for the button: the holder only while an event-tracing tag grows and one was picked. */
export function endableHolder(
  leaks: { growth: readonly { tag: string }[] | null; holder: EtwHolder | null } | null,
): EndableHolder | null {
  if (leaks === null || leaks.holder === null) return null;
  if (leaks.growth?.some((t) => isEtwTag(t.tag)) !== true) return null;
  return { pid: leaks.holder.pid, name: leaks.holder.name };
}

/** What `api/status` carries for the button: the holder it may end, and the sentence after one was ended. */
export function endBlock(leaks: PoolLeaks) {
  return { endHolder: endableHolder(leaks), holderEnded: leaks.ended ?? null };
}

/** How long Windows has to confirm the process is gone. */
export const END_WAIT_MS = 10_000;

/**
 * The pid and name a request asks to end, when they are the ones named now;
 * otherwise why not. The pid must be the current holder's and the name must
 * still be its name.
 */
export function mayEnd(
  body: unknown,
  current: EndableHolder | null,
): { ok: true; holder: EndableHolder } | { ok: false; error: string } {
  const asked = (body ?? {}) as { pid?: unknown; name?: unknown };
  if (current === null) return { ok: false, error: "No process is named as the holder now." };
  if (typeof asked.pid !== "number" || !Number.isInteger(asked.pid) || asked.name === undefined) {
    return { ok: false, error: "The request names no process." };
  }
  if (asked.pid !== current.pid || asked.name !== current.name) {
    return { ok: false, error: `${String(asked.name)} is not the process named now.` };
  }
  return { ok: true, holder: current };
}

const clock = (at: Date): string =>
  `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** The sentence the headline shows after the process was ended; the time is local. */
export function endedText(name: string, at: Date): string {
  return `${name} was ended at ${clock(at)} (local time); Windows frees its memory over the next minutes. Windows may start it again.`;
}

/**
 * The PowerShell that ends `holder` and says `ended`, `gone` (nothing had that
 * pid), `other:<name>` (another program has the pid now) or `error:<why>`. The
 * process counts as ended when it has exited, not when it leaves the list:
 * Windows keeps it there for minutes while it tears it down.
 */
export function endScript(holder: EndableHolder): string {
  const name = holder.name.replace(/\.exe$/i, "").replaceAll("'", "''");
  return [
    "try {",
    `$p = Get-Process -Id ${holder.pid} -ErrorAction SilentlyContinue;`,
    "if ($null -eq $p) { 'gone' }",
    `elseif ($p.ProcessName -ne '${name}') { 'other:' + $p.ProcessName }`,
    "else {",
    `Stop-Process -Id ${holder.pid} -Force -ErrorAction Stop;`,
    `[void]$p.WaitForExit(${END_WAIT_MS});`,
    "if ($p.HasExited) { 'ended' } else { 'error:still running after 10 seconds' }",
    "}",
    "} catch { 'error:' + $_.Exception.Message }",
  ].join(" ");
}

/** What the script said, as an error text or null when the process is ended (or was already gone). */
export function endError(out: string, holder: EndableHolder): string | null {
  const line =
    out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .at(-1) ?? "";
  if (line === "ended" || line === "gone") return null;
  if (line.startsWith("other:")) {
    return `Pid ${holder.pid} is ${line.slice(6)} now, not ${holder.name}: not ended.`;
  }
  if (line.startsWith("error:")) return `Could not end ${holder.name}: ${line.slice(6)}`;
  return `Could not end ${holder.name}: Windows said "${line}".`;
}

/** Runs the PowerShell for `holder`; the shared one unless a test gives its own. */
export type EndRunner = (script: string, timeout: number) => Promise<string>;

/**
 * Ends the holder if the request names the one named now. Resolves with the
 * sentence for the headline; rejects with why it did not end. `log` gets the
 * action either way.
 */
export async function endHolder(
  body: unknown,
  current: EndableHolder | null,
  log: (event: string, data: Record<string, string | number | boolean | null>) => void,
  now: Date = new Date(),
  run: EndRunner = powershell,
): Promise<string> {
  const allowed = mayEnd(body, current);
  if (!allowed.ok) {
    log("end_holder_refused", { error: allowed.error });
    throw new Error(allowed.error);
  }
  const { holder } = allowed;
  let error: string | null;
  try {
    error = endError(await run(endScript(holder), END_WAIT_MS + 10_000), holder);
  } catch (caught) {
    error = `Could not end ${holder.name}: ${caught instanceof Error ? caught.message : String(caught)}`;
  }
  log("end_holder", { pid: holder.pid, name: holder.name, error });
  if (error !== null) throw new Error(error);
  return endedText(holder.name, now);
}

/** What the End it button needs of the running state. */
type Ending = {
  leaks: PoolLeaks;
  etwHolderAt: number;
  api: { log: (event: string, data: Record<string, string | number | boolean | null>) => void };
};

/**
 * The End it button: ends the holder the headline names now, then clears it
 * and lets the next read name a new one 5 minutes on, as a read does today.
 */
export async function endCurrentHolder(
  current: Ending,
  body: unknown,
  run: EndRunner = powershell,
): Promise<{ text: string }> {
  const text = await endHolder(
    body,
    endableHolder(current.leaks),
    (event, data) => current.api.log(event, data),
    new Date(),
    run,
  );
  current.leaks.holder = null;
  current.leaks.ended = text;
  current.etwHolderAt = Date.now();
  return { text };
}
