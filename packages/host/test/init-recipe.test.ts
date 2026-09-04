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
  hasChoices,
  initialChoice,
  lockRefused,
  refusedNote,
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

  it("words each login from the sign-in table: the command, what to do instead, or a plain ask", () => {
    expect(signInCommand(byId("logins/gh"))).toBe("gh auth login");
    expect(signInCommand(byId("logins/claude"))).toBe("claude auth login");
    expect(signInCommand({ ...byId("logins/gh"), id: "logins/kube" })).toBe("kubectl has no sign-in; copy the kubeconfig instead");
    expect(signInCommand({ ...byId("logins/gh"), id: "logins/brand-new" })).toBe("sign in as the tool asks");
  });

  it("the checklist is exactly the logins chosen as sign in on the machine", () => {
    const choices = new Map([["logins/gh", "machine"], ["logins/claude", "skip"]] as const);
    expect(checklistFor(FIXTURE, choices, new Set())).toEqual([{ label: "GitHub CLI login", command: "gh auth login" }]);
    expect(checklistFor(FIXTURE, new Map([["logins/claude", "machine"]]), new Set())).toEqual([{ label: "Claude Code login", command: "claude auth login" }]);
  });
});

describe("rows the plan refuses by name", () => {
  const env: ManifestEntry = { rung: "everything", id: "everything/.env", label: ".env", paths: ["~/.env"], bytes: 20, default: "skip", role: "unknown", files: 1, mtime: 1 };
  const netrc: ManifestEntry = { rung: "everything", id: "everything/.netrc", label: ".netrc", paths: ["~/.netrc"], bytes: 30, default: "skip", consent: true, role: "credential", files: 1, mtime: 1 };

  const file = () => false;
  const dir = () => true;
  const missing = () => undefined;

  it("an unconsented .env or .netrc file gets the plan's note; a directory of that name, a consent row and a login's own .env do not", () => {
    expect(refusedNote(env, file)).toBe(".env files are never copied; set the values on the machine");
    expect(refusedNote(env, dir)).toBeUndefined();
    expect(refusedNote(env, missing)).toBeUndefined();
    expect(refusedNote(netrc, file)).toBeUndefined();
    expect(refusedNote({ ...env, rung: "logins", id: "logins/hermes", paths: ["~/.hermes/.env"] }, file)).toBeUndefined();
    expect(refusedNote({ ...env, paths: ["~/.env", "~/.app/config"] }, file)).toBeUndefined();
    expect(refusedNote(byId("tools/brew/gh"), file)).toBeUndefined();
    expect(refusedNote(byId("identity/ssh-key"), file)).toBe("private key, never copied");
  });

  it("lockRefused writes the plan's note onto the rows it would refuse whole and leaves every other row as it was", () => {
    const manifest = { entries: [env, netrc, byId("shell/zshrc")] };
    const locked = lockRefused(manifest, rel => (rel === ".env" ? false : undefined));
    expect(locked.entries[0]).toEqual({ ...env, default: "skip", reason: ".env files are never copied; set the values on the machine" });
    expect(isTickable(locked.entries[0]!)).toBe(false);
    expect(initialTicks({ ...locked.entries[0]!, bring: true })).toBe(false);
    expect(locked.entries.slice(1)).toEqual([netrc, byId("shell/zshrc")]);
    // A directory named .env is a Python environment more often than a secret: it stays a plain row.
    expect(lockRefused(manifest, dir).entries).toEqual(manifest.entries);
    expect(isTickable(env)).toBe(true);
  });
});

