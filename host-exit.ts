/**
 * Ending what this extension started when the host ends.
 *
 * prifly's host calls an extension's stop function on disable, unload and
 * reload, but not when the host itself exits. A `.exe` started through WSL's
 * interop outlives its Linux parent whenever something else still holds the
 * pipe it writes to (a `typeperf.exe` ran four days after its host was gone),
 * so each long-running child asks to be killed here as well.
 *
 * "exit" allows only synchronous work: `kill` is called as it is. A SIGTERM or
 * SIGINT does the same, then takes its own handler away and, when no other
 * listener (the host's own) is left to deal with the signal, sends it again to
 * this process so it ends the way it would have without us.
 */

/** The parts of `process` the hook uses; tests give it a fake. */
export type HostProcess = {
  on(event: string, handler: () => void): unknown;
  off(event: string, handler: () => void): unknown;
  listenerCount(event: string): number;
  /** Sends `signal` to this process. */
  raise(signal: NodeJS.Signals): void;
};

const SIGNALS = ["SIGTERM", "SIGINT"] as const;

export const realProcess: HostProcess = {
  on: (event, handler) => process.on(event, handler),
  off: (event, handler) => process.off(event, handler),
  listenerCount: (event) => process.listenerCount(event),
  raise: (signal) => {
    process.kill(process.pid, signal);
  },
};

/** Calls `kill` when the host exits or is signalled; the returned function takes the hooks away again. */
export function hookHostExit(kill: () => void, host: HostProcess = realProcess): () => void {
  const hooks: [string, () => void][] = [["exit", kill]];
  host.on("exit", kill);
  for (const signal of SIGNALS) {
    const onSignal = () => {
      kill();
      host.off(signal, onSignal);
      if (host.listenerCount(signal) === 0) host.raise(signal);
    };
    hooks.push([signal, onSignal]);
    host.on(signal, onSignal);
  }
  return () => {
    for (const [event, handler] of hooks.splice(0)) host.off(event, handler);
  };
}
