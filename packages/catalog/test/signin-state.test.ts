// SPDX-License-Identifier: AGPL-3.0-only
// Where each tool's login lives on the machine: every row that has one names
// it, the paths are home-relative, and the reader turns them into guest paths.
import { describe, expect, it } from "vitest";
import { CATALOG, CATALOG_AGENTS, GUEST_HOME, NEVER_IN_IMAGE, NO_SIGN_IN, SIGN_IN_ROWS, VAULT_VARIABLES, catalogEntry, hasLogin, livesOnComputer, loginStatePaths, mintsToken, type SignIn } from "../src/index.js";

describe("sign-in state on the machine", () => {
  it("every row with a login or a source names at least one path, home-relative and with no ..", () => {
    for (const [id, row] of Object.entries(SIGN_IN_ROWS as Record<string, SignIn>)) {
      // A login that lives on the computer that runs the workspaces keeps no state on any machine.
      if ((!hasLogin(row) && row.sources.length === 0) || livesOnComputer(row)) continue;
      const paths = row.stateOnMachine ?? [];
      expect(paths.length, `${id} names no state on the machine`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p.startsWith("/"), `${id}'s ${p} is not home-relative`).toBe(false);
        expect(p.startsWith("~"), `${id}'s ${p} is not home-relative`).toBe(false);
        expect(p.split("/"), `${id}'s ${p} climbs out of the home`).not.toContain("..");
      }
    }
  });

  it("loginStatePaths answers guest paths under the guest home, and nothing for an entry with no sign-in", () => {
    expect(loginStatePaths(catalogEntry("gh")!)).toEqual([`${GUEST_HOME}/.config/gh/hosts.yml`]);
    expect(loginStatePaths(catalogEntry("gemini")!)).toEqual([`${GUEST_HOME}/.gemini/oauth_creds.json`]);
    expect(loginStatePaths({ signIn: NO_SIGN_IN })).toEqual([]);
    for (const entry of CATALOG) for (const p of loginStatePaths(entry)) expect(p.startsWith(`${GUEST_HOME}/`)).toBe(true);
  });

  it("Claude's login and Codex's have no state on the machine: one is a token held on this computer, the other signs in on the box", () => {
    expect(loginStatePaths(catalogEntry("claude")!)).toEqual([]);
    expect(loginStatePaths(catalogEntry("codex")!)).toEqual([]);
  });
});

describe("the token sign-in and the vault", () => {
  it("Claude's row mints a token on this computer and nothing of it travels", () => {
    const s = SIGN_IN_ROWS.claude;
    expect(s.kind).toBe("token");
    expect(mintsToken(s)).toBe(true);
    expect(hasLogin(s)).toBe(false);
    expect(s.mint).toBe("claude setup-token");
    expect(s.tokenEnv).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(s.token.test("sk-ant-oat01-TESTONLYaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(s.token.test("not-a-token")).toBe(false);
    expect(s.sources).toEqual([]);
    expect(s.stateOnMachine).toEqual([]);
  });

  it("Codex's login lives on the computer that runs the workspaces and is never copied onto a builder", () => {
    const s = SIGN_IN_ROWS.codex;
    expect(livesOnComputer(s)).toBe(true);
    expect(s.sources).toEqual([]);
    expect(s.stateOnMachine).toEqual([]);
    expect(livesOnComputer(SIGN_IN_ROWS.gh)).toBe(false);
  });

  it("the vault holds the agents' token and key variables and nothing else", () => {
    expect([...VAULT_VARIABLES].sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GEMINI_API_KEY", "OPENAI_API_KEY"]);
    const declared = new Set(CATALOG_AGENTS.flatMap(a => [...(mintsToken(a.signIn) ? [a.signIn.tokenEnv] : []), ...("keyEnv" in a.signIn && a.signIn.keyEnv !== undefined ? [a.signIn.keyEnv] : [])]));
    for (const name of VAULT_VARIABLES) expect(declared.has(name), `${name} is in the vault but no agent row declares it`).toBe(true);
  });

  it("the paths a builder may never hold are absolute guest paths: the Claude credential, the helper key file and the Codex login", () => {
    expect(NEVER_IN_IMAGE).toEqual([`${GUEST_HOME}/.claude-cfg/.credentials.json`, `${GUEST_HOME}/.claude-cfg/anthropic-api-key`, `${GUEST_HOME}/.codex/auth.json`]);
    for (const p of NEVER_IN_IMAGE) expect(p.startsWith(`${GUEST_HOME}/`)).toBe(true);
  });
});
