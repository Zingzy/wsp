// SPDX-License-Identifier: AGPL-3.0-only
// The pty relay against a scripted link: bytes both ways, raw mode set and
// restored, size propagated, a printed URL shown once as a hyperlink and
// opened here on o, the quiet status run reading only what sits between the
// echo and the exit marker.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { CHECK_RUN_LINE, OFFER_MS, UrlScanner, checkScript, hyperlink, relayPty, runChecks, runQuiet, shellLine, stripOsc8, urlsIn, type RelayTerminal } from "../src/signin-relay.js";
import { SH_FILE } from "../src/init-secrets.js";
import { answersChecks, checkTag, fakePtyLink, type FakePty } from "./fake-pty-link.js";

interface Term extends RelayTerminal {
  input: PassThrough & RelayTerminal["input"];
  text(): string;
  raw: boolean[];
  columns: number;
  rows: number;
}

function terminal(tty = true): Term {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (on: boolean) => void };
  const output = new PassThrough() as PassThrough & { columns?: number; rows?: number };
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const raw: boolean[] = [];
  if (tty) {
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (on: boolean) => {
      raw.push(on);
      input.isRaw = on;
    };
  }
  output.columns = 120;
  output.rows = 40;
  return {
    input,
    output,
    text: () => chunks.join(""),
    raw,
    get columns() {
      return output.columns!;
    },
    set columns(v: number) {
      output.columns = v;
    },
    get rows() {
      return output.rows!;
    },
    set rows(v: number) {
      output.rows = v;
    },
  };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));

async function firstPty(link: ReturnType<typeof fakePtyLink>): Promise<FakePty> {
  for (let i = 0; i < 100 && link.ptys.length === 0; i++) await tick();
  const pty = link.ptys[0];
  if (!pty) throw new Error("no pty was created");
  return pty;
}

describe("URL detection", () => {
  it("strips OSC 8 wrappers, drops trailing punctuation and leaves a match that runs to the chunk's end for the next chunk", () => {
    const wrapped = "visit \x1b]8;;https://example.com/a?x=1\x1b\\https://example.com/a?x=1\x1b]8;;\x1b\\ now";
    expect(stripOsc8(wrapped)).toBe("visit https://example.com/a?x=1 now");
    expect(urlsIn(wrapped)).toEqual(["https://example.com/a?x=1"]);
    expect(urlsIn("Open this URL (https://github.com/login/device).\r\n")).toEqual(["https://github.com/login/device"]);
    expect(urlsIn("Open https://github.com/login/dev")).toEqual([]);
    expect(urlsIn("http://localhost:8976/oauth/callback and https://example.com/a and https://example.com/a again")).toEqual(["http://localhost:8976/oauth/callback", "https://example.com/a"]);
  });

  it("reports a URL split across chunks exactly once, and the same URL printed again not at all", () => {
    const s = new UrlScanner();
    expect(s.feed("Press Enter to open https://github.com/lo")).toEqual([]);
    expect(s.feed("gin/device in your browser...\r\n")).toEqual(["https://github.com/login/device"]);
    expect(s.feed("Open this URL to continue: https://github.com/login/device\r\n")).toEqual([]);
    expect(s.feed("\x1b]8;;https://claude.com/x\x07https://claude.com/x\x1b]8;;\x07\r\n")).toEqual(["https://claude.com/x"]);
  });

  it("flush settles a URL that ended the last chunk, once", () => {
    const s = new UrlScanner();
    expect(s.feed("Open https://x.test/abc")).toEqual([]);
    expect(s.flush()).toEqual(["https://x.test/abc"]);
    expect(s.flush()).toEqual([]);
    expect(s.feed("\r\n")).toEqual([]);
  });

  it("renders a terminal hyperlink", () => {
    expect(hyperlink("https://a.b/c")).toBe("\x1b]8;;https://a.b/c\x1b\\https://a.b/c\x1b]8;;\x1b\\");
  });

  it("execs the command so the pty ends with it, keeps an env prefix in front, exits on a command the shell cannot find; a bare shell gets no line", () => {
    expect(shellLine("gh auth login")).toBe("exec gh auth login || exit\r");
    expect(shellLine("NO_BROWSER=true gemini")).toBe("NO_BROWSER=true exec gemini || exit\r");
    expect(shellLine("codex login --device-auth")).toBe("exec codex login --device-auth || exit\r");
    expect(shellLine(undefined)).toBeUndefined();
  });
});

