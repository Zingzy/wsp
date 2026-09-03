// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { type CatalogPath, type Lookup, Rows, everything, lookup as catalog } from "../../src/index.js";
import { EXPECTED_SHAPES, HOME, NOW, RECENT, home, laptop, many, shapes } from "./fixture.js";

const rel = (p: string): string => p.replace(HOME, "~");
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
      [".cargo", "unknown", "large", "", "~/.cargo"],
      [".CFUserTextEncoding", "unknown", "", "", "~/.CFUserTextEncoding"],
      [".env", "credential", "credential", "", "~/.hermes/.env"],
      [".hermes", "state", "", "", "~/.hermes/node_modules"],
      [".jcode", "unknown", "", "", "~/.jcode"],
      [".mcp-auth", "unknown", "", "", "~/.mcp-auth"],
      [".netrc", "credential", "credential", "", "~/.netrc"],
      [".nix-profile", "unknown", "", "", "~/.nix-profile"],
      [".oh-my-zsh", "unknown", "", "", "~/.oh-my-zsh"],
      [".oh-my-zsh/.git", "state", "", "", "~/.oh-my-zsh/.git"],
      [".oldtool", "unknown", "stale", "", "~/.oldtool"],
      [".rustup", "unknown", "", "", "~/.rustup"],
      [".rustup/toolchains", "state", "large", "", "~/.rustup/toolchains"],
      [".ssh", "unknown", "credential", "", "~/.ssh"],
      [".tmux.conf", "unknown", "", "", "~/.tmux.conf"],
      [".viminfo", "unknown", "", "", "~/.viminfo"],
      [".zsh_history", "state", "", "", "~/.zsh_history"],
      [".zsh_sessions", "state", "", "", "~/.zsh_sessions"],
      [".zshrc", "unknown", "", "", "~/.zshrc"],
      ["auth.json", "credential", "credential", "", "~/.hermes/auth.json"],
      ["Caches", "cache", "", "", "~/Library/Caches"],
      ["Code", "unknown", "", "", "~/Library/Application Support/Code"],
      ["com.googlecode.iterm2.plist", "unknown", "", "", "~/Library/Preferences/com.googlecode.iterm2.plist"],
      ["config", "credential", "credential", "", "~/.kube/config"],
      ["credentials.yaml", "credential", "credential", "", "~/.config/monid/credentials.yaml"],
      ["gh", "config", "credential", "homebrew", "~/.config/gh"],
      ["gh:github.com", "device-bound-login", "", "gh", ""],
      ["github.com", "device-bound-login", "", "", ""],
      ["glab:gitlab.com:token", "device-bound-login", "", "", ""],
      ["hermes", "config", "credential+large", "", "~/.hermes"],
      ["hosts.yml", "credential", "credential", "homebrew", "~/.config/gh/hosts.yml"],
      ["id_ed25519", "credential", "credential", "", "~/.ssh/id_ed25519"],
      ["kubectl", "config", "credential", "", "~/.kube"],
      ["lib", "unknown", "", "", "~/.local/lib"],
      ["lib/node_modules", "state", "", "", "~/.local/lib/node_modules"],
      ["mise", "unknown", "", "", "~/.local/share/mise"],
      ["Monid", "config", "credential", "", "~/.config/monid"],
      ["node", "unknown", "", "", ""],
      ["nvim", "unknown", "", "", "~/.config/nvim"],
      ["omp", "unknown", "", "", ""],
      ["raycast", "unknown", "", "", "~/.config/raycast"],
      ["Raycast", "device-bound-login", "", "", ""],
      ["raycast/extensions", "state", "large", "", "~/.config/raycast/extensions"],
      ["state", "state", "", "", "~/.local/state"],
      ["token", "credential", "credential", "", "~/.cache/huggingface/token"],
      ["uv", "unknown", "large", "", "~/.local/share/uv"],
    ]);
  });

  it("a pair is one row whose paths are the config side only and whose size is what the credential pass left in it", async () => {
    const { rows } = await everything(laptop(home()), { lookup, now: NOW });
    expect(rows.find(r => r.name === "gh")).toEqual({ id: ".config/gh", name: "gh", kind: "config", paths: ["~/.config/gh"], bytes: Buffer.byteLength("git_protocol: https\n"), files: 1, mtime: RECENT, measured: "exact", owner: "homebrew", flags: ["credential"], ticked: false });
    const hermes = rows.find(r => r.name === "hermes");
    expect(hermes).toMatchObject({ id: ".hermes", paths: ["~/.hermes"], binary: "~/.local/bin/hermes", files: 3, bytes: 90_000_000 + Buffer.byteLength("HERMES_TOKEN=put-yours-here\n") + Buffer.byteLength("model: default\n") });
  });

  it("a binary nobody installed by recipe is a row with no paths and the binary named, never something to copy", async () => {
    const { rows } = await everything(laptop(home()), { now: NOW });
    expect(rows.find(r => r.name === "node")).toEqual({ id: "bin:node", name: "node", kind: "unknown", paths: [], binary: "~/.local/bin/node", bytes: 0, files: 0, mtime: RECENT, measured: "exact", flags: [], ticked: false });
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
    const hermes = rows.find(r => r.name === "hermes");
    const state = rows.find(r => r.kind === "state");
    const env = rows.find(r => r.name === ".env");
    expect(hermes).toMatchObject({ kind: "config", flags: [], bytes: Buffer.byteLength("model: default\n"), files: 1 });
    expect(state).toMatchObject({ paths: ["~/.hermes/node_modules"], flags: ["credential"], bytes: 0, files: 0 });
    expect(env).toMatchObject({ kind: "credential", paths: ["~/.hermes/node_modules/x/.env"], id: ".hermes/node_modules/x/.env" });
    expect(rows.every(r => r.bytes >= 0 && r.files >= 0)).toBe(true);
  });

  it("a credential rc file paired with its binary is split from the pair, not the pair turned into a credential", async () => {
    const m = laptop({ path: ["~/.local/bin"], files: { "~/.local/bin/npm": 1_000, "~/.npm/_cacache/x": 500, "~/.npm/npmrc-notes.md": 10, "~/.npmrc": { text: "//registry.npmjs.org/:_authToken=npm_fake\n", mode: 0o600 } } });
    const { rows } = await everything(m, { now: NOW });
    expect(rows.find(r => r.name === "npm")).toMatchObject({ kind: "config", paths: ["~/.npm"], binary: "~/.local/bin/npm", flags: ["credential"], files: 1 });
    expect(rows.find(r => r.name === ".npmrc")).toMatchObject({ kind: "credential", paths: ["~/.npmrc"], id: ".npmrc" });
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
    expect(rows.find(r => r.paths[0] === "~/.aws")).toMatchObject({ name: "AWS CLI", kind: "credential" });
    expect(rows.find(r => r.paths[0] === "~/.kube")).toMatchObject({ name: "kubectl", kind: "config", flags: ["credential"], bytes: 0, files: 0 });
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
    expect(rows.find(r => r.name === "gh")).toMatchObject({ paths: ["~/.config/gh"], flags: [] });
    expect(rows.filter(r => r.owner === "system")).toEqual([]);
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
    expect(rows.find(r => r.paths[0] === "~/.big")).toMatchObject({ measured: "lower-bound", flags: ["large"] });
    expect(rows.find(r => r.name === "gh")?.measured).toBe("exact");
  });

  it("the catalog names a directory and says which of its files are credentials; a no-op lookup leaves that undone", async () => {
    const named = await everything(laptop(home()), { lookup, now: NOW });
    expect(named.rows.find(r => r.paths[0] === "~/.config/monid")).toMatchObject({ name: "Monid", kind: "config", flags: ["credential"], bytes: 0, files: 0 });
    expect(named.rows.find(r => r.paths[0] === "~/.kube/config")).toMatchObject({ name: "config", kind: "credential", flags: ["credential"] });
    const plain = await everything(laptop(home()), { now: NOW });
    expect(plain.rows.find(r => r.paths[0] === "~/.config/monid")).toMatchObject({ name: "monid", kind: "unknown", flags: ["credential"] });
    expect(plain.rows.find(r => r.paths[0] === "~/.kube")).toMatchObject({ name: ".kube", kind: "unknown", flags: [] });
  });

  it("the shell pass rides along as names only, and notes carry what was skipped", async () => {
    const { shell, rows, notes } = await everything(laptop(home()), { now: NOW });
    expect(shell.map(s => [s.path, s.names])).toEqual([["~/.zshrc", ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]]]);
    expect(notes).toEqual([]);
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
