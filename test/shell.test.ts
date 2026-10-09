import { describe, expect, test } from "bun:test";
import { ScriptShell, type ShellChild } from "../shell";

/** A child the test drives by hand: it records what was written and answers when told. */
class FakeChild implements ShellChild {
  written: string[] = [];
  killed = false;
  private data: ((chunk: string) => void)[] = [];
  private exit: ((reason: string) => void)[] = [];

  write(text: string): void {
    this.written.push(text);
  }
  kill(): void {
    this.killed = true;
  }
  onData(listener: (chunk: string) => void): void {
    this.data.push(listener);
  }
  onExit(listener: (reason: string) => void): void {
    this.exit.push(listener);
  }

  emit(chunk: string): void {
    for (const listener of this.data) listener(chunk);
  }
  end(reason = "exit 1"): void {
    for (const listener of this.exit) listener(reason);
  }
  /** The id of the last script written: the first word of its line. */
  get id(): string {
    return (this.written.at(-1) ?? "").split(" ")[0] ?? "";
  }
  /** The scripts written so far, decoded. */
  get scripts(): string[] {
    return this.written.map((line) => Buffer.from(line.split(" ")[1] ?? "", "base64").toString());
  }
  end$(): string {
    return `<<END-${this.id}>>`;
  }
  err$(): string {
    return `<<ERR-${this.id}>>`;
  }
}

function setup() {
  const children: FakeChild[] = [];
  const shell = new ScriptShell(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return { shell, children };
}

const tick = () => new Promise((done) => setTimeout(done, 5));

describe("ScriptShell", () => {
  test("starts one child lazily and answers with the output before the marker", async () => {
    const { shell, children } = setup();
    expect(children).toHaveLength(0);
    const result = shell.run("Get-Thing", 1000);
    const child = children[0] as FakeChild;
    expect(child.scripts).toEqual(["Get-Thing"]);
    expect(child.written[0]).toMatch(/^\S+ [A-Za-z0-9+/=]+\n$/);
    child.emit(`a|1\nb|2\n${child.end$()}\n`);
    expect(await result).toBe("a|1\nb|2\n");
    const again = shell.run("Second", 1000);
    child.emit(`c|3\n${child.end$()}`);
    expect(await again).toBe("c|3\n");
    expect(children).toHaveLength(1);
  });

  test("sends a script with quotes, newlines and non-ASCII text intact", () => {
    const { shell, children } = setup();
    const script = "'it''s'\n\"å日\"";
    void shell.run(script, 1000).catch(() => {});
    expect((children[0] as FakeChild).scripts).toEqual([script]);
    shell.close();
  });

  test("finds a marker split across chunks", async () => {
    const { shell, children } = setup();
    const result = shell.run("x", 1000);
    const child = children[0] as FakeChild;
    const marker = child.end$();
    child.emit("line one\nline");
    child.emit(` two\n${marker.slice(0, 7)}`);
    child.emit(marker.slice(7, 12));
    child.emit(marker.slice(12));
    expect(await result).toBe("line one\nline two\n");
  });

  test("runs queued calls one after the other, each with its own output", async () => {
    const { shell, children } = setup();
    const first = shell.run("first", 1000);
    const second = shell.run("second", 1000);
    const child = children[0] as FakeChild;
    // Only the first script is written until it is answered.
    expect(child.scripts).toEqual(["first"]);
    child.emit(`one\n${child.end$()}\n`);
    expect(await first).toBe("one\n");
    expect(child.scripts).toEqual(["first", "second"]);
    child.emit(`two\n${child.end$()}\n`);
    expect(await second).toBe("two\n");
  });

  test("a script that throws rejects that call only and leaves the shell usable", async () => {
    const { shell, children } = setup();
    const bad = shell.run("throw", 1000);
    const next = shell.run("fine", 1000);
    const child = children[0] as FakeChild;
    child.emit(`partial\n${child.err$()}Boom happened\n${child.end$()}\n`);
    await expect(bad).rejects.toThrow("Boom happened");
    expect(child.killed).toBe(false);
    child.emit(`ok\n${child.end$()}\n`);
    expect(await next).toBe("ok\n");
    expect(children).toHaveLength(1);
  });

  test("a timeout rejects the call, kills the child, and the next call gets a fresh one", async () => {
    const { shell, children } = setup();
    const slow = shell.run("slow", 20);
    const queued = shell.run("queued", 1000);
    const first = children[0] as FakeChild;
    await expect(slow).rejects.toThrow("timed out");
    expect(first.killed).toBe(true);
    expect(children).toHaveLength(2);
    const second = children[1] as FakeChild;
    expect(second.scripts).toEqual(["queued"]);
    // Late output from the killed child is ignored.
    first.emit(`stale\n<<END-${first.id}>>\n`);
    second.emit(`fresh\n${second.end$()}\n`);
    expect(await queued).toBe("fresh\n");
  });

  test("an unexpected exit rejects the running and queued calls and the next call respawns", async () => {
    const { shell, children } = setup();
    const running = shell.run("a", 1000);
    const queued = shell.run("b", 1000);
    const first = children[0] as FakeChild;
    first.end("exit 1");
    await expect(running).rejects.toThrow("shell ended: exit 1");
    await expect(queued).rejects.toThrow("shell ended");
    expect(children).toHaveLength(1);
    const after = shell.run("c", 1000);
    expect(children).toHaveLength(2);
    const second = children[1] as FakeChild;
    second.emit(`back\n${second.end$()}\n`);
    expect(await after).toBe("back\n");
  });

  test("close kills the child and rejects what is waiting", async () => {
    const { shell, children } = setup();
    const running = shell.run("a", 1000);
    const child = children[0] as FakeChild;
    shell.close();
    await expect(running).rejects.toThrow("shell closed");
    expect(child.killed).toBe(true);
    await tick();
  });

  test("a spawn that throws rejects that call and the next one tries again", async () => {
    let attempts = 0;
    const child = new FakeChild();
    const shell = new ScriptShell(() => {
      if (++attempts === 1) throw new Error("no powershell");
      return child;
    });
    await expect(shell.run("a", 1000)).rejects.toThrow("no powershell");
    const second = shell.run("b", 1000);
    child.emit(`ok\n${child.end$()}`);
    expect(await second).toBe("ok\n");
  });
});
