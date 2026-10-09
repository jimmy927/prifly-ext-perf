/**
 * One long-lived shell that runs scripts one at a time. A script goes over the
 * shell's stdin as one line, `<id> <script in base64>`; the program at the
 * other end runs it and prints `<<END-id>>` when it is done, or
 * `<<ERR-id>>message` and then the end marker if it threw. The output before
 * the marker is the call's answer, and an error rejects that call alone.
 *
 * Pure of processes: the shell comes from a `spawn` function, so tests give it
 * a fake. `windows.ts` gives it one `powershell.exe` running a read loop,
 * where starting one per call made a console flash up on the Windows desktop
 * every few seconds. `wsl-exe.ts` gives it a plain `sh` inside WSL, with a
 * `frame` that sends the command as it is and echoes the end marker after it.
 */

/** The line that asks the child to run `script` and print `<<END-id>>` after it. */
export type Frame = (id: string, script: string) => string;

const BASE64_LINE: Frame = (id, script) =>
  `${id} ${Buffer.from(script, "utf8").toString("base64")}\n`;

/** The parts of a child process the shell uses. */
export type ShellChild = {
  write(text: string): void;
  kill(): void;
  /** Stdout, decoded as UTF-8 and cut anywhere. */
  onData(listener: (chunk: string) => void): void;
  /** The child ended, or could not start. Called at most once that matters; later calls are ignored. */
  onExit(listener: (reason: string) => void): void;
};

type Call = {
  script: string;
  timeout: number;
  done: (out: string) => void;
  fail: (error: Error) => void;
};

type Running = { call: Call; id: string; timer: ReturnType<typeof setTimeout> };

export class ScriptShell {
  private readonly spawn: () => ShellChild;
  private readonly frame: Frame;
  private child: ShellChild | null = null;
  private running: Running | null = null;
  private readonly queue: Call[] = [];
  private buffer = "";
  private counter = 0;

  constructor(spawn: () => ShellChild, frame: Frame = BASE64_LINE) {
    this.spawn = spawn;
    this.frame = frame;
  }

  /** Runs `script` after the ones already asked for; its output, or an error. */
  run(script: string, timeout: number): Promise<string> {
    return new Promise((done, fail) => {
      this.queue.push({ script, timeout, done, fail });
      this.next();
    });
  }

  /** Ends the child and rejects every call not yet answered; the next `run` starts a new child. */
  close(): void {
    this.discard(new Error("shell closed"));
  }

  private next(): void {
    if (this.running !== null) return;
    const call = this.queue.shift();
    if (call === undefined) return;
    let child: ShellChild;
    try {
      child = this.child ?? this.start();
    } catch (error) {
      call.fail(error instanceof Error ? error : new Error(String(error)));
      this.next();
      return;
    }
    const id = `${Date.now().toString(36)}-${++this.counter}`;
    const timer = setTimeout(() => {
      this.discard(new Error(`script timed out after ${call.timeout} ms`), call);
    }, call.timeout);
    this.running = { call, id, timer };
    try {
      child.write(this.frame(id, call.script));
    } catch (error) {
      this.discard(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private start(): ShellChild {
    const child = this.spawn();
    this.child = child;
    this.buffer = "";
    child.onData((chunk) => {
      if (this.child === child) this.take(chunk);
    });
    child.onExit((reason) => {
      if (this.child === child) this.discard(new Error(`shell ended: ${reason}`));
    });
    return child;
  }

  private take(chunk: string): void {
    const running = this.running;
    if (running === null) {
      this.buffer = "";
      return;
    }
    this.buffer += chunk;
    const end = this.buffer.indexOf(endMarker(running.id));
    if (end < 0) return;
    const output = this.buffer.slice(0, end);
    this.buffer = "";
    clearTimeout(running.timer);
    this.running = null;
    const failure = output.indexOf(errorMarker(running.id));
    if (failure >= 0) {
      const message = output.slice(failure + errorMarker(running.id).length).trim();
      running.call.fail(new Error(message === "" ? "script failed" : message));
    } else {
      running.call.done(output);
    }
    this.next();
  }

  /**
   * Kills the child and rejects the running call and every queued one with
   * `error`; with `only`, the queued calls instead wait for a fresh child
   * (a timeout is that call's failure, not theirs).
   */
  private discard(error: Error, only?: Call): void {
    const child = this.child;
    this.child = null;
    this.buffer = "";
    const running = this.running;
    this.running = null;
    if (running !== null) {
      clearTimeout(running.timer);
      running.call.fail(error);
    }
    if (only === undefined) {
      for (const call of this.queue.splice(0)) call.fail(error);
    }
    try {
      child?.kill();
    } catch {
      // Already gone.
    }
    this.next();
  }
}

const endMarker = (id: string): string => `<<END-${id}>>`;
const errorMarker = (id: string): string => `<<ERR-${id}>>`;
