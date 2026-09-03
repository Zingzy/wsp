// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { detectLogins } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

describe("logins", () => {
  it.each([
    ["gh with its token in hosts.yml", "darwin", { "~/.config/gh/hosts.yml": 200 }, {}, "logins/gh", ["~/.config/gh/hosts.yml"], "bring"],
    ["gcloud", "darwin", { "~/.config/gcloud/credentials.db": 4000, "~/.config/gcloud/configurations/config_default": 50, "~/.config/gcloud/logs/x.log": 9999 }, {}, "logins/gcloud", ["~/.config/gcloud/credentials.db", "~/.config/gcloud/configurations"], "bring"],
    ["wrangler on macOS", "darwin", { "~/Library/Preferences/.wrangler/config/default.toml": 300 }, {}, "logins/wrangler", ["~/Library/Preferences/.wrangler/config/default.toml"], "bring"],
    ["wrangler on Linux", "linux", { "~/.config/.wrangler/config/default.toml": 300 }, {}, "logins/wrangler", ["~/.config/.wrangler/config/default.toml"], "bring"],
    ["cloudflared", "darwin", { "~/.cloudflared/cert.pem": 800 }, {}, "logins/cloudflared", ["~/.cloudflared/cert.pem"], "bring"],
    ["vercel on macOS", "darwin", { "~/Library/Application Support/com.vercel.cli/auth.json": 100 }, {}, "logins/vercel", ["~/Library/Application Support/com.vercel.cli/auth.json"], "bring"],
    ["vercel on Linux", "linux", { "~/.config/com.vercel.cli/auth.json": 100 }, {}, "logins/vercel", ["~/.config/com.vercel.cli/auth.json"], "bring"],
    ["aws", "darwin", { "~/.aws/credentials": 120, "~/.aws/config": 300, "~/.aws/sso/cache/x.json": 900 }, {}, "logins/aws", ["~/.aws/credentials", "~/.aws/config"], "bring"],
    ["kubectl", "darwin", { "~/.kube/config": 6000 }, {}, "logins/kube", ["~/.kube/config"], "bring"],
    ["Claude Code on Linux", "linux", { "~/.claude/.credentials.json": 800 }, {}, "logins/claude", ["~/.claude/.credentials.json"], "skip"],
    ["Codex", "darwin", { "~/.codex/auth.json": 900 }, {}, "logins/codex", ["~/.codex/auth.json"], "bring"],
    ["Gemini CLI", "darwin", { "~/.gemini/oauth_creds.json": 500 }, {}, "logins/gemini", ["~/.gemini/oauth_creds.json"], "bring"],
    ["OpenCode", "darwin", { "~/.local/share/opencode/auth.json": 200 }, {}, "logins/opencode", ["~/.local/share/opencode/auth.json"], "bring"],
    ["Pi", "darwin", { "~/.pi/agent/auth.json": 900, "~/.pi/agent/settings.json": 80 }, {}, "logins/pi", ["~/.pi/agent/auth.json"], "bring"],
    ["Hermes Agent", "darwin", { "~/.hermes/.env": 25_000, "~/.hermes/auth.json": 400, "~/.hermes/config.yaml": 600 }, {}, "logins/hermes", ["~/.hermes/.env", "~/.hermes/auth.json"], "bring"],
  ])("%s", async (_name, platform, files, exec, id, paths, dflt) => {
    const rows = await detectLogins(fakeHost({ platform: platform === "linux" ? "linux" : "darwin", files, exec }));
    expect(rows).toEqual([{ rung: "logins", id, label: expect.any(String), group: expect.any(String), paths, bytes: expect.any(Number), default: dflt }]);
  });

  it("Claude Code on macOS is a Keychain item: presence only, sign in on the machine by default", async () => {
    const host = fakeHost({ exec: { 'security find-generic-password -s Claude Code-credentials': "keychain: ...\n" } });
    const rows = await detectLogins(host);
    expect(rows).toEqual([
      { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: ["Keychain: Claude Code-credentials"], bytes: 0, default: "skip" },
    ]);
  });

  it("gh with its token in the macOS Keychain carries that item as a second path and still defaults to copy", async () => {
    const host = fakeHost({ files: { "~/.config/gh/hosts.yml": 200 }, exec: { "security find-generic-password -s gh:github.com": "keychain: ...\n" } });
    const rows = await detectLogins(host);
    expect(rows).toEqual([
      { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], bytes: 200, default: "bring" },
    ]);
  });

  it.each([
    ["gh with its token in the Keychain", { "~/.config/gh/hosts.yml": 200 }, { "security find-generic-password -s gh:github.com": "keychain: ...\n" }, "GitHub CLI login", undefined],
    ["aws", { "~/.aws/credentials": 120, "~/.aws/config": 300 }, {}, "AWS keys and profiles", undefined],
  ])("%s is labelled by name; any sentence about it is a detail, not part of the label", async (_name, files, exec, label, reason) => {
    const [row] = await detectLogins(fakeHost({ files, exec }));
    expect(row?.label).toBe(label);
    expect(row?.reason).toBe(reason);
    expect(row?.label).not.toMatch(/[()]/);
    expect(row?.label.length).toBeLessThanOrEqual(40);
  });

  it("1Password CLI is listed locked off", async () => {
    const rows = await detectLogins(fakeHost({ which: ["op"] }));
    expect(rows).toEqual([
      { rung: "logins", id: "logins/op", label: "1Password CLI", group: "CLI logins", paths: [], bytes: 0, default: "skip", reason: "needs the 1Password desktop app; the machine uses a service account token" },
    ]);
  });

  it("never reads a login file and never asks the Keychain for a secret", async () => {
    const host = fakeHost({
      files: { "~/.config/gh/hosts.yml": "oauth_token: x", "~/.codex/auth.json": "{}", "~/.aws/credentials": "k", "~/.hermes/.env": "ANTHROPIC_API_KEY=sk-ant-x", "~/.pi/agent/auth.json": "{}" },
      exec: { 'security find-generic-password -s Claude Code-credentials': "x" },
    });
    await detectLogins(host);
    expect(host.calls.filter(c => c.startsWith("read"))).toEqual([]);
    expect(host.calls.filter(c => c.includes(" -w"))).toEqual([]);
  });

  it("no logins on an empty laptop", async () => {
    expect(await detectLogins(fakeHost())).toEqual([]);
  });
});
