// SPDX-License-Identifier: AGPL-3.0-only
// The per-CLI table: every login the collector can emit has a row, the flags
// are the measured ones, and each status check reads fixture output the way
// the tool prints it (fake names, masked tokens; nothing real).
import { describe, expect, it } from "vitest";
import { CLAUDE_CONFIG_DIR } from "@wsp/catalog";
import { AWS_STATUS, CLAUDE_KEY_PATH, CLAUDE_STATUS, CLOUDFLARED_STATUS, GEMINI_STATUS, SIGN_INS, claudeSource, claudeWhy, geminiSource, hasLogin, secretNamed, signInFor, signInWords, statusOf, type SignIn } from "../src/signin-table.js";
import { collectorLogins } from "./collector-logins.js";

function command(name: string): Extract<SignIn, { login: string }> {
  const s = signInFor(name);
  if (!hasLogin(s)) throw new Error(`${name} is not a login row`);
  return s;
}

const check = (name: string, output: string, exitCode: number): boolean => {
  const status = statusOf(signInFor(name));
  if (status === undefined) throw new Error(`${name} has no status command`);
  return status.signedIn(output, exitCode);
};

describe("sign-in table", () => {
  it("covers every login the collector emits, and none of them falls through to a bare shell", () => {
    const ids = collectorLogins();
    expect(ids).toEqual(expect.arrayContaining(["gh", "claude", "gcloud", "wrangler", "cloudflared", "vercel", "aws", "kube", "codex", "gemini", "opencode", "pi", "hermes", "op"]));
    for (const id of ids) expect(signInFor(id).kind, id).not.toBe("shell");
    expect(signInFor("some-new-tool")).toEqual({ kind: "shell" });
  });

  it("carries the corrected flags: device code or paste code where the callback flow cannot land, none where the tool has only one flow", () => {
    expect(command("gh").login).toBe("gh auth login");
    expect(command("gh").fallback).toBeUndefined();
    // gcloud, gemini and railway already take their paste or device flow under the daemon pty (DISPLAY unset), so no second variant.
    for (const name of ["gcloud", "gemini", "railway"]) expect(command(name).fallback, name).toBeUndefined();
    expect(command("aws").login).toBe("aws configure sso");
    expect(command("aws").fallback).toBe("aws configure sso --use-device-code");
    expect(command("aws").note).toMatch(/every configured profile/);
    // The profile aws configure sso writes is named {role}-{account}, so the check walks every profile in a subshell (its exits stay inside).
    expect(command("aws").status?.command).toBe(AWS_STATUS);
    expect(AWS_STATUS).toMatch(/^sh -c '.*aws configure list-profiles.*--profile "\$p".*exit 1'$/);
    expect(AWS_STATUS.replace(/^sh -c '|'$/g, "")).not.toMatch(/'/);
    // wrangler's --browser=false still binds the callback port, so it is no way around the callback.
    expect(command("wrangler").fallback).toBeUndefined();
    expect(command("wrangler").note).toMatch(/CLOUDFLARE_API_TOKEN/);
    expect(command("vercel").fallback).toBeUndefined();
    expect(command("codex").fallback).toBe("codex login --device-auth");
    expect(command("supabase").fallback).toBe("supabase login --no-browser");
    expect(command("claude").login).toBe("claude auth login");
    expect(command("opencode").note).toMatch(/1\.3\.0/);
    // pi signs in only through /login inside its TUI and hermes through its auth menu; both run in the machine's pty.
    expect(command("pi").login).toBe("pi");
    expect(command("pi").note).toMatch(/\/login/);
    expect(command("hermes").login).toBe("hermes auth");
    expect(command("hermes").fallback).toBeUndefined();
  });

  it("names the tool's own wait where it has one and leaves it out where the tool never gives up", () => {
    expect(command("wrangler").toolTimeoutMs).toBe(120_000);
    expect(command("aws").toolTimeoutMs).toBe(600_000);
    expect(command("gh").toolTimeoutMs).toBe(900_000);
    for (const name of ["gcloud", "codex", "claude", "supabase"]) expect(command(name).toolTimeoutMs, name).toBeUndefined();
  });

  it("has a status command for each tool that offers one, and says so for the rest", () => {
    const withStatus = Object.entries(SIGN_INS).filter(([, s]) => statusOf(s) !== undefined).map(([k]) => k);
    expect(withStatus.sort()).toEqual(["aws", "claude", "cloudflared", "codex", "doppler", "fly", "gcloud", "gemini", "gh", "hermes", "kube", "netlify", "opencode", "pi", "railway", "supabase", "vercel", "wrangler"]);
    // cloudflared has no status command; its login writes the origin certificate, so the check proves that file.
    expect(command("cloudflared").status?.command).toBe(CLOUDFLARED_STATUS);
    expect(CLOUDFLARED_STATUS).toBe(`if test -s "$HOME/.cloudflared/cert.pem"; then echo cert.pem; else false; fi`);
    for (const name of ["op", "kube"]) expect(signInFor(name).kind, name).toBe("none");
    // kubectl has no sign-in, so its row stays a "none" row whose status still proves a copied kubeconfig. What runs drops
    // stderr (v1.36.1 prints a kuberc warning there with no newline, so on the merged pty it glues onto the context name);
    // what the row shows is the command alone.
    expect(statusOf(signInFor("kube"))?.command).toBe("kubectl config current-context");
    expect(statusOf(signInFor("kube"))?.typed).toBe("kubectl config current-context 2>/dev/null");
    // Claude Code's typed line also proves the helper's key file, keeping claude's own exit for the marker; the row shows the status command alone.
    expect(command("claude").status?.command).toBe("claude auth status");
    expect(command("claude").status?.typed).toBe(CLAUDE_STATUS);
    expect(CLAUDE_KEY_PATH).toBe(`${CLAUDE_CONFIG_DIR}/anthropic-api-key`);
    expect(CLAUDE_STATUS).toBe(`claude auth status; s=$?; test -s ${CLAUDE_KEY_PATH} && echo WSP_KEY_FILE; (exit $s)`);
    for (const [name, s] of Object.entries(SIGN_INS)) if (name !== "kube" && name !== "claude") expect(statusOf(s)?.typed, name).toBeUndefined();
    expect(statusOf(signInFor("op"))).toBeUndefined();
    expect(statusOf({ kind: "shell" })).toBeUndefined();
    expect(statusOf(signInFor("gh"))).toBe(command("gh").status);
    expect(command("opencode").status?.command).toBe("opencode auth list");
    expect(command("pi").status?.command).toBe("pi --list-models");
    expect(command("hermes").status?.command).toBe("hermes auth list");
    // Gemini CLI has no status command of its own, so the check is a shell line over the login file and the two key names its docs name.
    expect(command("gemini").status?.command).toBe(GEMINI_STATUS);
    expect(GEMINI_STATUS).toMatch(/^if test -s "\$HOME\/.gemini\/oauth_creds.json"; then echo oauth_creds.json; elif test -n "\$GEMINI_API_KEY"; then echo GEMINI_API_KEY; elif test -n "\$GOOGLE_API_KEY"; then echo GOOGLE_API_KEY; else false; fi$/);
    expect(GEMINI_STATUS).not.toMatch(/exit/);
  });

  it("reads gh auth status: every account listed must be logged in, so a stale one beside a good one fails, as does the no-hosts answer", () => {
    const twoAccounts = [
      "github.com",
      "  ✓ Logged in to github.com account someone (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: ssh",
      "  - Token: gho_************************************",
      "",
      "  X Failed to log in to github.com account other (default)",
      "  - The token in default is invalid.",
    ].join("\n");
    expect(check("gh", twoAccounts, 1)).toBe(false);
    expect(check("gh", twoAccounts.replace(/  X Failed to log in to github.com account other \(default\)\n  - The token in default is invalid\./, "  ✓ Logged in to github.com account other (default)\n  - Active account: false"), 0)).toBe(true);
    expect(check("gh", "You are not logged into any GitHub hosts. To log in, run: gh auth login", 1)).toBe(false);
    expect(check("gh", "  X Failed to log in to github.com account other (default)\n  - The token in default is invalid.", 1)).toBe(false);
  });

  it("reads the other status commands from their printed shapes", () => {
    expect(check("gcloud", "someone@example.com", 0)).toBe(true);
    expect(check("gcloud", "", 0)).toBe(false);
    expect(check("gcloud", "No credentialed accounts.", 0)).toBe(false);
    expect(check("aws", '{\n    "UserId": "AIDAFAKE",\n    "Account": "123456789012",\n    "Arn": "arn:aws:iam::123456789012:user/someone"\n}', 0)).toBe(true);
    expect(check("aws", "Error loading SSO Token: Token for https://example.awsapps.com/start does not exist", 255)).toBe(false);
    expect(check("wrangler", "Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email someone@example.com.", 0)).toBe(true);
    expect(check("wrangler", "You are not authenticated. Please run `wrangler login`.", 0)).toBe(false);
    // wrangler 4.106.0 (src/user/whoami.ts) exits 0 either way and words an API token login differently.
    expect(check("wrangler", "Getting User settings...\n👋 You are logged in with an API Token. Unset the CLOUDFLARE_API_TOKEN in the environment to log in via OAuth.", 0)).toBe(true);
    expect(check("wrangler", "Getting User settings...\nYou are not authenticated. Please run `wrangler login`.\nTo deploy without logging in, run a command like `wrangler deploy --temporary` to use a temporary preview account.", 0)).toBe(false);
    expect(check("vercel", "someone", 0)).toBe(true);
    expect(check("vercel", "Error: No existing credentials found. Please run `vercel login` or pass \"--token\"", 1)).toBe(false);
    expect(check("netlify", "──────────────────────┐\n Current Netlify User │\n──────────────────────┘\nEmail: someone@example.com", 0)).toBe(true);
    expect(check("netlify", "Not logged in. Please log in to see site status.", 1)).toBe(false);
    expect(check("fly", "someone@example.com", 0)).toBe(true);
    expect(check("fly", "Error: No access token available. Please login with 'flyctl auth login'", 1)).toBe(false);
    expect(check("supabase", "LINKED | ORG ID | REFERENCE ID | NAME", 0)).toBe(true);
    expect(check("supabase", "Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable.", 1)).toBe(false);
    expect(check("railway", "Logged in as someone (someone@example.com) 👋", 0)).toBe(true);
    expect(check("railway", "Unauthorized. Please login with `railway login`", 1)).toBe(false);
    expect(check("doppler", "NAME      EMAIL\nsomeone   someone@example.com", 0)).toBe(true);
    expect(check("doppler", "Doppler Error: you must provide a token", 1)).toBe(false);
    expect(check("claude", '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty"\n}', 0)).toBe(true);
    expect(check("claude", '{\n  "loggedIn": false\n}', 1)).toBe(false);
    // A status that names the helper counts only with the key file marker: the status says logged in without running the helper.
    expect(check("claude", '{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}', 0)).toBe(false);
    expect(check("claude", '{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}\nWSP_KEY_FILE', 0)).toBe(true);
    expect(check("claude", '{\n  "loggedIn": false,\n  "authMethod": "none"\n}\nWSP_KEY_FILE', 1)).toBe(false);
    expect(check("codex", "Logged in using ChatGPT", 0)).toBe(true);
    expect(check("codex", "Not logged in", 1)).toBe(false);
  });

  it("reads kubectl, pi, hermes, opencode and the gemini shell check from their printed shapes", () => {
    // kubectl v1.36.1 on this Mac: the context name on exit 0, nothing (its error went to stderr) on exit 1.
    expect(check("kube", "connectgateway_someorg-default_us-central1_someorg-default-cluster-internal", 0)).toBe(true);
    expect(check("kube", "", 1)).toBe(false);
    expect(check("kube", "", 0)).toBe(false);
    expect(statusOf(signInFor("kube"))?.detail?.("minikube\n", new Map())).toBe("context minikube");
    // pi 0.84.1 on this Mac: a model table when some provider has credentials, a /login hint on exit 0 when none has.
    const models = ["provider   model                       context  max-out  thinking  images", "anthropic  claude-haiku-4-5            200K     64K      yes       yes   "].join("\n");
    expect(check("pi", models, 0)).toBe(true);
    expect(check("pi", "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md", 0)).toBe(false);
    expect(check("pi", models, 1)).toBe(false);
    // Hermes Agent v0.20.0 on this Mac: one block per provider with credentials, nothing at all when none has (exit 0 both).
    const pool = ["anthropic (1 credentials):", "  #1  ANTHROPIC_API_KEY    api_key env:ANTHROPIC_API_KEY ←", "", "nous (1 credentials):", "  #1  device_code          oauth   device_code ←", ""].join("\n");
    expect(check("hermes", pool, 0)).toBe(true);
    expect(check("hermes", "", 0)).toBe(false);
    expect(check("hermes", "Traceback (most recent call last):\n  ModuleNotFoundError: No module named 'yaml'", 1)).toBe(false);
    // opencode 1.18.18 on this Mac: a credentials count, then an environment count only when a provider key is exported (exit 0 both).
    const none = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
    expect(check("opencode", none, 0)).toBe(false);
    expect(check("opencode", "┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  Anthropic api\n│\n└  1 credentials\n", 0)).toBe(true);
    expect(check("opencode", `${none}\n┌  Environment\n│\n●  Anthropic ANTHROPIC_API_KEY\n│\n└  1 environment variable\n`, 0)).toBe(true);
    expect(check("opencode", `${none}\n┌  Environment\n│\n●  Anthropic ANTHROPIC_API_KEY\n│\n●  OpenAI OPENAI_API_KEY\n│\n└  2 environment variables\n`, 0)).toBe(true);
    expect(check("opencode", "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  10 credentials\n", 0)).toBe(true);
    // The gemini shell line prints what it found and fails when nothing is there.
    expect(check("gemini", "oauth_creds.json", 0)).toBe(true);
    expect(check("gemini", "GEMINI_API_KEY", 0)).toBe(true);
    expect(check("gemini", "", 1)).toBe(false);
    expect(check("cloudflared", "cert.pem", 0)).toBe(true);
    expect(check("cloudflared", "", 1)).toBe(false);
  });

  it("names the key the secrets step set when a status lists it, and what the gemini check found", () => {
    const secrets = new Map([["ANTHROPIC_API_KEY", "~/.zshrc"], ["OPENAI_API_KEY", "~/.env"]]);
    expect(secretNamed("  #1  ANTHROPIC_API_KEY    api_key env:ANTHROPIC_API_KEY ←", secrets)).toBe("API key from ~/.zshrc, set on the machine as a secret");
    expect(secretNamed("●  OpenAI OPENAI_API_KEY", secrets)).toBe("API key from ~/.env, set on the machine as a secret");
    expect(secretNamed("●  Anthropic api\n└  1 credentials", secrets)).toBeUndefined();
    expect(secretNamed("OPENAI_API_KEY_OLD", secrets)).toBeUndefined();
    expect(secretNamed("anything", new Map())).toBeUndefined();
    expect(command("opencode").status?.detail).toBe(secretNamed);
    expect(command("hermes").status?.detail).toBe(secretNamed);
    expect(geminiSource("oauth_creds.json", secrets)).toBe("OAuth credentials");
    expect(geminiSource("GEMINI_API_KEY", new Map([["GEMINI_API_KEY", "~/.zshrc"]]))).toBe("API key from ~/.zshrc, set on the machine as a secret");
    expect(geminiSource("GOOGLE_API_KEY\n", new Map())).toBe("API key from GOOGLE_API_KEY on the machine");
    expect(geminiSource("", new Map())).toBeUndefined();
    expect(command("gemini").status?.detail).toBe(geminiSource);
  });

  it("reads which key source claude auth status names: the exported key by the file it was cut from, the helper, or the OAuth credentials", () => {
    const envKey = '{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiProvider": "firstParty",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}';
    const secrets = new Map([["ANTHROPIC_API_KEY", "~/.zshrc"]]);
    expect(claudeSource(envKey, secrets)).toBe("API key from ~/.zshrc, set on the machine as a secret");
    expect(claudeSource(envKey, new Map())).toBe("API key from ANTHROPIC_API_KEY on the machine");
    // With a helper configured too, apiKeySource still names the environment: the exported key wins.
    expect(claudeSource(envKey.replace('"api_key"', '"api_key_helper"'), secrets)).toBe("API key from ~/.zshrc, set on the machine as a secret");
    expect(claudeSource('{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}', secrets)).toBe("API key from the settings.json helper");
    expect(claudeSource('{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}\nWSP_KEY_FILE', secrets)).toBe("API key from the settings.json helper, key file present");
    expect(claudeWhy('{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}')).toBe("claude auth status names the settings.json helper while its key file is missing or empty on the machine");
    expect(claudeWhy('{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}\nWSP_KEY_FILE')).toBeUndefined();
    expect(claudeWhy(envKey)).toBeUndefined();
    expect(claudeWhy("not json at all")).toBeUndefined();
    expect(command("claude").status?.why).toBe(claudeWhy);
    expect(command("gh").status?.why).toBeUndefined();
    expect(claudeSource('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}', secrets)).toBe("OAuth credentials");
    expect(claudeSource('{\n  "loggedIn": false,\n  "authMethod": "none"\n}', secrets)).toBeUndefined();
    expect(claudeSource("not json at all", secrets)).toBeUndefined();
    expect(command("claude").status?.detail).toBe(claudeSource);
    expect(command("gh").status?.detail).toBeUndefined();
  });

  it("names the flow each login takes: a browser callback, a code typed on a page, or a key", () => {
    expect(command("gh").kind).toBe("device");
    expect(command("hermes").kind).toBe("device");
    expect(command("opencode").kind).toBe("key");
    for (const name of ["claude", "codex", "gemini", "gcloud", "aws", "wrangler", "vercel", "pi", "cloudflared"]) expect(command(name).kind, name).toBe("oauth");
  });

  it("words a row for a checklist: the command, what to do instead, or a plain ask", () => {
    expect(signInWords(signInFor("gh"))).toBe("gh auth login");
    expect(signInWords(signInFor("kube"))).toBe("kubectl has no sign-in; copy the kubeconfig instead");
    expect(signInWords(signInFor("unknown"))).toBe("sign in as the tool asks");
  });

  it("never carries a token-looking value", () => {
    expect(JSON.stringify(SIGN_INS, (_k, v: unknown) => (typeof v === "function" ? String(v) : v))).not.toMatch(/gho_|sk-ant|ya29\.|AKIA/);
  });
});
