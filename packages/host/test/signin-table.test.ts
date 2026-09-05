// SPDX-License-Identifier: AGPL-3.0-only
// The per-CLI table: every login the collector can emit has a row, the flags
// are the measured ones, and each status check reads fixture output the way
// the tool prints it (fake names, masked tokens; nothing real).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AWS_STATUS, SIGN_INS, signInFor, signInWords, type SignIn } from "../src/signin-table.js";

const collectorLogins = (): string[] => {
  const src = readFileSync(join(import.meta.dirname, "../../collect/src/detect/logins.ts"), "utf8");
  const ids = [...src.matchAll(/\bid: "(?:logins\/)?([a-z]+)"/g)].map(m => m[1]!);
  return [...new Set(ids)];
};

function command(name: string): Extract<SignIn, { kind: "command" }> {
  const s = signInFor(name);
  if (s.kind !== "command") throw new Error(`${name} is not a command row`);
  return s;
}

const check = (name: string, output: string, exitCode: number): boolean => {
  const s = command(name);
  if (s.status === undefined) throw new Error(`${name} has no status command`);
  return s.status.signedIn(output, exitCode);
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
  });

  it("names the tool's own wait where it has one and leaves it out where the tool never gives up", () => {
    expect(command("wrangler").toolTimeoutMs).toBe(120_000);
    expect(command("aws").toolTimeoutMs).toBe(600_000);
    expect(command("gh").toolTimeoutMs).toBe(900_000);
    for (const name of ["gcloud", "codex", "claude", "supabase"]) expect(command(name).toolTimeoutMs, name).toBeUndefined();
  });

  it("has a status command for each tool that offers one, and says so for the rest", () => {
    const withStatus = Object.entries(SIGN_INS).filter(([, s]) => s.kind === "command" && s.status !== undefined).map(([k]) => k);
    expect(withStatus.sort()).toEqual(["aws", "claude", "codex", "doppler", "fly", "gcloud", "gh", "netlify", "railway", "supabase", "vercel", "wrangler"]);
    for (const name of ["gemini", "opencode", "cloudflared"]) expect(command(name).status, name).toBeUndefined();
    for (const name of ["op", "kube", "pi", "hermes"]) expect(signInFor(name).kind, name).toBe("none");
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
    expect(check("codex", "Logged in using ChatGPT", 0)).toBe(true);
    expect(check("codex", "Not logged in", 1)).toBe(false);
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