describe("consent rows", () => {
  const token: ManifestEntry = { rung: "everything", id: "everything/.demo-token", label: ".demo-token", paths: ["~/.demo-token"], bytes: 40, default: "skip", consent: true, role: "credential", files: 1, mtime: 1 };
  const plain: ManifestEntry = { rung: "everything", id: "everything/.config/demo", label: "demo", paths: ["~/.config/demo"], bytes: 300, default: "skip", role: "config", files: 2, mtime: 1 };

  it("a login or a credential-shaped row is answered, not ticked; its answer starts at skip, a saved tick alone is not consent, and a saved choice wins", () => {
    expect(hasChoices(token)).toBe(true);
    expect(hasChoices(plain)).toBe(false);
    expect(hasChoices(byId("logins/gh"))).toBe(true);
    expect(initialChoice(token)).toBe("skip");
    expect(initialChoice({ ...token, bring: true })).toBe("skip");
    expect(initialChoice({ ...token, bring: true, choice: "copy" })).toBe("copy");
    // An answer a consent row never offered (saved as sign in by an older recipe) reads as skip.
    expect(initialChoice({ ...token, bring: true, choice: "machine" })).toBe("skip");
    expect(initialTicks(plain)).toBe(false);
    expect(initialTicks({ ...plain, bring: true })).toBe(true);
  });

  it("a credential-shaped row never joins the sign-in checklist, whatever its answer", () => {
    const manifest = { entries: [...FIXTURE.entries, token] };
    expect(checklistFor(manifest, new Map([["everything/.demo-token", "machine"]]), new Set())).toEqual([]);
    expect(checklistFor(manifest, new Map([["everything/.demo-token", "copy"]]), new Set(["everything/.demo-token"]))).toEqual([]);
  });

  it("a ticked rc file whose secret exports were cut adds one set-on-the-machine line naming them; unticked it adds none", () => {
    const zshrc = { ...byId("shell/zshrc"), secrets: ["A_KEY", "B_TOKEN"] };
    const manifest = { entries: [...FIXTURE.entries.filter(e => e.id !== "shell/zshrc"), zshrc] };
    expect(checklistFor(manifest, new Map([["logins/gh", "machine"]]), new Set(["shell/zshrc"]))).toEqual([
      { label: "GitHub CLI login", command: "gh auth login" },
      { label: "~/.zshrc", command: "set A_KEY, B_TOKEN on the machine" },
    ]);
    expect(checklistFor(manifest, new Map(), new Set())).toEqual([]);
    expect(parseManifest({ entries: [zshrc] }).entries[0]).toMatchObject({ secrets: ["A_KEY", "B_TOKEN"] });
  });

  it("when the pack reports what it cut, the checklist names come from there, not from the recipe", () => {
    const bare = { ...byId("shell/zshrc") };
    const manifest = { entries: [...FIXTURE.entries.filter(e => e.id !== "shell/zshrc"), bare] };
    const cut = [{ path: "~/.zshrc", names: ["NEW_TOKEN"] }, { path: "~/.config/fish/config.fish", names: ["FISH_KEY"] }];
    expect(checklistFor(manifest, new Map(), new Set(["shell/zshrc"]), cut)).toEqual([
      { label: "~/.zshrc", command: "set NEW_TOKEN on the machine" },
      { label: "~/.config/fish/config.fish", command: "set FISH_KEY on the machine" },
    ]);
    const stale = { ...byId("shell/zshrc"), secrets: ["OLD_KEY"] };
    expect(checklistFor({ entries: [stale] }, new Map(), new Set(["shell/zshrc"]), [])).toEqual([]);
    expect(checklistFor({ entries: [stale] }, new Map(), new Set(["shell/zshrc"]))).toEqual([{ label: "~/.zshrc", command: "set OLD_KEY on the machine" }]);
  });

  it("the schema takes a choice on a consent row and refuses one on a plain row, and keeps role, files and mtime to the everything rung", () => {
    expect(parseManifest({ entries: [{ ...token, choice: "copy" }] }).entries[0]).toMatchObject({ choice: "copy", consent: true });
    expect(() => parseManifest({ entries: [{ ...plain, choice: "copy" }] })).toThrow(/entries\.0\.choice: only a logins row or a consent row carries a choice/);
    expect(() => parseManifest({ entries: [{ ...byId("shell/zshrc"), role: "config" }] })).toThrow(/entries\.0\.role: only an everything row carries role/);
    expect(() => parseManifest({ entries: [{ ...byId("shell/zshrc"), files: 2 }] })).toThrow(/entries\.0\.files/);
    expect(parseManifest({ entries: [{ ...byId("shell/zshrc"), excludes: ["~/.zshrc.d/secret"] }] }).entries[0]).toMatchObject({ excludes: ["~/.zshrc.d/secret"] });
  });

  it("the recipe round-trips an everything row: tick, answer, excludes and the row facts come back as saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    try {
      const path = join(dir, "golden-recipe.json");
      const withExcludes = { ...plain, excludes: ["~/.config/demo/cache"], detail: "looks like config" };
      saveRecipe(path, { entries: [...FIXTURE.entries, withExcludes, token] }, new Set(["everything/.config/demo", "everything/.demo-token"]), new Map([["everything/.demo-token", "copy"]]));
      const back = loadManifest(path);
      expect(back.entries.find(e => e.id === "everything/.config/demo")).toEqual({ ...withExcludes, bring: true });
      expect(back.entries.find(e => e.id === "everything/.demo-token")).toEqual({ ...token, bring: true, choice: "copy" });
      expect(back.entries.filter(e => e.rung === "everything").map(initialTicks)).toEqual([true, true]);
      expect(initialChoice(back.entries.find(e => e.id === "everything/.demo-token")!)).toBe("copy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(back.entries.filter(e => e.rung === "logins").map(initialChoice)).toEqual(["machine", "copy", "machine"]);
  });

  it("loadManifest reports the path on a bad file, ahead of the collector's reason", () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    expect(() => loadManifest(join(dir, "missing.json"))).toThrow(/missing\.json/);
    const path = join(dir, "recipe.json");
    writeFileSync(path, JSON.stringify({ entries: [{ ...byId("shell/zshrc"), choice: "copy" }] }));
    expect(() => loadManifest(path)).toThrow(/recipe\.json: invalid manifest: entries\.0\.choice: only a logins row or a consent row carries a choice/);
  });
});
