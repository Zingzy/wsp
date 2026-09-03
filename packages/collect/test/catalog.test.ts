// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { buildLookup, convertMackup, dirKey, isCredential, isMacOnly, lookup, parseMackupCfg, renderCatalog } from "../src/index.js";

const GIT = `[application]
name = Git

[configuration_files]
.gitconfig

[xdg_configuration_files]
git/config
git/ignore
`;

const IDEAVIM = `[application]
name=IdeaVim

[configuration_files]
# the plugin reads this one file
.ideavimrc
`;

const PLIST_ONLY = `[application]
name = 1Password 4

[configuration_files]
Library/Preferences/com.agilebits.onepassword4.plist
Library/Application Support/1Password 4
`;

const OVERLAY = { paths: [".aws/credentials", ".cloudflared/*.json", ".infisical", ".config/gh/hosts.yml"], names: ["auth.json", "credentials*", "*.pem"] };

describe("mackup cfg parsing", () => {
  it("reads the name and both path sections, skipping comments, with or without spaces around =", () => {
    expect(parseMackupCfg("git", GIT)).toEqual({ id: "git", name: "Git", paths: [".gitconfig"], xdg: ["git/config", "git/ignore"] });
    expect(parseMackupCfg("ideavim", IDEAVIM)).toEqual({ id: "ideavim", name: "IdeaVim", paths: [".ideavimrc"], xdg: [] });
  });

  it("calls an entry macOS-only when every path is under Library/ and there is no xdg twin", () => {
    expect(isMacOnly(parseMackupCfg("1password-4", PLIST_ONLY))).toBe(true);
    expect(isMacOnly({ id: "code", name: "Code", paths: ["Library/Application Support/Code/User/settings.json"], xdg: ["Code/User/settings.json"] })).toBe(false);
    expect(isMacOnly({ id: "atom", name: "Atom", paths: ["Library/Preferences/com.github.atom.plist", ".atom/config.cson"], xdg: [] })).toBe(false);
  });

  it("converts a checkout into a sorted catalog that names what it dropped, and renders one entry per line", () => {
    const c = convertMackup([{ id: "ideavim", text: IDEAVIM }, { id: "1password-4", text: PLIST_ONLY }, { id: "git", text: GIT }], "abc123");
    expect(c.commit).toBe("abc123");
    expect(c.license).toBe("GPL-3.0-or-later");
    expect(c.dropped).toEqual(["1password-4"]);
    expect(c.entries.map(e => e.id)).toEqual(["git", "ideavim"]);
    const text = renderCatalog(c);
    expect(JSON.parse(text)).toEqual(c);
    expect(text.split("\n").filter(l => l.startsWith('    {"id"'))).toHaveLength(2);
    expect(text.endsWith("]\n}\n")).toBe(true);
  });
});

describe("directory keys and credential flags", () => {
  it.each([
    [".aws/credentials", ".aws"],
    [".gitconfig", ".gitconfig"],
    ["~/.config/gh/hosts.yml", "gh"],
    [".config/starship.toml", "starship.toml"],
    ["Library/Application Support/Code/User/settings.json", "Code"],
    ["Library/Preferences/.wrangler/config/default.toml", ".wrangler"],
    [".local/share/com.vercel.cli/auth.json", "com.vercel.cli"],
    ["gh", "gh"],
  ])("dirKey(%s) is %s", (path, key) => {
    expect(dirKey(path)).toBe(key);
  });

  it.each([
    [".aws/credentials", true],
    [".aws", true],
    [".aws/config", false],
    [".cloudflared/abc.json", true],
    [".cloudflared/config.yml", false],
    [".cloudflared", true],
    [".infisical/anything/at/all", true],
    [".config/gh/hosts.yml", true],
    [".config/gh/config.yml", false],
    [".codex/auth.json", true],
    [".codex/config.toml", false],
    [".cargo/credentials.toml", true],
    ["certs/server.pem", true],
    [".config/nvim/init.lua", false],
  ])("isCredential(%s) is %s", (path, flag) => {
    expect(isCredential(path, OVERLAY)).toBe(flag);
  });

  it("indexes home and xdg paths under the directory the collector walks and dedupes a path listed twice", () => {
    const look = buildLookup(
      [
        { id: "gh", name: "GitHub CLI", paths: [], xdg: ["gh/config.yml", "gh/hosts.yml"] },
        { id: "gh-twin", name: "Twin", paths: [".config/gh/hosts.yml"], xdg: [] },
      ],
      OVERLAY,
    );
    expect(look("gh")).toEqual([
      { app: "GitHub CLI", path: "~/.config/gh/config.yml", credential: false },
      { app: "GitHub CLI", path: "~/.config/gh/hosts.yml", credential: true },
    ]);
    expect(look("~/.config/gh")).toEqual(look("gh"));
    expect(look("nope")).toEqual([]);
  });
});

describe("shipped catalog", () => {
  it.each([
    ["a mackup entry", ".aws", [{ app: "AWS CLI", path: "~/.aws", credential: true }]],
    ["a wsp entry", "gh", [{ app: "GitHub CLI", path: "~/.config/gh/config.yml", credential: false }, { app: "GitHub CLI", path: "~/.config/gh/hosts.yml", credential: true }]],
    ["an overlay hit on a mackup path", ".kube", [{ app: "kubectl", path: "~/.kube/config", credential: true }]],
    ["a miss", ".no-such-tool", []],
  ])("lookup for %s", (_, dir, rows) => {
    expect(lookup(dir)).toEqual(rows);
  });

  it("keeps the xdg twin of a GUI editor and flags nothing in it", () => {
    const rows = lookup("Code");
    expect(rows.map(r => r.path)).toContain("~/.config/Code/User/settings.json");
    expect(rows.map(r => r.path)).toContain("~/Library/Application Support/Code/User/settings.json");
    expect(rows.every(r => r.app === "Visual Studio Code" && !r.credential)).toBe(true);
  });

  it("carries every tool the research found missing from mackup", () => {
    for (const dir of ["gh", "gcloud", ".wrangler", "com.vercel.cli", ".fly", ".supabase", ".doppler", ".railway", "glab-cli", "uv", ".bunfig.toml", "atuin"]) {
      expect(lookup(dir).length, dir).toBeGreaterThan(0);
    }
  });
});
