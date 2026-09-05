// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in stage over a scripted daemon link: a status check runs with the
// secrets step's file sourced, so a key set there counts; the row names the
// key source the status reports, the exported key by the file it was cut from.
// The machine sign-in with a fake shim: the page the tool asks to open, when
// it names a callback port, is what o opens, whichever order it and the
// printed link arrive in.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import { describe, expect, it } from "vitest";
import { flowHooks, signInStage, statusLine, type SignInFlow, type SignInStageOptions } from "../src/init-signin.js";
import { CLAUDE_STATUS } from "../src/signin-table.js";
import { fakePtyLink, type FakePty, type FakePtyLink } from "./fake-pty-link.js";

const CLAUDE: ManifestEntry = { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "bring", choice: "copy" };
const STATUS = "claude auth status";
const KUBE: ManifestEntry = { rung: "logins", id: "logins/kube", label: "kubectl config", group: "CLI logins", paths: [], bytes: 0, default: "bring", choice: "copy" };

/** The fake builder answers the status command with this output and exit code, the way the tool prints it. */
function answering(status: string, exitCode = 0): FakePtyLink {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    if (!line.includes("WSP_STATUS")) return;
    link.data(pty, `${status.replace(/\n/g, "\r\n")}\r\nWSP_STATUS ${exitCode}\r\n`);
    link.exit(pty, exitCode);
  };
  return link;
}

function stage(link: FakePtyLink, over: Partial<SignInStageOptions> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
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
    if (line.includes("WSP_STATUS")) {
      link.data(p, '{\r\n  "loggedIn": true,\r\n  "authMethod": "claude.ai"\r\n}\r\nWSP_STATUS 0\r\n');
      link.exit(p, 0);
      return;
    }
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
  it("runs a copied login's status check with the secrets file sourced first, in the promptless sh, so a key the secrets step exported counts", async () => {
    const link = answering('{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}');
    const { run } = stage(link, { secrets: new Map([["ANTHROPIC_API_KEY", "~/.zshrc"]]) });
    const [r] = await run;
    expect(statusLine(STATUS)).toBe(". /etc/profile.d/wsp-secrets.sh 2>/dev/null; claude auth status");
    expect(link.ptys.map(p => p.created)).toEqual([{ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "" } }]);
    expect(link.ptys[0]!.writes).toEqual([`${statusLine(CLAUDE_STATUS)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(r).toEqual({ id: "logins/claude", label: "Claude Code login", state: "signed-in", note: "copied; API key from ~/.zshrc, set on the machine as a secret; claude auth status" });
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

  it("a sign-in on the machine is proved by the same check, its source named", async () => {
    const link = fakePtyLink();
    link.script = (pty, line) => {
      if (line.includes("WSP_STATUS")) {
        link.data(pty, '{\r\n  "loggedIn": true,\r\n  "authMethod": "claude.ai"\r\n}\r\nWSP_STATUS 0\r\n');
        link.exit(pty, 0);
        return;
      }
      if (line.startsWith("exec claude auth login")) link.exit(pty, 0);
    };
    const { run } = stage(link, { logins: [{ ...CLAUDE, choice: "machine" }] });
    const [r] = await run;
    expect(link.ptys.map(p => p.writes[0])).toEqual(["exec claude auth login || exit\r", `${statusLine(CLAUDE_STATUS)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(r).toEqual({ id: "logins/claude", label: "Claude Code login", state: "signed-in", command: "claude auth login", exit: 0, note: "OAuth credentials; claude auth status" });
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
