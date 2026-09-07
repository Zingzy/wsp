// SPDX-License-Identifier: AGPL-3.0-only
// Logins are presence only: a path is stat'ed, a Keychain item is looked up
// by service name without -w, and no login file is ever read. The rc files
// and Claude Code's settings.json are read for names alone: which variable is
// exported, whether a helper command is set.
import { CLAUDE_SETTINGS_FILE, LOGIN_ROWS, loginRow, signsInByDefault } from "@wsp/catalog";
import { type Host, type Platform, expand } from "../host.js";
import { RC_PATHS, stripExports } from "./shell-rc.js";
import type { Default, ManifestEntry } from "../manifest.js";
import { entry, found, item, present } from "./common.js";

interface Login {
  id: string;
  label: string;
  group: "CLI logins" | "Agent logins";
  paths: Partial<Record<Platform, string[]>> & { all?: string[] };
  /** Set where the catalog's sign-in kind is not the row's answer; the detail says why. */
  default?: Default;
  detail?: string;
}

/** What a login row starts as: a copy (bring) for a key, a keys row or a tool with no sign-in, a sign-in on the
 * machine (skip) for a browser or device flow the catalog names; a tool the catalog does not know starts as a copy. */
export function loginDefault(id: string): Default {
  const row = loginRow(id);
  return row !== undefined && signsInByDefault(row.signIn) ? "skip" : "bring";
}

const LOGINS: readonly Login[] = [
  { id: "gcloud", label: "Google Cloud login", group: "CLI logins", paths: { all: ["~/.config/gcloud/credentials.db", "~/.config/gcloud/access_tokens.db", "~/.config/gcloud/application_default_credentials.json", "~/.config/gcloud/configurations", "~/.config/gcloud/active_config", "~/.config/gcloud/legacy_credentials"] } },
  { id: "wrangler", label: "Cloudflare Wrangler login", group: "CLI logins", paths: { darwin: ["~/Library/Preferences/.wrangler/config/default.toml"], linux: ["~/.config/.wrangler/config/default.toml"] } },
  { id: "cloudflared", label: "cloudflared login", group: "CLI logins", paths: { all: ["~/.cloudflared/cert.pem"] } },
  { id: "vercel", label: "Vercel login", group: "CLI logins", paths: { darwin: ["~/Library/Application Support/com.vercel.cli/auth.json"], linux: ["~/.config/com.vercel.cli/auth.json"], all: ["~/.vercel/auth.json"] } },
  { id: "aws", label: "AWS keys and profiles", group: "CLI logins", paths: { all: ["~/.aws/credentials", "~/.aws/config"] } },
  { id: "kube", label: "kubectl config", group: "CLI logins", paths: { all: ["~/.kube/config"] } },
  { id: "codex", label: "Codex login", group: "Agent logins", paths: { all: ["~/.codex/auth.json"] } },
  { id: "gemini", label: "Gemini CLI login", group: "Agent logins", paths: { all: ["~/.gemini/oauth_creds.json"] } },
  { id: "opencode", label: "OpenCode login", group: "Agent logins", paths: { all: ["~/.local/share/opencode/auth.json"] } },
  { id: "pi", label: "Pi login", group: "Agent logins", paths: { all: ["~/.pi/agent/auth.json"] } },
  { id: "hermes", label: "Hermes Agent login", group: "Agent logins", paths: { all: ["~/.hermes/auth.json"] } },
];

/** The rows for key files the catalog names beside a login: one per entry whose keys are here, a copy by default. */
async function keysRows(host: Host): Promise<ManifestEntry[]> {
  const rows: ManifestEntry[] = [];
  for (const r of LOGIN_ROWS) {
    if (r.keys === undefined) continue;
    const f = await found(host, r.keys.paths);
    if (f.paths.length === 0) continue;
    rows.push(entry({ rung: "logins", id: `logins/${r.id}`, label: `${r.entry.name} API keys`, group: r.entry.kind === "agent" ? "Agent logins" : "CLI logins", ...f, default: loginDefault(r.id), detail: r.keys.note }));
  }
  return rows;
}

async function keychainHas(host: Host, service: string): Promise<boolean> {
  if (host.platform !== "darwin") return false;
  return (await host.exec.run("security", ["find-generic-password", "-s", service])) !== undefined;
}

