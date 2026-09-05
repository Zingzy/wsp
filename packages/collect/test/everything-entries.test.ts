// SPDX-License-Identifier: AGPL-3.0-only
// The Row to manifest-entry adapter, one case per kind and per flag, then the
// grouping and the composition with the seven rungs over the fixture laptop.
import { describe, expect, it } from "vitest";
import { APP_DATA_GROUP, BY_HAND_GROUP, KEYCHAIN_GROUP, LARGE_GROUP, appDir, claimedPaths, entriesFor, locationOf, rungPrograms } from "../src/everything-entries.js";
import type { Row } from "../src/everything/row.js";
import { collect, parseManifest } from "../src/index.js";
import { home, laptop } from "./everything/fixture.js";
import { fakeHost } from "./fake-host.js";

const row = (over: Partial<Row> & Pick<Row, "id" | "name" | "kind">): Row => ({
  paths: [`~/${over.id}`],
  excludes: [],
  bytes: 100,
  files: 1,
  mtime: 1_700_000_000_000,
  measured: "exact",
  flags: [],
  ticked: false,
  ...over,
});

describe("entriesFor: one manifest row per found row", () => {
  const cases: { row: Row; want: Record<string, unknown> }[] = [
    {
      row: row({ id: ".config/atuin", name: "atuin", kind: "config", owner: "homebrew", tool: "atuin", bytes: 2_048, files: 3 }),
      want: { id: "everything/.config/atuin", label: "atuin", group: "~/.config", paths: ["~/.config/atuin"], bytes: 2_048, role: "config", files: 3, detail: "looks like config; config for atuin; installed by homebrew" },
    },
    {
      row: row({ id: ".docker", name: ".docker", kind: "config", owner: "app", tool: "docker" }),
      want: { detail: "looks like config; config for docker; installed as a macOS app" },
    },
    {
      row: row({ id: ".claude", name: ".claude", kind: "config", tool: "claude", binary: "~/.local/bin/claude" }),
      want: { detail: "looks like config; config for claude; its program ~/.local/bin/claude was installed by hand" },
    },
    {
      row: row({ id: "Library/Application Support/GitKrakenCLI", name: "GitKrakenCLI", kind: "config", tool: "gk", owner: "homebrew" }),
      want: { detail: "looks like config; config for gk; installed by homebrew" },
    },
    {
      row: row({ id: ".config/mystery", name: "mystery", kind: "unknown" }),
      want: { detail: "in ~/.config; no installed tool has its name" },
    },
    {
      row: row({ id: "Library/Application Support/Arc", name: "Arc", kind: "app-data", tool: "Arc", bytes: 400_000 }),
      want: { group: APP_DATA_GROUP, label: "Application Support/Arc", role: "app-data", detail: "data of the macOS app Arc; nothing on a Linux machine reads it" },
    },
    {
      row: row({ id: "Library/Application Support/com.docker.install", name: "com.docker.install", kind: "app-data", bytes: 2_000_000_000, files: 3000, flags: ["large"] }),
      want: { group: APP_DATA_GROUP, label: "Application Support/com.docker.install", detail: "data of a macOS app; nothing on a Linux machine reads it; large; never copied without a tick" },
    },
    {
      row: row({ id: "Library/Application Support/com.docker.install/Cache", name: "com.docker.install/Cache", kind: "app-data" }),
      want: { group: APP_DATA_GROUP, label: "Application Support/com.docker.install/Cache", detail: "data of a macOS app; nothing on a Linux machine reads it" },
    },
    {
      row: row({ id: "Library/Application Support/gh-dash", name: "gh-dash", kind: "app-data" }),
      want: { group: APP_DATA_GROUP, label: "Application Support/gh-dash", detail: "in ~/Library/Application Support; no installed tool has its name; macOS apps keep their data here" },
    },
    {
      row: row({ id: "Library/Preferences/com.raycast.macos", name: "com.raycast.macos", kind: "app-data" }),
      want: { group: APP_DATA_GROUP, label: "Preferences/com.raycast.macos", detail: "data of a macOS app; nothing on a Linux machine reads it" },
    },
    {
      row: row({ id: ".hermes", name: ".hermes", kind: "unknown", flags: ["credential"], excludes: ["~/.hermes/auth.json"] }),
      want: { excludes: ["~/.hermes/auth.json"], detail: "nothing says what this is; holds credential-shaped files" },
    },
    {
      row: row({ id: ".hermes/state", name: ".hermes/state", kind: "state", flags: ["large"], measured: "lower-bound", bytes: 5_000_000, files: 900 }),
      want: { role: "state", group: LARGE_GROUP, detail: "state the program rebuilds; size is a lower bound; large; never copied without a tick" },
    },
    {
      row: row({ id: ".cache", name: ".cache", kind: "cache", measured: "none", bytes: 0, files: 0 }),
      want: { role: "cache", files: 0, detail: "cache, rebuilt on use; not measured" },
    },
    {
      row: row({ id: ".axiom.toml", name: ".axiom.toml", kind: "credential", flags: ["credential"] }),
      want: { role: "credential", consent: true, detail: "credential-shaped" },
    },
    {
      // A key split out of its directory inherits the directory's owner guess; nobody installed the key.
      row: row({ id: ".android/adbkey", name: ".android/adbkey", kind: "credential", flags: ["credential"], owner: "homebrew" }),
      want: { role: "credential", consent: true, detail: "credential-shaped" },
    },
    {
      row: row({ id: "keychain:gh:github.com", name: "gh:github.com", kind: "device-bound-login", paths: [], bytes: 0, files: 0, mtime: 0, owner: "homebrew" }),
      want: { paths: [], reason: "signed in here; the login is bound to this device, sign in on the machine", group: KEYCHAIN_GROUP, role: "device-bound-login" },
    },
    {
      row: row({ id: "bin:omp", name: "omp", kind: "unknown", paths: [], bytes: 0, files: 0, binary: "~/.local/bin/omp" }),
      want: { id: "everything/bin:omp", paths: [], reason: "installed by hand; reinstall it on the machine", group: BY_HAND_GROUP },
    },
    {
      row: row({ id: ".oldtool", name: ".oldtool", kind: "unknown", flags: ["stale"] }),
      want: { role: "unknown", detail: "nothing says what this is; its program is gone and nothing changed in two years" },
    },
    {
      row: row({ id: ".aside", name: ".aside", kind: "unknown", flags: ["credential", "partial"], excludes: ["~/.aside/credentials.json"] }),
      want: { consent: true, excludes: ["~/.aside/credentials.json"], detail: "nothing says what this is; holds credential-shaped files; the credential check stopped early; look inside first" },
    },
    {
      row: row({ id: ".config/nvim", name: "nvim", kind: "config", linkTarget: "~/dotfiles/nvim" }),
      want: { detail: "looks like config; a link to ~/dotfiles/nvim" },
    },
    {
      row: row({ id: ".local/share/chezmoi", name: "chezmoi", kind: "config", manager: "chezmoi", rcCopies: ["dot_zshrc.tmpl", "private_dot_bashrc"], rcSecrets: ["dot_zshrc.tmpl"], flags: ["credential"], excludes: ["~/.local/share/chezmoi/run_once_install.sh.tmpl"] }),
      want: { manager: "chezmoi", excludes: ["~/.local/share/chezmoi/run_once_install.sh.tmpl"], detail: "a chezmoi source state holding rc copies; secret-shaped exports in dot_zshrc.tmpl are cut from the copy; holds credential-shaped files" },
    },
    {
      row: row({ id: ".dotfiles", name: ".dotfiles", kind: "config", manager: "stow", rcCopies: ["zsh/.zshrc"], rcSecrets: [] }),
      want: { manager: "stow", detail: "a stow directory holding rc copies" },
    },
    {
      row: row({ id: "dotfiles", name: "dotfiles", kind: "config", manager: "dotfiles", rcCopies: [], rcSecrets: [] }),
      want: { manager: "dotfiles", detail: "a dotfiles directory" },
    },
    {
      row: row({ id: ".config/yadm", name: "yadm", kind: "config", manager: "yadm", rcCopies: [], rcSecrets: [] }),
      want: { manager: "yadm", detail: "yadm's directory" },
    },
    {
      row: row({ id: ".local/share/yadm/repo.git", name: "yadm/repo.git", kind: "credential", flags: ["credential", "history"] }),
      want: { role: "credential", consent: true, detail: "credential-shaped; a git history: every version ever committed travels with it, secrets included" },
    },
    {
      row: row({ id: ".dotfiles/work.sh", name: ".dotfiles/work.sh", kind: "credential", flags: ["credential", "exports"] }),
      want: { role: "credential", consent: true, detail: "credential-shaped; secret-shaped exports under a name the copy does not strip" },
    },
  ];

  it.each(cases.map(c => [c.row.id, c] as const))("%s", (_id, c) => {
    const [e] = entriesFor([c.row]);
    expect(e).toMatchObject({ rung: "everything", default: "skip", mtime: c.row.mtime, ...c.want });
    expect(e).not.toHaveProperty("required");
    expect(e).not.toHaveProperty("bring");
    if (!("consent" in c.want)) expect(e).not.toHaveProperty("consent");
    if (!("manager" in c.want)) expect(e).not.toHaveProperty("manager");
    if (!("excludes" in c.want)) expect(e).not.toHaveProperty("excludes");
    if ("reason" in c.want) expect(e).not.toHaveProperty("detail");
    else expect(e).not.toHaveProperty("reason");
    expect(parseManifest({ entries: [e] }).entries[0]).toEqual(e);
  });

  it("groups by location, then by app directory in HOME when two or more rows share one, then app data, large and what never copies", () => {
    const entries = entriesFor([
      row({ id: ".aside", name: ".aside", kind: "unknown", flags: ["credential"] }),
      row({ id: ".aside/cache", name: ".aside/cache", kind: "cache" }),
      row({ id: ".aside/credentials.json", name: ".aside/credentials.json", kind: "credential", flags: ["credential"] }),
      row({ id: ".aside/state", name: "state files in ~/.aside", kind: "state", paths: ["~/.aside/logs", "~/.aside/sessions"], flags: ["large"] }),
      row({ id: ".config/gh/config.yml", name: "gh/config.yml", kind: "config" }),
      row({ id: ".config/gh/hosts.yml", name: "gh/hosts.yml", kind: "credential", flags: ["credential"] }),
      row({ id: ".config/raycast/extensions", name: "raycast/extensions", kind: "state", flags: ["large"] }),
      row({ id: ".local/share/nvim/site", name: "nvim/site", kind: "state" }),
      row({ id: ".local/state", name: "state", kind: "state" }),
      row({ id: "Library/Application Support/lazydocker", name: "lazydocker", kind: "config", tool: "lazydocker" }),
      row({ id: "Library/Application Support/Arc", name: "Arc", kind: "app-data", tool: "Arc" }),
      row({ id: "Library/Application Support/Arc/Cache", name: "Arc/Cache", kind: "app-data", flags: ["large"] }),
      row({ id: "Library/Preferences/com.raycast.macos", name: "com.raycast.macos", kind: "app-data" }),
      row({ id: "Library/Preferences/.wrangler/config/default.toml", name: ".wrangler/config/default.toml", kind: "credential", flags: ["credential"] }),
      row({ id: "Library/Caches", name: "Caches", kind: "cache", measured: "none" }),
      row({ id: ".bashrc", name: ".bashrc", kind: "unknown" }),
      row({ id: "bin:omp", name: "omp", kind: "unknown", paths: [], binary: "~/.local/bin/omp" }),
      row({ id: "keychain:Raycast", name: "Raycast", kind: "device-bound-login", paths: [] }),
      row({ id: ".zz-big", name: ".zz-big", kind: "unknown", flags: ["large"] }),
      row({ id: ".aaa-big", name: ".aaa-big", kind: "unknown", flags: ["large"] }),
    ]);
    expect(entries.map(e => [e.label, e.group])).toEqual([
      [".aside", ".aside"],
      [".aside/cache", ".aside"],
      [".aside/credentials.json", ".aside"],
      [".bashrc", undefined],
      ["gh/config.yml", "~/.config"],
      ["gh/hosts.yml", "~/.config"],
      ["nvim/site", "~/.local/share"],
      ["state", "~/.local"],
      ["lazydocker", "~/Library/Application Support"],
      [".wrangler/config/default.toml", "~/Library/Preferences"],
      ["Caches", "~/Library"],
      ["Application Support/Arc", APP_DATA_GROUP],
      ["Application Support/Arc/Cache", APP_DATA_GROUP],
      ["Preferences/com.raycast.macos", APP_DATA_GROUP],
      [".aaa-big", LARGE_GROUP],
      [".config/raycast/extensions", LARGE_GROUP],
      [".zz-big", LARGE_GROUP],
      ["state files in ~/.aside", LARGE_GROUP],
      ["Raycast", KEYCHAIN_GROUP],
      ["omp", BY_HAND_GROUP],
    ]);
    expect(appDir("~/.local/share/nvim/site/pack")).toBe(".local/share/nvim");
    expect(appDir("~/.config/gh")).toBe(".config/gh");
    expect(appDir("~/.zshrc")).toBe(".zshrc");
    expect(appDir("~/Library/Application Support/Code/User/settings.json")).toBe("Library/Application Support/Code");
    expect(appDir("~/Library/Preferences/.wrangler/config")).toBe("Library/Preferences/.wrangler");
    expect(["~/.config/gh", "~/.local/share/nvim", "~/.local/state", "~/Library/Application Support/Arc/x", "~/Library/Preferences/.w", "~/Library/Caches", "~/.zshrc", "~/.hermes/auth.json"].map(locationOf)).toEqual(["~/.config", "~/.local/share", "~/.local", "~/Library/Application Support", "~/Library/Preferences", "~/Library", undefined, undefined]);
  });
});

