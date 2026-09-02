// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectTools, parseBrewfile, parseCargoInstalls, parseGoVersionM, parseNpmGlobals, parsePipxList, parseUvToolList } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const BREWFILE = `tap "homebrew/bundle"
brew "gh"
brew "jq", link: true
brew "oven-sh/bun/bun"
cask "rectangle"
mas "Xcode", id: 497799835
vscode "ms-python.python"
`;

describe("tools", () => {
  it("parses a Brewfile into taps, formulae, casks and mas apps", () => {
    expect(parseBrewfile(BREWFILE)).toEqual([
      { kind: "tap", name: "homebrew/bundle" },
      { kind: "brew", name: "gh" },
      { kind: "brew", name: "jq" },
      { kind: "brew", name: "oven-sh/bun/bun" },
      { kind: "cask", name: "rectangle" },
      { kind: "mas", name: "Xcode" },
    ]);
  });

  it("Homebrew rows: formulae bring, casks and mas locked off with the macOS reason", async () => {
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": BREWFILE } });
    const rows = await detectTools(host);
    expect(rows).toEqual([
      { rung: "tools", id: "tools/brew-tap/homebrew/bundle", label: "homebrew/bundle", group: "Homebrew taps", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/brew/jq", label: "jq", group: "Homebrew", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/brew/oven-sh/bun/bun", label: "oven-sh/bun/bun", group: "Homebrew", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/brew-cask/rectangle", label: "rectangle", group: "Homebrew casks", paths: [], bytes: 0, default: "skip", reason: "macOS app, no Linux build" },
      { rung: "tools", id: "tools/mas/Xcode", label: "Xcode", group: "Mac App Store", paths: [], bytes: 0, default: "skip", reason: "Mac App Store, macOS only" },
    ]);
  });

  it("no brew means no dump is attempted", async () => {
    const host = fakeHost();
    expect(await detectTools(host)).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it("Nix home-manager config is brought wholesale", async () => {
    const rows = await detectTools(fakeHost({ files: { "~/.config/home-manager/home.nix": 700, "~/.config/home-manager/flake.nix": 300 } }));
    expect(rows).toEqual([{ rung: "tools", id: "tools/nix-home-manager", label: "Nix home-manager config", paths: ["~/.config/home-manager"], bytes: 1000, default: "bring" }]);
  });

  it("parses npm globals, dropping npm and corepack", () => {
    const out = JSON.stringify({ dependencies: { npm: { version: "10.0.0" }, corepack: { version: "0.29.0" }, pnpm: { version: "9.12.0" }, "@anthropic-ai/claude-code": { version: "1.0.0" } } });
    expect(parseNpmGlobals(out)).toEqual([{ name: "pnpm", version: "9.12.0" }, { name: "@anthropic-ai/claude-code", version: "1.0.0" }]);
    expect(parseNpmGlobals("not json")).toEqual([]);
  });

  it("parses pipx, uv tool and cargo listings", () => {
    const pipx = JSON.stringify({ venvs: { httpie: { metadata: { main_package: { package_version: "3.2.4" } } }, black: { metadata: {} } } });
    expect(parsePipxList(pipx)).toEqual([{ name: "httpie", version: "3.2.4" }, { name: "black" }]);
    expect(parseUvToolList("ruff v0.6.3\n- ruff\nhttpx v0.27.0\n- httpx\n")).toEqual([{ name: "ruff", version: "0.6.3" }, { name: "httpx", version: "0.27.0" }]);
    expect(parseCargoInstalls("ripgrep v14.1.0:\n    rg\nbat v0.24.0 (/src/bat):\n    bat\n")).toEqual([{ name: "ripgrep", version: "14.1.0" }, { name: "bat", version: "0.24.0" }]);
  });

  it("reads module path and version out of go version -m", () => {
    const out = "/Users/dev/go/bin/gopls: go1.23.1\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n";
    expect(parseGoVersionM(out)).toEqual({ path: "golang.org/x/tools/gopls", version: "v0.16.2" });
    expect(parseGoVersionM("garbage")).toBeUndefined();
  });

  it("global installs become one row per package under their manager's group", async () => {
    const host = fakeHost({
      files: { "~/go/bin/gopls": 1 },
      which: ["npm", "pipx", "uv", "cargo", "go"],
      exec: {
        "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { pnpm: { version: "9.12.0" } } }),
        "pipx list --json": JSON.stringify({ venvs: { httpie: { metadata: { main_package: { package_version: "3.2.4" } } } } }),
        "uv tool list": "ruff v0.6.3\n- ruff\n",
        "cargo install --list": "ripgrep v14.1.0:\n    rg\n",
        "go version -m /Users/dev/go/bin/gopls": "/Users/dev/go/bin/gopls: go1.23.1\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n",
      },
    });
    const rows = await detectTools(host);
    expect(rows).toEqual([
      { rung: "tools", id: "tools/npm/pnpm", label: "pnpm@9.12.0", group: "npm globals", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/pipx/httpie", label: "httpie 3.2.4", group: "pipx", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/uv/ruff", label: "ruff 0.6.3", group: "uv tools", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep 14.1.0", group: "cargo installs", paths: [], bytes: 0, default: "bring" },
      { rung: "tools", id: "tools/go/gopls", label: "gopls (golang.org/x/tools/gopls@v0.16.2)", group: "Go binaries", paths: [], bytes: 0, default: "bring" },
    ]);
  });

  it("a go binary without module info is offered unticked", async () => {
    const host = fakeHost({ files: { "~/go/bin/mystery": 1 }, which: ["go"] });
    const rows = await detectTools(host);
    expect(rows).toEqual([{ rung: "tools", id: "tools/go/mystery", label: "mystery (no module info)", group: "Go binaries", paths: [], bytes: 0, default: "skip" }]);
  });
});
