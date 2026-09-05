// SPDX-License-Identifier: AGPL-3.0-only
// The location pass: a directory or file directly under a config location is
// config when a tool of its name exists, macOS app data when it sits under
// ~/Library with no such tool, and unknown otherwise. Carves and credentials
// are named for what they are, never for a path that does not exist.
import { describe, expect, it } from "vitest";
import { type EverythingOptions, type Machine, everything as fold } from "../../src/index.js";
import { type Laptop, NOW, laptop } from "./fixture.js";

const everything = (m: Machine, opts: EverythingOptions = {}): ReturnType<typeof fold> => fold(m, { clock: () => 0, now: NOW, ...opts });

/** A Mac with CLI tools that keep config under ~/Library/Application Support and ~/.config, GUI apps beside them. */
const located = (): Laptop => ({
  path: ["/opt/homebrew/bin", "~/.local/bin", "/Applications/Visual Studio Code.app/Contents/Resources/app/bin"],
  links: {
    "/opt/homebrew/bin/lazydocker": "../Cellar/lazydocker/0.24.1/bin/lazydocker",
    "/opt/homebrew/bin/gk": "../Caskroom/gitkraken-cli/3.0.0/gk",
    "/opt/homebrew/bin/starship": "../Cellar/starship/1.20.0/bin/starship",
  },
  files: {
    "/opt/homebrew/Cellar/lazydocker/0.24.1/bin/lazydocker": 10_000_000,
    "/opt/homebrew/Caskroom/gitkraken-cli/3.0.0/gk": { bytes: 20_000_000, mode: 0o755 },
    "/opt/homebrew/Cellar/starship/1.20.0/bin/starship": 8_000_000,
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code": { bytes: 1_000, mode: 0o755 },
    "/Applications/Arc.app/Contents/Info.plist": 100,
    "/Applications/Clicky.app/Contents/Info.plist": 100,
    "~/.local/bin/hermes": { bytes: 5_000_000, mode: 0o755 },
    "~/Library/Application Support/lazydocker/config.yml": "gui:\n  theme: x\n",
    "~/Library/Application Support/GitKrakenCLI/config.json": "{}",
    "~/Library/Application Support/gh-dash/config.yml": "prSections: []\n",
    "~/Library/Application Support/iTerm2/DynamicProfiles/p.json": 200,
    "~/Library/Application Support/Arc/StorableSidebar.json": 400_000,
    "~/Library/Application Support/Clicky/settings.plist": 300,
    "~/Library/Application Support/com.docker.install/data.bin": 2_000,
    "~/Library/Application Support/com.raycast.macos/db.sqlite": 3_000,
    "~/Library/Application Support/Code/User/settings.json": "{}",
    "~/Library/Application Support/Code/logs/main.log": 5_000,
    "~/Library/Application Support/Code/Cache/blob": 7_000,
    "~/Library/Preferences/.wrangler/config/default.toml": "x = 1\n",
    "~/.config/Hermes/settings.yaml": "a: 1\n",
    "~/.config/starship.toml": "add_newline = false\n",
    "~/.config/go/env": "GOPATH=/Users/dev/go\n",
    "~/.config/mystery/thing.toml": "z = 1\n",
    "~/.config/mystery/cache/blob": 10,
    "~/.claude/settings.json": "{}",
    "~/.claude/projects/a/session.jsonl": 4_000,
    "~/.claude/file-history/x": 2_000,
    "~/.claude/statsig/y": 100,
  },
});

/** The Brewfile rung's names, as collect hands them over: formulae and the two app kinds. */
const rung = { tools: ["gh-dash", "go", "lazydocker"], apps: ["iterm2", "arc", "raycast"] };

