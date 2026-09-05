// SPDX-License-Identifier: AGPL-3.0-only
// A pty on the builder shown in this terminal, the way ssh would: keystrokes
// go up, bytes come down, the local terminal sits in raw mode for the
// duration and its size follows. The only thing read from the stream is a
// URL the tool printed, which is re-shown as a hyperlink with `o` to open it
// on this computer, unless the tool asked for a page that returns through a
// forwarded port, which o opens instead; codes and tokens are never looked at.
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters, styleText } from "node:util";

export interface PtyLink {
  op(op: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Daemon events as they arrive; the return detaches. */
  onEvent(fn: (e: Record<string, unknown>) => void): () => void;
  /** Settles when the link is gone; a relay waiting on a pty then ends instead of holding the terminal. */
  closed?: Promise<unknown>;
}

export interface RelayTerminal {
  input: Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(on: boolean): unknown };
  output: Writable & { columns?: number; rows?: number };
}

export interface RelayOptions {
  link: PtyLink;
  /** The line the guest shell runs; the pty exits with its status. Absent: a bare shell the person exits. */
  command?: string;
  terminal: RelayTerminal;
  /** Opens a URL on this computer; called only when the person presses o. */
  open(url: string): Promise<boolean>;
  /** The page the tool asked the machine to open, when one arrived that returns through a forwarded port:
   * o opens it in place of the printed link, whose page only shows a code to paste. */
  callbackUrl?(): string | undefined;
  /** The person pressed o and this URL opened here. */
  onConsent?(url: string): void;
  /** The pty is killed after this long. */
  timeoutMs: number;
  /** A URL that ends a chunk is offered after this much quiet, for a tool that prints it and blocks. Default 300 ms. */
  flushMs?: number;
  now?: () => number;
}

export interface RelayOutcome {
  /** -1 when the pty never exited (a timeout or a dropped link). */
  exitCode: number;
  timedOut: boolean;
  /** The daemon link went away under the pty. */
  dropped: boolean;
  /** Distinct URLs the tool printed. */
  urls: number;
  /** How many times o opened one here. */
  opened: number;
}

/** A pressed o opens the URL only this soon after it appeared, and only before any text was typed
 * (Enter and other control keys keep the offer: gh asks for an Enter before its own open). */
export const OFFER_MS = 60_000;
const OPENED_PRINTED = "opened on this computer; if the page shows a code, paste it into the terminal above";
const OPENED_PAGE = "opened the sign-in page; it returns to the machine on its own";
const FLUSH_MS = 300;
const PRINTABLE = /[\x20-\x7e\u00a0-\uffff]/;
/** Arrow keys and the like, CSI or application-mode SS3: a menu moved is not text typed. */
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[A-Z]/g;
const TAIL_CHARS = 2048;
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\x00-\x1f\x7f]+/g;

export function stripOsc8(text: string): string {
  return text.replace(OSC8, "");
}

