// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { credentials, keysSignal, modeSignal, nameSignal, parseGitleaks, pemSignal, roles, topLevelKeys } from "../../src/index.js";
import { HOME, home, laptop } from "./fixture.js";

const rel = (p: string): string => p.replace(HOME, "~");

describe("pass 4: credential shape", () => {
  it("over the fixture: flags by name, mode, key names and PEM header; skips .example, .pub, git work trees and cache subtrees", async () => {
    const m = laptop(home());
    const found = await credentials(m, await roles(m));
    expect(found.map(c => [rel(c.path), c.signals])).toEqual([
      ["~/.cache/huggingface/token", ["name", "mode"]],
      ["~/.config/gh/hosts.yml", ["name", "mode"]],
      ["~/.config/monid/credentials.yaml", ["name", "mode", "keys"]],
      ["~/.hermes/auth.json", ["name", "keys"]],
      ["~/.kube/config", ["mode"]],
      ["~/.netrc", ["name", "mode"]],
      ["~/.ssh/id_ed25519", ["name", "mode", "pem"]],
    ]);
    expect(found.find(c => c.path.endsWith("hosts.yml"))).toMatchObject({ mode: 0o600, bytes: Buffer.byteLength("github.com:\n    user: dev\n    oauth_token: redacted\n") });
  });

  it("mode on its own counts right inside the app directory with a credential-shaped extension, not deeper and not for markers", async () => {
    const m = laptop(home());
    const paths = (await credentials(m, await roles(m))).map(c => rel(c.path));
    expect(paths).toContain("~/.kube/config");
    expect(paths).not.toContain("~/.mcp-auth/mcp-remote-0.1/abc_client_info.json");
    expect(paths).not.toContain("~/.jcode/state.active");
  });

  it("reads only small files of a shape worth checking, never the state or cache subtrees", async () => {
    const m = laptop(home());
    await credentials(m, await roles(m));
    const reads = m.calls.filter(c => c.startsWith("read ")).map(c => rel(c.slice(5)));
    expect(reads).not.toContain("~/.oh-my-zsh/credentials.json");
    expect(reads).not.toContain("~/.hermes/.env.example");
    expect(reads).not.toContain("~/.zsh_history");
    expect(reads.some(r => r.includes("node_modules"))).toBe(false);
  });

  it("name patterns", () => {
    expect(["credentials.db", "auth.json", "hosts.yml", "access-token", "server.pem", "id_rsa", ".netrc", "token.txt", "my_secret", "stored_tokens"].map(nameSignal)).toEqual(Array<boolean>(10).fill(true));
    expect(["credentials.go", "auth.json.example", "id_rsa.pub", "token.ts", "config.yml", "settings.json", "README.md"].map(nameSignal)).toEqual(Array<boolean>(7).fill(false));
  });

  it("mode: owner-only and under 100 KB, never empty", () => {
    const e = { kind: "file" as const, mtime: 0 };
    expect(modeSignal({ ...e, mode: 0o600, bytes: 100 })).toBe(true);
    expect(modeSignal({ ...e, mode: 0o400, bytes: 100 })).toBe(true);
    expect(modeSignal({ ...e, mode: 0o644, bytes: 100 })).toBe(false);
    expect(modeSignal({ ...e, mode: 0o600, bytes: 0 })).toBe(false);
    expect(modeSignal({ ...e, mode: 0o600, bytes: 200 * 1024 })).toBe(false);
  });

  it("key names at the top of JSON, YAML and TOML", () => {
    expect(topLevelKeys('{"token":"x","user":{"password":"y"}}')).toEqual(["token", "user"]);
    expect(topLevelKeys("github.com:\n    oauth_token: x\nclient-secret: y\n")).toEqual(["github.com", "client-secret"]);
    expect(topLevelKeys('[registry]\napi_key = "x"\n')).toEqual(["api_key"]);
    expect(keysSignal('{"access_token":"x"}')).toBe(true);
    expect(keysSignal("client-secret: y\n")).toBe(true);
    expect(keysSignal('{"theme":"dark"}')).toBe(false);
    expect(keysSignal('["token"]')).toBe(false);
  });

  it("PEM header", () => {
    expect(pemSignal("-----BEGIN OPENSSH PRIVATE KEY-----\nx\n")).toBe(true);
    expect(pemSignal("-----BEGIN RSA PRIVATE KEY-----\n")).toBe(true);
    expect(pemSignal("-----BEGIN CERTIFICATE-----\n")).toBe(false);
    expect(pemSignal("ssh-ed25519 AAAA\n")).toBe(false);
  });

  it("gitleaks runs only when present, redacted, and adds a signal by file", async () => {
    const report = JSON.stringify([{ RuleID: "generic-api-key", File: `${HOME}/.config/monid/credentials.yaml`, Secret: "REDACTED" }, { RuleID: "aws-access-token", File: `${HOME}/.config/other/settings.json`, Secret: "REDACTED" }]);
    const base = home();
    const m = laptop({
      ...base,
      which: [...(base.which ?? []), "gitleaks"],
      files: { ...base.files, "~/.config/other/settings.json": '{"region":"eu"}' },
      exec: { ...base.exec, [`gitleaks dir ${HOME}/.config/monid --redact --no-banner --exit-code 0 --report-format json --report-path /dev/stdout`]: report, [`gitleaks dir ${HOME}/.config/other --redact --no-banner --exit-code 0 --report-format json --report-path /dev/stdout`]: report },
    });
    const found = await credentials(m, await roles(m));
    expect(found.find(c => c.path.endsWith("credentials.yaml"))?.signals).toEqual(["name", "mode", "keys", "gitleaks"]);
    expect(found.find(c => c.path.endsWith("settings.json"))?.signals).toEqual(["gitleaks"]);
    expect(m.calls.filter(c => c.startsWith("run gitleaks")).every(c => c.includes("--redact"))).toBe(true);

    const without = laptop(home());
    await credentials(without, await roles(without));
    expect(without.calls.some(c => c.startsWith("run gitleaks"))).toBe(false);
    expect([...parseGitleaks("not json")]).toEqual([]);
  });
});