describe("relayPty", () => {
  it("opens a pty at the terminal's size, runs the command, relays keystrokes up and bytes down, follows a resize, and restores the terminal", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    const run = relayPty({ link, command: "gh auth login", terminal: term, open: async u => (opened.push(u), true), timeoutMs: 60_000 });
    const pty = await firstPty(link);
    expect(pty.created).toEqual({ cols: 120, rows: 40, shell: "bash" });
    await tick();
    expect(pty.attached).toBe(true);
    expect(pty.writes[0]).toBe("exec gh auth login || exit\r");
    expect(term.raw).toEqual([true]);

    link.data(pty, "? Authenticate Git with your GitHub credentials? (Y/n) ");
    expect(term.text()).toContain("Authenticate Git");
    term.input.write("n");
    term.input.write("\r");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["n", "\r"]);

    term.columns = 100;
    term.rows = 30;
    term.output.emit("resize");
    await tick();
    expect(pty.resizes).toEqual([{ cols: 100, rows: 30 }]);

    link.exit(pty, 0);
    const outcome = await run;
    expect(outcome).toEqual({ exitCode: 0, timedOut: false, dropped: false, urls: 0, opened: 0 });
    expect(term.raw).toEqual([true, false]);
    expect(pty.killed).toBe(true);
    expect(term.input.listenerCount("data")).toBe(0);
    expect(term.output.listenerCount("resize")).toBe(0);
    expect(opened).toEqual([]);
  });

  it("shows a printed URL once as a hyperlink with the o offer; o opens it here, gives consent, and is not sent to the pty", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    let consented = 0;
    const run = relayPty({ link, command: "claude auth login", terminal: term, open: async u => (opened.push(u), true), onConsent: () => consented++, timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    const url = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
    link.data(pty, `If the browser didn't open, visit: \x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\\r\nPaste code here if prompted > `);
    const shown = term.text();
    expect(shown).toContain(hyperlink(url));
    expect(shown).toContain("o opens it on this computer");
    expect(shown.split("o opens it on this computer")).toHaveLength(2);

    term.input.write("o");
    await tick();
    expect(opened).toEqual([url]);
    expect(consented).toBe(1);
    expect(pty.writes.slice(1)).toEqual([]);
    expect(stripVTControlCharacters(term.text())).toContain("opened on this computer");

    // The same URL printed again is not offered again. Enter keeps the offer (gh asks for one before it opens);
    // typing text ends it, so a later o is a keystroke.
    link.data(pty, `visit: ${url}\r\n`);
    expect(term.text().split("o opens it on this computer")).toHaveLength(2);
    term.input.write("\r");
    term.input.write("o");
    await tick();
    expect(opened).toEqual([url, url]);
    term.input.write("x");
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["\r", "x", "o"]);
    expect(opened).toEqual([url, url]);

    link.exit(pty, 0);
    const outcome = await run;
    expect(outcome).toEqual({ exitCode: 0, timedOut: false, dropped: false, urls: 1, opened: 2 });
  });

  it("o opens the page the machine asked for when one arrived that returns through a forwarded port, and says so; without one, the printed link with the paste-code line", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    const consented: string[] = [];
    let page: string | undefined;
    const run = relayPty({ link, command: "claude auth login", terminal: term, open: async u => (opened.push(u), true), onConsent: u => consented.push(u), callbackUrl: () => page, timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    const printed = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
    link.data(pty, `If the browser didn't open, visit: ${printed}\r\nPaste code here if prompted > `);
    term.input.write("o");
    await tick();
    expect(opened).toEqual([printed]);
    expect(stripVTControlCharacters(term.text())).toContain("opened on this computer; if the page shows a code, paste it into the terminal above");

    page = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A42485%2Fcallback";
    term.input.write("o");
    await tick();
    expect(opened).toEqual([printed, page]);
    expect(consented).toEqual([printed, page]);
    expect(stripVTControlCharacters(term.text())).toContain("opened the sign-in page; it returns to the machine on its own");
    expect(pty.writes.slice(1)).toEqual([]);
    link.exit(pty, 0);
    expect((await run).opened).toBe(2);
  });

  it("arrow keys and other CSI sequences keep the o offer; typed text ends it", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const opened: string[] = [];
    const run = relayPty({ link, command: "gh auth login", terminal: term, open: async u => (opened.push(u), true), timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    link.data(pty, "? Where do you use GitHub?  [Use arrows to move]\r\n> GitHub.com https://github.com/login/device \r\n");
    // CSI arrows, then the application-mode (DECCKM) arrows a tool that sets it makes the terminal send.
    term.input.write("\x1b[B");
    term.input.write("\x1b[A");
    term.input.write("\x1bOA");
    term.input.write("\x1bOB");
    term.input.write("\r");
    term.input.write("o");
    await tick();
    expect(opened).toEqual(["https://github.com/login/device"]);
    expect(pty.writes.slice(1)).toEqual(["\x1b[B", "\x1b[A", "\x1bOA", "\x1bOB", "\r"]);
    term.input.write("n");
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["\x1b[B", "\x1b[A", "\x1bOA", "\x1bOB", "\r", "n", "o"]);
    link.exit(pty, 0);
    await run;
  });

  it("a URL that ends the chunk is offered after a short quiet, so a tool that prints it and blocks still gets o", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const run = relayPty({ link, command: "netlify login", terminal: term, open: async () => true, timeoutMs: 60_000, flushMs: 20 });
    const pty = await firstPty(link);
    await tick();
    link.data(pty, "Opening https://app.netlify.com/authorize?ticket=abc");
    expect(term.text()).not.toContain("o opens it on this computer");
    await new Promise(r => setTimeout(r, 60));
    expect(term.text().split("o opens it on this computer")).toHaveLength(2);
    expect(term.text()).toContain(hyperlink("https://app.netlify.com/authorize?ticket=abc"));
    link.exit(pty, 0);
    expect((await run).urls).toBe(1);
  });

  it("an o pressed long after the URL appeared is a keystroke, and a failed open says so", async () => {
    const link = fakePtyLink();
    const term = terminal();
    let t = 1_000_000;
    const run = relayPty({ link, command: "netlify login", terminal: term, open: async () => false, timeoutMs: 60_000, now: () => t });
    const pty = await firstPty(link);
    await tick();
    link.data(pty, "Opening https://app.netlify.com/authorize?response_type=ticket&ticket=abc \r\n");
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual([]);
    expect(stripVTControlCharacters(term.text())).toContain("could not open a browser here");
    t += OFFER_MS + 1;
    term.input.write("o");
    await tick();
    expect(pty.writes.slice(1)).toEqual(["o"]);
    link.exit(pty, 130);
    expect((await run).exitCode).toBe(130);
  });

  it("kills the pty and reports a timeout when the tool never finishes", async () => {
    const link = fakePtyLink();
    const term = terminal();
    const run = relayPty({ link, command: "gcloud auth login", terminal: term, open: async () => true, timeoutMs: 20 });
    const pty = await firstPty(link);
    const outcome = await run;
    expect(outcome.timedOut).toBe(true);
    expect(pty.killed).toBe(true);
    expect(term.raw).toEqual([true, false]);
  });

  it("a link that drops under the pty ends the relay with the terminal restored", async () => {
    const link = fakePtyLink();
    let drop: (() => void) | undefined;
    link.closed = new Promise<void>(r => (drop = r));
    const term = terminal();
    const run = relayPty({ link, command: "codex login", terminal: term, open: async () => true, timeoutMs: 60_000 });
    await firstPty(link);
    await tick();
    drop!();
    const outcome = await run;
    expect(outcome).toMatchObject({ exitCode: -1, dropped: true, timedOut: false });
    expect(term.raw).toEqual([true, false]);
  });

  it("a bare shell writes no command line and leaves raw mode alone off a tty", async () => {
    const link = fakePtyLink();
    const term = terminal(false);
    const run = relayPty({ link, terminal: term, open: async () => true, timeoutMs: 60_000 });
    const pty = await firstPty(link);
    await tick();
    expect(pty.writes).toEqual([]);
    expect(term.raw).toEqual([]);
    term.input.write("exit\r");
    await tick();
    expect(pty.writes).toEqual(["exit\r"]);
    link.exit(pty, 0);
    await run;
  });
});

