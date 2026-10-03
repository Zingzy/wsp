// SPDX-License-Identifier: AGPL-3.0-only
// Recipes as the host keeps them: one TOML file each beside the state,
// written whole, never holding a secret, resolved against this computer by
// real paths, and the choices a recipe picks from read with every Mac-only
// thing left out. A recipe taken away leaves its computers following none.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collect, type Host } from "@wsp/collect";
import { NO_RECIPE, RecipeFile, type PlaceReport } from "@wsp/protocol";
import { createRuntime, memoryStore, newPlaceKeyPair, serveRuntime, type Runtime, type RuntimeServer } from "@wsp/runtime";
import { WsClient } from "../../runtime/test/ws-client.js";
import { gitCut, configTexts } from "../src/recipe-configs.js";
import { folderOptions, recipeOptions } from "../src/recipe-options.js";
import { catalogEntry, sizeBytes } from "@wsp/catalog";
import { execFileSync } from "node:child_process";
import { keptTools, readRecipe, readRecipes, recipeHash, recipeShelf, recipesDir, resolveRecipe, TOOLS_KEPT_MS, writeRecipe, type RecipeReading } from "../src/recipes.js";
import { stubBackend } from "./stub-backend.js";

let dir: string;
let statePath: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wsp-recipes-"));
  statePath = join(dir, "state.json");
  home = join(dir, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LAPTOP = RecipeFile.parse({
  name: "laptop",
  agents: { claude: { signin: "vault" }, codex: { signin: "machine" } },
  mcp: { linear: { agents: ["claude", "codex"] } },
  clis: { gh: { via: "brew" }, "cargo-nextest": { via: "cargo", needs: ["build-essential"] } },
  skills: { unslop: { from: "~/.claude/skills" } },
  plugins: { "frontend-design@claude-plugins-official": {} },
  folders: { wsp: { from: "~/wsp", name: "wsp", icon: "code", hue: "blue", keep: [".env.example"] } },
  configs: { git: {}, shell: {}, github: { signin: "vault" } },
});

describe("the recipe file", () => {
  it("is written whole under its slug and reads back as the same recipe", async () => {
    const saved = await writeRecipe(statePath, { ...LAPTOP, name: "My Laptop" });
    expect(saved.slug).toBe("my-laptop");
    const path = join(recipesDir(statePath), "my-laptop.toml");
    expect(readFileSync(path, "utf8")).toContain('name = "My Laptop"');
    expect((await readRecipe(statePath, "My Laptop")).file).toEqual({ ...LAPTOP, name: "My Laptop" });
    expect((await readRecipe(statePath, "my-laptop")).file).toEqual({ ...LAPTOP, name: "My Laptop" });
    // A hand edit is read at the next open; its comment does not survive the next save.
    writeFileSync(path, `# mine\n${readFileSync(path, "utf8").replace('name = "My Laptop"', 'name = "My Laptop"\n[clis.jq]\nvia = "brew"')}`);
    expect(Object.keys((await readRecipe(statePath, "my-laptop")).file.clis)).toContain("jq");
    await writeRecipe(statePath, (await readRecipe(statePath, "my-laptop")).file);
    expect(readFileSync(path, "utf8")).not.toContain("# mine");
  });

  it("refuses a key named like a secret and a value shaped like a token, and writes nothing", async () => {
    await expect(writeRecipe(statePath, { ...LAPTOP, mcp: { GITHUB_TOKEN: { agents: ["claude"] } } })).rejects.toThrow(/mcp.GITHUB_TOKEN is named like a secret/);
    await expect(writeRecipe(statePath, { ...LAPTOP, folders: { wsp: { from: "ghp_16C7e42F292c6912E7710c838347Ae178B4a", keep: [] } } })).rejects.toThrow(/folders.wsp.from holds a value shaped like a token/);
    await expect(writeRecipe(statePath, { ...LAPTOP, name: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv" })).rejects.toThrow(/shaped like a token/);
    await expect(writeRecipe(statePath, { ...LAPTOP, folders: { wsp: { from: "~/wsp", keep: ["gho_16C7e42F292c6912E7710c838347Ae178B4a"] } } })).rejects.toThrow(/keep\[0\]/);
    expect(existsSync(recipesDir(statePath))).toBe(false);
  });

  it("refuses every common token shape, anywhere in a value or as a row's name, and passes the words around them", async () => {
    const shapes = [
      "sk-ZQ8r2kLmN4pQ7sT1vX3yA5bC",
      "sk-proj-ZQ8r2kLmN4pQ7sT1vX3yA5bC9dE",
      "sk-ant-api03-ZQ8r2kLmN4pQ7sT1vX3yA5bC",
      "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "gho_16C7e42F292c6912E7710c838347Ae178B4a",
      "ghs_16C7e42F292c6912E7710c838347Ae178B4a",
      "ghu_16C7e42F292c6912E7710c838347Ae178B4a",
      "glpat-xxxxxxxxxxxxxxxxxxxx",
      // Built here so the file holds no line a secret scanner reads as a live Slack token.
      ["xoxb", "123456789012", "1234567890123", "AbCdEfGhIjKlMnOp"].join("-"),
      ["xoxp", "123456789012", "1234567890123", "AbCdEfGhIjKl"].join("-"),
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----",
    ];
    for (const shape of shapes) {
      await expect(writeRecipe(statePath, { ...LAPTOP, folders: { wsp: { from: `~/code/${shape}/x`, keep: [] } } }), shape).rejects.toThrow(/folders.wsp.from holds a value shaped like a token/);
      await expect(writeRecipe(statePath, { ...LAPTOP, clis: { [shape]: { via: "brew" } } }), shape).rejects.toThrow(/shaped like a token/);
    }
    expect(existsSync(recipesDir(statePath))).toBe(false);
    const plain = await writeRecipe(statePath, { ...LAPTOP, name: "desk session", skills: { "task-sk-notes": { from: "~/.claude/skills" }, "sk-learn": { from: "~/.claude/skills" }, "sk-build-and-release-pipeline-notes": { from: "~/.claude/skills" } } });
    expect(plain.file.name).toBe("desk session");
  });

  it("refuses a name that makes no file name, and a field nothing reads", async () => {
    await expect(writeRecipe(statePath, { ...LAPTOP, name: "!!!" })).rejects.toThrow(/needs a letter or a digit/);
    await expect(writeRecipe(statePath, { ...LAPTOP, agents: { claude: { signin: "copy" } } })).rejects.toThrow(/does not fit/);
  });

  it("lists every file that reads and passes over one that does not", async () => {
    await writeRecipe(statePath, LAPTOP);
    writeFileSync(join(recipesDir(statePath), "broken.toml"), "name = [");
    expect((await readRecipes(statePath)).map(r => r.slug)).toEqual(["laptop"]);
    await expect(readRecipe(statePath, "broken")).rejects.toThrow(/broken.toml/);
    await expect(readRecipe(statePath, "desk")).rejects.toThrow("no recipe named desk; you have laptop");
  });
});

describe("a resolved recipe", () => {
  const reading = (tools: { id: string; version?: string }[] = []): RecipeReading => ({
    home,
    tools: async () => tools.map(t => ({ rung: "tools", id: t.id, label: t.id, paths: [], bytes: 0, default: "bring", ...(t.version !== undefined ? { version: t.version } : {}) })),
  });

  it("hashes the same whatever order its rows were written in", async () => {
    const reordered = RecipeFile.parse({
      configs: { github: { signin: "vault" }, shell: {}, git: {} },
      folders: LAPTOP.folders,
      plugins: LAPTOP.plugins,
      skills: LAPTOP.skills,
      clis: { "cargo-nextest": LAPTOP.clis["cargo-nextest"], gh: LAPTOP.clis["gh"] },
      mcp: LAPTOP.mcp,
      agents: { codex: { signin: "machine" }, claude: { signin: "vault" } },
      name: "laptop",
    });
    const tools = [{ id: "tools/brew/gh", version: "2.80.0" }];
    expect(recipeHash(await resolveRecipe(reordered, reading(tools)))).toBe(recipeHash(await resolveRecipe(LAPTOP, reading(tools))));
    // A version moving on this computer moves the hash, which is what a computer that applied it is held to.
    expect(recipeHash(await resolveRecipe(LAPTOP, reading([{ id: "tools/brew/gh", version: "2.81.0" }])))).not.toBe(recipeHash(await resolveRecipe(LAPTOP, reading(tools))));
  });

  it("reads a symlinked skill where it lives, so an edit through its target moves the hash", async () => {
    const real = join(dir, "checkout", "unslop");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "---\nname: unslop\n---\none\n");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(real, join(home, ".claude", "skills", "unslop"));
    const before = await resolveRecipe(LAPTOP, reading());
    expect(before.items["skills/unslop"]).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(real, "SKILL.md"), "---\nname: unslop\n---\ntwo\n");
    expect((await resolveRecipe(LAPTOP, reading())).items["skills/unslop"]).not.toBe(before.items["skills/unslop"]);
  });

  it("reads nothing through a folder linked inside a skill, so a change there moves no hash", async () => {
    const real = join(home, ".claude", "skills", "unslop");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "SKILL.md"), "---\nname: unslop\n---\n");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "one");
    symlinkSync(join(home, ".ssh"), join(real, "keys"));
    const before = await resolveRecipe(LAPTOP, reading());
    writeFileSync(join(home, ".ssh", "id_ed25519"), "two");
    expect((await resolveRecipe(LAPTOP, reading())).items["skills/unslop"]).toBe(before.items["skills/unslop"]);
  });

  it("moves an agent's item for an edit to its own files, and not for one to a file it rewrites as it runs", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), "{}\n");
    const before = await resolveRecipe(LAPTOP, reading());
    expect(before.items["agents/claude"]).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(home, ".claude.json"), '{"numStartups":2}\n');
    expect((await resolveRecipe(LAPTOP, reading())).items["agents/claude"]).toBe(before.items["agents/claude"]);
    writeFileSync(join(home, ".claude", "settings.json"), '{"model":"opus"}\n');
    expect((await resolveRecipe(LAPTOP, reading())).items["agents/claude"]).not.toBe(before.items["agents/claude"]);
  });

  it("moves no hash when this computer gains a tool the recipe does not hold", async () => {
    const tools = [{ id: "tools/brew/gh", version: "2.80.0" }];
    const before = recipeHash(await resolveRecipe(LAPTOP, reading(tools)));
    expect(recipeHash(await resolveRecipe(LAPTOP, reading([...tools, { id: "tools/npm/cowsay", version: "1.6.0" }])))).toBe(before);
  });

  it("reads the managers once a day, and again when the watcher asks", async () => {
    let reads = 0;
    let now = 0;
    const kept = keptTools(async () => (reads++, []), () => now);
    await kept.tools();
    await kept.tools();
    expect(reads).toBe(1);
    now = TOOLS_KEPT_MS;
    await kept.tools();
    expect(reads).toBe(2);
    await kept.refresh();
    expect(reads).toBe(3);
  });

  it("asks no manager anything when the recipe picks no CLI", async () => {
    let asked = 0;
    await resolveRecipe({ ...LAPTOP, clis: {} }, { home, tools: async () => (asked++, []) });
    expect(asked).toBe(0);
  });
});

