// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in stage over a scripted daemon link: the copied logins' status
// checks run as one script with the secrets step's file read first, so a key
// set there counts, each row checking with its seconds until its answer turns
// it; the row names the key source the status reports, the exported key by the
// file it was cut from. A machine sign-in is judged by its exit code. The
// machine sign-in with a fake shim: the page the tool asks to open, when it
// names a callback port, is what o opens, whichever order it and the printed
// link arrive in.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import { describe, expect, it } from "vitest";
import { flowHooks, signInStage, type SignInFlow, type SignInStageOptions } from "../src/init-signin.js";
import { SH_FILE } from "../src/init-secrets.js";
import { CHECK_RUN_LINE, checkScript } from "../src/signin-relay.js";
import { CLAUDE_STATUS } from "../src/signin-table.js";
import { answersChecks, fakePtyLink, type FakePty, type FakePtyLink } from "./fake-pty-link.js";

const CLAUDE: ManifestEntry = { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "bring", choice: "copy" };
const KUBE: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "copy" };

/** The fake builder answers every status command with this output and exit code, the way the tool prints it. */
function answering(status: string, exitCode = 0): FakePtyLink {
  const link = fakePtyLink();
  link.script = answersChecks(link, () => ({ output: status, exitCode }));
  return link;
}

const GH: ManifestEntry = { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "copy" };
const GH_IN = "github.com\n  ✓ Logged in to github.com account someone (keyring)";
const typed = (...commands: string[]): string => checkScript(commands, SH_FILE).map(l => `${l}\r`).join("");

function stage(link: FakePtyLink, over: Partial<SignInStageOptions> & { tty?: boolean } = {}) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), over.tty === true ? { isTTY: true, columns: 120 } : {});
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  const run = signInStage({
    logins: [CLAUDE],
    dial: async () => ({ link: link.dial(), close: () => {} }),
    terminal: { input, output },
    open: async () => true,
    flow: { armed: false },
    ...over,
  });
  return { run, input, text: () => stripVTControlCharacters(chunks.join("")) };
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 5));
const PRINTED = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
const PAGE = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A42485%2Fcallback";
const DEVICE = "https://github.com/login/device";
const BUILDER = { id: "m_builder", name: "default" };

/** The machine sign-in for Claude Code over the stage's hooks. The shim is what the host relay does with a
 * browser.open from the builder: asks autoOpen (with the port when the page names one), opens or logs the line
 * through onLine. claude asks for its page before it prints the link, or after, or never, as the order says. */
function claudeOnTheMachine(order: "before" | "after" | "never") {
  const link = fakePtyLink();
  const flow: SignInFlow = { armed: false };
  const hooks = flowHooks(flow, BUILDER);
  const opened: string[] = [];
  const lines: string[] = [];
  const shim = (url: string, port?: number): void => {
    if (hooks.autoOpen(BUILDER.id, url, port)) {
      opened.push(url);
      return;
    }
    const line = hooks.openLine("default (builder)", new URL(url).host, url);
    if (!hooks.onLine(line)) lines.push(line);
  };
  let pty: FakePty | undefined;
  link.script = (p, line) => {
    if (!line.startsWith("exec claude auth login")) return;
    pty = p;
    if (order === "before") shim(PAGE, 42485);
    link.data(p, `Opening browser to sign in...\r\nIf the browser didn't open, visit: ${PRINTED}\r\nPaste code here if prompted > `);
  };
  const st = stage(link, { logins: [{ ...CLAUDE, choice: "machine" }], open: async u => (opened.push(u), true), flow });
  const ready = async (): Promise<FakePty> => {
    for (let i = 0; i < 100 && pty === undefined; i++) await tick();
    if (pty === undefined) throw new Error("claude never ran");
    return pty;
  };
  const press = async (key: string): Promise<void> => {
    st.input.write(key);
    await tick();
  };
  return { ...st, link, flow, shim, opened, lines, ready, press };
}

