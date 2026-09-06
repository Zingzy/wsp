// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManifestEntry, parseManifest } from "@wsp/collect";
import { afterEach, describe, expect, it } from "vitest";
import type { GoldenImport } from "@wsp/runtime";
import type { Recipe } from "@wsp/protocol";
import {
  applyRecipe,
  goldenRecipeFor,
  hasChoices,
  initialChoice,
  lockRefused,
  refusedNote,
  initialTicks,
  isTickable,
  linuxCaskRows,
  loadManifest,
  loadRecipe,
  loginTool,
  recipePath,
  saveRecipe,
  tickLoginTools,
  unbuiltRows,
  withoutAgentTools,
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
    // The collector's default carries the catalog's word: a browser or device sign-in (gh, codex, the Claude OAuth credential) is skip, a key or a tool with no sign-in is bring.
    expect(initialChoice(byId("logins/gh"))).toBe("machine");
    expect(initialChoice(byId("logins/codex"))).toBe("machine");
    expect(initialChoice({ ...byId("logins/gh"), default: "bring" })).toBe("copy");
    expect(initialChoice(byId("logins/claude"))).toBe("machine");
    expect(initialChoice({ ...byId("logins/gh"), default: "skip", reason: "expires in hours" })).toBe("machine");
    expect(initialChoice({ ...byId("logins/gh"), choice: "skip" })).toBe("skip");
    expect(initialChoice({ ...byId("logins/gh"), bring: false })).toBe("machine");
    expect(initialChoice({ ...byId("logins/claude"), choice: "copy" })).toBe("copy");
  });

});

