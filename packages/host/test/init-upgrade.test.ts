// SPDX-License-Identifier: AGPL-3.0-only
import type { RecipeDiff } from "@wsp/engine";
import { describe, expect, it } from "vitest";
import { carryLogins } from "../src/init-upgrade.js";

const diff = (logins: RecipeDiff["logins"]): RecipeDiff => ({ files: [], tools: [], agents: [], logins });

describe("logins an updated version carries", () => {
  it("carries the previous version's outcomes as they were when no login choice moved", () => {
    const previous = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "skipped" as const }];
    expect(carryLogins(previous, diff([]))).toEqual(previous);
  });

  it("a login whose choice moved to copy is rewritten as copied, in place; one not stamped before is appended", () => {
    const previous = [{ name: "GitHub CLI login", state: "signed-in" as const }, { name: "Codex login", state: "not-signed-in" as const }];
    const moved = diff([
      { id: "logins/codex", label: "Codex login", from: "machine", to: "copy" },
      { id: "logins/gh", label: "GitHub CLI login", from: "copy", to: "copy" },
      { id: "logins/vercel", label: "Vercel login", from: "machine", to: "copy" },
    ]);
    expect(carryLogins(previous, moved)).toEqual([
      { name: "GitHub CLI login", state: "signed-in" },
      { name: "Codex login", state: "copied" },
      { name: "Vercel login", state: "copied" },
    ]);
  });

  it("a version that carries none stays without any when nothing moved to copy; a copy move alone stamps that row", () => {
    expect(carryLogins(undefined, diff([]))).toBeUndefined();
    expect(carryLogins(undefined, diff([{ id: "logins/gh", label: "GitHub CLI login", from: "machine", to: "copy" }]))).toEqual([{ name: "GitHub CLI login", state: "copied" }]);
  });

  it("a login moved to sign in is left as it was: that road is the rebuild's", () => {
    const previous = [{ name: "GitHub CLI login", state: "signed-in" as const }];
    expect(carryLogins(previous, diff([{ id: "logins/gh", label: "GitHub CLI login", from: "copy", to: "machine" }]))).toEqual(previous);
  });
});