describe("claimedPaths", () => {
  it("takes the ~ paths and Keychain items of every rung but tools and everything, and the file of a hand-installed tools row", () => {
    const claimed = claimedPaths([
      { rung: "identity", id: "identity/gitconfig", paths: ["~/.gitconfig"] },
      { rung: "shell", id: "shell/zsh", paths: ["~/.zshrc", "~/.zshenv"] },
      { rung: "tools", id: "tools/brewfile", paths: ["Brewfile"] },
      { rung: "tools", id: "tools/go/gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"] },
      { rung: "tools", id: "tools/nix-home-manager", paths: ["~/.config/home-manager"] },
      { rung: "tools", id: "tools/hand/omp", paths: ["~/.local/bin/omp"] },
      { rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"] },
      { rung: "everything", id: "everything/.hermes", paths: ["~/.hermes"] },
    ]);
    expect([...claimed].sort()).toEqual(["Keychain: gh:github.com", "~/.config/gh/hosts.yml", "~/.gitconfig", "~/.local/bin/omp", "~/.zshenv", "~/.zshrc"]);
  });
});

describe("rungPrograms", () => {
  it("splits the tools rung into command line tools and macOS apps by the id's kind", () => {
    expect(rungPrograms([
      { rung: "tools", id: "tools/brew/gh-dash" },
      { rung: "tools", id: "tools/brew-tap/homebrew/cask" },
      { rung: "tools", id: "tools/brew-cask/iterm2" },
      { rung: "tools", id: "tools/mas/Xcode" },
      { rung: "tools", id: "tools/npm/@anthropic-ai/claude-code" },
      { rung: "tools", id: "tools/nix-home-manager" },
      { rung: "shell", id: "shell/zshrc" },
    ])).toEqual({ tools: ["gh-dash", "homebrew/cask", "@anthropic-ai/claude-code"], apps: ["iterm2", "Xcode"] });
  });
});

