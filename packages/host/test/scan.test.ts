// SPDX-License-Identifier: AGPL-3.0-only
// The Also on this Mac scan: what the package managers here could put on the
// Linux image, with the line that installs it there and the size measured here.
import type { Host } from "@wsp/collect";
import { describe, expect, it } from "vitest";
import { asLinuxbrew } from "@wsp/catalog";
import { customFromScan, scanTools } from "../src/scan.js";

const BREWFILE = [
  'tap "homebrew/bundle"',
  'brew "just"',
  'brew "node"',
  'brew "go"',
  'brew "blueutil"',
  'cask "figma"',
  'mas "Xcode", id: 497799835',
].join("\n");

const NPM_GLOBALS = JSON.stringify({ dependencies: { npm: { version: "11.0.0" }, "@openai/codex": { version: "0.153.0" }, turbo: { version: "2.5.0" } } });

interface Fake {
  brew?: boolean;
  npm?: boolean;
  cargo?: boolean;
  pipx?: boolean;
  /** Names under each directory the scan lists. */
  dirs?: Record<string, string[]>;
  /** The npm globals listing, when a test wants its own. */
  globals?: Record<string, { version: string }>;
  /** Kilobytes du reports for a path, by the tail of the path asked about; null makes du fail for the whole read. */
  du?: Record<string, number> | null;
}

function laptop(over: Fake = {}): Host & { calls: string[] } {
  const calls: string[] = [];
  const dirs: Record<string, string[]> = over.dirs ?? {
    "/opt/homebrew/Cellar": ["just", "blueutil"],
    "/opt/homebrew/lib/node_modules": ["turbo", "@openai"],
    "/opt/homebrew/lib/node_modules/@openai": ["codex"],
  };
  const here = new Set([...(over.brew === false ? [] : ["brew"]), ...(over.npm === false ? [] : ["npm"]), ...(over.cargo === true ? ["cargo", "uv"] : []), ...(over.pipx === true ? ["uv", "pipx"] : []), "du"]);
  return {
    calls,
    platform: "darwin",
    home: "/Users/dev",
    fs: {
      stat: async () => undefined,
      list: async dir => dirs[dir] ?? [],
      readText: async () => undefined,
      walk: async () => [],
      async *lines() {},
    },
    exec: {
      which: async bin => here.has(bin),
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "brew" && args[0] === "bundle") return BREWFILE;
        if (cmd === "brew" && args[0] === "--cellar") return "/opt/homebrew/Cellar\n";
        if (cmd === "npm" && args[0] === "ls") return over.globals === undefined ? NPM_GLOBALS : JSON.stringify({ dependencies: over.globals });
        if (cmd === "npm" && args[0] === "prefix") return "/opt/homebrew\n";
        if (cmd === "cargo") return "bacon v3.1.0:\n    bacon\n";
        if (cmd === "uv") return "ruff v0.14.0\n- ruff\n";
        if (cmd === "pipx") return JSON.stringify({ venvs: { ruff: { metadata: { main_package: { package_version: "0.13.0" } } } } });
        if (cmd === "du") {
          if (over.du === null) return undefined;
          const kb = over.du ?? { just: 2048, blueutil: 100, turbo: 1024, codex: 512 };
          const of = (p: string): number => Object.entries(kb).find(([name]) => p.endsWith(`/${name}`))?.[1] ?? 0;
          return args.slice(1).map(p => `${of(p)}\t${p}`).join("\n");
        }
        return undefined;
      },
    },
  };
}

