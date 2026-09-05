// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { CLI_GROUP, detectTools, parseBrewfile, parseCaskInfo, parseBunGlobals, parseCargoInstalls, parseGoVersionM, parseNpmGlobals, parsePipxList, parsePnpmGlobals, parseUvToolList } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

const BREWFILE = `tap "homebrew/bundle"
brew "gh"
brew "jq", link: true
brew "oven-sh/bun/bun"
brew "mas"
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
      { kind: "brew", name: "mas" },
      { kind: "cask", name: "rectangle" },
      { kind: "mas", name: "Xcode" },
    ]);
  });

  it("Homebrew rows: formulae marked by the Linux bottle snapshot, casks and mas locked off with the macOS reason", async () => {
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": BREWFILE } });
    const rows = await detectTools(host);
    expect(rows).toEqual([
      { rung: "tools", id: "tools/brew-tap/homebrew/bundle", label: "homebrew/bundle", group: "Homebrew taps", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/jq", label: "jq", group: "Homebrew", paths: [], bytes: 0, default: "bring", linux: "yes" },
      { rung: "tools", id: "tools/brew/oven-sh/bun/bun", label: "oven-sh/bun/bun", group: "Homebrew", paths: [], bytes: 0, default: "skip", linux: "unknown" },
      { rung: "tools", id: "tools/brew/mas", label: "mas", group: "Homebrew", paths: [], bytes: 0, default: "skip", reason: "no Linux bottle", linux: "no" },
      { rung: "tools", id: "tools/brew-cask/rectangle", label: "rectangle", group: "Homebrew casks", paths: [], bytes: 0, default: "skip", reason: "macOS app, no Linux build", linux: "no" },
      { rung: "tools", id: "tools/mas/Xcode", label: "Xcode", group: "Mac App Store", paths: [], bytes: 0, default: "skip", reason: "Mac App Store, macOS only", linux: "no" },
    ]);
  });

  it("default ticks: no Linux bottle locks the row off with its reason, an unknown Linux build starts unticked but stays tickable, a bottled formula starts ticked", async () => {
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": 'brew "mas"\nbrew "zingzy/tap/diskbloom"\nbrew "gh"\n' } });
    const rows = await detectTools(host);
    expect(rows.map(r => [r.id, r.default, r.reason, r.linux])).toEqual([
      ["tools/brew/mas", "skip", "no Linux bottle", "no"],
      ["tools/brew/zingzy/tap/diskbloom", "skip", undefined, "unknown"],
      ["tools/brew/gh", "bring", undefined, "yes"],
    ]);
  });

  it("a formula already installed on a Linux laptop runs on Linux whatever the snapshot says", async () => {
    const host = fakeHost({ platform: "linux", which: ["brew"], exec: { "brew bundle dump --file=-": 'brew "mas"\nbrew "oven-sh/bun/bun"\n' } });
    const rows = await detectTools(host);
    expect(rows.map(r => [r.id, r.default, r.linux])).toEqual([["tools/brew/mas", "bring", "yes"], ["tools/brew/oven-sh/bun/bun", "bring", "yes"]]);
  });

  const cask = (token: string, over: Record<string, unknown> = {}) => ({ token, full_token: token, tap: "homebrew/cask", version: "1.0", url: `https://example.com/${token}.zip`, artifacts: [{ app: [`${token}.app`] }], ...over });
  const SPOO = cask("spoo", { full_token: "spoo-me/tap/spoo", tap: "spoo-me/tap", version: "0.4.1", url: "https://github.com/spoo-me/spoo-cli/releases/download/v0.4.1/spoo_0.4.1_darwin_arm64.tar.gz", artifacts: [{ binary: ["spoo"] }, { bash_completion: ["completions/spoo.bash"] }] });
  const SPOO_STANZA = 'cask "spoo" do\n  on_macos do\n  end\n  on_linux do\n  end\n  binary "spoo"\nend\n';

  it("reads each cask's artifacts, version, tap and url out of brew info, keyed by both its token and its full token", () => {
    const info = parseCaskInfo({ casks: [SPOO, cask("rectangle"), { token: 7 }] });
    expect(info.get("spoo")).toEqual({ token: "spoo", fullToken: "spoo-me/tap/spoo", tap: "spoo-me/tap", version: "0.4.1", url: SPOO.url, binaries: ["spoo"], app: false });
    expect(info.get("spoo-me/tap/spoo")).toBe(info.get("spoo"));
    expect(info.get("rectangle")).toMatchObject({ binaries: [], app: true });
    expect(info.size).toBe(3);
    expect(parseCaskInfo("nope").size).toBe(0);
  });

  it("a cask whose artifact is a binary from a GitHub release is a command-line tool: one row named for the command, installed from the release; the stanza's on_linux block makes it a Linux yes", async () => {
    const dump = 'tap "spoo-me/tap"\ncask "spoo-me/tap/spoo"\ncask "rectangle"\n';
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": dump, "brew info --json=v2 --cask spoo-me/tap/spoo rectangle": JSON.stringify({ casks: [SPOO, cask("rectangle")] }), "brew cat spoo-me/tap/spoo": SPOO_STANZA } });
    const rows = await detectTools(host);
    expect(rows).toEqual([
      { rung: "tools", id: "tools/cli/spoo", label: "spoo", group: CLI_GROUP, paths: ["github.com/spoo-me/spoo-cli@v0.4.1"], bytes: 0, default: "bring", linux: "yes", version: "0.4.1" },
      { rung: "tools", id: "tools/brew-cask/rectangle", label: "rectangle", group: "Homebrew casks", paths: [], bytes: 0, default: "skip", reason: "macOS app, no Linux build", linux: "no" },
    ]);
    // The stanza is read only for the casks that could take the road.
    expect(host.calls.filter(c => c.startsWith("run brew cat"))).toEqual(["run brew cat spoo-me/tap/spoo"]);
  });

  it("a release cask whose stanza has no Linux block starts unticked but tickable; a binary cask from elsewhere is locked off as a CLI with no Linux road; an app that also ships a CLI is an app; a cask brew info does not know is an app", async () => {
    const dump = 'cask "spoo-me/tap/spoo"\ncask "ngrok"\ncask "cursor"\ncask "mystery"\n';
    const casks = [SPOO, cask("ngrok", { url: "https://bin.ngrok.com/a/x/ngrok-v3-3.39.11-darwin-arm64.zip", artifacts: [{ binary: ["ngrok"] }] }), cask("cursor", { artifacts: [{ app: ["Cursor.app"] }, { binary: ["/Applications/Cursor.app/Contents/Resources/app/bin/code"] }] })];
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": dump, "brew info --json=v2 --cask spoo-me/tap/spoo ngrok cursor mystery": JSON.stringify({ casks }), "brew cat spoo-me/tap/spoo": 'cask "spoo" do\n  binary "spoo"\nend\n' } });
    const rows = await detectTools(host);
    expect(rows.map(r => [r.id, r.default, r.reason, r.linux])).toEqual([
      ["tools/cli/spoo", "skip", undefined, "unknown"],
      ["tools/cli/ngrok", "skip", "command-line tool, but not from a GitHub release; no Linux install path", "no"],
      ["tools/brew-cask/cursor", "skip", "macOS app, no Linux build", "no"],
      ["tools/brew-cask/mystery", "skip", "macOS app, no Linux build", "no"],
    ]);
  });

  it("a multi-binary cask is named for the binary that matches its token, else the first; a brew info that fails leaves every cask an app", async () => {
    const gcloud = cask("gcloud-cli", { url: "https://github.com/g/cloud/releases/download/v1/x.tar.gz", artifacts: [{ binary: ["google-cloud-sdk/bin/bq"] }, { binary: ["google-cloud-sdk/bin/gcloud"] }] });
    const host = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": 'cask "gcloud-cli"\n', "brew info --json=v2 --cask gcloud-cli": JSON.stringify({ casks: [gcloud] }), "brew cat gcloud-cli": "" } });
    expect((await detectTools(host)).map(r => [r.id, r.label, r.linux])).toEqual([["tools/cli/gcloud", "gcloud (gcloud-cli)", "unknown"]]);
    const failing = fakeHost({ which: ["brew"], exec: { "brew bundle dump --file=-": 'cask "gcloud-cli"\n' } });
    expect((await detectTools(failing)).map(r => [r.id, r.reason])).toEqual([["tools/brew-cask/gcloud-cli", "macOS app, no Linux build"]]);
  });

  it("a go binary named for a CLI cask's command folds into its row: one tick, the release first and the module as the fallback; the cask's tap folds in when no formula uses it, and stays when one does", async () => {
    const goOut = (path: string, v: string) => `x\n\tpath\t${path}\n\tmod\t${path}\t${v}\th1:abc=\n`;
    const exec = {
      "brew bundle dump --file=-": 'tap "spoo-me/tap"\ntap "zingzy/tap"\nbrew "zingzy/tap/diskbloom"\ncask "spoo-me/tap/spoo"\n',
      "brew info --json=v2 --cask spoo-me/tap/spoo": JSON.stringify({ casks: [SPOO] }),
      "brew cat spoo-me/tap/spoo": SPOO_STANZA,
      "go version -m /Users/dev/go/bin/spoo": goOut("github.com/spoo-me/spoo-cli/cmd/spoo", "v0.3.0"),
      "go version -m /Users/dev/go/bin/gopls": goOut("golang.org/x/tools/gopls", "v0.16.2"),
      "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { "spoo.me": { version: "0.1.0" } } }),
    };
    const host = fakeHost({ which: ["brew", "go", "npm"], files: { "~/go/bin/spoo": 1, "~/go/bin/gopls": 1 }, exec });
    const rows = await detectTools(host);
    expect(rows.map(r => r.id)).toEqual(["tools/brew-tap/zingzy/tap", "tools/brew/zingzy/tap/diskbloom", "tools/cli/spoo", "tools/npm/spoo.me", "tools/go/gopls"]);
    expect(rows[2]).toEqual({ rung: "tools", id: "tools/cli/spoo", label: "spoo", group: CLI_GROUP, paths: ["github.com/spoo-me/spoo-cli@v0.4.1", "github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0"], bytes: 0, default: "bring", linux: "yes", version: "0.4.1" });
    // The same module as the release repository adds no second path.
    const same = fakeHost({ which: ["brew", "go"], files: { "~/go/bin/spoo": 1 }, exec: { ...exec, "go version -m /Users/dev/go/bin/spoo": goOut("github.com/spoo-me/spoo-cli", "v0.4.1") } });
    expect((await detectTools(same))[2]!.paths).toEqual(["github.com/spoo-me/spoo-cli@v0.4.1"]);
  });

  it("no brew means no dump is attempted", async () => {
    const host = fakeHost();
    expect(await detectTools(host)).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it("Nix home-manager config is brought wholesale", async () => {
    const rows = await detectTools(fakeHost({ files: { "~/.config/home-manager/home.nix": 700, "~/.config/home-manager/flake.nix": 300 } }));
    expect(rows).toEqual([{ rung: "tools", id: "tools/nix-home-manager", label: "Nix home-manager config", paths: ["~/.config/home-manager"], bytes: 1000, default: "bring", linux: "yes" }]);
  });

  it("parses npm globals, dropping npm and corepack", () => {
    const out = JSON.stringify({ dependencies: { npm: { version: "10.0.0" }, corepack: { version: "0.29.0" }, pnpm: { version: "9.12.0" }, "@anthropic-ai/claude-code": { version: "1.0.0" } } });
    expect(parseNpmGlobals(out)).toEqual([{ name: "pnpm", version: "9.12.0" }, { name: "@anthropic-ai/claude-code", version: "1.0.0" }]);
    expect(parseNpmGlobals("not json")).toEqual([]);
  });

  it("parses pnpm globals: one project object per global dir, its dependencies map", () => {
    const out = JSON.stringify([{ path: "/Users/dev/Library/pnpm/global/5", private: true, dependencies: { typescript: { from: "typescript", version: "5.6.2", resolved: "https://x", path: "/y" }, "@biomejs/biome": { from: "@biomejs/biome", version: "1.9.4" } } }]);
    expect(parsePnpmGlobals(out)).toEqual([{ name: "typescript", version: "5.6.2" }, { name: "@biomejs/biome", version: "1.9.4" }]);
    expect(parsePnpmGlobals(JSON.stringify([{ path: "/x", private: true, dependencies: {} }]))).toEqual([]);
    expect(parsePnpmGlobals("not json")).toEqual([]);
  });

  it("parses bun globals: a header line then a tree of name@version, scoped names included", () => {
    const out = "/Users/dev/.bun/install/global node_modules (4)\n├── @types/node@26.4.1\n└── is-odd@3.0.1\n";
    expect(parseBunGlobals(out)).toEqual([{ name: "@types/node", version: "26.4.1" }, { name: "is-odd", version: "3.0.1" }]);
    expect(parseBunGlobals("")).toEqual([]);
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
      which: ["npm", "pnpm", "bun", "pipx", "uv", "cargo", "go"],
      exec: {
        "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { pnpm: { version: "9.12.0" } } }),
        "pnpm ls -g --depth=0 --json": JSON.stringify([{ path: "/g", private: true, dependencies: { typescript: { version: "5.6.2" } } }]),
        "bun pm ls -g": "/Users/dev/.bun/install/global node_modules (1)\n└── is-odd@3.0.1\n",
        "pipx list --json": JSON.stringify({ venvs: { httpie: { metadata: { main_package: { package_version: "3.2.4" } } } } }),
        "uv tool list": "ruff v0.6.3\n- ruff\n",
        "cargo install --list": "ripgrep v14.1.0:\n    rg\n",
        "go version -m /Users/dev/go/bin/gopls": "/Users/dev/go/bin/gopls: go1.23.1\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n",
      },
    });
    const rows = await detectTools(host);
    expect(rows).toEqual([
      { rung: "tools", id: "tools/npm/pnpm", label: "pnpm@9.12.0", group: "npm globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "9.12.0" },
      { rung: "tools", id: "tools/pnpm/typescript", label: "typescript@5.6.2", group: "pnpm globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "5.6.2" },
      { rung: "tools", id: "tools/bun/is-odd", label: "is-odd@3.0.1", group: "bun globals", paths: [], bytes: 0, default: "bring", linux: "yes", version: "3.0.1" },
      { rung: "tools", id: "tools/pipx/httpie", label: "httpie 3.2.4", group: "pipx", paths: [], bytes: 0, default: "bring", linux: "yes", version: "3.2.4" },
      { rung: "tools", id: "tools/uv/ruff", label: "ruff 0.6.3", group: "uv tools", paths: [], bytes: 0, default: "bring", linux: "yes", version: "0.6.3" },
      { rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep 14.1.0", group: "cargo installs", paths: [], bytes: 0, default: "bring", linux: "yes", version: "14.1.0" },
      { rung: "tools", id: "tools/go/gopls", label: "gopls", group: "Go binaries", paths: ["golang.org/x/tools/gopls@v0.16.2"], bytes: 0, default: "bring", linux: "yes", version: "v0.16.2" },
    ]);
  });

  it("bun with an empty global dir lists nothing (bun pm ls -g exits non-zero there)", async () => {
    const host = fakeHost({ which: ["bun"] });
    expect(await detectTools(host)).toEqual([]);
    expect(host.calls).toEqual(["run bun pm ls -g"]);
  });

  const LONG_MODULE = "github.com/some-organisation/some-very-long-repository-name/cmd/tooling/wsp-go";

  it.each([
    ["gopls", "golang.org/x/tools/gopls", "v0.16.2"],
    ["wsp-go", LONG_MODULE, "v1.4.0"],
  ])("a go binary is labelled %s; the module path is its first detail line", async (name, path, version) => {
    expect(LONG_MODULE).toHaveLength(78);
    const host = fakeHost({ files: { [`~/go/bin/${name}`]: 1 }, which: ["go"], exec: { [`go version -m /Users/dev/go/bin/${name}`]: `x\n\tpath\t${path}\n\tmod\t${path}\t${version}\th1:abc=\n` } });
    const rows = await detectTools(host);
    expect(rows).toEqual([{ rung: "tools", id: `tools/go/${name}`, label: name, group: "Go binaries", paths: [`${path}@${version}`], bytes: 0, default: "bring", linux: "yes", version }]);
  });

  it("a go binary without module info is offered unticked", async () => {
    const host = fakeHost({ files: { "~/go/bin/mystery": 1 }, which: ["go"] });
    const rows = await detectTools(host);
    expect(rows).toEqual([{ rung: "tools", id: "tools/go/mystery", label: "mystery (no module info)", group: "Go binaries", paths: [], bytes: 0, default: "skip", linux: "yes" }]);
  });
});