describe("a refused pty op", () => {
  const refusing = (op: string) => {
    const link = fakePtyLink();
    const real = link.op.bind(link);
    link.op = async (name, extra = {}) => {
      if (name !== op) return real(name, extra);
      link.ops.push({ op: name, extra });
      return { id: 1, ok: false, error: `${op} is not allowed here` };
    };
    return link;
  };

  it("pty.create answered ok:false throws with the daemon's reason, so nothing goes raw and no attach or write follows", async () => {
    const link = refusing("pty.create");
    const term = terminal();
    await expect(relayPty({ link, command: "gh auth login", terminal: term, open: async () => true, timeoutMs: 60_000 })).rejects.toThrow("pty.create refused: pty.create is not allowed here");
    expect(term.raw).toEqual([]);
    expect(link.ops.map(o => o.op)).toEqual(["pty.create"]);
    await expect(runQuiet(link, "gh auth status", 5_000)).rejects.toThrow("pty.create refused: pty.create is not allowed here");
    expect(link.ops.map(o => o.op)).toEqual(["pty.create", "pty.create"]);
  });

  it("pty.attach answered ok:false throws too, with the pty killed and the terminal untouched", async () => {
    const link = refusing("pty.attach");
    const term = terminal();
    await expect(relayPty({ link, command: "gh auth login", terminal: term, open: async () => true, timeoutMs: 60_000 })).rejects.toThrow("pty.attach refused");
    expect(term.raw).toEqual([]);
    expect(link.ptys[0]!.killed).toBe(true);
    expect(link.ptys[0]!.writes).toEqual([]);
    await expect(runQuiet(link, "gh auth status", 5_000)).rejects.toThrow("pty.attach refused");
    expect(link.ptys[1]!.killed).toBe(true);
  });
});