describe("scanTools", () => {
  it("groups what each manager has by manager, with the line that installs it on the image and the size measured here", async () => {
    const rows = await scanTools(laptop());
    expect(rows.map(r => r.group)).toEqual(["Homebrew formulae", "npm globals"]);
    expect(rows).toEqual([
      { id: "brew/just", name: "just", manager: "brew", group: "Homebrew formulae", install: "brew install just", check: asLinuxbrew("list --versions 'just'"), size: 2048 * 1024 },
      { id: "npm/turbo", name: "turbo", manager: "npm", group: "npm globals", install: "npm install -g turbo", check: "npm ls -g 'turbo'", size: 1024 * 1024, version: "2.5.0" },
    ]);
  });

  it("leaves out a cask, a Mac App Store app, a formula with no Linux bottle, and anything the catalog carries", async () => {
    const names = (await scanTools(laptop())).map(r => r.name);
    expect(names).not.toContain("figma");
    expect(names).not.toContain("Xcode");
    // No Linux bottle: nothing to install on the image.
    expect(names).not.toContain("blueutil");
    // The base installs Node on every machine, and Go has a catalog row of its own on the Tools screen.
    expect(names).not.toContain("node");
    expect(names).not.toContain("go");
    // Codex's own npm package: the Agents screen installs it, so it is not a second row here.
    expect(names).not.toContain("@openai/codex");
  });

  it("reads each manager once and du once for its directory", async () => {
    const host = laptop();
    await scanTools(host);
    expect(host.calls.filter(c => c.startsWith("du "))).toHaveLength(2);
    expect(host.calls.filter(c => c.startsWith("brew bundle"))).toHaveLength(1);
  });

  it("keeps two scoped npm names ending in the same word apart, each with its own size", async () => {
    const rows = await scanTools(laptop({
      brew: false,
      npm: true,
      globals: { "@a/cli": { version: "1.0.0" }, "@b/cli": { version: "2.0.0" } },
      dirs: {
        "/opt/homebrew/lib/node_modules": ["@a", "@b"],
        "/opt/homebrew/lib/node_modules/@a": ["cli"],
        "/opt/homebrew/lib/node_modules/@b": ["cli"],
      },
      du: { "@a/cli": 100, "@b/cli": 900 },
    }));
    expect(rows.map(r => [r.name, r.size])).toEqual([["@a/cli", 100 * 1024], ["@b/cli", 900 * 1024]]);
  });

  it("skips a manager that is not here and leaves a row's size off when du cannot be read", async () => {
    const rows = await scanTools(laptop({ brew: false, du: null }));
    expect(rows.map(r => r.id)).toEqual(["npm/turbo"]);
    expect(rows[0]).not.toHaveProperty("size");
  });

  it("groups uv and pipx together and names cargo's own group", async () => {
    const rows = await scanTools(laptop({ brew: false, npm: false, cargo: true }));
    expect(rows).toEqual([
      { id: "uv/ruff", name: "ruff", manager: "uv", group: "uv and pipx tools", install: "uv tool install ruff", check: "uv tool list | grep -q '^ruff '", version: "0.14.0" },
      { id: "cargo/bacon", name: "bacon", manager: "cargo", group: "cargo installs", install: "cargo install bacon", check: "cargo install --list | grep -q '^bacon '", version: "3.1.0" },
    ]);
  });

  it("asks Homebrew itself whether a formula is there, since a formula's binaries need not carry its name", async () => {
    const rows = await scanTools(laptop());
    // brew install llvm leaves clang and llvm-config; command -v llvm would read a good install as a failure.
    expect(rows[0]!.check).toBe(asLinuxbrew("list --versions 'just'"));
    expect(rows[0]!.check).not.toContain("command -v");
  });

  it("leaves out a tool the recipe already installs by another hand, so a tick cannot install it twice", async () => {
    const byHand = [{ kind: "custom" as const, id: "just", name: "just", install: ["brew install just"], check: "command -v just", why: "added by the agent" }];
    expect((await scanTools(laptop(), byHand)).map(r => r.id)).toEqual(["npm/turbo"]);
    // The row this screen wrote for that very package is not one of those: it comes back, to be drawn ticked.
    const own = [{ ...byHand[0]!, id: "brew/just" }];
    expect((await scanTools(laptop(), own)).map(r => r.id)).toEqual(["brew/just", "npm/turbo"]);
  });

  it("turns a scanned row into a recipe row the machine can install, under the tool's own name", () => {
    const row = { id: "brew/just", name: "just", manager: "brew" as const, group: "Homebrew formulae", install: "brew install just", check: "brew list just", size: 2048 };
    // The row names its manager, so the build brings Homebrew before the line runs.
    expect(customFromScan(row)).toEqual({ kind: "custom", id: "brew/just", name: "just", install: ["brew install just"], check: "brew list just", manager: "brew", size: 2048, why: "installed on this Mac by brew" });
  });

  it("keeps one name from two managers apart: two rows, two recipe ids, each with its own manager's line", async () => {
    const rows = await scanTools(laptop({ brew: false, npm: false, pipx: true }));
    expect(rows.map(r => r.id)).toEqual(["uv/ruff", "pipx/ruff"]);
    expect(rows.map(r => r.install)).toEqual(["uv tool install ruff", "pipx install ruff"]);
    // Each manager answers for its own, so no row leans on the package's name being the command it leaves.
    expect(rows.map(r => r.check)).toEqual(["uv tool list | grep -q '^ruff '", "pipx list --short | grep -q '^ruff '"]);
    // Two rows under one recipe id would be two installs, two digest ticks and one check answering for both.
    expect(new Set(rows.map(r => customFromScan(r).id)).size).toBe(2);
    expect(rows.map(r => customFromScan(r).name)).toEqual(["ruff", "ruff"]);
  });
});
