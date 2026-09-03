// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { binaryNames, parseCrates2, provenance } from "../../src/index.js";
import { HOME, OLD, RECENT, home, laptop } from "./fixture.js";

describe("pass 1: provenance", () => {
  it("classifies every executable on PATH by where the real file lives and reads the owner's receipt", async () => {
    const { tools } = await provenance(laptop(home()));
    expect(tools.map(t => [t.name, t.owner, t.package, t.version, t.onRequest])).toEqual([
      ["python", "mise", "python", undefined, undefined],
      ["litmus", "npm", "litmus-cli", "1.2.0", undefined],
      ["ty", "uv", "ty", "0.0.1", undefined],
      ["adb", "homebrew", "android-platform-tools", "37.0.0", undefined],
      ["brew", "homebrew", "brew", undefined, undefined],
      ["gh", "homebrew", "gh", "2.97.0", true],
      ["jq", "homebrew", "jq", "1.7.1", false],
      ["rg", "nix", "ripgrep", "14.1.0", undefined],
      ["bat", "cargo", "bat", "0.24.0", undefined],
      ["gopls", "go", "golang.org/x/tools/gopls", "v0.16.2", undefined],
      ["docker", "app", "Docker", undefined, undefined],
      ["ls", "system", undefined, undefined, undefined],
    ]);
    const gh = tools.find(t => t.name === "gh");
    expect(gh).toMatchObject({ path: "/opt/homebrew/bin/gh", resolved: "/opt/homebrew/Cellar/gh/2.97.0/bin/gh", bytes: 40_000_000, mtime: RECENT });
  });

  it("lists what no prefix claims with size, mtime and the neighbouring dot-directory", async () => {
    const { leftovers } = await provenance(laptop(home()));
    expect(leftovers).toEqual([
      { name: "hermes", path: `${HOME}/.local/bin/hermes`, resolved: `${HOME}/.local/bin/hermes`, bytes: 5_000_000, mtime: RECENT, neighbour: `${HOME}/.hermes` },
      { name: "node", path: `${HOME}/.local/bin/node`, resolved: `${HOME}/.hermes/node/bin/node`, bytes: 90_000_000, mtime: RECENT, neighbour: `${HOME}/.hermes` },
      { name: "omp", path: `${HOME}/.local/bin/omp`, resolved: `${HOME}/.local/bin/omp`, bytes: 9_000_000, mtime: OLD },
    ]);
  });

  it("skips non-executables and dangling links, and the first entry on PATH wins a name", async () => {
    const m = laptop({
      path: ["~/.local/bin", "/opt/homebrew/bin"],
      links: { "~/.local/bin/gone": "/nowhere", "/opt/homebrew/bin/gh": "../Cellar/gh/2.97.0/bin/gh" },
      files: { "~/.local/bin/notes.txt": { text: "x", mode: 0o644 }, "~/.local/bin/gh": 10, "/opt/homebrew/Cellar/gh/2.97.0/bin/gh": 20 },
    });
    const p = await provenance(m);
    expect(p.tools).toEqual([]);
    expect(p.leftovers.map(l => [l.name, l.path])).toEqual([["gh", `${HOME}/.local/bin/gh`]]);
  });

  it("a mise shim belongs to mise even though it resolves into the Homebrew cellar", async () => {
    const m = laptop({
      path: ["~/.local/share/mise/shims", "~/.local/share/mise/installs/node/22.1.0/bin"],
      links: { "~/.local/share/mise/shims/node": "/opt/homebrew/Cellar/mise/2026.1.0/bin/mise" },
      files: { "/opt/homebrew/Cellar/mise/2026.1.0/bin/mise": 1, "~/.local/share/mise/installs/node/22.1.0/bin/npm": 1 },
    });
    const { tools } = await provenance(m);
    expect(tools.map(t => [t.name, t.owner, t.package, t.version])).toEqual([["node", "mise", "node", undefined], ["npm", "mise", "node", "22.1.0"]]);
  });

  it("a stray file in Homebrew's bin is not brew's: a Go binary identifies itself, anything else is a leftover", async () => {
    const m = laptop({
      path: ["/opt/homebrew/bin"],
      which: ["go"],
      files: { "/opt/homebrew/bin/spoo": 1, "/opt/homebrew/bin/pipscript": 1, "/opt/homebrew/share/google-cloud-sdk/bin/gcloud": 1 },
      links: { "/opt/homebrew/bin/gcloud": "../share/google-cloud-sdk/bin/gcloud" },
      exec: { "go version -m /opt/homebrew/bin/spoo": "/opt/homebrew/bin/spoo: go1.23.1\n\tpath\tgithub.com/spoo-me/cli\n\tmod\tgithub.com/spoo-me/cli\tv1.4.0\th1:x=\n" },
    });
    const p = await provenance(m);
    expect(p.leftovers.map(l => l.name)).toEqual(["pipscript"]);
    expect(p.tools.map(t => [t.name, t.owner, t.package, t.version])).toEqual([["gcloud", "homebrew", undefined, undefined], ["spoo", "go", "github.com/spoo-me/cli", "v1.4.0"]]);
  });

  it("pipx venvs, scoped npm packages, bun globals and asdf shims", async () => {
    const m = laptop({
      path: ["~/.local/bin", "~/.bun/bin", "~/.asdf/shims"],
      links: {
        "~/.local/bin/httpie": "../share/pipx/venvs/httpie/bin/httpie",
        "~/.local/bin/monid": "../lib/node_modules/@monid-ai/cli/dist/index.js",
        "~/.bun/bin/is-odd": "../install/global/node_modules/is-odd/bin/is-odd",
      },
      files: {
        "~/.local/share/pipx/venvs/httpie/bin/httpie": 1,
        "~/.local/share/pipx/venvs/httpie/pipx_metadata.json": '{"main_package":{"package_version":"3.2.4"}}',
        "~/.local/lib/node_modules/@monid-ai/cli/dist/index.js": { bytes: 1, mode: 0o755 },
        "~/.bun/install/global/node_modules/is-odd/bin/is-odd": 1,
        "~/.bun/bin/bun": 1,
        "~/.asdf/shims/ruby": 1,
      },
    });
    const { tools, leftovers } = await provenance(m);
    expect(leftovers).toEqual([]);
    expect(tools.map(t => [t.name, t.owner, t.package, t.version])).toEqual([
      ["httpie", "pipx", "httpie", "3.2.4"],
      ["monid", "npm", "@monid-ai/cli", undefined],
      ["bun", "bun", "bun", undefined],
      ["is-odd", "bun", "is-odd", undefined],
      ["ruby", "asdf", "ruby", undefined],
    ]);
  });

  it("binaryNames covers owned tools and leftovers alike", async () => {
    expect([...binaryNames(await provenance(laptop(home())))].sort()).toEqual(["adb", "bat", "brew", "docker", "gh", "gopls", "hermes", "jq", "litmus", "ls", "node", "omp", "python", "rg", "ty"]);
  });

  it("parses .crates2.json by bin name", () => {
    const text = JSON.stringify({ installs: { "ripgrep 14.1.0 (registry+https://x)": { bins: ["rg"] }, "cargo-edit 0.12.2 (registry+https://x)": { bins: ["cargo-add", "cargo-rm"] } } });
    expect([...parseCrates2(text)]).toEqual([["rg", { package: "ripgrep", version: "14.1.0" }], ["cargo-add", { package: "cargo-edit", version: "0.12.2" }], ["cargo-rm", { package: "cargo-edit", version: "0.12.2" }]]);
    expect(parseCrates2("nope").size).toBe(0);
  });
});