describe("the configs a recipe carries", () => {
  it("cuts git's credentials, rewrites, signing and includes, and asks gh for credentials", () => {
    const cut = gitCut(
      [
        "[user]",
        "\tname = Dev",
        "\temail = dev@example.com",
        "\tsigningkey = ~/.ssh/id_ed25519.pub",
        "[credential]",
        "\thelper = osxkeychain",
        '[credential "https://github.com"]',
        "\thelper = !gh auth git-credential",
        '[url "git@github.com:"]',
        "\tinsteadOf = https://github.com/",
        "[core]",
        "\teditor = vim",
        "\tsshCommand = ssh -i ~/.ssh/work",
        "[commit]",
        "\tgpgsign = true",
        "[gpg]",
        "\tformat = ssh",
        '[includeIf "gitdir:~/work/"]',
        "\tpath = ~/.gitconfig-work",
      ].join("\n"),
      true,
    );
    expect(cut).toBe(["[user]", "\tname = Dev", "\temail = dev@example.com", "[core]", "[commit]", "[credential]", "\thelper = !gh auth git-credential", ""].join("\n"));
  });

  it("lands no line that carries a secret: a token-shaped value, a key named like a secret, a password, a URL with a login in it", () => {
    const cut = gitCut(["[user]", "\tname = Dev", "[github]", "\ttoken = ghp_16C7e42F292c6912E7710c838347Ae178B4a", "[sendemail]", "\tsmtpPass = hunter2", "\tsmtpServer = smtp.example.com", "[http]", "\tproxy = http://user:pw@proxy.example.com:3128", "\tsslVerify = true"].join("\n"), false);
    expect(cut).toBe(["[user]", "\tname = Dev", "[github]", "[sendemail]", "\tsmtpServer = smtp.example.com", "[http]", "\tsslVerify = true", ""].join("\n"));
  });

  it("lands no key that names a command, since root's own git on the box reads the file", () => {
    const cut = gitCut(
      [
        "[core]",
        "	autocrlf = input",
        "	fsmonitor = /usr/local/bin/watch",
        "	hooksPath = ~/hooks",
        "	pager = delta",
        "	editor = code --wait",
        "	askPass = /usr/bin/ask",
        "[alias]",
        "	lg = log --oneline",
        "	nuke = !rm -rf .",
        "[diff]",
        "	external = difftool.sh",
        "	colorMoved = zebra",
        '[diff "pdf"]',
        "	textconv = pdftotext",
        '[merge "ours"]',
        "	driver = true",
        '[filter "lfs"]',
        "	clean = git-lfs clean -- %f",
        "[sequence]",
        "	editor = vim",
        "[pager]",
        "	log = less",
        "[interactive]",
        "	diffFilter = delta --color-only",
        '[difftool "x"]',
        "	cmd = x $LOCAL",
      ].join("\n"),
      false,
    );
    expect(cut).toBe(["[core]", "\tautocrlf = input", "[alias]", "\tlg = log --oneline", "[diff]", "\tcolorMoved = zebra", '[diff "pdf"]', '[merge "ours"]', "[sequence]", "[interactive]", ""].join("\n"));
  });

  it("carries no bash file and no exported secret of the shell's", () => {
    writeFileSync(join(home, ".zshrc"), "alias g=git\nexport OPENAI_API_KEY=sk-x\nexport EDITOR=vim\n");
    writeFileSync(join(home, ".bashrc"), "alias g=git\n");
    writeFileSync(join(home, ".profile"), "export PATH=$PATH\n");
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "set -x EDITOR vim\n");
    writeFileSync(join(home, ".config", "fish", "fish_variables"), "SETUVAR GH_TOKEN:ghp_x\n");
    const texts = configTexts("shell", home);
    expect(texts.map(t => t.rel)).toEqual([".zshrc", ".config/fish/config.fish"]);
    expect(texts[0]!.text).toBe("alias g=git\nexport EDITOR=vim\n");
  });
});