describe("collect with a machine", () => {
  it("appends the everything rung after the seven, counts it, and lists nothing the rungs already carry", async () => {
    const host = fakeHost({ files: { "~/.gitconfig": 512, "~/.zshrc": 3000, "~/.config/gh/hosts.yml": 200 }, which: ["git"], exec: { "git config --global --get user.name": "Dev\n" } });
    const seen: string[] = [];
    const manifest = await collect(host, { machine: laptop(home()), lookup: () => [], onRung: (rung, n) => seen.push(`${rung} ${n}`) });
    expect(seen.at(-1)).toMatch(/^everything \d+$/);
    expect(seen).toHaveLength(8);
    const found = manifest.entries.filter(e => e.rung === "everything");
    expect(found.length).toBeGreaterThan(5);
    expect(manifest.entries.indexOf(found[0]!)).toBe(manifest.entries.length - found.length);
    const paths = found.flatMap(e => e.paths);
    expect(paths).not.toContain("~/.zshrc");
    expect(paths).not.toContain("~/.gitconfig");
    expect(paths).not.toContain("~/.config/gh/hosts.yml");
    expect(found.every(e => e.default === "skip" && e.bring === undefined)).toBe(true);
    expect(found.some(e => e.consent === true && e.role === "credential")).toBe(true);
    expect(found.some(e => e.group === LARGE_GROUP)).toBe(true);
    // The shell rung's rc row carries the names cut from its copy; the manifest holds names only.
    expect(manifest.entries.find(e => e.id === "shell/zshrc")?.secrets).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]);
    expect(JSON.stringify(manifest)).not.toContain("sk-redacted");
  });

  it("an rc file inside a directory a rung carries hands its cut names to that directory's row", async () => {
    const host = fakeHost({ files: { "~/.config/fish/config.fish": 40, "~/.zshrc": 10 } });
    const fish = laptop({ ...home(), files: { ...home().files, "~/.config/fish/config.fish": "set -gx FISH_KEY fake\nset -g theme x\n" } });
    const manifest = await collect(host, { machine: fish, lookup: () => [] });
    expect(manifest.entries.find(e => e.id === "shell/fish")).toMatchObject({ paths: ["~/.config/fish"], secrets: ["FISH_KEY"] });
    expect(JSON.stringify(manifest)).not.toContain("FISH_KEY fake");
  });

  it("a manager home's rc copies hand their cut names to the home's row, and a copy the name rule cannot strip is its own consent row", async () => {
    const dots = laptop({ files: { "~/.dotfiles/zshrc": "export GH_TOKEN=fake-plain\nalias a=b\n", "~/.dotfiles/zsh/aliases": "export ALIAS_TOKEN=fake-alias\n", "~/.dotfiles/work.sh": "export WORK_TOKEN=fake-work\n", "~/.dotfiles/install.sh": "echo hi\n" } });
    const manifest = await collect(fakeHost({ files: { "~/.zshrc": 10 } }), { machine: dots, lookup: () => [] });
    expect(manifest.entries.find(e => e.id === "everything/.dotfiles")).toMatchObject({
      manager: "dotfiles",
      role: "config",
      secrets: ["ALIAS_TOKEN", "GH_TOKEN"],
      excludes: ["~/.dotfiles/work.sh"],
      detail: "a dotfiles directory holding rc copies; secret-shaped exports in zsh/aliases, zshrc are cut from the copy; holds credential-shaped files",
    });
    const whole = manifest.entries.find(e => e.id === "everything/.dotfiles/work.sh");
    expect(whole).toMatchObject({ consent: true, role: "credential", detail: "credential-shaped; secret-shaped exports under a name the copy does not strip" });
    expect(whole).not.toHaveProperty("secrets");
    expect(whole).not.toHaveProperty("manager");
    expect(JSON.stringify(manifest)).not.toContain("fake-");
  });

  it("a directory named .env (a Python environment) is a plain unknown row: no consent, no reason", async () => {
    const venv = laptop({ ...home(), files: { ...home().files, "~/.env/bin/activate": "export VIRTUAL_ENV=/Users/dev/.env\n", "~/.env/pyvenv.cfg": "home = /usr/bin\n", "~/.env/lib/site-packages/x.py": 10 } });
    const manifest = await collect(fakeHost({ files: { "~/.zshrc": 10 } }), { machine: venv, lookup: () => [] });
    const row = manifest.entries.find(e => e.id === "everything/.env");
    expect(row).toMatchObject({ paths: ["~/.env"], role: "unknown", files: 3, detail: "nothing says what this is" });
    expect(row).not.toHaveProperty("consent");
    expect(row).not.toHaveProperty("reason");
  });

  it("an eighth rung that throws costs the seven nothing: one note, everything reported as 0, no row", async () => {
    const broken = laptop(home());
    broken.fs.list = async () => { throw new Error("EIO: disk fell over"); };
    const notes: string[] = [];
    const seen: string[] = [];
    const manifest = await collect(fakeHost({ files: { "~/.zshrc": 10 } }), { machine: broken, lookup: () => [], onRung: (rung, n) => seen.push(`${rung} ${n}`), onNote: n => notes.push(n) });
    expect(manifest.entries.some(e => e.rung === "everything")).toBe(false);
    expect(manifest.entries.some(e => e.rung === "shell")).toBe(true);
    expect(seen.at(-1)).toBe("everything 0");
    expect(notes).toEqual(["Everything else could not be read and is left out: EIO: disk fell over"]);
  });

  it("without a machine the seven rungs come back alone", async () => {
    const manifest = await collect(fakeHost({}));
    expect(manifest.entries.some(e => e.rung === "everything")).toBe(false);
  });
});
