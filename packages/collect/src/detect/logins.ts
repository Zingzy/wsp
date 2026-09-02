// SPDX-License-Identifier: AGPL-3.0-only
// Logins are presence only: a path is stat'ed, a Keychain item is looked up
// by service name without -w, and no file under this rung is ever read.
import type { Host, Platform } from "../host.js";
import type { Default, ManifestEntry } from "../manifest.js";
import { entry, found, item, present } from "./common.js";

interface Login {
  id: string;
  label: string;
  group: "CLI logins" | "Agent logins";
  paths: Partial<Record<Platform, string[]>> & { all?: string[] };
  default?: Default;
}

const LOGINS: readonly Login[] = [
  { id: "gcloud", label: "Google Cloud login", group: "CLI logins", paths: { all: ["~/.config/gcloud/credentials.db", "~/.config/gcloud/access_tokens.db", "~/.config/gcloud/application_default_credentials.json", "~/.config/gcloud/configurations", "~/.config/gcloud/active_config", "~/.config/gcloud/legacy_credentials"] } },
  { id: "wrangler", label: "Cloudflare Wrangler login", group: "CLI logins", paths: { darwin: ["~/Library/Preferences/.wrangler/config/default.toml"], linux: ["~/.config/.wrangler/config/default.toml"] } },
  { id: "cloudflared", label: "cloudflared login", group: "CLI logins", paths: { all: ["~/.cloudflared/cert.pem"] } },
  { id: "vercel", label: "Vercel login", group: "CLI logins", paths: { darwin: ["~/Library/Application Support/com.vercel.cli/auth.json"], linux: ["~/.config/com.vercel.cli/auth.json"], all: ["~/.vercel/auth.json"] } },
  { id: "aws", label: "AWS keys and profiles (SSO caches expire; sign in on the machine for those)", group: "CLI logins", paths: { all: ["~/.aws/credentials", "~/.aws/config"] } },
  { id: "kube", label: "kubectl config", group: "CLI logins", paths: { all: ["~/.kube/config"] } },
  { id: "codex", label: "Codex login", group: "Agent logins", paths: { all: ["~/.codex/auth.json"] } },
  { id: "gemini", label: "Gemini CLI login", group: "Agent logins", paths: { all: ["~/.gemini/oauth_creds.json"] } },
  { id: "opencode", label: "OpenCode login", group: "Agent logins", paths: { all: ["~/.local/share/opencode/auth.json"] } },
  { id: "pi", label: "Pi login", group: "Agent logins", paths: { all: ["~/.pi/agent/auth.json"] } },
  { id: "hermes", label: "Hermes Agent API keys and logins", group: "Agent logins", paths: { all: ["~/.hermes/.env", "~/.hermes/auth.json"] } },
];

async function keychainHas(host: Host, service: string): Promise<boolean> {
  if (host.platform !== "darwin") return false;
  return (await host.exec.run("security", ["find-generic-password", "-s", service])) !== undefined;
}

async function ghRow(host: Host): Promise<ManifestEntry | undefined> {
  const f = await found(host, ["~/.config/gh/hosts.yml"]);
  if (f.paths.length === 0) return undefined;
  if (await keychainHas(host, "gh:github.com")) {
    return entry({ rung: "logins", id: "logins/gh", label: "GitHub CLI login (token in Keychain; sign in on the machine)", group: "CLI logins", ...f, default: "skip" });
  }
  return entry({ rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", ...f });
}

// Claude defaults to signing in on the machine: the vendor's terms forbid a
// host to collect or intermediate the credential, and a copy would transit
// the wsp process. The row stays tickable so the person can still choose.
async function claudeRow(host: Host): Promise<ManifestEntry | undefined> {
  if (host.platform === "darwin") {
    if (!(await keychainHas(host, "Claude Code-credentials"))) return undefined;
    return entry({ rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: ["Keychain: Claude Code-credentials"], bytes: 0, default: "skip" });
  }
  const f = await found(host, ["~/.claude/.credentials.json"]);
  if (f.paths.length === 0) return undefined;
  return entry({ rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", ...f, default: "skip" });
}

export async function detectLogins(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [await ghRow(host)];
  for (const l of LOGINS) {
    const f = await found(host, [...(l.paths[host.platform] ?? []), ...(l.paths.all ?? [])]);
    if (f.paths.length === 0) continue;
    rows.push(entry({ rung: "logins", id: `logins/${l.id}`, label: l.label, group: l.group, ...f, ...(l.default !== undefined ? { default: l.default } : {}) }));
  }
  if (await host.exec.which("op")) {
    rows.push(item({ rung: "logins", id: "logins/op", label: "1Password CLI", group: "CLI logins", default: "skip", reason: "needs the 1Password desktop app; the machine uses a service account token" }));
  }
  rows.push(await claudeRow(host));
  return present(rows);
}