describe("runQuiet", () => {
  it("runs the status command in a promptless sh and returns only what sits between the echo and the exit marker", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.startsWith("gh auth status")) {
        link.data(pty, "github.com\r\n  ✓ Logged in to github.com account someone (keyring)\r\n  - Token: gho_****\r\n\r\nWSP_STATUS 1\r\n");
        link.exit(pty, 1);
      }
    };
    const res = await runQuiet(link, "gh auth status", 5_000);
    expect(link.ptys[0]!.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "" } });
    expect(link.ptys[0]!.writes).toEqual(["gh auth status; printf '\\nWSP_STATUS %s\\n' $?; exit\r"]);
    expect(res).toEqual({ output: "github.com\n  ✓ Logged in to github.com account someone (keyring)\n  - Token: gho_****", exitCode: 1, timedOut: false, dropped: false });
    expect(link.ptys[0]!.killed).toBe(true);
  });

  it("hands back the output as plain text: a tool that colours into the pty (opencode 1.18.18 paints key names) reads as words", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.startsWith("opencode auth list")) {
        link.data(pty, "\x1b[0m\r\n●  Anthropic \x1b[90mANTHROPIC_API_KEY\r\n│\r\n└  1 environment variable\r\n\r\nWSP_STATUS 0\r\n");
        link.exit(pty, 0);
      }
    };
    const res = await runQuiet(link, "opencode auth list", 5_000);
    expect(res.output).toBe("●  Anthropic ANTHROPIC_API_KEY\n│\n└  1 environment variable");
  });

  it("times out a status command that never answers", async () => {
    const link = fakePtyLink();
    const res = await runQuiet(link, "codex login status", 20);
    expect(res).toEqual({ output: "", exitCode: -1, timedOut: true, dropped: false });
    expect(link.ptys[0]!.killed).toBe(true);
  });

  it("a link that drops during the status command reads as dropped, not as an answer", async () => {
    const link = fakePtyLink();
    const view = link.dial();
    const run = runQuiet(view, "codex login status", 5_000);
    await firstPty(link);
    await tick();
    link.drop();
    expect(await run).toEqual({ output: "", exitCode: -1, timedOut: false, dropped: true });
  });
});

