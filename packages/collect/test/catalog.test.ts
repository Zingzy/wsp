// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildLookup, convertMackup, dirKey, isCredential, isMacOnly, lookup, parseMackupCfg, renderCatalog } from "../src/index.js";
import { parseDataFile } from "../src/catalog.js";

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

const TRAILING_SLASH = `[application]
name = Base

[configuration_files]
Library/Containers/uk.co.menial.Base/Data/Library/Application Support/Base/
`;

const OVERLAY = { paths: [".aws/credentials", ".cloudflared/*.json", ".infisical", ".config/gh/hosts.yml"], names: ["auth.json", "credentials*", "*.pem"] };

describe("mackup cfg parsing", () => {
  it("reads the name and both path sections, skipping comments, with or without spaces around =", () => {
    expect(parseMackupCfg("git", GIT)).toEqual({ id: "git", name: "Git", paths: [".gitconfig"], xdg: ["git/config", "git/ignore"] });
    expect(parseMackupCfg("ideavim", IDEAVIM)).toEqual({ id: "ideavim", name: "IdeaVim", paths: [".ideavimrc"], xdg: [] });
  });

  it("drops a trailing slash so a directory path never renders as ~/.../Base/", () => {
    expect(parseMackupCfg("base", TRAILING_SLASH).paths).toEqual(["Library/Containers/uk.co.menial.Base/Data/Library/Application Support/Base"]);
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
    ["Library/KeyBindings/DefaultKeyBinding.dict", "KeyBindings"],
    ["Library/Rime/default.yaml", "Rime"],
    ["~/.config/gh/", "gh"],
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

  it("narrows a name with a slash to the paths at or under that location and leaves a bare name whole", () => {
    const look = buildLookup([{ id: "atuin", name: "Atuin", paths: [".local/share/atuin/key"], xdg: ["atuin/config.toml"] }], OVERLAY);
    expect(look("atuin").map(r => r.path)).toEqual(["~/.local/share/atuin/key", "~/.config/atuin/config.toml"]);
    expect(look("~/.config/atuin").map(r => r.path)).toEqual(["~/.config/atuin/config.toml"]);
    expect(look(".local/share/atuin/").map(r => r.path)).toEqual(["~/.local/share/atuin/key"]);
    expect(look("~/.config/atuin/config.toml").map(r => r.path)).toEqual(["~/.config/atuin/config.toml"]);
    expect(look("~/atuin")).toEqual([]);
  });

  it("keeps the first app's label when two entries list the same path", () => {
    const look = buildLookup(
      [
        { id: "asdf", name: "asdf", paths: [".tool-versions"], xdg: [] },
        { id: "mise", name: "mise", paths: [".tool-versions"], xdg: [] },
      ],
      OVERLAY,
    );
    expect(look(".tool-versions")).toEqual([{ app: "asdf", path: "~/.tool-versions", credential: false }]);
  });

  it("names the data file when its text is not JSON or not the expected shape", () => {
    const schema = z.object({ entries: z.array(z.string()) });
    expect(() => parseDataFile("catalog.json", "{", schema)).toThrow(/^catalog\.json: /);
    expect(() => parseDataFile("wsp-entries.json", '{"entries": 1}', schema)).toThrow(/^wsp-entries\.json: .*entries/s);
    expect(parseDataFile("ok.json", '{"entries": ["a"]}', schema)).toEqual({ entries: ["a"] });
  });
});

describe("shipped catalog", () => {
  it.each([
    ["a mackup entry", ".aws", [{ app: "AWS CLI", path: "~/.aws", credential: true }]],
    ["a wsp entry", "gh", [{ app: "GitHub CLI", path: "~/.config/gh/config.yml", credential: false }, { app: "GitHub CLI", path: "~/.config/gh/hosts.yml", credential: true }]],
    ["an overlay hit on a mackup path", ".kube", [{ app: "kubectl", path: "~/.kube/config", credential: true }]],
    ["a miss", ".no-such-tool", []],
    ["a kept entry under a Library/ subdirectory other than the two common ones", "KeyBindings", [{ app: "MacOSX", path: "~/Library/KeyBindings/DefaultKeyBinding.dict", credential: false }]],
    ["the bare Library directory", "Library", []],
  ])("lookup for %s", (_, dir, rows) => {
    expect(lookup(dir)).toEqual(rows);
  });

  it.each([
    [".m2", "~/.m2/settings-security.xml", true],
    [".m2", "~/.m2/settings.xml", true],
    [".m2", "~/.m2/toolchains.xml", false],
    ["hub", "~/.config/hub", true],
    [".npmrcs", "~/.npmrcs", true],
    [".password-store", "~/.password-store", true],
    [".gradle", "~/.gradle/gradle.properties", true],
    [".gradle", "~/.gradle/init.gradle", false],
    [".okta-aws", "~/.okta-aws", true],
    ["aerc", "~/.config/aerc/accounts.conf", true],
    ["aerc", "~/.config/aerc/aerc.conf", false],
    ["mkcert", "~/.local/share/mkcert/rootCA-key.pem", true],
  ])("lookup(%s) flags %s as credential=%s", (dir, path, flag) => {
    const row = lookup(dir).find(r => r.path === path);
    expect(row, path).toBeDefined();
    expect(row?.credential).toBe(flag);
  });

  it.each([
    ["~/.config/atuin", ["~/.config/atuin/config.toml"]],
    [".local/share/atuin", ["~/.local/share/atuin/key", "~/.local/share/atuin/session"]],
    ["~/.config/Code", ["~/.config/Code/User/snippets", "~/.config/Code/User/keybindings.json", "~/.config/Code/User/settings.json"]],
    ["Library/Application Support/Code", ["~/Library/Application Support/Code/User/snippets", "~/Library/Application Support/Code/User/prompts", "~/Library/Application Support/Code/User/keybindings.json", "~/Library/Application Support/Code/User/settings.json"]],
  ])("lookup(%s) returns only the paths under that location", (dir, paths) => {
    expect(lookup(dir).map(r => r.path)).toEqual(paths);
  });

  it("returns every location for a bare name", () => {
    expect(lookup("atuin").map(r => r.path)).toEqual(["~/.local/share/atuin/key", "~/.local/share/atuin/session", "~/.config/atuin/config.toml"]);
    expect(lookup("Code")).toHaveLength(7);
  });

  it("keeps the xdg twin of a GUI editor and flags nothing in it", () => {
    const rows = lookup("Code");
    expect(rows.map(r => r.path)).toContain("~/.config/Code/User/settings.json");
    expect(rows.map(r => r.path)).toContain("~/Library/Application Support/Code/User/settings.json");
    expect(rows.every(r => r.app === "Visual Studio Code" && !r.credential)).toBe(true);
  });

  it("carries every tool the research found missing from mackup", () => {
    for (const dir of ["gh", "gcloud", ".wrangler", "com.vercel.cli", ".fly", ".supabase", ".doppler", ".railway", "glab-cli", "uv", ".bunfig.toml", "atuin", "aerc", "lazydocker", "mkcert"]) {
      expect(lookup(dir).length, dir).toBeGreaterThan(0);
    }
  });
});