// hosts.yml names the account; on macOS the token sits in the Keychain, so that
// item rides along as a second path and the copy step reads it there.
async function ghRow(host: Host): Promise<ManifestEntry | undefined> {
  const f = await found(host, ["~/.config/gh/hosts.yml"]);
  if (f.paths.length === 0) return undefined;
  const paths = (await keychainHas(host, "gh:github.com")) ? [...f.paths, "Keychain: gh:github.com"] : f.paths;
  return entry({ rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths, bytes: f.bytes, default: loginDefault("gh") });
}

export const CLAUDE_KEY_ENV = "ANTHROPIC_API_KEY";

/** The apiKeyHelper command a settings.json names, when it parses and has one. */
export function apiKeyHelperOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const helper = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["apiKeyHelper"] : undefined;
    return typeof helper === "string" && helper.trim() !== "" ? helper : undefined;
  } catch {
    return undefined;
  }
}

/** The first rc file that exports the name; the pack cuts that line and the secrets step sets it on the machine. */
async function exportedIn(host: Host, name: string): Promise<string | undefined> {
  for (const rel of RC_PATHS) {
    const text = await host.fs.readText(`${host.home}/${rel}`);
    if (text !== undefined && stripExports(text).names.includes(name)) return `~/${rel}`;
  }
  return undefined;
}

// Claude Code takes its key from ANTHROPIC_API_KEY first, then the apiKeyHelper, then the OAuth
// credentials (measured on 2.1.257). An API key travels: the exported one is cut from the rc file
// and set on the machine in the secrets step, the helper's is read here with the Keychain logins.
// The OAuth credential defaults to a sign-in on the machine: the vendor's terms forbid a host
// to collect or intermediate it, and a copy would transit the wsp process.
async function claudeRow(host: Host): Promise<ManifestEntry | undefined> {
  const oauth = host.platform === "darwin" ? { paths: (await keychainHas(host, "Claude Code-credentials")) ? ["Keychain: Claude Code-credentials"] : [], bytes: 0 } : await found(host, ["~/.claude/.credentials.json"]);
  const helper = apiKeyHelperOf(await host.fs.readText(expand(host, CLAUDE_SETTINGS_FILE)));
  const exported = await exportedIn(host, CLAUDE_KEY_ENV);
  const sources = [
    ...(exported !== undefined ? [`the API key exported in ${exported} (set on the machine in the secrets step if ${exported} comes along)`] : []),
    ...(helper !== undefined ? [`the apiKeyHelper in ${CLAUDE_SETTINGS_FILE}`] : []),
    ...(oauth.paths.length > 0 ? ["OAuth credentials"] : []),
  ];
  if (sources.length === 0) return undefined;
  const [used, ...rest] = sources;
  return entry({
    rung: "logins",
    id: "logins/claude",
    label: "Claude Code login",
    group: "Agent logins",
    paths: [...oauth.paths, ...(helper !== undefined ? [`Helper: ${CLAUDE_SETTINGS_FILE}`] : [])],
    bytes: oauth.bytes,
    default: exported !== undefined || helper !== undefined ? "bring" : "skip",
    detail: `Claude Code uses ${used}${rest.length > 0 ? `; also found: ${rest.join(", ")}` : ""}`,
  });
}

export async function detectLogins(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [await ghRow(host)];
  for (const l of LOGINS) {
    const f = await found(host, [...(l.paths[host.platform] ?? []), ...(l.paths.all ?? [])]);
    if (f.paths.length === 0) continue;
    rows.push(entry({ rung: "logins", id: `logins/${l.id}`, label: l.label, group: l.group, ...f, default: l.default ?? loginDefault(l.id), ...(l.detail !== undefined ? { detail: l.detail } : {}) }));
  }
  rows.push(...(await keysRows(host)));
  if (await host.exec.which("op")) {
    rows.push(item({ rung: "logins", id: "logins/op", label: "1Password CLI", group: "CLI logins", default: "skip", reason: "needs the 1Password desktop app; the machine uses a service account token" }));
  }
  rows.push(await claudeRow(host));
  return present(rows);
}
