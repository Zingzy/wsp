// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { GITLEAKS_MAX_ROOTS, credentials, keysSignal, modeSignal, nameSignal, parseGitleaks, pemSignal, roles, topLevelKeys } from "../../src/index.js";
import { EXPECTED_SHAPES, HOME, home, laptop, shapes } from "./fixture.js";

const rel = (p: string): string => p.replace(HOME, "~");
const gitleaksArgs = (root: string): string => `gitleaks dir ${root} --redact --no-banner --exit-code 0 --report-format json --report-path /dev/stdout`;

describe("pass 4: credential shape", () => {
  it("over the fixture: flags by name, mode, key names and PEM header; skips .example, .pub, git work trees and cache subtrees", async () => {
    const m = laptop(home());
    const { found } = await credentials(m, await roles(m));
    expect(found.map(c => [rel(c.path), c.signals])).toEqual([
      ["~/.cache/huggingface/token", ["name", "mode"]],
      ["~/.config/gh/hosts.yml", ["name", "mode", "keys"]],
      ["~/.config/monid/credentials.yaml", ["name", "mode", "keys"]],
      ["~/.hermes/.env", ["name", "keys"]],
      ["~/.hermes/auth.json", ["name", "keys"]],
      ["~/.netrc", ["name", "mode"]],
      ["~/.ssh/id_ed25519", ["name", "mode", "pem"]],
    ]);
    expect(found.find(c => c.path.endsWith("hosts.yml"))).toMatchObject({ mode: 0o600, files: 1, bytes: Buffer.byteLength("github.com:\n    user: dev\n    oauth_token: redacted\n") });
  });

  it("thirty shapes: every real credential file is found by the pass alone except the two only the catalog knows", async () => {
    const m = laptop(shapes());
    const { found } = await credentials(m, await roles(m));
    const paths = found.map(c => rel(c.path));
    const real = [
      "~/.netrc", "~/.aws/credentials", "~/.config/gh/hosts.yml", "~/.config/gcloud/access_tokens.db", "~/.config/gcloud/legacy_credentials/dev@example.com/.boto",
      "~/.gcp/service-account-abc.json", "~/.ssh/id_rsa", "~/.cloudflared/cert.pem", "~/.codex/auth.json", "~/.gemini/oauth_creds.json", "~/.claude/.credentials.json",
      "~/.docker/config.json", "~/.pypirc", "~/.fly/config.yml", "~/.supabase/access-token", "~/.doppler/.doppler.yaml", "~/.local/share/atuin/key", "~/.secrets",
      "~/.hermes/.env", "~/.hermes/.env.local", "~/.hermes/auth.json", "~/.npmrc", "~/.git-credentials", "~/.config/.wrangler/config/default.toml",
      "~/Library/Preferences/.wrangler/config/default.toml", "~/.railway/config.json", "~/.gnupg", "~/.password-store", "~/.config/monid/credentials.yaml",
    ];
    expect(real.filter(p => !paths.includes(p))).toEqual([]);
    expect(paths).not.toContain("~/.kube/config");
    for (const fp of EXPECTED_SHAPES) expect(paths).not.toContain(rel(fp));
    expect(paths.filter(p => p.startsWith("~/.gnupg/") || p.startsWith("~/.password-store/"))).toEqual([]);
    expect(found.find(c => c.path.endsWith(".gnupg"))).toMatchObject({ files: 2, signals: ["name"] });
  });

  it("mode on its own is not believed once the content parsed as plain config, and never for a file without a real extension", async () => {
    const m = laptop(home());
    const { found } = await credentials(m, await roles(m));
    const paths = found.map(c => rel(c.path));
    expect(paths).not.toContain("~/.kube/config");
    expect(paths).not.toContain("~/.config/raycast/config.json");
    expect(paths).not.toContain("~/.mcp-auth/mcp-remote-0.1/abc_client_info.json");
    expect(paths).not.toContain("~/.jcode/state.active");
    expect(paths).not.toContain("~/.viminfo");
    expect(paths).not.toContain("~/.ssh/known_hosts");
  });

  it("reads only small files of a shape worth checking, never the state or cache subtrees, nor the whole-directory credentials", async () => {
    const m = laptop(shapes());
    await credentials(m, await roles(m));
    const reads = m.calls.filter(c => c.startsWith("read ")).map(c => rel(c.slice(5)));
    expect(reads).not.toContain("~/.hfstuff/tokenizer.json");
    expect(reads.some(r => r.startsWith("~/.gnupg/") || r.startsWith("~/.password-store/"))).toBe(false);
    expect(reads.some(r => r.includes("node_modules"))).toBe(false);
    const fixture = laptop(home());
    await credentials(fixture, await roles(fixture));
    const fixtureReads = fixture.calls.filter(c => c.startsWith("read ")).map(c => rel(c.slice(5)));
    expect(fixtureReads).not.toContain("~/.oh-my-zsh/credentials.json");
    expect(fixtureReads).not.toContain("~/.hermes/.env.example");
    expect(fixtureReads).not.toContain("~/.zsh_history");
  });

  it("name patterns: token and secret as whole words, env files, npmrc, pypirc, git-credentials, dotted credentials", () => {
    const yes = ["credentials.db", ".credentials.json", "auth.json", "hosts.yml", "access-token", "server.pem", "atuin.key", "key", "id_rsa", ".netrc", "token.txt", "my_secret", "stored_tokens", "access_tokens.db", ".secrets", ".env", ".env.local", ".env.production", ".npmrc", ".pypirc", ".git-credentials", "7a66_tokens.json", "client_secret.json"];
    expect(yes.map(nameSignal)).toEqual(Array<boolean>(yes.length).fill(true));
    const no = ["credentials.go", "auth.json.example", "id_rsa.pub", "token.ts", "config.yml", "settings.json", "README.md", "tokenizer.json", "tokenizer_config.json", "known_hosts", ".viminfo", ".CFUserTextEncoding", ".z", "zsh_history", ".env.example", ".envrc", "secretary.txt"];
    expect(no.map(nameSignal)).toEqual(Array<boolean>(no.length).fill(false));
  });

  it("mode: owner-only and under 100 KB, never empty", () => {
    const e = { kind: "file" as const, mtime: 0 };
    expect(modeSignal({ ...e, mode: 0o600, bytes: 100 })).toBe(true);
    expect(modeSignal({ ...e, mode: 0o400, bytes: 100 })).toBe(true);
    expect(modeSignal({ ...e, mode: 0o644, bytes: 100 })).toBe(false);
    expect(modeSignal({ ...e, mode: 0o600, bytes: 0 })).toBe(false);
    expect(modeSignal({ ...e, mode: 0o600, bytes: 200 * 1024 })).toBe(false);
  });

  it("key names at any depth of JSON, YAML, TOML and KEY=value files", () => {
    expect(topLevelKeys('{"token":"x","user":{"password":"y"}}')).toEqual(["token", "user", "password"]);
    expect(topLevelKeys("github.com:\n    oauth_token: x\nclient-secret: y\n")).toEqual(["github.com", "oauth_token", "client-secret"]);
    expect(topLevelKeys('[registry]\napi_key = "x"\n')).toEqual(["api_key"]);
    expect(topLevelKeys("//registry.npmjs.org/:_authToken=x\nregistry=https://r\n")).toEqual(["_authToken", "registry"]);
    expect(topLevelKeys('// settings\n{\n  "theme": "dark",\n  "vim_mode": true,\n}\n')).toEqual(["theme", "vim_mode"]);
    expect(keysSignal('{"access_token":"x"}')).toBe(true);
    expect(keysSignal("client-secret: y\n")).toBe(true);
    expect(keysSignal('{"claudeAiOauth":{"accessToken":"x"}}')).toBe(true);
    expect(keysSignal('{"auths":{}}')).toBe(true);
    expect(keysSignal("ANTHROPIC_API_KEY=sk-x\n")).toBe(true);
    expect(keysSignal("//registry.npmjs.org/:_authToken=x\n")).toBe(true);
    expect(keysSignal('{"theme":"dark","editor":{"fontSize":13}}')).toBe(false);
    expect(keysSignal('{"model_max_length":512}')).toBe(false);
    expect(keysSignal('{"os_crypt":{"encrypted_key":"x"},"sort_key":1,"max_tokens":3,"key":"pub"}')).toBe(false);
    expect(keysSignal("sort_key=46\nhide_kernel_threads=1\n")).toBe(false);
    expect(keysSignal('{"packages":{"node_modules/password-prompt":{"version":"1"}}}')).toBe(false);
    expect(keysSignal('["token"]')).toBe(false);
  });

  it("PEM header", () => {
    expect(pemSignal("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n")).toBe(true);
    expect(pemSignal("-----BEGIN RSA PRIVATE KEY-----\n")).toBe(true);
    expect(pemSignal("-----BEGIN CERTIFICATE-----\n")).toBe(false);
    expect(pemSignal("ssh-ed25519 AAAA\n")).toBe(false);
  });

  it("gitleaks runs once per small unknown root only when present, redacted, and adds a signal by file", async () => {
    const report = JSON.stringify([{ RuleID: "generic-api-key", File: `${HOME}/.config/monid/credentials.yaml`, Secret: "REDACTED" }, { RuleID: "aws-access-token", File: "settings.json", Secret: "REDACTED" }]);
    const base = home();
    const m = laptop({
      ...base,
      which: [...(base.which ?? []), "gitleaks"],
      files: { ...base.files, "~/.config/other/settings.json": '{"region":"eu"}' },
      exec: { ...base.exec, [gitleaksArgs(`${HOME}/.config/monid`)]: report, [gitleaksArgs(`${HOME}/.config/other`)]: report },
    });
    const { found, notes } = await credentials(m, await roles(m));
    expect(found.find(c => c.path.endsWith("credentials.yaml"))?.signals).toEqual(["name", "mode", "keys", "gitleaks"]);
    expect(found.find(c => c.path === `${HOME}/.config/other/settings.json`)?.signals).toEqual(["gitleaks"]);
    expect(notes).toEqual([]);
    const runs = m.calls.filter(c => c.startsWith("run gitleaks"));
    expect(runs.every(c => c.includes("--redact"))).toBe(true);
    const scanned = runs.map(c => rel(c.split(" ")[3] ?? ""));
    expect(scanned).toContain("~/.config/monid");
    expect(scanned).toContain("~/.config/other");
    expect(scanned).not.toContain("~/.hermes/node_modules");
    expect(scanned).not.toContain("~/.cache");
    expect(scanned).not.toContain("~/.config/raycast/extensions");
    expect(scanned).not.toContain("~/.gnupg");
    expect(scanned).not.toContain("~/.hermes");

    const without = laptop(home());
    await credentials(without, await roles(without));
    expect(without.calls.some(c => c.startsWith("run gitleaks"))).toBe(false);
    expect([...parseGitleaks("not json")]).toEqual([]);
  });

  it("gitleaks skips a large root and is skipped altogether, with a note, above the root cap", async () => {
    const large = laptop({ which: ["gitleaks"], files: { "~/.huge/blob": 2_000_000, "~/.tiny/a.txt": "x\n" } });
    await credentials(large, await roles(large));
    expect(large.calls.filter(c => c.startsWith("run gitleaks")).map(c => rel(c.split(" ")[3] ?? ""))).toEqual(["~/.tiny"]);

    const files: Record<string, string> = {};
    for (let i = 0; i <= GITLEAKS_MAX_ROOTS; i += 1) files[`~/.tool${String(i).padStart(3, "0")}/config.toml`] = "x = 1\n";
    const crowded = laptop({ which: ["gitleaks"], files });
    const { notes } = await credentials(crowded, await roles(crowded));
    expect(crowded.calls.some(c => c.startsWith("run gitleaks"))).toBe(false);
    expect(notes).toEqual([`gitleaks skipped: ${GITLEAKS_MAX_ROOTS + 1} candidate roots, the cap is ${GITLEAKS_MAX_ROOTS}`]);
  });
});