describe("the sign-in stage and the key sources", () => {
  it("runs a copied login's status check as the check script in the promptless sh, the secrets file read first when it is there, so a key the secrets step exported counts", async () => {
    const link = answering('{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}');
    const { run } = stage(link, { secrets: new Map([["ANTHROPIC_API_KEY", "~/.zshrc"]]) });
    const [r] = await run;
    expect(link.ptys.map(p => p.created)).toEqual([{ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "", PS2: "" } }]);
    expect(link.ptys[0]!.writes.join("")).toBe(typed(CLAUDE_STATUS));
    expect(checkScript([CLAUDE_STATUS], SH_FILE)[2]).toBe("[ -r /etc/profile.d/wsp-secrets.sh ] && . /etc/profile.d/wsp-secrets.sh");
    expect(r).toEqual({ id: "logins/claude", label: "Claude Code login", state: "signed-in", note: "copied; API key from ~/.zshrc, set on the machine as a secret; claude auth status" });
  });

  it("every copied login is checked by one script over one link, each row checking with its seconds until its answer arrives, turning in the order the tools finish", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => (command.startsWith("gh auth status") ? { output: GH_IN, exitCode: 0, after: 2 } : { output: '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}', exitCode: 0, after: 1 }));
    const st = stage(link, { logins: [GH, CLAUDE] });
    const rows = await st.run;
    expect(link.dials).toBe(1);
    expect(link.ptys.map(p => p.writes.join(""))).toEqual([typed("gh auth status", CLAUDE_STATUS)]);
    expect(rows).toEqual([
      { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", note: "copied; gh auth status" },
      { id: "logins/claude", label: "Claude Code login", state: "signed-in", note: "copied; OAuth credentials; claude auth status" },
    ]);
    // Off a terminal each row is written as it changes: both checking, then claude's answer, then gh's.
    expect(st.text().replace(/\r/g, "")).toMatch(
      /GitHub CLI login: checking: gh auth status\s+0 s\n│\s+Claude Code login: checking: claude auth status\s+0 s\n│\s+Claude Code login: signed in \(copied; OAuth credentials; claude auth status\)\n│\s+GitHub CLI login: signed in \(copied; gh auth status\)\n│\n/,
    );
  });

  it("on a terminal a checking row's seconds tick while the guest is quiet", async () => {
    const link = fakePtyLink();
    const checks = answersChecks(link, () => ({ output: GH_IN, exitCode: 0 }));
    link.script = (pty, line) => {
      if (line === CHECK_RUN_LINE) setTimeout(() => checks(pty, line), 60);
      else checks(pty, line);
    };
    let t = 0;
    const st = stage(link, { logins: [GH], tty: true, tickMs: 10, now: () => (t += 1000) });
    await st.run;
    expect(st.text()).toMatch(/checking: gh auth status\s+1 s[\s\S]*checking: gh auth status\s+2 s[\s\S]*checking: gh auth status\s+3 s/);
  });

  it("a tool still silent at the shared budget is reported with the others, once, and the pty is killed", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => (command.startsWith("gh auth status") ? { output: GH_IN, exitCode: 0 } : undefined));
    const st = stage(link, { logins: [GH, CLAUDE], checkBudgetMs: 500, skipWhy: "nobody here" });
    const rows = await st.run;
    expect(rows).toEqual([
      { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", note: "copied; gh auth status" },
      { id: "logins/claude", label: "Claude Code login", state: "not-signed-in", note: "copied, but claude auth status did not answer within 1 s" },
    ]);
    expect(link.ptys).toHaveLength(1);
    expect(link.ptys[0]!.killed).toBe(true);
    expect(st.text()).not.toContain("1 min");
  });

  it("a link that drops during the checks leaves the rows still checking not signed in, with the reason", async () => {
    const link = fakePtyLink();
    link.script = answersChecks(link, command => (command.startsWith("gh auth status") ? { output: GH_IN, exitCode: 0 } : undefined));
    const st = stage(link, { logins: [GH, CLAUDE], skipWhy: "nobody here" });
    for (let i = 0; i < 100 && link.ptys.length === 0; i++) await tick();
    await tick();
    link.drop();
    const rows = await st.run;
    expect(rows.map(r => r.note)).toEqual(["copied; gh auth status", "copied, but the machine's terminal link dropped during the status check"]);
  });

  it("names the key source the status reports: the helper, the OAuth credentials, or an exported key the secrets step did not set", async () => {
    const helper = stage(answering('{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}\nWSP_KEY_FILE'));
    expect((await helper.run)[0]!.note).toBe("copied; API key from the settings.json helper, key file present; claude auth status");
    // The helper named with no key file behind it is the failure the check exists for: the row says why, not "not signed in".
    const emptyKey = stage(answering('{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}'), { skipWhy: "nobody here" });
    expect((await emptyKey.run)[0]).toMatchObject({ state: "not-signed-in", note: "copied, but claude auth status names the settings.json helper while its key file is missing or empty on the machine" });
    const oauth = stage(answering('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}'));
    expect((await oauth.run)[0]!.note).toBe("copied; OAuth credentials; claude auth status");
    const machineEnv = stage(answering('{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}'));
    expect((await machineEnv.run)[0]!.note).toBe("copied; API key from ANTHROPIC_API_KEY on the machine; claude auth status");
    expect(oauth.text()).toContain("Claude Code login: signed in (copied; OAuth credentials; claude auth status)");
  });

  it("a status that says not signed in, or a shell that cannot find the tool, reads as before with the file sourced", async () => {
    const none = stage(answering('{\n  "loggedIn": false,\n  "authMethod": "none"\n}', 1), { skipWhy: "nobody here" });
    expect((await none.run)[0]).toMatchObject({ state: "not-signed-in", note: "copied, but claude auth status says not signed in" });
    const missing = stage(answering("sh: claude: not found", 127), { skipWhy: "nobody here" });
    expect((await missing.run)[0]).toMatchObject({ state: "copied", exit: 127, note: "not verified: claude is not on the machine" });
  });

  it("a copied kubeconfig with no context set stays not signed in and nothing is offered, since kubectl has no sign-in", async () => {
    const unset = stage(answering("", 1), { logins: [KUBE] });
    expect((await unset.run)[0]).toMatchObject({ state: "not-signed-in", note: "copied, but kubectl config current-context says not signed in" });
    expect(unset.text()).not.toMatch(/sign in on the machine|r retry/);
  });

  const SECRETS = new Map([["ANTHROPIC_API_KEY", "~/.zshrc"]]);

  it("opencode's stored credential is a login with no key to name, and hermes names only a key the secrets step set", async () => {
    const stored = answering("\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  Anthropic \x1b[90mapi\n│\n└  1 credentials\n");
    expect((await stage(stored, { logins: [{ ...KUBE, id: "logins/opencode", label: "opencode" }], secrets: SECRETS }).run)[0]!.note).toBe("copied; opencode auth list");
    const machineKey = answering("anthropic (1 credentials):\n  #1  ANTHROPIC_API_KEY    api_key env:ANTHROPIC_API_KEY ←\n");
    expect((await stage(machineKey, { logins: [{ ...KUBE, id: "logins/hermes", label: "hermes" }] }).run)[0]!.note).toBe("copied; hermes auth list");
  });

  it("a sign-in on the machine that exits 0 is signed in by that exit: no status check follows, the next row comes at once, and nothing is offered", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.startsWith("exec ")) link.exit(pty, 0);
    };
    const st = stage(link, { logins: [{ ...CLAUDE, choice: "machine" }, { ...GH, choice: "machine" }] });
    const rows = await st.run;
    expect(link.ptys.map(p => p.writes[0])).toEqual(["exec claude auth login || exit\r", "exec gh auth login || exit\r"]);
    expect(rows).toEqual([
      { id: "logins/claude", label: "Claude Code login", state: "signed-in", command: "claude auth login", exit: 0, note: "claude auth login exited 0" },
      { id: "logins/gh", label: "GitHub CLI login", state: "signed-in", command: "gh auth login", exit: 0, note: "gh auth login exited 0" },
    ]);
    const text = st.text();
    expect(text).toMatch(/Claude Code login: signed in \(claude auth login exited 0\)\n[\s\S]*GitHub CLI login\s+gh auth login\n/);
    expect(text).not.toMatch(/r retry|s skip|checking:/);
  });

  it("a sign-in on the machine that exits with a failure is not signed in by that exit, and a retry or a skip is offered", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.startsWith("exec ")) link.exit(pty, 1);
    };
    const st = stage(link, { logins: [{ ...CLAUDE, choice: "machine" }] });
    for (let i = 0; i < 100 && !st.text().includes("r retry"); i++) await tick();
    expect(st.text()).toContain("Claude Code login: not signed in (claude auth login exited 1)");
    st.input.write("s");
    const [r] = await st.run;
    expect(r).toMatchObject({ state: "skipped", exit: 1, note: "skipped by you" });
  });
});

