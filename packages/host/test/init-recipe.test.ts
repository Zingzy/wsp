// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManifestEntry, parseManifest } from "@wsp/collect";
import { afterEach, describe, expect, it } from "vitest";
import type { GoldenImport } from "@wsp/runtime";
import {
  checklistFor,
  goldenRecipeFor,
  initialChoice,
  initialTicks,
  isTickable,
  loadManifest,
  recipePath,
  saveRecipe,
  signInCommand,
} from "../src/init-recipe.js";
import { FIXTURE, byId } from "./init-fixture.js";

const ANTHROPIC = "sk-ant-x-fake-anthropic-key";

describe("manifest ticks", () => {
  it("a skip with a reason cannot be ticked; a bare skip can", () => {
    expect(isTickable(byId("identity/ssh-key"))).toBe(false);
    expect(isTickable(byId("agents/codex"))).toBe(true);
    expect(isTickable(byId("identity/git-user"))).toBe(true);
  });

  it("initial ticks follow the default, then a saved bring flag, and required is always on", () => {
    expect(initialTicks(byId("identity/ssh-config"))).toBe(true);
    expect(initialTicks(byId("agents/codex"))).toBe(false);
    expect(initialTicks(byId("identity/ssh-key"))).toBe(false);
    expect(initialTicks({ ...byId("agents/codex"), bring: true })).toBe(true);
    expect(initialTicks({ ...byId("identity/git-user"), bring: false })).toBe(true);
    expect(initialTicks({ ...byId("identity/ssh-key"), bring: true })).toBe(false);
  });
});

describe("login choices", () => {
  it("copy when the default is bring, sign in on the machine when it is skip or cannot be copied, and a saved choice wins", () => {
    expect(initialChoice(byId("logins/gh"))).toBe("copy");
    expect(initialChoice(byId("logins/claude"))).toBe("machine");
    expect(initialChoice({ ...byId("logins/gh"), default: "skip", reason: "expires in hours" })).toBe("machine");
    expect(initialChoice({ ...byId("logins/gh"), choice: "skip" })).toBe("skip");
    expect(initialChoice({ ...byId("logins/gh"), bring: false })).toBe("machine");
    expect(initialChoice({ ...byId("logins/claude"), choice: "copy" })).toBe("copy");
  });

  it("knows the sign-in command of the common logins and says nothing for the rest", () => {
    expect(signInCommand(byId("logins/gh"))).toBe("gh auth login");
    expect(signInCommand(byId("logins/claude"))).toBe("claude, then /login");
    expect(signInCommand({ ...byId("logins/gh"), id: "logins/kube" })).toBeUndefined();
  });

  it("the checklist is exactly the logins chosen as sign in on the machine", () => {
    const choices = new Map([["logins/gh", "machine"], ["logins/claude", "skip"]] as const);
    expect(checklistFor(FIXTURE, choices)).toEqual([{ label: "GitHub CLI login", command: "gh auth login" }]);
    expect(checklistFor(FIXTURE, new Map([["logins/claude", "machine"]]))).toEqual([{ label: "Claude Code login", command: "claude, then /login" }]);
  });
});

describe("parseManifest", () => {
  it("accepts the collector shape and a saved recipe with bring flags", () => {
    expect(parseManifest(JSON.parse(JSON.stringify(FIXTURE)))).toEqual(FIXTURE);
    const saved = { entries: [{ ...byId("shell/zshrc"), bring: false }] };
    expect(parseManifest(saved).entries[0]).toMatchObject({ id: "shell/zshrc", bring: false });
  });

  it("names the row and field that is wrong, in the collector's words", () => {
    expect(() => parseManifest({ entries: [{ rung: "kitchen", id: "kitchen/x", label: "x", paths: [], bytes: 0, default: "bring" }] })).toThrow(/invalid manifest: entries\.0\.rung/);
    expect(() => parseManifest({ entries: [{ rung: "shell", id: "shell/x", label: "x", paths: [], bytes: "big", default: "bring" }] })).toThrow(/entries\.0\.bytes/);
    expect(() => parseManifest({ entries: [{ ...byId("logins/gh"), choice: "maybe" }] })).toThrow(/entries\.0\.choice/);
    expect(() => parseManifest({ entries: [{ ...byId("shell/zshrc"), id: "zshrc" }] })).toThrow(/entries\.0\.id: id must start with shell\//);
    expect(() => parseManifest({ entries: [byId("shell/zshrc"), byId("shell/zshrc")] })).toThrow(/entries\.1\.id: duplicate id shell\/zshrc/);
    expect(() => parseManifest({ items: [] })).toThrow(/entries/);
    expect(() => parseManifest("nope")).toThrow(/object/);
  });
});

describe("goldenRecipeFor", () => {
  const bring = (...ids: string[]): ManifestEntry[] => ids.map(byId);
  const imp: GoldenImport = { recipeHash: "h", tools: [], agents: [] };

  it("runs a bare harness and smoke; the import carries files, tools and agents; envs name no agent when none is ticked", () => {
    const none = goldenRecipeFor(bring("identity/git-user", "shell/zshrc"), {}, { import: imp });
    expect(none.setup).toBe("true");
    expect(none.smoke).toBe("true");
    expect(none.import).toBe(imp);
    expect(none.envs).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(none.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(none.envs?.["PATH"]).toContain("/root/.local/bin");
    expect(none.envs?.["PATH"]).toContain("/home/linuxbrew/.linuxbrew/bin");
    expect(JSON.stringify(none)).not.toMatch(/claude/i);
  });

  it("a ticked Claude Code sets its config dir and the key only when loaded", () => {
    const withKey = goldenRecipeFor(bring("agents/claude", "shell/zshrc"), { anthropic: ANTHROPIC });
    expect(withKey.envs).toMatchObject({ ANTHROPIC_API_KEY: ANTHROPIC, CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });
    expect(withKey.cpu).toBe(2);
    expect(withKey.memMb).toBe(4096);

    const noKey = goldenRecipeFor(bring("agents/claude"), {});
    expect(noKey.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(noKey.envs).toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("threads the daemon deploy hook through", () => {
    const hook = async () => "node v22";
    expect(goldenRecipeFor([], {}, { deployDaemon: hook }).deployDaemon).toBe(hook);
  });
});
