// SPDX-License-Identifier: AGPL-3.0-only
// Where each tool's login lives on the machine: every row that has one names
// it, the paths are home-relative, and the reader turns them into guest paths.
import { describe, expect, it } from "vitest";
import { CATALOG, GUEST_HOME, NO_SIGN_IN, SIGN_IN_ROWS, catalogEntry, hasLogin, loginStatePaths, type SignIn } from "../src/index.js";

describe("sign-in state on the machine", () => {
  it("every row with a login or a source names at least one path, home-relative and with no ..", () => {
    for (const [id, row] of Object.entries(SIGN_IN_ROWS as Record<string, SignIn>)) {
      if (!hasLogin(row) && row.sources.length === 0) continue;
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
    expect(loginStatePaths(catalogEntry("codex")!)).toEqual([`${GUEST_HOME}/.codex/auth.json`]);
    expect(loginStatePaths(catalogEntry("gh")!)).toEqual([`${GUEST_HOME}/.config/gh/hosts.yml`]);
    expect(loginStatePaths({ signIn: NO_SIGN_IN })).toEqual([]);
    for (const entry of CATALOG) for (const p of loginStatePaths(entry)) expect(p.startsWith(`${GUEST_HOME}/`)).toBe(true);
  });

  it("Claude Code's login is under its config dir and never the guest home's .claude", () => {
    const paths = loginStatePaths(catalogEntry("claude")!);
    expect(paths).toContain(`${GUEST_HOME}/.claude-cfg/.credentials.json`);
    for (const p of paths) expect(p.startsWith(`${GUEST_HOME}/.claude/`)).toBe(false);
  });
});