describe("o and the page the machine asks to open", () => {
  it("a page with a callback port that arrived before o is what o opens, through the forwarded port, and the line says it returns on its own", async () => {
    const t = claudeOnTheMachine("before");
    const pty = await t.ready();
    expect(t.text()).toContain("default (builder): press o on the link above to open it here");
    expect(t.lines).toEqual([]);
    expect(t.flow.callbackUrl).toBe(PAGE);
    await t.press("o");
    expect(t.opened).toEqual([PAGE]);
    expect(t.text()).toContain("opened the sign-in page; it returns to the machine on its own");
    expect(t.text()).not.toContain("paste it into the terminal above");
    // o opened the machine's own page: nothing is armed, and the page asked for again is the one already open.
    expect(t.flow.armed).toBe(false);
    t.shim(PAGE, 42485);
    expect(t.opened).toEqual([PAGE]);
    expect(t.text()).toContain("default (builder): that page is already open here");
    expect(pty.writes.slice(1)).toEqual([]);
    t.link.exit(pty, 0);
    const [r] = await t.run;
    expect(r).toMatchObject({ state: "signed-in", exit: 0 });
    expect(t.flow).toEqual({ armed: false });
  });

  it("a page with a callback port that arrives after o opens on its own: o opened the printed link and asked for the code to be pasted", async () => {
    const t = claudeOnTheMachine("after");
    const pty = await t.ready();
    await t.press("o");
    expect(t.opened).toEqual([PRINTED]);
    expect(t.text()).toContain("opened on this computer; if the page shows a code, paste it into the terminal above");
    expect(t.flow.armed).toBe(true);
    t.shim(PAGE, 42485);
    expect(t.opened).toEqual([PRINTED, PAGE]);
    expect(t.flow.armed).toBe(false);
    t.link.exit(pty, 0);
    await t.run;
  });

  it("with no page asked for, o opens the printed link and asks for the code to be pasted; a page without a port is not kept for o", async () => {
    const t = claudeOnTheMachine("never");
    const pty = await t.ready();
    t.shim(DEVICE);
    expect(t.flow.callbackUrl).toBeUndefined();
    expect(t.text()).toContain("default (builder): press o on the link above to open it here");
    await t.press("o");
    expect(t.opened).toEqual([PRINTED]);
    expect(t.text()).toContain("opened on this computer; if the page shows a code, paste it into the terminal above");
    t.link.exit(pty, 0);
    await t.run;
  });

  it("a page that arrives with no pty on screen is left to the app and not kept for a later o", async () => {
    const t = claudeOnTheMachine("never");
    t.shim(PAGE, 42485);
    expect(t.lines).toEqual(["default (builder): a sign-in page for claude.com is ready; open it from the app"]);
    expect(t.flow).toEqual({ armed: false });
    const pty = await t.ready();
    await t.press("o");
    expect(t.opened).toEqual([PRINTED]);
    t.link.exit(pty, 0);
    await t.run;
  });
});
