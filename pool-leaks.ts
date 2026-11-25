/**
 * What the kernel pools' tags say about a leak, read in the background: the
 * tags every 10 s while the window is open and every minute while it is shut
 * but a pool is over 2 GB (`readPools`), and, while an event-tracing tag
 * grows, who holds its registrations (`etw-holders.ts`), at most every 5
 * minutes. The results land in `State` (`pools`, `poolHistory`, `leaks`).
 */

import { chooseEtwHolder, etwHolders, parseEtwHolders } from "./etw-holders";
import { open, type State } from "./state";
import { POOL_ABNORMAL } from "./verdict";
import {
  isEtwTag,
  keepPoolReading,
  POOL_TAGS_SHOWN,
  parsePoolTags,
  poolGrowth,
  poolTags,
} from "./windows-memory";

/** The kernel pool tags are read at most this often while the window is open... */
const POOLS_EVERY = 10_000;
/** ...and this often while it is shut, then only while a pool is over 2 GB. */
const POOLS_CLOSED_EVERY = 60_000;
/** Who holds the event-tracing registrations is read at most this often, and only while an event-tracing tag grows. */
const ETW_HOLDER_EVERY = 5 * 60_000;

/**
 * Reads the pool tags when due. Each read joins the last 30 minutes of
 * readings, from which the growing tags come (`poolGrowth`). A failed read
 * leaves the growth unknown, so the reasons say what they said before, and the
 * failure is logged.
 */
export function readPools(current: State, now = Date.now()): void {
  const latest = current.windows?.history.at(-1);
  if (latest === undefined) return;
  const over = Math.max(latest.poolPaged ?? 0, latest.poolNonpaged ?? 0) > POOL_ABNORMAL;
  const watching = open(current);
  // Open: only while the page shows pool sizes (a pool counter exists). Shut: only while a pool is over 2 GB.
  if (watching ? latest.poolPaged === null : !over) {
    // Nothing to read: what was known of the leak is unknown from here on (the readings stay: live counts carry over a gap).
    current.leaks = { growth: null, holder: null };
    return;
  }
  if (now - current.poolsAt <= (watching ? POOLS_EVERY : POOLS_CLOSED_EVERY)) return;
  current.poolsAt = now;
  poolTags()
    .then((out) => {
      const all = parsePoolTags(out, Number.POSITIVE_INFINITY);
      current.pools = {
        tags: all === null ? null : all.slice(0, POOL_TAGS_SHOWN),
        error: all === null ? "Windows gave no pool tags" : "",
      };
      if (all === null) {
        current.api.log("pool_tags_failed", { error: "Windows gave no pool tags" });
        current.leaks.growth = null;
        return;
      }
      keepPoolReading(current.poolHistory, { at: Date.now(), tags: all });
      current.leaks.growth = poolGrowth(current.poolHistory);
      const etwGrows = current.leaks.growth?.some((t) => isEtwTag(t.tag)) === true;
      if (etwGrows && Date.now() - current.etwHolderAt > ETW_HOLDER_EVERY) readEtwHolder(current);
    })
    .catch((error: unknown) => {
      current.api.log("pool_tags_failed", { error: String(error) });
      current.pools = { tags: null, error: String(error) };
      current.leaks.growth = null;
    });
}

/** Who holds the most event-tracing registrations while suspended: one pass over the handle table. */
function readEtwHolder(current: State): void {
  current.etwHolderAt = Date.now();
  etwHolders()
    .then((out) => {
      const processes = parseEtwHolders(out);
      if (processes === null) {
        current.api.log("etw_holders_failed", { error: "no process with event-tracing handles" });
        current.leaks.holder = null;
        return;
      }
      current.leaks.holder = chooseEtwHolder(processes, Date.now());
    })
    .catch((error: unknown) => {
      current.api.log("etw_holders_failed", { error: String(error) });
      current.leaks.holder = null;
    });
}
