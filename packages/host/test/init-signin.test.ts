// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in stage over a scripted daemon link: a status check runs with the
// secrets step's file sourced, so a key set there counts; the row names the
// key source the status reports, the exported key by the file it was cut from.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
import { describe, expect, it } from "vitest";
import { signInStage, statusLine, type SignInStageOptions } from "../src/init-signin.js";
import { fakePtyLink, type FakePtyLink } from "./fake-pty-link.js";

const CLAUDE: ManifestEntry = { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: [], bytes: 0, default: "bring", choice: "copy" };
const STATUS = "claude auth status";

/** claude on the fake builder answers its status the way 2.1.257 prints it for each key source. */
function claudeAnswering(status: string, exitCode = 0): FakePtyLink {
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
  return { run, text: () => stripVTControlCharacters(chunks.join("")) };
}

describe("the sign-in stage and the key sources", () => {
  it("runs a copied login's status check with the secrets file sourced first, in the promptless sh, so a key the secrets step exported counts", async () => {
    const link = claudeAnswering('{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}');
    const { run } = stage(link, { secrets: new Map([["ANTHROPIC_API_KEY", "~/.zshrc"]]) });
    const [r] = await run;
    expect(statusLine(STATUS)).toBe(". /etc/profile.d/wsp-secrets.sh 2>/dev/null; claude auth status");
    expect(link.ptys.map(p => p.created)).toEqual([{ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "" } }]);
    expect(link.ptys[0]!.writes).toEqual([`${statusLine(STATUS)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(r).toEqual({ id: "logins/claude", label: "Claude Code login", state: "signed-in", note: "copied; API key from ~/.zshrc, set on the machine as a secret; claude auth status" });
  });

  it("names the key source the status reports: the helper, the OAuth credentials, or an exported key the secrets step did not set", async () => {
    const helper = stage(claudeAnswering('{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}'));
    expect((await helper.run)[0]!.note).toBe("copied; API key from the settings.json helper; claude auth status");
    const oauth = stage(claudeAnswering('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}'));
    expect((await oauth.run)[0]!.note).toBe("copied; OAuth credentials; claude auth status");
    const machineEnv = stage(claudeAnswering('{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}'));
    expect((await machineEnv.run)[0]!.note).toBe("copied; API key from ANTHROPIC_API_KEY on the machine; claude auth status");
    expect(oauth.text()).toContain("Claude Code login: signed in (copied; OAuth credentials; claude auth status)");
  });

  it("a status that says not signed in, or a shell that cannot find the tool, reads as before with the file sourced", async () => {
    const none = stage(claudeAnswering('{\n  "loggedIn": false,\n  "authMethod": "none"\n}', 1), { skipWhy: "nobody here" });
    expect((await none.run)[0]).toMatchObject({ state: "not-signed-in", note: "copied, but claude auth status says not signed in" });
    const missing = stage(claudeAnswering("sh: claude: not found", 127), { skipWhy: "nobody here" });
    expect((await missing.run)[0]).toMatchObject({ state: "copied", exit: 127, note: "not verified: claude is not on the machine" });
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
    expect(link.ptys.map(p => p.writes[0])).toEqual(["exec claude auth login || exit\r", `${statusLine(STATUS)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`]);
    expect(r).toEqual({ id: "logins/claude", label: "Claude Code login", state: "signed-in", command: "claude auth login", exit: 0, note: "OAuth credentials; claude auth status" });
  });
});
