// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GOLDEN_SETUP, GOLDEN_SMOKE } from "../src/doctor.js";
import {
  RUNGS,
  checklistFor,
  goldenRecipeFor,
  initialChoice,
  initialTicks,
  isTickable,
  loadManifest,
  parseManifest,
  recipePath,
  saveRecipe,
  signInCommand,
  type ManifestEntry,
} from "../src/init-recipe.js";
import { FIXTURE, byId } from "./init-fixture.js";

const ANTHROPIC = "sk-ant-x-fake-anthropic-key";

describe("manifest ticks", () => {
  it("lists the seven rungs in ladder order", () => {
    expect(RUNGS).toEqual(["identity", "shell", "editors", "toolchains", "tools", "agents", "logins"]);
  });

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

  it("names the field that is wrong", () => {
    expect(() => parseManifest({ entries: [{ rung: "kitchen", id: "x", label: "x", paths: [], bytes: 0, default: "bring" }] })).toThrow(/entries\[0\]\.rung/);
    expect(() => parseManifest({ entries: [{ rung: "shell", id: "x", label: "x", paths: [], bytes: "big", default: "bring" }] })).toThrow(/entries\[0\]\.bytes/);
    expect(() => parseManifest({ entries: [{ ...byId("logins/gh"), choice: "maybe" }] })).toThrow(/entries\[0\]\.choice/);
    expect(() => parseManifest({ items: [] })).toThrow(/entries/);
    expect(() => parseManifest("nope")).toThrow(/object/);
  });
});

describe("goldenRecipeFor", () => {
  const bring = (...ids: string[]): ManifestEntry[] => ids.map(byId);

  it("installs only the ticked agents that have an install line, and names no agent when none is ticked", () => {
    const none = goldenRecipeFor(bring("identity/git-user", "shell/zshrc"), {});
    expect(none.setup).toBe("true");
    expect(none.smoke).toBe("true");
    expect(none.envs).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(none.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(none.envs?.["PATH"]).toContain("/root/.local/bin");
    expect(JSON.stringify(none)).not.toMatch(/claude/i);
  });

  it("a ticked Claude Code uses the sanctioned installer and its smoke, with the key only when loaded", () => {
    const withKey = goldenRecipeFor(bring("agents/claude", "shell/zshrc"), { anthropic: ANTHROPIC });
    expect(withKey.setup).toBe(GOLDEN_SETUP);
    expect(withKey.smoke).toBe(GOLDEN_SMOKE);
    expect(withKey.envs).toMatchObject({ ANTHROPIC_API_KEY: ANTHROPIC, CLAUDE_CONFIG_DIR: "/root/.claude-cfg" });
    expect(withKey.cpu).toBe(2);
    expect(withKey.memMb).toBe(4096);

    const noKey = goldenRecipeFor(bring("agents/claude"), {});
    expect(noKey.envs).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(noKey.envs).toHaveProperty("CLAUDE_CONFIG_DIR");
  });

  it("an agent without an install line is carried in the recipe file but installs nothing", () => {
    const recipe = goldenRecipeFor(bring("agents/codex"), {});
    expect(recipe.setup).toBe("true");
    expect(recipe.smoke).toBe("true");
  });

  it("threads the daemon deploy hook through", () => {
    const hook = async () => "node v22";
    expect(goldenRecipeFor([], {}, { deployDaemon: hook }).deployDaemon).toBe(hook);
  });
});

describe("recipe file", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lives next to the state file and round-trips the ticks as bring flags", () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    const statePath = join(dir, "sub", "state.json");
    const path = recipePath(statePath);
    expect(path).toBe(join(dir, "sub", "golden-recipe.json"));

    const choices = new Map([["logins/gh", "machine"], ["logins/claude", "copy"]] as const);
    saveRecipe(path, FIXTURE, new Set(["identity/git-user", "shell/zshrc", "agents/claude", "logins/claude"]), choices);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const back = loadManifest(path);
    expect(back.entries).toHaveLength(FIXTURE.entries.length);
    expect(back.entries.map(e => [e.id, e.bring])).toEqual(
      FIXTURE.entries.map(e => [e.id, ["identity/git-user", "shell/zshrc", "agents/claude", "logins/claude"].includes(e.id)]),
    );
    expect(back.entries.find(e => e.id === "logins/gh")?.choice).toBe("machine");
    expect(back.entries.find(e => e.id === "logins/claude")?.choice).toBe("copy");
    expect(back.entries.find(e => e.id === "shell/zshrc")).not.toHaveProperty("choice");
    // A re-run of the saved file preselects exactly what was ticked and chosen.
    expect(back.entries.filter(initialTicks).map(e => e.id)).toEqual(["identity/git-user", "shell/zshrc", "agents/claude", "logins/claude"]);
    expect(back.entries.filter(e => e.rung === "logins").map(initialChoice)).toEqual(["machine", "copy"]);
  });

  it("loadManifest reports the path on a bad file", () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    expect(() => loadManifest(join(dir, "missing.json"))).toThrow(/missing\.json/);
  });
});