/** URLs in the text, trailing punctuation dropped, a match that runs to the very end left for the next chunk. */
export function urlsIn(text: string): string[] {
  const clean = stripOsc8(text);
  const out: string[] = [];
  for (const m of clean.matchAll(URL_IN_TEXT)) {
    if (m.index + m[0].length === clean.length) continue;
    const url = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** Feeds chunks and reports each URL once, even one split across two chunks. */
export class UrlScanner {
  private tail = "";
  private seen = new Set<string>();
  feed(chunk: string): string[] {
    const text = this.tail + chunk;
    this.tail = text.slice(-TAIL_CHARS);
    return this.fresh(urlsIn(text));
  }
  /** Settles a URL that ended the last chunk, as if a line break had followed it. */
  flush(): string[] {
    return this.fresh(urlsIn(`${this.tail}\n`));
  }
  private fresh(urls: string[]): string[] {
    const out = urls.filter(u => !this.seen.has(u));
    for (const u of out) this.seen.add(u);
    return out;
  }
}

export function hyperlink(url: string): string {
  return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;
}

const dim = (s: string): string => styleText("dim", s);

/** The daemon answers a refused op with {ok:false, error} and the socket resolves that envelope; here a refusal throws. */
function okOrThrow(op: string, reply: Record<string, unknown>): Record<string, unknown> {
  if (reply["ok"] !== true) throw new Error(`${op} refused: ${typeof reply["error"] === "string" ? reply["error"] : "no reason given"}`);
  return reply;
}

function ptyIdOf(reply: Record<string, unknown>): string {
  const id = okOrThrow("pty.create", reply)["ptyId"];
  if (typeof id !== "string") throw new Error("pty.create answered without a pty id");
  return id;
}

/** The one line the pty's shell runs. exec, so the pty ends with the tool whatever way it ends: an
 * interactive shell drops the rest of a `cmd; exit` line on Ctrl-C and comes back to its prompt.
 * Leading NAME=value words stay in front of exec; a command the shell cannot find exits the pty too. */
export function shellLine(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  const words = command.split(" ");
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  return `${[...words.slice(0, i), "exec", ...words.slice(i)].join(" ")} || exit\r`;
}

export async function relayPty(o: RelayOptions): Promise<RelayOutcome> {
  const { input, output } = o.terminal;
  const now = o.now ?? Date.now;
  const cols = output.columns ?? 80;
  const rows = output.rows ?? 24;
  // bash by name: the person's login shell may read interactive rc files that would sit under the typed line.
  const ptyId = ptyIdOf(await o.link.op("pty.create", { cols, rows, shell: "bash" }));
  const scanner = new UrlScanner();
  const outcome: RelayOutcome = { exitCode: -1, timedOut: false, dropped: false, urls: 0, opened: 0 };
  let offer: { url: string; at: number; typed: boolean } | undefined;
  let done: (() => void) | undefined;
  const exited = new Promise<void>(r => (done = r));
  const show = (urls: string[]): void => {
    for (const url of urls) {
      outcome.urls += 1;
      offer = { url, at: now(), typed: false };
      output.write(`\r\n  ${dim("link")}  ${hyperlink(url)}  ${dim("o opens it on this computer")}\r\n`);
    }
  };
  let flush: NodeJS.Timeout | undefined;

  const detach = o.link.onEvent(e => {
    if (e["ptyId"] !== ptyId) return;
    if (e["type"] === "pty.data") {
      const data = String(e["data"]);
      output.write(data);
      show(scanner.feed(data));
      if (flush) clearTimeout(flush);
      flush = setTimeout(() => show(scanner.flush()), o.flushMs ?? FLUSH_MS);
      flush.unref();
      return;
    }
    if (e["type"] === "pty.exit") {
      outcome.exitCode = Number(e["exitCode"]);
      done?.();
    }
  });
  void o.link.closed?.then(() => {
    if (outcome.exitCode === -1) outcome.dropped = true;
    done?.();
  });

  const wasRaw = input.isRaw === true;
  let rawSet = false;
  const onData = (chunk: Buffer | string): void => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (s === "o" && offer !== undefined && !offer.typed && now() - offer.at <= OFFER_MS) {
      const page = o.callbackUrl?.();
      const url = page ?? offer.url;
      o.onConsent?.(url);
      void o.open(url).then(ok => {
        if (ok) outcome.opened += 1;
        output.write(`\r\n  ${dim(ok ? (page !== undefined ? OPENED_PAGE : OPENED_PRINTED) : "could not open a browser here; use the link above")}\r\n`);
      });
      return;
    }
    if (offer !== undefined && PRINTABLE.test(s.replace(CSI, ""))) offer.typed = true;
    void o.link.op("pty.write", { ptyId, data: s }).catch(() => {});
  };
  const onResize = (): void => {
    void o.link.op("pty.resize", { ptyId, cols: output.columns ?? cols, rows: output.rows ?? rows }).catch(() => {});
  };
  const timer = setTimeout(() => {
    outcome.timedOut = true;
    done?.();
  }, o.timeoutMs);
  timer.unref();

  try {
    okOrThrow("pty.attach", await o.link.op("pty.attach", { ptyId }));
    if (input.isTTY && input.setRawMode) {
      input.setRawMode(true);
      rawSet = true;
    }
    input.on("data", onData);
    input.resume();
    output.on("resize", onResize);
    const line = shellLine(o.command);
    if (line !== undefined) await o.link.op("pty.write", { ptyId, data: line });
    await exited;
  } finally {
    clearTimeout(timer);
    if (flush) clearTimeout(flush);
    input.off("data", onData);
    input.pause();
    output.off("resize", onResize);
    if (rawSet && input.setRawMode) input.setRawMode(wasRaw);
    detach();
    await o.link.op("pty.kill", { ptyId }).catch(() => {});
  }
  return outcome;
}

export interface QuietRun {
  output: string;
  exitCode: number;
  timedOut: boolean;
  /** The daemon link went away before the command answered. */
  dropped: boolean;
}

const STATUS_MARK = "WSP_STATUS";

/** Runs one command on the builder with nothing shown: the output between the
 * echoed line and the exit marker, for the secrets step. `env` rides the pty's
 * environment, where a value never reaches the echoed line. */
export async function runQuiet(link: PtyLink, command: string, timeoutMs: number, env: Record<string, string> = {}): Promise<QuietRun> {
  const ptyId = ptyIdOf(await link.op("pty.create", { cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", ...env } }));
  let text = "";
  /** Index of the exit marker line in what arrived so far, -1 before it. */
  const markAtEnd = (): number => {
    const lines = text.replace(/\r/g, "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) if (/^WSP_STATUS \d+$/.test(lines[i]!)) return i;
    return -1;
  };
  let done: (() => void) | undefined;
  const exited = new Promise<void>(r => (done = r));
  const detach = link.onEvent(e => {
    if (e["ptyId"] !== ptyId) return;
    if (e["type"] === "pty.data") text += String(e["data"]);
    if (e["type"] === "pty.exit") done?.();
  });
  let timedOut = false;
  let dropped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    done?.();
  }, timeoutMs);
  timer.unref();
  void link.closed?.then(() => {
    if (done !== undefined && markAtEnd() < 0) dropped = true;
    done?.();
  });
  try {
    okOrThrow("pty.attach", await link.op("pty.attach", { ptyId }));
    await link.op("pty.write", { ptyId, data: `${command}; printf '\\n${STATUS_MARK} %s\\n' $?; exit\r` });
    await exited;
  } finally {
    clearTimeout(timer);
    detach();
    await link.op("pty.kill", { ptyId }).catch(() => {});
  }
  const lines = text.replace(/\r/g, "").split("\n");
  const markAt = markAtEnd();
  const exitCode = markAt >= 0 ? Number(/(\d+)$/.exec(lines[markAt]!)![1]) : -1;
  // The first line is the shell echoing what was typed.
  const body = lines.slice(1, markAt >= 0 ? markAt : undefined);
  // Tools colour into the pty (opencode 1.18.18 paints key names even piped); the readers want the words.
  return { output: stripVTControlCharacters(body.join("\n")).trim(), exitCode, timedOut, dropped };
}

export interface CheckAnswer {
  output: string;
  exitCode: number;
}

export interface ChecksRun {
  /** By command, what the guest answered; undefined for one still silent when the run ended. */
  answers: (CheckAnswer | undefined)[];
  timedOut: boolean;
  /** The daemon link went away before every command answered. */
  dropped: boolean;
}

const HEREDOC_END = "WSP_EOF";
export const CHECK_RUN_LINE = 'sh "$d/run"; exit';
/** One pty.write carries at most this much: the line discipline's input buffer is 4096 bytes. */
const WRITE_BYTES = 2000;
const STATUS_LINE = /^WSP_STATUS (\d+) (\d+)$/;

/** The lines typed into the guest's sh: a heredoc that writes a script, then runs it. The script reads the
 * secrets file only when it is there, since a `.` of a missing file is fatal in a POSIX sh (dash drops the
 * rest of the line, a non-interactive sh exits); starts every command at once, each in a background subshell
 * with stdin closed so none can wait on the terminal or stop the rest with an exit; and prints one marker
 * pair per command as it finishes. The exit code lands by rename, so a marker never reads a half-written file.
 * The script removes its own dir when it ends, including on the hangup a killed pty sends, so a run the budget
 * cut short leaves nothing on the machine. */
export function checkScript(commands: readonly string[], secretsFile: string): string[] {
  const ids = commands.map((_, i) => String(i + 1));
  return [
    `d=$(mktemp -d "\${TMPDIR:-/tmp}/wsp-check.XXXXXX") && cat >"$d/run" <<'${HEREDOC_END}'`,
    `d=$(dirname "$0")`,
    `trap 'rm -rf "$d"' EXIT`,
    `trap exit HUP TERM`,
    `[ -r ${secretsFile} ] && . ${secretsFile}`,
    ...commands.map((c, i) => `{ ( ${c} ) >"$d/${ids[i]}" 2>&1 </dev/null; echo $? >"$d/${ids[i]}.tmp"; mv "$d/${ids[i]}.tmp" "$d/${ids[i]}.rc"; } &`),
    `n=0; while [ $n -lt ${ids.length} ]; do for i in ${ids.join(" ")}; do if [ -f "$d/$i.rc" ]; then printf 'WSP_STATUS %s %s\\n' "$i" "$(cat "$d/$i.rc")"; cat "$d/$i"; printf '\\nWSP_END %s\\n' "$i"; rm "$d/$i.rc"; n=$((n+1)); fi; done; sleep 0.2; done`,
    HEREDOC_END,
    CHECK_RUN_LINE,
  ];
}

export interface ChecksOptions {
  commands: readonly string[];
  /** The secrets step's file, read by the script first when it is there. */
  secretsFile: string;
  /** Shared by every command; one still silent then is left unanswered. */
  budgetMs: number;
  /** The guest's sh; a test names another. */
  shell?: string;
}

/** Runs every status command on the builder at once through one quiet pty and hands each answer over as
 * its marker pair arrives; ends when all answered, the shared budget ran out, or the link dropped. */
export async function runChecks(link: PtyLink, o: ChecksOptions, onAnswer: (index: number, answer: CheckAnswer) => void): Promise<ChecksRun> {
  const { commands } = o;
  const ptyId = ptyIdOf(await link.op("pty.create", { cols: 200, rows: 50, shell: o.shell ?? "/bin/sh", env: { PS1: "", PS2: "" } }));
  const answers: (CheckAnswer | undefined)[] = commands.map(() => undefined);
  let text = "";
  let done: (() => void) | undefined;
  const ended = new Promise<void>(r => (done = r));
  const settled = (): boolean => answers.every(a => a !== undefined);
  /** Every complete marker pair in what arrived so far, each handed over once. The script prints the pairs one
   * after another, so everything between a start marker and its end marker is that tool's output, whatever it
   * looks like, and an open pair is the tail of the stream. */
  const read = (): void => {
    const lines = text.replace(/\r/g, "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = STATUS_LINE.exec(lines[i]!);
      if (!m) continue;
      const end = lines.indexOf(`WSP_END ${m[1]}`, i + 1);
      if (end < 0) break;
      const index = Number(m[1]) - 1;
      if (index < commands.length && answers[index] === undefined) {
        const answer = { output: stripVTControlCharacters(lines.slice(i + 1, end).join("\n")).trim(), exitCode: Number(m[2]) };
        answers[index] = answer;
        onAnswer(index, answer);
      }
      i = end;
    }
    if (settled()) done?.();
  };
  const detach = link.onEvent(e => {
    if (e["ptyId"] !== ptyId) return;
    if (e["type"] === "pty.data") {
      text += String(e["data"]);
      read();
    }
    if (e["type"] === "pty.exit") done?.();
  });
  let timedOut = false;
  let dropped = false;
  const timer = setTimeout(() => {
    timedOut = true;
    done?.();
  }, o.budgetMs);
  timer.unref();
  void link.closed?.then(() => {
    if (done !== undefined && !settled()) dropped = true;
    done?.();
  });
  try {
    okOrThrow("pty.attach", await link.op("pty.attach", { ptyId }));
    for (const data of batched(checkScript(commands, o.secretsFile).map(l => `${l}\r`))) await link.op("pty.write", { ptyId, data });
    await ended;
  } finally {
    clearTimeout(timer);
    detach();
    await link.op("pty.kill", { ptyId }).catch(() => {});
  }
  return { answers, timedOut: timedOut && !settled(), dropped };
}

/** Whole lines packed into writes under WRITE_BYTES; a line longer than that goes alone. */
function batched(lines: readonly string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur !== "" && cur.length + l.length > WRITE_BYTES) {
      out.push(cur);
      cur = "";
    }
    cur += l;
  }
  if (cur !== "") out.push(cur);
  return out;
}