describe("the command a login needs", () => {
  const GCLOUD_CASK: ManifestEntry = { rung: "tools", id: "tools/brew-cask/gcloud-cli", label: "gcloud-cli", group: "Homebrew casks", paths: [], bytes: 0, default: "skip", reason: "macOS app, no Linux build", linux: "no" };
  const DOCKER_CASK: ManifestEntry = { ...GCLOUD_CASK, id: "tools/brew-cask/docker-desktop", label: "docker-desktop" };
  const RECTANGLE: ManifestEntry = { ...GCLOUD_CASK, id: "tools/brew-cask/rectangle", label: "rectangle" };
  const AWSCLI: ManifestEntry = { rung: "tools", id: "tools/brew/awscli", label: "awscli", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" };
  /** gcloud-cli as the collector reads it when brew info answers: a command row, locked since Google's release is not on GitHub. */
  const GCLOUD_CLI: ManifestEntry = { rung: "tools", id: "tools/cli/gcloud", label: "gcloud (gcloud-cli)", group: "Command-line tools", paths: [], bytes: 0, default: "skip", reason: "command-line tool, but not from a GitHub release; no Linux install path", linux: "no", version: "575.0.0" };
  const login = (id: string, label: string): ManifestEntry => ({ rung: "logins", id: `logins/${id}`, label, group: "CLI logins", paths: [`~/.${id}`], bytes: 10, default: "bring" });
  const GCLOUD = login("gcloud", "Google Cloud login");
  const WRANGLER = login("wrangler", "Cloudflare Wrangler login");
  const KUBE = login("kube", "kubectl config");
  const AWS = login("aws", "AWS keys and profiles");
  const opened = linuxCaskRows([GCLOUD_CASK, DOCKER_CASK, RECTANGLE, AWSCLI]);

  it("linuxCaskRows opens a cask the table knows to a tick, unticked and Linux yes, and leaves every other row as it was", () => {
    expect(opened[0]).toEqual({ rung: "tools", id: "tools/brew-cask/gcloud-cli", label: "gcloud-cli", group: "Homebrew casks", paths: [], bytes: 0, default: "skip", linux: "yes" });
    expect(isTickable(opened[0]!)).toBe(true);
    expect(opened[1]).toMatchObject({ id: "tools/brew-cask/docker-desktop", linux: "yes" });
    expect(opened[1]!.reason).toBeUndefined();
    expect(opened[2]).toEqual(RECTANGLE);
    expect(opened[3]).toEqual(AWSCLI);
    // A saved tick stands: the row keeps its bring flag.
    expect(linuxCaskRows([{ ...GCLOUD_CASK, bring: true }])[0]).toMatchObject({ bring: true, default: "skip" });
    // The command row the collector makes of gcloud-cli opens the same way, its version kept for the install.
    expect(linuxCaskRows([GCLOUD_CLI])[0]).toEqual({ rung: "tools", id: "tools/cli/gcloud", label: "gcloud (gcloud-cli)", group: "Command-line tools", paths: [], bytes: 0, default: "skip", linux: "yes", version: "575.0.0" });
  });

  it("a login's command is coming when its tools row is ticked, else the row is named as unticked, locked, or missing with what would bring it", () => {
    const manifest = { entries: [...opened, ...FIXTURE.entries, GCLOUD, WRANGLER, KUBE, AWS] };
    const none = new Set<string>();
    expect(loginTool(GCLOUD, manifest, none)).toEqual({ bin: "gcloud", row: opened[0], coming: false, why: "gcloud is not coming: its tool row is unticked; copy or sign in ticks it" });
    expect(loginTool(GCLOUD, manifest, new Set(["tools/brew-cask/gcloud-cli"]))).toEqual({ bin: "gcloud", row: opened[0], coming: true });
    expect(loginTool(WRANGLER, manifest, none)).toEqual({ bin: "wrangler", coming: false, why: "wrangler is not coming: no row lists it; npm install -g wrangler brings it" });
    // kubectl comes with Docker Desktop on this computer; the table names the cask that brings the Linux build.
    expect(loginTool(KUBE, manifest, none)).toMatchObject({ bin: "kubectl", row: opened[1], coming: false, why: "kubectl is not coming: its tool row is unticked; copy or sign in ticks it" });
    expect(loginTool(KUBE, { entries: [KUBE] }, none)?.why).toBe("kubectl is not coming: no row lists it; a docker-desktop cask would bring it");
    // The command row of the same cask counts by its command.
    const cli = linuxCaskRows([GCLOUD_CLI])[0]!;
    expect(loginTool(GCLOUD, { entries: [cli, GCLOUD] }, new Set(["tools/cli/gcloud"]))).toEqual({ bin: "gcloud", row: cli, coming: true });
    expect(loginTool(GCLOUD, { entries: [GCLOUD_CLI, GCLOUD] }, none)?.why).toBe("gcloud is not coming: its tool row cannot come (command-line tool, but not from a GitHub release; no Linux install path)");
    // A formula not named for its command still counts.
    expect(loginTool(AWS, manifest, new Set(["tools/brew/awscli"]))).toEqual({ bin: "aws", row: AWSCLI, coming: true });
    // A cask the table does not know stays locked, and the login says so.
    expect(loginTool(GCLOUD, { entries: [RECTANGLE, { ...GCLOUD_CASK }, GCLOUD] }, none)).toMatchObject({ coming: false, why: "gcloud is not coming: its tool row cannot come (macOS app, no Linux build)" });
    // gh's row is ticked in the fixture's defaults; an agent's login follows its agent, not a tools row.
    expect(loginTool(byId("logins/gh"), manifest, new Set(["tools/brew/gh"]))).toEqual({ bin: "gh", row: byId("tools/brew/gh"), coming: true });
    expect(loginTool(byId("logins/claude"), manifest, none)).toBeUndefined();
    expect(loginTool(byId("tools/brew/gh"), manifest, none)).toBeUndefined();
  });

  it("a wrangler row under any node package manager or Homebrew's own formula counts as the command", () => {
    for (const id of ["tools/npm/wrangler", "tools/pnpm/wrangler", "tools/bun/wrangler", "tools/brew/cloudflare-wrangler"]) {
      const row: ManifestEntry = { rung: "tools", id, label: "wrangler", paths: [], bytes: 0, default: "bring", linux: "yes" };
      expect(loginTool(WRANGLER, { entries: [row, WRANGLER] }, new Set([id]))).toEqual({ bin: "wrangler", row, coming: true });
    }
  });

  it("tickLoginTools ticks the row of every login answered copy or sign in; a skip, a coming row and a locked row leave the ticks alone", () => {
    const manifest = { entries: [...opened, GCLOUD, KUBE, WRANGLER, AWS, AWSCLI] };
    const ticks = new Set<string>(["tools/brew/awscli"]);
    const added = tickLoginTools(manifest, new Map([["logins/gcloud", "copy"], ["logins/kube", "machine"], ["logins/wrangler", "copy"], ["logins/aws", "copy"]]), ticks);
    expect(added).toEqual(["gcloud-cli", "docker-desktop"]);
    expect([...ticks]).toEqual(["tools/brew/awscli", "tools/brew-cask/gcloud-cli", "tools/brew-cask/docker-desktop"]);
    const untouched = new Set<string>();
    expect(tickLoginTools({ entries: [RECTANGLE, GCLOUD_CASK, GCLOUD] }, new Map([["logins/gcloud", "copy"]]), untouched)).toEqual([]);
    expect(tickLoginTools(manifest, new Map([["logins/gcloud", "skip"]]), untouched)).toEqual([]);
    expect(untouched.size).toBe(0);
  });
});

describe("npm globals an agent installs itself", () => {
  const PI_NPM: ManifestEntry = { rung: "tools", id: "tools/npm/@earendil-works/pi-coding-agent", label: "@earendil-works/pi-coding-agent@0.84.1", group: "npm globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "0.84.1" };
  const WRANGLER_NPM: ManifestEntry = { ...PI_NPM, id: "tools/npm/wrangler", label: "wrangler@4.106.0", version: "4.106.0" };
  const PI_AGENT: ManifestEntry = { rung: "agents", id: "agents/pi", label: "Pi", paths: ["~/.pi/agent/settings.json"], bytes: 80, default: "bring" };

  it("the package's row goes when its agent is on the Agents screen, whatever the agent's tick; without the agent row it stays, as do other globals", () => {
    expect(withoutAgentTools([PI_NPM, WRANGLER_NPM, PI_AGENT, ...FIXTURE.entries])).toEqual([WRANGLER_NPM, PI_AGENT, ...FIXTURE.entries]);
    expect(withoutAgentTools([PI_NPM, WRANGLER_NPM])).toEqual([PI_NPM, WRANGLER_NPM]);
    expect(withoutAgentTools([{ ...PI_NPM, bring: true }, { ...PI_AGENT, bring: false }])).toEqual([{ ...PI_AGENT, bring: false }]);
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

describe("the small recipe", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const RECIPE: Recipe = {
    version: 1,
    at: "2026-09-06T03:00:00.000Z",
    histories: [{ agent: "claude", state: "read", sessions: 149, calls: 87593 }],
    rows: [
      { id: "claude", kind: "agent", on: false, source: { kind: "popular", sessions: 149, images: 1 } },
      { id: "codex", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.codex/config.toml"], bin: true }, size: 1 },
      { id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 }, signIn: "copy" },
      { id: "yq", kind: "tool", on: false, source: { kind: "popular", sessions: 0, images: 3 } },
      { id: "agent-browser", kind: "tool", on: true, source: { kind: "used", sessions: 45, calls: 2591 } },
      { id: "git", kind: "tool", on: true, source: { kind: "popular", sessions: 118, images: 5 } },
      { id: "kubectl", kind: "tool", on: false, source: { kind: "popular", sessions: 1, images: 1 }, signIn: "machine" },
    ],
  };

  it("loadRecipe names the path on a missing or malformed file and checks the protocol's shape", () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-recipe-"));
    expect(() => loadRecipe(join(dir, "missing.json"))).toThrow(/no recipe at .*missing\.json/);
    const path = join(dir, "recipe.json");
    writeFileSync(path, "{");
    expect(() => loadRecipe(path)).toThrow(/recipe\.json: /);
    writeFileSync(path, JSON.stringify({ ...RECIPE, rows: [{ id: "gh", kind: "tool", on: true, source: { kind: "guess" } }] }));
    expect(() => loadRecipe(path)).toThrow(/recipe\.json: invalid recipe: rows\.0\.source/);
    writeFileSync(path, JSON.stringify(RECIPE));
    expect(loadRecipe(path)).toEqual(RECIPE);
  });

  it("applyRecipe ticks the agents and tools rows from the catalog ids and leaves the other rungs to their defaults", () => {
    const applied = applyRecipe({ ...FIXTURE, entries: [...FIXTURE.entries, { rung: "agents", id: "agents/mcp/claude/spoo-ops", label: "spoo-ops", paths: [], bytes: 0, default: "bring" }, { rung: "agents", id: "agents/mcp/codex/axiom", label: "axiom", paths: [], bytes: 0, default: "bring" }, { rung: "agents", id: "agents/mcp/mcp-remote", label: "mcp-remote", paths: [], bytes: 0, default: "bring" }, { rung: "tools", id: "tools/brew/openjdk@21", label: "openjdk@21", paths: [], bytes: 0, default: "skip", reason: "no Linux bottle" }] }, RECIPE);
    const bring = new Map(applied.entries.map(e => [e.id, e.bring]));
    expect(bring.get("agents/claude")).toBe(false);
    expect(bring.get("agents/codex")).toBe(true);
    // An MCP server follows its agent; the mcp-remote row is no agent's and keeps its default.
    expect(bring.get("agents/mcp/claude/spoo-ops")).toBe(false);
    expect(bring.get("agents/mcp/codex/axiom")).toBe(true);
    expect(bring.get("agents/mcp/mcp-remote")).toBe(true);
    // gh is the catalog's gh; yq is off in the recipe; tsx stands for no catalog tool; a locked row stays locked whatever the recipe says.
    expect(bring.get("tools/brew/gh")).toBe(true);
    expect(bring.get("tools/brew/yq")).toBe(false);
    expect(bring.get("tools/npm/tsx")).toBe(false);
    expect(bring.get("tools/brew/rectangle")).toBe(false);
    expect(bring.get("tools/brew/openjdk@21")).toBe(false);
    expect(applied.entries.filter(e => e.rung === "tools").every(e => initialTicks(e) === (e.id === "tools/brew/gh"))).toBe(true);
    for (const id of ["identity/git-user", "identity/ssh-key", "shell/zshrc", "editors/nvim", "toolchains/mise"]) expect(bring.has(id) && bring.get(id) === undefined, id).toBe(true);
    // The saved sign-in answer lands on the login row; a login the recipe did not answer keeps its own default.
    expect(applied.entries.find(e => e.id === "logins/gh")).toMatchObject({ choice: "copy" });
    expect(applied.entries.find(e => e.id === "logins/gh")?.bring).toBeUndefined();
    expect(applied.entries.find(e => e.id === "logins/claude")).not.toHaveProperty("choice");
    expect(applied.entries.find(e => e.id === "logins/codex")).not.toHaveProperty("choice");
    expect(initialChoice(applied.entries.find(e => e.id === "logins/gh")!)).toBe("copy");
  });

  it("unbuiltRows names the ticked rows this computer has no row for, the floor aside", () => {
    expect(unbuiltRows(RECIPE, FIXTURE.entries).map(r => r.id)).toEqual(["agent-browser"]);
    expect(unbuiltRows(RECIPE, []).map(r => r.id)).toEqual(["codex", "gh", "agent-browser"]);
  });
});
