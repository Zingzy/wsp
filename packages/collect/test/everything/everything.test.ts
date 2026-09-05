// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import * as pkg from "../../src/index.js";
import { type CatalogPath, type EverythingOptions, type Lookup, type Machine, Rows, everything as fold, lookup as catalog } from "../../src/index.js";
import { EXPECTED_SHAPES, HOME, LOGIN_KEYCHAIN, NOW, RECENT, home, laptop, many, shapes } from "./fixture.js";

const rel = (p: string): string => p.replace(HOME, "~");
/** The walks' time caps read this clock, so what a test sees is decided by the entry caps alone, however slow the box. */
const everything = (m: Machine, opts: EverythingOptions = {}): ReturnType<typeof fold> => fold(m, { clock: () => 0, ...opts });
const path = (app: string, path: string, credential = false): CatalogPath => ({ app, path, credential });
const lookup: Lookup = dirName => {
  if (dirName === "~/.config/monid") return [path("Monid", "~/.config/monid/config.toml"), path("Monid", "~/.config/monid/credentials.yaml", true)];
  if (dirName === "~/.kube") return [path("kubectl", "~/.kube/config", true)];
  return [];
};

describe("everything: the seven passes folded into rows", () => {
  it("one row per thing, nothing ticked, credentials and large items flagged, kinds from the passes", async () => {
    const { rows } = await everything(laptop(home()), { lookup, now: NOW });
    expect(rows.every(r => r.ticked === false)).toBe(true);
    expect(rows.map(r => [r.name, r.kind, r.flags.join("+"), r.owner ?? "", r.paths.join(" ")])).toEqual([
      [".cache", "cache", "", "", "~/.cache"],
      [".cargo", "unknown", "", "", "~/.cargo"],
      [".cargo/bin", "state", "large", "", "~/.cargo/bin"],
      [".CFUserTextEncoding", "unknown", "", "", "~/.CFUserTextEncoding"],
      [".DS_Store", "cache", "", "", "~/.DS_Store"],
      [".hermes", "config", "credential", "", "~/.hermes"],
      [".hermes/.env", "credential", "credential", "", "~/.hermes/.env"],
      [".hermes/auth.json", "credential", "credential", "", "~/.hermes/auth.json"],
      [".jcode", "unknown", "", "", "~/.jcode"],
      [".kube/config", "credential", "credential", "", "~/.kube/config"],
      [".mcp-auth", "unknown", "", "", "~/.mcp-auth"],
      [".netrc", "credential", "credential", "", "~/.netrc"],
      [".nix-profile/bin", "state", "", "", "~/.nix-profile/bin"],
      [".oh-my-zsh", "unknown", "", "", "~/.oh-my-zsh"],
      [".oh-my-zsh/.git", "state", "", "", "~/.oh-my-zsh/.git"],
      [".oldtool", "unknown", "stale", "", "~/.oldtool"],
      [".rustup", "unknown", "", "", "~/.rustup"],
      [".rustup/toolchains", "state", "large", "", "~/.rustup/toolchains"],
      [".ssh", "unknown", "credential", "", "~/.ssh"],
      [".ssh/id_ed25519", "credential", "credential", "", "~/.ssh/id_ed25519"],
      [".tmux.conf", "unknown", "", "", "~/.tmux.conf"],
      [".viminfo", "unknown", "", "", "~/.viminfo"],
      [".wrangler/config/default.toml", "credential", "credential", "", "~/Library/Preferences/.wrangler/config/default.toml"],
      [".zcompdump-mac-5.9", "cache", "", "", "~/.zcompdump-mac-5.9"],
      [".zsh_history", "state", "", "", "~/.zsh_history"],
      [".zsh_sessions", "state", "", "", "~/.zsh_sessions"],
      [".zshrc", "unknown", "", "", "~/.zshrc"],
      ["Caches", "cache", "", "", "~/Library/Caches"],
      ["Code", "app-data", "", "", "~/Library/Application Support/Code"],
      ["dotfiles", "config", "", "", "~/dotfiles"],
      ["gh", "config", "credential", "homebrew", "~/.config/gh"],
      ["gh:github.com", "device-bound-login", "", "gh", ""],
      ["gh/hosts.yml", "credential", "credential", "homebrew", "~/.config/gh/hosts.yml"],
      ["github.com", "device-bound-login", "", "", ""],
      ["glab:gitlab.com:token", "device-bound-login", "", "", ""],
      ["huggingface/token", "credential", "credential", "", "~/.cache/huggingface/token"],
      ["lib/node_modules", "state", "", "", "~/.local/lib/node_modules"],
      ["mise/shims", "state", "", "", "~/.local/share/mise/shims"],
      ["monid/credentials.yaml", "credential", "credential", "", "~/.config/monid/credentials.yaml"],
      ["node", "unknown", "", "", ""],
      ["nvim", "unknown", "", "", "~/.config/nvim"],
      ["omp", "unknown", "", "", ""],
      ["raycast", "unknown", "", "", "~/.config/raycast"],
      ["Raycast", "device-bound-login", "", "", ""],
      ["raycast/extensions", "state", "large", "", "~/.config/raycast/extensions"],
      ["state", "state", "", "", "~/.local/state"],
      ["state files in ~/.hermes", "state", "large", "", "~/.hermes/node/bin ~/.hermes/node_modules"],
      ["uv/tools/ty/bin", "state", "large", "", "~/.local/share/uv/tools/ty/bin"],
    ]);
  });

  it("a pair is one row whose paths are the config side only, whose size is config only, and whose excludes name what a copier must leave out", async () => {
    const { rows } = await everything(laptop(home()), { lookup, now: NOW });
    expect(rows.find(r => r.name === "gh")).toEqual({ id: ".config/gh", name: "gh", kind: "config", paths: ["~/.config/gh"], excludes: ["~/.config/gh/hosts.yml"], bytes: Buffer.byteLength("git_protocol: https\n"), files: 1, mtime: RECENT, measured: "exact", owner: "homebrew", tool: "gh", flags: ["credential"], ticked: false });
    const hermes = rows.find(r => r.name === ".hermes");
    expect(hermes).toMatchObject({ id: ".hermes", paths: ["~/.hermes"], binary: "~/.local/bin/hermes", tool: "hermes", files: 2, bytes: Buffer.byteLength("HERMES_TOKEN=put-yours-here\n") + Buffer.byteLength("model: default\n"), flags: ["credential"] });
    expect(hermes?.excludes).toEqual(["~/.hermes/.env", "~/.hermes/auth.json", "~/.hermes/node/bin", "~/.hermes/node_modules"]);
    expect(rows.find(r => r.name === "state files in ~/.hermes")).toMatchObject({ kind: "state", paths: ["~/.hermes/node/bin", "~/.hermes/node_modules"], bytes: 90_002_000, flags: ["large"], excludes: [] });
    expect(rows.find(r => r.name === ".cargo/bin")).toMatchObject({ kind: "state", paths: ["~/.cargo/bin"], bytes: 6_000_000 });
    expect(rows.find(r => r.name === ".cargo")).toMatchObject({ kind: "unknown", files: 1, excludes: ["~/.cargo/bin"] });
    expect(rows.find(r => r.name === "uv/tools/ty/bin")).toMatchObject({ kind: "state", paths: ["~/.local/share/uv/tools/ty/bin"] });
    expect(rows.every(r => r.excludes.every(x => r.paths.some(p => x.startsWith(`${p}/`))))).toBe(true);
  });

  it("a binary directly in its app directory is not config, and a split record with several paths is named for its directory", async () => {
    const m = laptop({ path: ["~/.local/bin", "~/.cargo/bin"], links: { "~/.local/bin/x": "/Users/dev/.x/x" }, files: { "~/.x/x": { bytes: 5_000_000, mode: 0o755 }, "~/.x/config.toml": "a = 1\n", "~/.cargo/bin/bat": 6_000_000, "~/.cargo/registry/index/a": 10, "~/.cargo/config.toml": "b = 2\n", "~/.cargo/bin/rg": 1 } });
    const { rows } = await everything(m, { now: NOW });
    expect(rows.find(r => r.name === ".x")).toMatchObject({ kind: "config", paths: ["~/.x"], bytes: 6, files: 1, excludes: ["~/.x/x"], binary: "~/.local/bin/x", tool: "x" });
    expect(rows.find(r => r.name === ".x/x")).toMatchObject({ kind: "state", paths: ["~/.x/x"], bytes: 5_000_000 });
    expect(rows.find(r => r.name === "state files in ~/.cargo")).toMatchObject({ kind: "state", paths: ["~/.cargo/bin", "~/.cargo/registry"] });
    expect(rows.find(r => r.name === ".cargo")).toMatchObject({ kind: "unknown", files: 1 });
    expect(rows.every(r => r.paths.every(p => !p.endsWith("/bin/bat")))).toBe(true);
  });

  it("a hand-installed binary whose directory folds to nothing stays as a leftover row", async () => {
    const m = laptop({ path: ["~/.local/bin"], files: { "~/.local/bin/foo": 1_000, "~/.foo/auth.json": '{"access_token":"x"}', "~/.local/bin/qux": 1_000, "~/.qux/node_modules/x/i.js": 10 } });
    const { rows } = await everything(m, { now: NOW });
    expect(rows.find(r => r.name === "foo")).toEqual({ id: "bin:foo", name: "foo", kind: "unknown", paths: [], excludes: [], binary: "~/.local/bin/foo", bytes: 0, files: 0, mtime: RECENT, measured: "exact", flags: [], ticked: false });
    expect(rows.find(r => r.name === "qux")).toMatchObject({ id: "bin:qux", paths: [], binary: "~/.local/bin/qux" });
    expect(rows.find(r => r.name === ".foo/auth.json")).toMatchObject({ kind: "credential" });
    expect(rows.find(r => r.name === ".qux/node_modules")).toMatchObject({ kind: "state" });
  });

  it("credential and split rows are named by their real path under their app directory; climbing happens only on a remaining collision", async () => {
    const { rows } = await everything(laptop(home()), { lookup, now: NOW });
    const names = rows.map(r => r.name);
    expect(names).toEqual(expect.arrayContaining(["gh/hosts.yml", ".hermes/auth.json", ".hermes/.env", "monid/credentials.yaml", ".kube/config", ".ssh/id_ed25519", "huggingface/token", ".netrc", ".oh-my-zsh/.git", ".rustup/toolchains", "raycast/extensions", "lib/node_modules"]));
    expect(names.filter(n => ["config", "token", "hosts.yml", ".env", "auth.json"].includes(n))).toEqual([]);
    const deep = await everything(laptop({ files: { "~/.config/gcloud/legacy_credentials/dev@example.com/.boto": { text: "[Credentials]\ngs_oauth2_refresh_token = x\n", mode: 0o600 }, "~/.config/gcloud/configurations/config_default": "[core]\n", "~/.x/0/credentials.json": '{"token":"a"}', "~/.y/0/credentials.json": '{"token":"b"}' } }), { now: NOW });
    expect(deep.rows.map(r => r.name).sort()).toEqual([".x/0/credentials.json", ".y/0/credentials.json", "gcloud", "gcloud/legacy_credentials/dev@example.com/.boto"]);
  });

  it("no row is ever zero files with a lower bound", async () => {
    const m = laptop({ ...home(), files: { ...home().files, ...many("~/.app/aaa", 6_000), "~/.app/node_modules/x/i.js": 1_000 } });
    const { rows } = await everything(m, { now: NOW });
    for (const r of rows) expect(r.files === 0 && r.measured === "lower-bound", r.id).toBe(false);
    expect(rows.find(r => r.name === ".app/node_modules")).toMatchObject({ files: 1, measured: "exact" });
  });

  it("a failing Keychain dump and an unreadable rc file both leave a note", async () => {
    const base = home();
    const { [`security dump-keychain ${LOGIN_KEYCHAIN}`]: _dump, ...exec } = base.exec ?? {};
    const { notes, rows } = await everything(laptop({ ...base, exec, files: { ...base.files, "~/.bashrc": { bytes: 3_000_000 } } }), { now: NOW });
    expect(notes).toEqual(expect.arrayContaining(["security dump-keychain failed; Keychain logins are not listed", "~/.bashrc could not be read (over 1 MiB or unreadable) and was not scanned"]));
    expect(rows.filter(r => r.kind === "device-bound-login")).toEqual([]);
  });

  it("HOME noise is a cache row, not an unknown one", async () => {
    const { rows } = await everything(laptop(home()), { now: NOW });
    expect(rows.find(r => r.paths[0] === "~/.DS_Store")?.kind).toBe("cache");
    expect(rows.find(r => r.paths[0] === "~/.zcompdump-mac-5.9")?.kind).toBe("cache");
  });

  it("the package exports the module's public pieces by name and none of its helpers", () => {
    const api = pkg as Record<string, unknown>;
    for (const helper of ["basename", "dirname", "tilde", "walk", "budget", "spend", "summarize", "add", "EMPTY", "RC_FILES"]) expect(api[helper], helper).toBeUndefined();
    for (const name of ["everything", "roles", "credentials", "keychain", "shellRc", "stripExports", "RC_PATHS", "sizeGate", "provenance", "pair", "nodeMachine", "Rows", "WALK_ENTRIES", "lookup"]) expect(api[name], name).toBeDefined();
  });

  it("a binary nobody installed by recipe is a row with no paths and the binary named, never something to copy", async () => {
    const { rows } = await everything(laptop(home()), { now: NOW });
    expect(rows.find(r => r.name === "node")).toEqual({ id: "bin:node", name: "node", kind: "unknown", paths: [], excludes: [], binary: "~/.local/bin/node", bytes: 0, files: 0, mtime: RECENT, measured: "exact", flags: [], ticked: false });
    expect(rows.find(r => r.name === "omp")?.binary).toBe("~/.local/bin/omp");
    expect(rows.flatMap(r => r.paths).some(p => p.includes("/bin/"))).toBe(false);
  });

  it("a credential under a state subtree of a paired app is split from the row that counted it, and nothing goes negative", async () => {
    const report = JSON.stringify([{ RuleID: "generic-api-key", File: `${HOME}/.hermes/node_modules/x/.env`, Secret: "REDACTED" }]);
    const m = laptop({
      path: ["~/.local/bin"],
      which: ["gitleaks"],
      files: { "~/.local/bin/hermes": 1_000, "~/.hermes/config.yaml": "model: default\n", "~/.hermes/node_modules/x/.env": "TOKEN=redacted\n" },
      exec: { [`gitleaks dir ${HOME}/.hermes --redact --no-banner --exit-code 0 --report-format json --report-path /dev/stdout`]: report },
    });
    const { rows } = await everything(m, { now: NOW });
    const hermes = rows.find(r => r.name === ".hermes");
    const env = rows.find(r => r.name === ".hermes/node_modules/x/.env");
    expect(hermes).toMatchObject({ kind: "config", flags: [], bytes: Buffer.byteLength("model: default\n"), files: 1 });
    expect(rows.find(r => r.kind === "state")).toBeUndefined();
    expect(env).toMatchObject({ kind: "credential", paths: ["~/.hermes/node_modules/x/.env"], id: ".hermes/node_modules/x/.env" });
    expect(rows.every(r => r.bytes >= 0 && r.files >= 0)).toBe(true);
  });

  it("a credential rc file paired with its binary is split from the pair, not the pair turned into a credential", async () => {
    const m = laptop({ path: ["~/.local/bin"], files: { "~/.local/bin/npm": 1_000, "~/.npm/_cacache/x": 500, "~/.npm/npmrc-notes.md": 10, "~/.npmrc": { text: "//registry.npmjs.org/:_authToken=npm_fake\n", mode: 0o600 } } });
    const { rows } = await everything(m, { now: NOW });
    expect(rows.find(r => r.name === ".npm")).toMatchObject({ kind: "config", paths: ["~/.npm"], binary: "~/.local/bin/npm", tool: "npm", flags: ["credential"], files: 1 });
    expect(rows.find(r => r.name === ".npmrc")).toMatchObject({ kind: "credential", paths: ["~/.npmrc"], id: ".npmrc" });
    expect(rows.find(r => r.name === ".npm")?.excludes).toEqual(["~/.npm/_cacache"]);
  });

  it("a pair whose first candidate is a credential file keeps one id per row", async () => {
    const m = laptop({ path: ["~/.local/bin"], files: { "~/.local/bin/foo": 1_000, "~/.foo": { text: "token = fake\n", mode: 0o600 }, "~/.local/share/foo/data.db": 200 } });
    const { rows } = await everything(m, { now: NOW });
    const ids = rows.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.find(r => r.name === "foo")).toMatchObject({ id: ".local/share/foo", kind: "config", paths: ["~/.local/share/foo"], tool: "foo", flags: ["credential"] });
    expect(rows.find(r => r.name === ".foo")).toMatchObject({ id: ".foo", kind: "credential" });
  });

  it("a row left with nothing to carry after the fold is dropped", async () => {
    const m = laptop({ files: { "~/.docker/config.json": '{"auths":{"r":{"auth":"x"}}}', "~/.empty/": 0 } });
    const { rows } = await everything(m, { now: NOW });
    expect(rows.map(r => [r.name, r.kind, r.id])).toEqual([[".docker/config.json", "credential", ".docker/config.json"]]);
  });

  it("thirty credential shapes end up flagged with the shipped catalog, and the five look-alikes do not", async () => {
    const { rows } = await everything(laptop(shapes()), { lookup: catalog, now: NOW });
    const flagged = new Set(rows.filter(r => r.flags.includes("credential")).flatMap(r => r.paths));
    const credentialRows = rows.filter(r => r.kind === "credential").map(r => r.paths[0]);
    for (const p of [
      "~/.netrc", "~/.aws", "~/.config/gh/hosts.yml", "~/.config/gcloud/access_tokens.db", "~/.config/gcloud/legacy_credentials", "~/.gcp/service-account-abc.json", "~/.ssh/id_rsa",
      "~/.cloudflared/cert.pem", "~/.codex/auth.json", "~/.gemini/oauth_creds.json", "~/.claude/.credentials.json", "~/.kube/config", "~/.docker/config.json", "~/.pypirc",
      "~/.fly/config.yml", "~/.supabase/access-token", "~/.doppler/.doppler.yaml", "~/.local/share/atuin/key", "~/.secrets", "~/.hermes/.env", "~/.hermes/.env.local", "~/.hermes/auth.json",
      "~/.npmrc", "~/.git-credentials", "~/.config/.wrangler/config/default.toml", "~/Library/Preferences/.wrangler/config/default.toml", "~/.railway/config.json", "~/.gnupg", "~/.password-store",
      "~/.config/monid/credentials.yaml",
    ]) {
      expect(credentialRows, p).toContain(p);
    }
    expect(rows.find(r => r.paths[0] === "~/.aws")).toMatchObject({ name: ".aws", tool: "AWS CLI", kind: "credential" });
    expect(rows.find(r => r.paths[0] === "~/.kube")).toBeUndefined();
    for (const fp of EXPECTED_SHAPES) {
      expect(flagged.has(rel(fp)), fp).toBe(false);
      expect(rows.find(r => r.paths[0] === rel(fp))?.kind ?? "unknown", fp).not.toBe("credential");
    }
    expect(rows.filter(r => r.paths[0]?.startsWith("~/.hfstuff")).map(r => r.flags)).toEqual([[]]);
    expect(rows.find(r => r.paths[0] === "~/.config/raycast")?.flags).toEqual([]);
  });

  it("names that collide render with their parent directory; ids are the path relative to HOME and unique", async () => {
    const { rows } = await everything(laptop(shapes()), { lookup: catalog, now: NOW });
    const names = rows.filter(r => r.paths[0]?.endsWith("/config.json")).map(r => [r.name, r.id]);
    expect(names).toEqual(expect.arrayContaining([[".docker/config.json", ".docker/config.json"], [".railway/config.json", ".railway/config.json"]]));
    const ids = rows.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const deep = await everything(laptop({ files: {
      "~/.config/.wrangler/config/default.toml": 'oauth_token = "x"\n',
      "~/Library/Preferences/.wrangler/config/default.toml": 'oauth_token = "y"\n',
      "~/Library/Application Support/Aside/Default/Sessions/s1": 10,
      "~/Library/Application Support/Chrome/Default/Sessions/s2": 10,
      "~/Library/Application Support/Aside/settings.json": 5,
      "~/Library/Application Support/Chrome/settings.json": 5,
    } }), { now: NOW });
    expect(deep.rows.filter(r => r.name.endsWith("default.toml")).map(r => r.name).sort()).toEqual([".config/.wrangler/config/default.toml", "Preferences/.wrangler/config/default.toml"]);
    expect(deep.rows.filter(r => r.paths[0]?.endsWith("/Sessions")).map(r => [r.name, r.kind])).toEqual([["Aside/Default/Sessions", "app-data"], ["Chrome/Default/Sessions", "app-data"]]);
    const deepNames = deep.rows.map(r => r.name);
    expect(new Set(deepNames).size).toBe(deepNames.length);
    const twice = await everything(laptop({ files: { "~/.npmrc": { text: "//r/:_authToken=x\n", mode: 0o600 }, "~/.glaze/.npmrc": { text: "//r/:_authToken=y\n", mode: 0o600 } } }), { now: NOW });
    expect(twice.rows.filter(r => r.kind === "credential").map(r => [r.name, r.id])).toEqual([[".glaze/.npmrc", ".glaze/.npmrc"], [".npmrc", ".npmrc"]]);
    const fixture = await everything(laptop(home()), { lookup, now: NOW });
    expect(fixture.rows.map(r => r.id)).toEqual(expect.arrayContaining([".config/gh", ".hermes", ".hermes/.env", "bin:node", "bin:omp", "keychain:gh:github.com", ".cache", ".config/raycast/extensions", ".local/lib/node_modules"]));
    expect(new Set(fixture.rows.map(r => r.id)).size).toBe(fixture.rows.length);
  });

  it("paths the other rungs already carry are subtracted, rows and credentials alike, and system binaries own nothing", async () => {
    const claimed = new Set(["~/.zshrc", "~/.ssh", ".config/gh/hosts.yml"]);
    const { rows } = await everything(laptop(home()), { lookup, now: NOW, claimed });
    const paths = rows.flatMap(r => r.paths);
    expect(paths).not.toContain("~/.zshrc");
    expect(paths).not.toContain("~/.ssh");
    expect(paths).not.toContain("~/.ssh/id_ed25519");
    expect(paths).not.toContain("~/.config/gh/hosts.yml");
    expect(rows.filter(r => r.owner === "system")).toEqual([]);
  });

  it("a claimed credential still flags the row that holds it, and what it weighs is taken off", async () => {
    const { rows } = await everything(laptop(home()), { lookup, now: NOW, claimed: new Set([".config/gh/hosts.yml"]) });
    expect(rows.find(r => r.name === "gh")).toMatchObject({ paths: ["~/.config/gh"], flags: ["credential"], bytes: Buffer.byteLength("git_protocol: https\n"), files: 1 });
    expect(rows.some(r => r.paths.includes("~/.config/gh/hosts.yml"))).toBe(false);
  });

  it("a claimed path inside a record, credential or not, is taken off the record's size", async () => {
    const m = (): ReturnType<typeof laptop> => laptop({ files: { "~/.app/settings.json": 100, "~/.app/notes.md": 50, "~/.app/plugins/x/node_modules/a/i.js": 1_000, "~/.app/plugins/y/node_modules/b/i.js": 2_000 } });
    const plain = await everything(m(), { now: NOW });
    expect(plain.rows.find(r => r.paths[0] === "~/.app")).toMatchObject({ bytes: 150, files: 2 });
    const { rows } = await everything(m(), { now: NOW, claimed: new Set(["~/.app/notes.md", "~/.app/plugins/y/node_modules"]) });
    expect(rows.find(r => r.paths[0] === "~/.app")).toMatchObject({ bytes: 100, files: 1, excludes: ["~/.app/notes.md", "~/.app/plugins/x/node_modules", "~/.app/plugins/y/node_modules"] });
    expect(rows.find(r => r.kind === "state")).toMatchObject({ paths: ["~/.app/plugins/x/node_modules"], bytes: 1_000, files: 1 });
  });

  it("a claimed ancestor of a split path drops the split and takes only what the parent counted", async () => {
    const app = (): ReturnType<typeof laptop> => laptop({ files: { "~/.app/settings.json": 100, "~/.app/notes.md": 50, "~/.app/plugins/x/node_modules/a/i.js": 1_000, "~/.app/plugins/y/node_modules/b/i.js": 2_000 } });
    const { rows } = await everything(app(), { now: NOW, claimed: new Set(["~/.app/plugins"]) });
    expect(rows.find(r => r.paths[0] === "~/.app")).toMatchObject({ bytes: 150, files: 2 });
    expect(rows.filter(r => r.kind === "state")).toEqual([]);
    expect(rows.flatMap(r => r.paths).some(p => p.startsWith("~/.app/plugins"))).toBe(false);
    const tool = laptop({ files: { "~/.tool/a.toml": 120, "~/.tool/settings/config.toml": 30, "~/.tool/settings/cache/blob": 5_000 } });
    const cut = await everything(tool, { now: NOW, claimed: new Set(["~/.tool/settings"]) });
    expect(cut.rows.map(r => [r.paths[0], r.kind, r.bytes, r.files])).toEqual([["~/.tool", "unknown", 120, 1]]);
  });

  it("a directory holding only symlinks is a row, not a silent drop", async () => {
    const m = laptop({ links: { "~/.config/stowed/config.toml": "/Users/dev/dotfiles/stowed/config.toml" }, files: { "~/dotfiles/stowed/config.toml": 40 } });
    const { rows } = await everything(m, { now: NOW });
    expect(rows.find(r => r.paths[0] === "~/.config/stowed")).toMatchObject({ name: "stowed", kind: "unknown", bytes: 0, files: 1, measured: "exact" });
  });

  it("nested claimed paths are subtracted once", async () => {
    const m = laptop({ files: { "~/.app/settings.json": 100, "~/.app/sub/file": 100, "~/.app/sub/other": 25 } });
    const { rows } = await everything(m, { now: NOW, claimed: new Set(["~/.app/sub", "~/.app/sub/file"]) });
    expect(rows.find(r => r.paths[0] === "~/.app")).toMatchObject({ bytes: 100, files: 1, excludes: ["~/.app/sub"] });
  });

  it("a lower-bound record with a claimed child is not clamped to a false zero", async () => {
    const m = laptop({ files: { ...many("~/.big/aaa", 6_000), "~/.big/settings.json": 80 } });
    const { rows } = await everything(m, { now: NOW, claimed: new Set(["~/.big/aaa"]) });
    const big = rows.find(r => r.paths[0] === "~/.big");
    expect(big).toBeDefined();
    expect(big?.files === 0 && big?.measured === "lower-bound").toBe(false);
    expect(big?.flags.includes("large") && big?.bytes === 0).toBe(false);
    expect(big?.excludes).toEqual(["~/.big/aaa"]);
  });

  it("a lower-bound record whose claimed child measures more than the walk counted is not measured at all", async () => {
    const files: Record<string, number> = { "~/.big/settings.json": 80 };
    for (let i = 0; i < 5_000; i += 1) files[`~/.big/aaa/f${i}`] = 1;
    for (let i = 0; i < 100; i += 1) files[`~/.big/zzz/f${i}`] = 1_000_000;
    const { rows } = await everything(laptop({ files }), { now: NOW, claimed: new Set(["~/.big/zzz"]) });
    const big = rows.find(r => r.paths[0] === "~/.big");
    expect(big).toMatchObject({ measured: "none", bytes: 0, files: 0, excludes: ["~/.big/zzz"] });
    expect(big?.flags).not.toContain("large");
  });

  it("claimed accepts ~/x, bare x, the absolute path under HOME, a trailing slash and a Keychain item, and refuses anything else", async () => {
    for (const form of ["~/.ssh", ".ssh", `${HOME}/.ssh`, "~/.ssh/", ".ssh/", `${HOME}/.ssh/`]) {
      const { rows } = await everything(laptop(home()), { now: NOW, claimed: new Set([form]) });
      expect(rows.flatMap(r => r.paths).some(p => p === "~/.ssh" || p.startsWith("~/.ssh/")), form).toBe(false);
    }
    const kc = await everything(laptop(home()), { now: NOW, claimed: new Set(["Keychain: gh:github.com", "keychain:Raycast"]) });
    expect(kc.rows.filter(r => r.kind === "device-bound-login").map(r => r.name)).toEqual(["github.com", "glab:gitlab.com:token"]);
    for (const bad of ["", "~", "/etc/passwd", "/Users/other/.ssh"]) {
      await expect(everything(laptop(home()), { now: NOW, claimed: new Set([bad]) }), bad).rejects.toThrow(/claimed/);
    }
  });

  it("a symlinked dotfile or config directory is a row under the link path that says where it points", async () => {
    const { rows } = await everything(laptop(home()), { now: NOW });
    expect(rows.find(r => r.name === "nvim")).toMatchObject({ paths: ["~/.config/nvim"], linkTarget: "~/dotfiles/nvim", bytes: 500, files: 1 });
    expect(rows.find(r => r.name === ".tmux.conf")).toMatchObject({ paths: ["~/.tmux.conf"], linkTarget: "~/dotfiles/tmux.conf", bytes: 300, files: 1 });
  });

  it("the spec cache and state roots are not measured; a capped root is a lower bound and large", async () => {
    const { rows } = await everything(laptop({ ...home(), files: { ...home().files, ...many("~/.big", 6_000) } }), { now: NOW });
    expect(rows.find(r => r.paths[0] === "~/.cache")).toMatchObject({ measured: "none", bytes: 0, files: 0, flags: [] });
    expect(rows.find(r => r.paths[0] === "~/Library/Caches")).toMatchObject({ measured: "none" });
    expect(rows.find(r => r.paths[0] === "~/.local/state")).toMatchObject({ measured: "none" });
    expect(rows.find(r => r.paths[0] === "~/.big")).toMatchObject({ measured: "lower-bound", flags: expect.arrayContaining(["large"]) });
    expect(rows.find(r => r.name === "gh")?.measured).toBe("exact");
  });

  it("a credential walk that hits its cap says so: a note and the partial flag, never a silent miss", async () => {
    const m = laptop({ files: { ...many("~/.ssh/known", 5_100), "~/.ssh/id_rsa": { text: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n", mode: 0o600 } } });
    const { rows, notes } = await everything(m, { now: NOW });
    expect(notes).toContain("credential scan of ~/.ssh stopped at the cap");
    expect(rows.find(r => r.paths[0] === "~/.ssh")?.flags).toEqual(expect.arrayContaining(["partial", "large"]));
    expect(rows.filter(r => r.flags.includes("partial"))).toHaveLength(1);
    const quiet = await everything(laptop(home()), { now: NOW });
    expect(quiet.notes.some(n => n.includes("stopped at the cap"))).toBe(false);
  });

  it("a broken top-level link is a note, not silence", async () => {
    const { notes } = await everything(laptop(home()), { now: NOW });
    expect(notes).toEqual(["~/.broken is a broken symlink and is not listed"]);
  });

  it("the catalog names a directory and says which of its files are credentials; a no-op lookup leaves that undone", async () => {
    const named = await everything(laptop(home()), { lookup, now: NOW });
    expect(named.rows.find(r => r.paths[0] === "~/.config/monid")).toBeUndefined();
    expect(named.rows.find(r => r.paths[0] === "~/.config/monid/credentials.yaml")).toMatchObject({ kind: "credential", flags: ["credential"] });
    expect(named.rows.find(r => r.paths[0] === "~/.kube/config")).toMatchObject({ name: ".kube/config", kind: "credential", flags: ["credential"] });
    expect(named.rows.find(r => r.paths[0] === "~/.kube")).toBeUndefined();
    const withConfig = await everything(laptop({ ...home(), files: { ...home().files, "~/.config/monid/config.toml": "x = 1\n" } }), { lookup, now: NOW });
    expect(withConfig.rows.find(r => r.paths[0] === "~/.config/monid")).toMatchObject({ name: "monid", tool: "Monid", kind: "config", flags: ["credential"], files: 1 });
    const plain = await everything(laptop(home()), { now: NOW });
    expect(plain.rows.find(r => r.paths[0] === "~/.kube")).toMatchObject({ name: ".kube", kind: "unknown", flags: [] });
  });

  it("the shell pass rides along as names only, and notes carry what was skipped", async () => {
    const { shell, rows } = await everything(laptop(home()), { now: NOW });
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/.zshrc", ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]]]);
    expect(JSON.stringify({ shell, rows })).not.toContain("redacted");
    expect(JSON.stringify(rows)).not.toContain("Keychains");
    expect(JSON.stringify(rows)).not.toContain("Safe Storage");
    expect(JSON.stringify(rows)).not.toContain("AirPort");
  });

  it("rows validate against the schema", async () => {
    const { rows } = await everything(laptop(home()), { now: NOW });
    expect(() => Rows.parse(rows)).not.toThrow();
  });
});
