// SPDX-License-Identifier: AGPL-3.0-only
import type { Readable, Writable } from "node:stream";

export interface InputStream extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

type Waiter =
  | { kind: "line"; resolve(line: string): void }
  | { kind: "secret"; resolve(secret: string): void; reject(err: Error): void };

// One reader for the whole process. A fresh readline per question loses every
// line already buffered from a pipe, which kills the second prompt.
export class TerminalInput {
  private attached = false;
  private ended = false;
  private partial = "";
  private secret = "";
  private readonly lines: string[] = [];
  private waiter: Waiter | undefined;

  constructor(
    private readonly input: InputStream,
    private readonly output: Writable,
  ) {}

  ask(question: string): Promise<string> {
    this.output.write(question);
    return this.takeLine();
  }

  askSecret(question: string): Promise<string> {
    this.output.write(question);
    const raw = this.input.isTTY === true ? this.input.setRawMode?.bind(this.input) : undefined;
    // Raw mode is the only way to stop a tty echoing keystrokes; off a tty
    // nothing echoes, so a plain line read is already silent.
    if (raw === undefined) return this.takeLine();
    raw(true);
    return new Promise<string>((resolve, reject) => {
      this.secret = "";
      this.wait({ kind: "secret", resolve, reject });
    }).finally(() => {
      raw(false);
      this.output.write("\n");
    });
  }

  private takeLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.ended) return Promise.resolve(this.flushPartial());
    return new Promise<string>(resolve => this.wait({ kind: "line", resolve }));
  }

  private wait(waiter: Waiter): void {
    this.waiter = waiter;
    if (!this.attached) {
      this.attached = true;
      this.input.on("data", (chunk: Buffer | string) => this.onData(chunk.toString()));
      this.input.on("end", () => this.onEnd());
    }
    this.input.resume();
  }

  private settle(): void {
    this.waiter = undefined;
    this.input.pause();
  }

  private flushPartial(): string {
    const line = this.partial;
    this.partial = "";
    return line;
  }

  private onData(text: string): void {
    let rest = text;
    if (this.waiter?.kind === "secret") rest = this.onSecretData(this.waiter, text);
    if (rest === "") return;
    this.partial += rest;
    const parts = this.partial.split("\n");
    this.partial = parts.pop() ?? "";
    this.lines.push(...parts);
    const waiter = this.waiter;
    if (waiter?.kind === "line") {
      const line = this.lines.shift();
      if (line !== undefined) {
        this.settle();
        waiter.resolve(line);
      }
    }
  }

  private onSecretData(waiter: Extract<Waiter, { kind: "secret" }>, text: string): string {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\r" || ch === "\n" || ch === "") {
        this.settle();
        waiter.resolve(this.secret);
        this.secret = "";
        return text.slice(i + 1).replace(/^\n/, "");
      }
      if (ch === "") {
        this.settle();
        waiter.reject(new Error("interrupted"));
        this.secret = "";
        return "";
      }
      if (ch === "" || ch === "\b") this.secret = this.secret.slice(0, -1);
      else this.secret += ch;
    }
    return "";
  }

  private onEnd(): void {
    this.ended = true;
    const waiter = this.waiter;
    if (waiter === undefined) return;
    this.settle();
    if (waiter.kind === "secret") waiter.resolve(this.secret);
    else waiter.resolve(this.flushPartial());
  }
}