describe("the check script", () => {
  it("is a heredoc the guest's sh runs: its dir removed when it ends or is hung up, the secrets file read only when it is there, every status in its own background subshell with stdin closed, its output and exit code in files, one tagged marker pair printed per tool as it finishes", () => {
    const lines = checkScript(["gh auth status", "claude auth status; s=$?; (exit $s)"], SH_FILE, "a1b2c3");
    expect(lines).toEqual([
      `d=$(mktemp -d "\${TMPDIR:-/tmp}/wsp-check.XXXXXX") && cat >"$d/run" <<'WSP_EOF'`,
      `d=$(dirname "$0")`,
      `trap 'rm -rf "$d"' EXIT`,
      `trap exit HUP TERM`,
      `[ -r /etc/profile.d/wsp-secrets.sh ] && . /etc/profile.d/wsp-secrets.sh`,
      `{ ( gh auth status ) >"$d/1" 2>&1 </dev/null; echo $? >"$d/1.tmp"; mv "$d/1.tmp" "$d/1.rc"; } &`,
      `{ ( claude auth status; s=$?; (exit $s) ) >"$d/2" 2>&1 </dev/null; echo $? >"$d/2.tmp"; mv "$d/2.tmp" "$d/2.rc"; } &`,
      `n=0; while [ $n -lt 2 ]; do for i in 1 2; do if [ -f "$d/$i.rc" ]; then printf 'WSP_STATUS a1b2c3 %s %s\\n' "$i" "$(cat "$d/$i.rc")"; cat "$d/$i"; printf '\\nWSP_END a1b2c3 %s\\n' "$i"; rm "$d/$i.rc"; n=$((n+1)); fi; done; sleep 0.2; done`,
      "WSP_EOF",
      CHECK_RUN_LINE,
    ]);
    // The pty's line discipline takes 4095 bytes per line; every line stays well under it.
    for (const l of lines) expect(l.length).toBeLessThan(1000);
  });
});

