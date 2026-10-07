// SPDX-License-Identifier: AGPL-3.0-only
// A daemon link whose ptys are scripted: every op is recorded, typed bytes are
// kept per pty, and a pty created with args runs them as a daemon does: as it
// is attached, the shell's own lines print first, then the mark a sign-in's
// bash prints as its tool starts, and the line its args run, with the command
// standing where the line reads it, is handed to the script. A complete typed
// line (ending in \r) is echoed back the way a tty would and handed to the
// script too; the test pushes output and exits.
import { TOOL_STARTS, type PtyLink } from "../src/signin-relay.js";

/** What a sign-in's bash prints as its tool starts. */
const MARKS_TOOL = "printf '\\036'";

export interface FakePty {
  id: string;
  created: Record<string, unknown>;
  /** Every pty.write payload in order: what was typed into the pty, and nothing it was started with. */
  writes: string[];
  attached: boolean;
  killed: boolean;
  resizes: { cols: number; rows: number }[];
  exited: boolean;
  /** The command its args ran, where they ran one. */
  ran?: string;
  /** The line its args ran, the command standing where the line reads it. */
  line?: string;
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
  /** What each pty's shell prints as it is attached, before its tool starts: an rc file's words. */
  banner?: string;
  /** The daemon is older than args: it answers a pty.create without saying it ran them. */
  noArgv?: boolean;
  /** Called with the line a pty's args run as it is attached, and with each complete typed line after its echo. */
  script?: (pty: FakePty, line: string) => void;
  emit(e: Record<string, unknown>): void;
  data(pty: FakePty, text: string): void;
  exit(pty: FakePty, exitCode: number): void;
  /** True when the pty got exactly this typed (a Ctrl-C, say). */
  typed(pty: FakePty, s: string): boolean;
}

/** The script after `-c` and the command it reads as $1, as `<shell> -c <script> <$0> <command>` hands them. */
function ranBy(args: unknown): { line: string; command: string } | undefined {
  if (!Array.isArray(args)) return undefined;
  const at = args.indexOf("-c");
  const script = args[at + 1];
  const command = args[at + 3];
  if (at < 0 || typeof script !== "string" || typeof command !== "string") return undefined;
  return { line: script.replace('eval "$1"', command).replace('"$1"', command), command };
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
          const ran = ranBy(extra["args"]);
          const pty: FakePty = { id: `pty_${++seq}`, created: extra, writes: [], attached: false, killed: false, resizes: [], exited: false, ...(ran !== undefined ? { ran: ran.command, line: ran.line } : {}) };
          link.ptys.push(pty);
          return { ok: true, ptyId: pty.id, pid: 100 + seq, ...(extra["args"] !== undefined && link.noArgv !== true ? { argv: true } : {}) };
        }
        case "pty.attach": {
          const pty = find();
          pty.attached = true;
          if (link.banner !== undefined) link.data(pty, link.banner);
          if (pty.line !== undefined) {
            if (pty.line.includes(MARKS_TOOL)) link.data(pty, TOOL_STARTS);
            link.script?.(pty, pty.line);
          }
          return { ok: true, ptyId: extra["ptyId"] };
        }
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
        case "exec":
          return { ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false };
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
      return pty.writes.includes(s);
    },
  };
  return link;
}

/** The execs a caller ran on the link. */
export function execsBeside(link: FakePtyLink): { op: string; extra: Record<string, unknown> }[] {
  return link.ops.filter(o => o.op === "exec");
}
