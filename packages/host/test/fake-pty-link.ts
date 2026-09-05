// SPDX-License-Identifier: AGPL-3.0-only
// A daemon link whose ptys are scripted: every op is recorded, typed bytes are
// kept per pty, a complete line (ending in \r) is echoed back the way a tty
// would and handed to the script, and the test pushes output and exits.
import { CHECK_RUN_LINE, type PtyLink } from "../src/signin-relay.js";

export interface FakePty {
  id: string;
  created: Record<string, unknown>;
  /** Every pty.write payload in order. */
  writes: string[];
  attached: boolean;
  killed: boolean;
  resizes: { cols: number; rows: number }[];
  exited: boolean;
}

export interface FakePtyLink extends PtyLink {
  ops: { op: string; extra: Record<string, unknown> }[];
  ptys: FakePty[];
  /** How many links were dialled through dial(). */
  dials: number;
  /** A fresh link view over the same ptys, the way a redial gives one; its closed settles on drop(). */
  dial(): PtyLink;
  /** The latest dialled view goes away: closed settles and its ops reject the way a dead socket's do. */
  drop(): void;
  /** Called with each complete typed line, after its echo. */
  script?: (pty: FakePty, line: string) => void;
  emit(e: Record<string, unknown>): void;
  data(pty: FakePty, text: string): void;
  exit(pty: FakePty, exitCode: number): void;
  /** True when the pty got exactly this typed after its command line (a Ctrl-C, say). */
  typed(pty: FakePty, s: string): boolean;
}

export function fakePtyLink(): FakePtyLink {
  const fns = new Set<(e: Record<string, unknown>) => void>();
  const partial = new Map<string, string>();
  let seq = 0;
  const views: { dropped: boolean; settle: () => void }[] = [];
  const link: FakePtyLink = {
    ops: [],
    ptys: [],
    dials: 0,
    dial() {
      let settle: () => void = () => {};
      const closed = new Promise<void>(r => (settle = r));
      const view = { dropped: false, settle };
      views.push(view);
      link.dials += 1;
      return {
        op: (op, extra) => (view.dropped ? Promise.reject(new Error("daemon connection closed 1006")) : link.op(op, extra)),
        onEvent: fn => link.onEvent(fn),
        closed,
      };
    },
    drop() {
      const view = views.at(-1);
      if (!view) throw new Error("nothing dialled");
      view.dropped = true;
      view.settle();
    },
    async op(op, extra = {}) {
      link.ops.push({ op, extra });
      const find = (): FakePty => {
        const p = link.ptys.find(x => x.id === extra["ptyId"]);
        if (!p) throw new Error(`no pty ${String(extra["ptyId"])}`);
        return p;
      };
      switch (op) {
        case "pty.create": {
          const pty: FakePty = { id: `pty_${++seq}`, created: extra, writes: [], attached: false, killed: false, resizes: [], exited: false };
          link.ptys.push(pty);
          return { ok: true, ptyId: pty.id, pid: 100 + seq };
        }
        case "pty.attach":
          find().attached = true;
          return { ok: true, ptyId: extra["ptyId"] };
        case "pty.write": {
          const pty = find();
          const s = String(extra["data"]);
          pty.writes.push(s);
          const buf = (partial.get(pty.id) ?? "") + s;
          const lines = buf.split("\r");
          partial.set(pty.id, lines.pop() ?? "");
          for (const line of lines) {
            link.data(pty, `${line}\r\n`);
            link.script?.(pty, line);
          }
          return { ok: true };
        }
        case "pty.resize":
          find().resizes.push({ cols: Number(extra["cols"]), rows: Number(extra["rows"]) });
          return { ok: true };
        case "pty.kill":
          find().killed = true;
          return { ok: true };
        default:
          return { ok: true };
      }
    },
    onEvent(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    emit(e) {
      for (const f of fns) f(e);
    },
    data(pty, text) {
      link.emit({ type: "pty.data", ptyId: pty.id, data: text });
    },
    exit(pty, exitCode) {
      pty.exited = true;
      link.emit({ type: "pty.exit", ptyId: pty.id, exitCode });
    },
    typed(pty, s) {
      return pty.writes.slice(1).includes(s);
    },
  };
  return link;
}

export interface CheckAnswer {
  output: string;
  exitCode: number;
}

const TOOL_LINE = /^\{ \( (.*) \) >"\$d\/(\d+)" 2>&1 <\/dev\/null; /;

/** The fake guest runs the check script: from the heredoc's first line to the run line every typed line is
 * the script's, the tool lines are remembered, and the run line answers each through `answer` as the script
 * would, one marker pair per tool in the order they finish (the answer's `after` gives a later place); a tool
 * answered undefined stays silent. The pty exits once every tool answered. Returns true for a line of the
 * script, so a script hook can pass the rest on. */
export function answersChecks(link: FakePtyLink, answer: (command: string) => (CheckAnswer & { after?: number }) | undefined): (pty: FakePty, line: string) => boolean {
  const scripts = new Map<string, { index: number; command: string }[]>();
  return (pty, line) => {
    if (line.endsWith("<<'WSP_EOF'")) {
      scripts.set(pty.id, []);
      return true;
    }
    const tools = scripts.get(pty.id);
    if (tools === undefined) return false;
    const tool = TOOL_LINE.exec(line);
    if (tool) tools.push({ index: Number(tool[2]), command: tool[1]! });
    if (line !== CHECK_RUN_LINE) return true;
    scripts.delete(pty.id);
    const answers = tools.map(t => ({ ...t, answer: answer(t.command) })).filter(t => t.answer !== undefined);
    answers.sort((a, b) => (a.answer!.after ?? 0) - (b.answer!.after ?? 0));
    for (const t of answers) link.data(pty, `WSP_STATUS ${t.index} ${t.answer!.exitCode}\r\n${t.answer!.output.replace(/\n/g, "\r\n")}\r\nWSP_END ${t.index}\r\n`);
    if (answers.length === tools.length) link.exit(pty, 0);
    return true;
  };
}