describe("the location pass", () => {
  it("classifies by location and name: config for a tool, app data under ~/Library, unknown elsewhere", async () => {
    const { rows } = await everything(laptop(located()), rung);
    const by = (path: string) => rows.find(r => r.paths[0] === path);
    expect(by("~/Library/Application Support/lazydocker")).toMatchObject({ name: "lazydocker", kind: "config", tool: "lazydocker", owner: "homebrew" });
    expect(by("~/Library/Application Support/GitKrakenCLI")).toMatchObject({ name: "GitKrakenCLI", kind: "config", tool: "gk", owner: "homebrew" });
    expect(by("~/Library/Application Support/gh-dash")).toMatchObject({ name: "gh-dash", kind: "config", tool: "gh-dash" });
    expect(by("~/Library/Application Support/gh-dash")).not.toHaveProperty("owner");
    expect(by("~/.config/Hermes")).toMatchObject({ name: "Hermes", kind: "config", tool: "hermes", binary: "~/.local/bin/hermes" });
    expect(by("~/.config/starship.toml")).toMatchObject({ name: "starship.toml", kind: "config", tool: "starship" });
    expect(by("~/.config/go")).toMatchObject({ name: "go", kind: "config", tool: "go" });
    expect(by("~/.config/mystery")).toMatchObject({ name: "mystery", kind: "unknown" });
    expect(by("~/.config/mystery")).not.toHaveProperty("tool");
    for (const app of ["iTerm2", "Arc", "Clicky", "com.docker.install", "com.raycast.macos", "Code"]) {
      expect(by(`~/Library/Application Support/${app}`), app).toMatchObject({ name: app, kind: "app-data" });
    }
    expect(by("~/Library/Application Support/Arc")).toMatchObject({ tool: "Arc" });
    expect(by("~/Library/Application Support/Code")).toMatchObject({ tool: "Visual Studio Code" });
    expect(by("~/Library/Application Support/iTerm2")).toMatchObject({ tool: "iterm2" });
    expect(by("~/Library/Application Support/com.docker.install")).not.toHaveProperty("tool");
  });

  it("an app's caches and state are app data too, named for what they hold", async () => {
    const { rows } = await everything(laptop(located()), rung);
    const code = rows.filter(r => r.paths[0]?.startsWith("~/Library/Application Support/Code"));
    expect(code.map(r => [r.name, r.kind, r.paths])).toEqual([
      ["Code", "app-data", ["~/Library/Application Support/Code"]],
      ["Code/Cache", "app-data", ["~/Library/Application Support/Code/Cache"]],
      ["Code/logs", "app-data", ["~/Library/Application Support/Code/logs"]],
    ]);
    expect(rows.find(r => r.paths[0] === "~/.config/mystery/cache")).toMatchObject({ name: "mystery/cache", kind: "cache" });
  });

  it("an app-named entry under ~/.config or ~/.local/share is that app's config, never app data", async () => {
    const m = laptop({
      path: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin"],
      files: {
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code": { bytes: 1_000, mode: 0o755 },
        "/Applications/Ghostty.app/Contents/Info.plist": 100,
        "~/.config/ghostty/config": "font-size = 14\n",
        "~/.config/Code/User/settings.json": "{}",
        "~/.local/share/zed/db/0-stable/db.sqlite": 2_000,
      },
    });
    const { rows } = await everything(m, { tools: [], apps: ["zed"] });
    const by = (path: string) => rows.find(r => r.paths[0] === path);
    expect(by("~/.config/ghostty")).toMatchObject({ name: "ghostty", kind: "config", tool: "Ghostty" });
    expect(by("~/.config/ghostty")).not.toHaveProperty("owner");
    expect(by("~/.config/Code")).toMatchObject({ name: "Code", kind: "config", tool: "Visual Studio Code", owner: "app" });
    expect(by("~/.local/share/zed")).toMatchObject({ name: "zed", kind: "config", tool: "zed" });
    expect(rows.filter(r => r.kind === "app-data")).toEqual([]);
  });

  it("a dot-directory under ~/Library is a tool's, not an app's", async () => {
    const { rows } = await everything(laptop({ files: { "~/Library/Preferences/.wrangler/config/default.toml": "x = 1\n", "~/Library/Preferences/.wrangler/notes": "n\n" } }));
    expect(rows.find(r => r.paths[0] === "~/Library/Preferences/.wrangler")).toMatchObject({ name: ".wrangler", kind: "unknown" });
  });

  it("a carve over several subtrees is named for its directory, the subtrees stay on the detail line; a carve of one subtree is that subtree's real path", async () => {
    const { rows } = await everything(laptop(located()), rung);
    expect(rows.find(r => r.kind === "state" && r.paths[0]?.startsWith("~/.claude"))).toMatchObject({
      name: "state files in ~/.claude",
      paths: ["~/.claude/file-history", "~/.claude/projects"],
    });
    expect(rows.find(r => r.paths[0] === "~/.claude")).toMatchObject({ name: ".claude", kind: "unknown", excludes: ["~/.claude/file-history", "~/.claude/projects"] });
    const one = await everything(laptop({ path: ["~/.local/bin"], links: { "~/.local/bin/ty": "../share/uv/tools/ty/bin/ty" }, files: { "~/.local/share/uv/tools/ty/bin/ty": 3_000_000, "~/.local/share/uv/settings.toml": "a = 1\n" } }));
    expect(one.rows.find(r => r.kind === "state")).toMatchObject({ name: "uv/tools/ty/bin", paths: ["~/.local/share/uv/tools/ty/bin"] });
  });

  it("a credential deep in a directory is named by its real path under that directory", async () => {
    const { rows } = await everything(laptop({ files: { "~/.config/gcloud/legacy_credentials/dev@example.com/.boto": { text: "[Credentials]\ngs_oauth2_refresh_token = x\n", mode: 0o600 }, "~/.config/gcloud/configurations/config_default": "[core]\n" } }));
    expect(rows.map(r => r.name).sort()).toEqual(["gcloud", "gcloud/legacy_credentials/dev@example.com/.boto"]);
  });

  it("a pair is named for its path and says which tool it is for", async () => {
    const m = laptop({ path: ["~/.local/bin", "/opt/homebrew/bin"], links: { "/opt/homebrew/bin/gh": "../Cellar/gh/2.97.0/bin/gh" }, files: { "/opt/homebrew/Cellar/gh/2.97.0/bin/gh": 40_000_000, "~/.local/bin/claude": { bytes: 1_000, mode: 0o755 }, "~/.claude/settings.json": "{}", "~/.config/gh/config.yml": "git_protocol: https\n" } });
    const { rows } = await everything(m);
    expect(rows.find(r => r.paths[0] === "~/.claude")).toMatchObject({ name: ".claude", kind: "config", tool: "claude", binary: "~/.local/bin/claude" });
    expect(rows.find(r => r.paths[0] === "~/.config/gh")).toMatchObject({ name: "gh", kind: "config", tool: "gh", owner: "homebrew" });
  });

  it("a paired directory that carries nothing falls back to a row for its binary under the tool's name", async () => {
    const m = laptop({ path: ["~/.local/bin"], files: { "~/.local/bin/qux": 1_000, "~/.qux/node_modules/x/i.js": 10 } });
    const { rows } = await everything(m);
    expect(rows.find(r => r.binary === "~/.local/bin/qux")).toMatchObject({ id: "bin:qux", name: "qux", paths: [] });
  });

  it("the catalog's name for a directory goes on the tool, the row keeps its path", async () => {
    const lookup = (dir: string) => (dir === "~/.config/monid" ? [{ app: "Monid", path: "~/.config/monid/config.toml", credential: false }] : []);
    const { rows } = await everything(laptop({ files: { "~/.config/monid/config.toml": "x = 1\n" } }), { lookup });
    expect(rows.find(r => r.paths[0] === "~/.config/monid")).toMatchObject({ name: "monid", kind: "config", tool: "Monid" });
  });
});