/** A Mac with one formula that has a Linux build, one that has none, a cask and a crate. */
function laptop(): Host {
  const out: Record<string, string> = {
    "brew bundle dump --file=-": 'brew "a2ps"\nbrew "afsctool"\ncask "iterm2"\n',
    "cargo install --list": "cargo-nextest v0.9.100:\n    cargo-nextest\n",
  };
  return {
    platform: "darwin",
    home,
    fs: { stat: async () => undefined, list: async () => [], readText: async () => undefined, walk: async () => [], async *lines() {} },
    exec: { which: async bin => bin === "brew" || bin === "cargo", run: async (bin, args) => out[`${bin} ${args.join(" ")}`] },
  };
}

describe("what a recipe picks from", () => {
  it("leaves out a cask and a formula with no Linux build, and names the C toolchain on a crate", async () => {
    const options = recipeOptions(await collect(laptop()), { skills: [], plugins: [], configs: [], github: false });
    expect(options.clis).toEqual([
      { name: "a2ps", via: "brew" },
      { name: "cargo-nextest", via: "cargo", version: "0.9.100", needs: ["build-essential"] },
    ]);
    expect(JSON.stringify(options)).not.toContain("iterm2");
    expect(JSON.stringify(options)).not.toContain("afsctool");
  });

  it("offers a person's own skills and leaves a plugin's to its plugin", () => {
    const options = recipeOptions(
      { entries: [] },
      {
        skills: [
          { name: "unslop", scope: "user", paths: [{ path: "~/.claude/skills/unslop", linkTo: "~/checkout/unslop" }] },
          { name: "pdf", scope: "plugin", paths: [{ path: "~/.claude/plugins/cache/x/skills/pdf" }] },
        ],
        plugins: ["frontend-design@claude-plugins-official"],
        configs: ["git"],
        github: true,
      },
    );
    expect(options.skills).toEqual([{ name: "unslop", from: "~/.claude/skills", linked: true }]);
    expect(options.plugins).toEqual([{ name: "frontend-design@claude-plugins-official" }]);
    expect(options.configs.map(c => c.id)).toEqual(["git", "github"]);
  });

  it("says what each CLI and agent weighs where the catalog measured it, and how each agent signs in", async () => {
    const options = recipeOptions(await collect(laptop()), { skills: [], plugins: [], configs: [], github: false });
    expect(options.clis.find(c => c.name === "a2ps")?.bytes).toBeUndefined();
    const manifest = { entries: [{ rung: "agents" as const, id: "agents/claude", label: "Claude Code", paths: [], bytes: 0, default: "bring" as const }, { rung: "tools" as const, id: "tools/brew/gh", label: "gh", paths: [], bytes: 0, default: "bring" as const }] };
    const read = recipeOptions(manifest, { skills: [], plugins: [], configs: [], github: false });
    expect(read.clis.find(c => c.name === "gh")?.bytes).toBe(sizeBytes(catalogEntry("gh")!.size));
    expect(read.agents.find(a => a.id === "claude")).toMatchObject({ bytes: sizeBytes(catalogEntry("claude")!.size), kind: catalogEntry("claude")!.signIn.kind });
  });

  it("offers this computer's own projects as folders with what each weighs, how far it is ahead of its remote, and whether GitHub keeps it private", async () => {
    const repo = join(dir, "app");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "one");
    git("remote", "add", "origin", "git@github.com:acme/private.git");
    const asked: string[] = [];
    const folders = await folderOptions([{ name: "app", path: repo }], async url => (asked.push(url), false));
    expect(asked).toEqual(["https://github.com/acme/private.git"]);
    expect(folders).toEqual([{ name: "app", path: repo, remote: "git@github.com:acme/private.git", private: true, unpushed: 1, bytes: expect.any(Number) }]);
    expect(folders[0]!.bytes).toBeGreaterThan(0);
    // A folder with no remote is asked of no one and has every commit to carry.
    git("remote", "remove", "origin");
    expect(await folderOptions([{ name: "app", path: repo }], async () => true)).toEqual([{ name: "app", path: repo, unpushed: 1, bytes: expect.any(Number) }]);
  });

  it("says how each MCP server signs in, off the first agent's definition that says anything", () => {
    const server = (agent: string, name: string, signIn?: "none" | "key" | "token" | "oauth") => ({ rung: "agents" as const, id: `agents/mcp/${agent}/${name}`, label: name, paths: [], bytes: 0, default: "bring" as const, ...(signIn !== undefined ? { signIn } : {}) });
    const read = recipeOptions({ entries: [server("claude", "linear", "oauth"), server("codex", "linear", "oauth"), server("claude", "context7", "key"), server("codex", "playwright", "none"), server("claude", "old")] }, { skills: [], plugins: [], configs: [], github: false });
    expect(read.mcp).toEqual([
      { name: "context7", agents: ["claude"], kind: "key" },
      { name: "linear", agents: ["claude", "codex"], kind: "oauth" },
      { name: "old", agents: ["claude"] },
      { name: "playwright", agents: ["codex"], kind: "none" },
    ]);
  });

  it("offers GitHub on its own with how it can sign in: the vault only where this computer holds gh's login, else on the box or skipped", () => {
    const read = (github: boolean) => recipeOptions({ entries: [] }, { skills: [], plugins: [], configs: [], github }).configs.find(c => c.id === "github");
    expect(read(true)?.signins).toEqual(["vault", "machine", "skip"]);
    expect(read(false)?.signins).toEqual(["machine", "skip"]);
  });
});

