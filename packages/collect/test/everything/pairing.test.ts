// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { type Dir, type Provenance, type Tool, candidates, pair, provenance, roles } from "../../src/index.js";
import { HOME, home, laptop } from "./fixture.js";

const dir = (path: string, role: Dir["role"] = "unknown"): Dir => ({ path: `${HOME}/${path}`, kind: "dir", role, paths: [`${HOME}/${path}`], excludes: [], bytes: 10, files: 1, mtime: 1, measured: "exact" });
const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({ name, path: `/opt/homebrew/bin/${name}`, resolved: `/opt/homebrew/Cellar/${name}/1/bin/${name}`, owner: "homebrew", bytes: 1, mtime: 1, ...extra });
const prov = (tools: Tool[], leftovers: Provenance["leftovers"] = []): Provenance => ({ tools, leftovers });

describe("pass 3: name pairing", () => {
  it("the four places a binary called foo keeps its files", () => {
    expect(candidates(HOME, "foo")).toEqual([`${HOME}/.config/foo`, `${HOME}/.foo`, `${HOME}/.local/share/foo`, `${HOME}/.foorc`]);
  });

  it("over the fixture: gh owns ~/.config/gh, the curl-installed hermes owns ~/.hermes, everything else stays unpaired", async () => {
    const m = laptop(home());
    const p = await provenance(m);
    const { pairs, rest } = pair(HOME, p, await roles(m));
    expect(pairs.map(x => [x.name, x.owner, x.binary?.path, x.dirs.map(d => d.path)])).toEqual([
      ["gh", "homebrew", undefined, [`${HOME}/.config/gh`]],
      ["hermes", undefined, `${HOME}/.local/bin/hermes`, [`${HOME}/.hermes`]],
    ]);
    expect(rest.map(d => d.path)).not.toContain(`${HOME}/.config/gh`);
    expect(rest.filter(d => d.path === `${HOME}/.hermes`).map(d => d.role)).toEqual(["state"]);
  });

  it("a system binary never pairs: ssh does not own ~/.ssh and zsh does not own ~/.zshrc", async () => {
    const m = laptop(home());
    const p = await provenance(m);
    expect(p.tools.filter(t => t.owner === "system").map(t => t.name)).toEqual(["ls", "ssh", "zsh"]);
    const { pairs, rest } = pair(HOME, p, await roles(m));
    expect(pairs.map(x => x.name)).not.toContain("ssh");
    expect(pairs.map(x => x.name)).not.toContain("zsh");
    expect(rest.map(d => d.path)).toEqual(expect.arrayContaining([`${HOME}/.ssh`, `${HOME}/.zshrc`]));
  });

  it("pairs by package name too, taking that name, and by an rc file", () => {
    const { pairs } = pair(HOME, prov([tool("rg", { package: "ripgrep" }), tool("bat"), tool("dirmngr", { package: "gnupg" })]), [dir(".config/ripgrep"), dir(".batrc"), dir(".config/other"), dir(".gnupg")]);
    expect(pairs.map(x => [x.name, x.dirs.map(d => d.path)])).toEqual([["ripgrep", [`${HOME}/.config/ripgrep`]], ["bat", [`${HOME}/.batrc`]], ["gnupg", [`${HOME}/.gnupg`]]]);
  });

  it("a cache or state record never pairs, and a record pairs once", () => {
    const { pairs, rest } = pair(HOME, prov([tool("foo"), tool("foo", { path: "/usr/local/bin/foo" })]), [dir(".foo", "cache"), dir(".config/foo")]);
    expect(pairs.map(x => x.dirs.map(d => d.path))).toEqual([[`${HOME}/.config/foo`]]);
    expect(rest.map(d => d.path)).toEqual([`${HOME}/.foo`]);
  });
});