describe("runChecks", () => {
  it("types the script into one promptless sh, hands each tool's answer over as its marker pair arrives, in the order they finish, as plain text without the markers, and kills the pty", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => {
      if (command === "gh auth status") return { output: "github.com\n  \u2713 Logged in to github.com account someone (keyring)\n  - Token: gho_****\n", exitCode: 0, after: 2 };
      if (command === "opencode auth list") return { output: "\x1b[0m\n\u25cf  Anthropic \x1b[90mANTHROPIC_API_KEY\n\u2502\n\u2514  1 environment variable", exitCode: 0, after: 1 };
      return { output: "sh: 1: pi: not found", exitCode: 127 };
    });
    const seen: [number, { output: string; exitCode: number }][] = [];
    const res = await runChecks(link, { commands: ["gh auth status", "opencode auth list", "pi --list-models"], secretsFile: SH_FILE, budgetMs: 5_000 }, (i, a) => seen.push([i, a]));
    expect(link.ptys[0]!.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", PS2: "" } });
    expect(link.ptys[0]!.writes.join("")).toBe(checkScript(["gh auth status", "opencode auth list", "pi --list-models"], SH_FILE, checkTag(link.ptys[0]!)).map(l => `${l}\r`).join(""));
    expect(seen).toEqual([
      [2, { output: "sh: 1: pi: not found", exitCode: 127 }],
      [1, { output: "\u25cf  Anthropic ANTHROPIC_API_KEY\n\u2502\n\u2514  1 environment variable", exitCode: 0 }],
      [0, { output: "github.com\n  \u2713 Logged in to github.com account someone (keyring)\n  - Token: gho_****", exitCode: 0 }],
    ]);
    expect(res).toEqual({ answers: [seen[2]![1], seen[1]![1], seen[0]![1]], timedOut: false, dropped: false });
    expect(link.ptys[0]!.killed).toBe(true);
  });

  it("a tool still silent at the budget is the only one unanswered: the others' answers stand, the run says it timed out, and the pty is killed", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => (command === "gh auth status" ? { output: "ok", exitCode: 0 } : undefined));
    const seen: number[] = [];
    const res = await runChecks(link, { commands: ["gh auth status", "codex login status"], secretsFile: SH_FILE, budgetMs: 30 }, i => seen.push(i));
    expect(seen).toEqual([0]);
    expect(res).toEqual({ answers: [{ output: "ok", exitCode: 0 }, undefined], timedOut: true, dropped: false });
    expect(link.ptys[0]!.killed).toBe(true);
  });

  it("a marker split across chunks, or a tool whose output has no final newline, still reads whole; the script's own echoed lines are never taken for markers", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line !== CHECK_RUN_LINE) return;
      const tag = checkTag(pty);
      link.data(pty, "WSP_STA");
      link.data(pty, `TUS ${tag} 1 3\r\nno newline at the end`);
      link.data(pty, `\r\nWSP_END ${tag} 1\r\n`);
      link.exit(pty, 0);
    };
    const res = await runChecks(link, { commands: ["printf x"], secretsFile: SH_FILE, budgetMs: 5_000 }, () => {});
    expect(res).toEqual({ answers: [{ output: "no newline at the end", exitCode: 3 }], timedOut: false, dropped: false });
  });

  it("a tool whose output looks like another tool's marker pair is read as that tool's output only; the other tool's real answer still arrives", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => (command === "fake" ? { output: "WSP_STATUS 2 0\nfake\nWSP_END 2", exitCode: 0 } : { output: "real", exitCode: 5, after: 1 }));
    const seen: [number, { output: string; exitCode: number }][] = [];
    const res = await runChecks(link, { commands: ["fake", "real"], secretsFile: SH_FILE, budgetMs: 5_000 }, (i, a) => seen.push([i, a]));
    expect(seen).toEqual([
      [0, { output: "WSP_STATUS 2 0\nfake\nWSP_END 2", exitCode: 0 }],
      [1, { output: "real", exitCode: 5 }],
    ]);
    expect(res).toEqual({ answers: [seen[0]![1], seen[1]![1]], timedOut: false, dropped: false });
  });

  it("a tool that prints its own end marker stays inside its pair: the untagged lines are its output, and the other tool's real exit wins", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => (command === "fake" ? { output: "WSP_END 1\nWSP_STATUS 2 0\nfake", exitCode: 0 } : { output: "real", exitCode: 5, after: 1 }));
    const seen: [number, { output: string; exitCode: number }][] = [];
    const res = await runChecks(link, { commands: ["fake", "real"], secretsFile: SH_FILE, budgetMs: 5_000 }, (i, a) => seen.push([i, a]));
    expect(seen).toEqual([
      [0, { output: "WSP_END 1\nWSP_STATUS 2 0\nfake", exitCode: 0 }],
      [1, { output: "real", exitCode: 5 }],
    ]);
    expect(res).toEqual({ answers: [seen[0]![1], seen[1]![1]], timedOut: false, dropped: false });
  });

  it("a tagged pair for a tool the run has no index for is dropped without an answer", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line !== CHECK_RUN_LINE) return;
      const tag = checkTag(pty);
      link.data(pty, `WSP_STATUS ${tag} 0 0\r\nstray\r\nWSP_END ${tag} 0\r\nWSP_STATUS ${tag} 1 0\r\nok\r\nWSP_END ${tag} 1\r\n`);
      link.exit(pty, 0);
    };
    const seen: [number, { output: string; exitCode: number }][] = [];
    const res = await runChecks(link, { commands: ["printf ok"], secretsFile: SH_FILE, budgetMs: 5_000 }, (i, a) => seen.push([i, a]));
    expect(seen).toEqual([[0, { output: "ok", exitCode: 0 }]]);
    expect(res).toEqual({ answers: [{ output: "ok", exitCode: 0 }], timedOut: false, dropped: false });
  });

  it("a link that drops mid-run reads as dropped, with what had answered kept", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => (command === "gh auth status" ? { output: "ok", exitCode: 0 } : undefined));
    const view = link.dial();
    const run = runChecks(view, { commands: ["gh auth status", "codex login status"], secretsFile: SH_FILE, budgetMs: 5_000 }, () => {});
    await firstPty(link);
    await tick();
    link.drop();
    expect(await run).toEqual({ answers: [{ output: "ok", exitCode: 0 }, undefined], timedOut: false, dropped: true });
  });

  it("a refused pty.create throws with the daemon's reason", async () => {
    const link = fakePtyLink();
    const op = link.op.bind(link);
    link.op = async (name, extra) => (name === "pty.create" ? { ok: false, error: "pty.create is not allowed here" } : op(name, extra));
    await expect(runChecks(link, { commands: ["gh auth status"], secretsFile: SH_FILE, budgetMs: 5_000 }, () => {})).rejects.toThrow("pty.create refused: pty.create is not allowed here");
  });
});