describe("a recipe taken away", () => {
  let rt: Runtime | undefined;
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    await rt?.close();
  });

  it("leaves every computer that followed it following none, and says which", async () => {
    const store = memoryStore();
    const report: PlaceReport = { name: "spoo", platform: "linux", arch: "x86_64", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 7700 }, login: { HOME: "/root" }, runsWorkspaces: true, engine: "none", daemonVersion: 1, wsp: ["/usr/local/bin/wsp"], agents: [], dialed: "http://10.0.0.9:14621" };
    const at = new Date().toISOString();
    for (const [id, name, recipe] of [["p_1", "spoo", "laptop"], ["p_2", "vps", "laptop"], ["p_3", "desk", "other"]] as const) {
      await store.put("places", id, { id, name, publicKey: "k", joinedAt: at, lastSeenAt: at, report: { ...report, name }, picks: { ...LAPTOP, name: recipe }, recipe });
    }
    rt = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { hostKey: newPlaceKeyPair(), here: () => ({ name: "mac" }), hostName: () => "mac" } });
    srv = await serveRuntime(rt, { port: 0, authToken: "host-token", devices: rt.devices, recipes: recipeShelf({ statePath, home }) });
    await writeRecipe(statePath, LAPTOP);
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    const listed = await c.request("recipes.list");
    expect(listed["recipes"]).toEqual([expect.objectContaining({ slug: "laptop", machines: ["spoo", "vps"] })]);
    const removed = await c.request("recipes.remove", { name: "laptop" });
    expect(removed.ok, String(removed["error"])).toBe(true);
    expect(removed["recipe"]).toEqual(expect.objectContaining({ machines: ["spoo", "vps"] }));
    const places = (await c.request("places.list"))["places"] as { name: string; recipe?: string }[];
    c.close();
    expect(Object.fromEntries(places.filter(p => p.recipe !== undefined).map(p => [p.name, p.recipe]))).toEqual({ spoo: NO_RECIPE, vps: NO_RECIPE, desk: "other" });
    expect(await readRecipes(statePath)).toEqual([]);
  });

  it("is followed by a computer the person sets to it, and followed by none again, by its name", async () => {
    const store = memoryStore();
    const at = new Date().toISOString();
    await store.put("places", "p_1", { id: "p_1", name: "spoo", publicKey: "k", joinedAt: at, lastSeenAt: at, report: { name: "spoo", platform: "linux", arch: "x86_64", os: "Ubuntu", shape: { cpu: 2, memMb: 7700 }, login: { HOME: "/root" }, runsWorkspaces: true, engine: "none", daemonVersion: 1, wsp: ["/w"], agents: [] }, picks: LAPTOP, recipe: NO_RECIPE });
    rt = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { hostKey: newPlaceKeyPair(), here: () => ({ name: "mac" }), hostName: () => "mac" } });
    srv = await serveRuntime(rt, { port: 0, authToken: "host-token", devices: rt.devices, recipes: recipeShelf({ statePath, home }) });
    await writeRecipe(statePath, { ...LAPTOP, name: "Box" });
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    const followed = await c.request("places.follow", { placeId: "p_1", recipe: "Box" });
    expect(followed.ok, String(followed["error"])).toBe(true);
    expect(followed["place"]).toMatchObject({ name: "spoo", recipe: "box" });
    expect((await c.request("recipes.list"))["recipes"]).toEqual([expect.objectContaining({ slug: "box", machines: ["spoo"] })]);
    const none = await c.request("places.follow", { placeId: "p_1", recipe: NO_RECIPE });
    expect(none["place"]).toMatchObject({ recipe: NO_RECIPE });
    const nowhere = await c.request("places.follow", { placeId: "p_1", recipe: "desk" });
    expect(nowhere.ok).toBe(false);
    expect(String(nowhere["error"])).toContain("no recipe named desk");
    c.close();
  });

  it("is saved from a computer's own picks, and that computer follows it", async () => {
    const store = memoryStore();
    const at = new Date().toISOString();
    await store.put("places", "p_1", { id: "p_1", name: "spoo", publicKey: "k", joinedAt: at, lastSeenAt: at, report: { name: "spoo", platform: "linux", arch: "x86_64", os: "Ubuntu", shape: { cpu: 2, memMb: 7700 }, login: { HOME: "/root" }, runsWorkspaces: true, engine: "none", daemonVersion: 1, wsp: ["/w"], agents: [] }, picks: LAPTOP, recipe: NO_RECIPE });
    rt = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: { hostKey: newPlaceKeyPair(), here: () => ({ name: "mac" }), hostName: () => "mac" } });
    srv = await serveRuntime(rt, { port: 0, authToken: "host-token", devices: rt.devices, recipes: recipeShelf({ statePath, home }) });
    const c = await WsClient.connect(srv.port, { token: "host-token" });
    const saved = await c.request("recipes.save", { name: "Box", from: "spoo" });
    expect(saved.ok, String(saved["error"])).toBe(true);
    expect(saved["recipe"]).toEqual(expect.objectContaining({ name: "Box", slug: "box", machines: ["spoo"], file: { ...LAPTOP, name: "Box" } }));
    c.close();
  });
});
