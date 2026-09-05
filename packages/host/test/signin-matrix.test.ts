// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in regression matrix: every login source the table names, against
// every tool the collector can emit a login row for. A cell says what the
// source alone looks like on a fake laptop and the row the collector makes of
// it, then what the tool's status prints on the fake guest when that source
// signed it in and the row it earns there: state, the words beside it, the
// exact line typed on the guest, and that no secret value reaches a note. A
// cell the product cannot produce is listed with its reason, never left out;
// a source added to the table without a cell fails the coverage test by name.
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { detectLogins, type ManifestEntry } from "@wsp/collect";
import type { LoginState } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { fakeHost, type FakeLaptop } from "../../collect/test/fake-host.js";
import { signInStage, statusLine } from "../src/init-signin.js";
import { AWS_STATUS, CLOUDFLARED_STATUS, GEMINI_STATUS, SIGN_INS, statusOf, type LoginSource } from "../src/signin-table.js";
import { collectorLogins } from "./collector-logins.js";
import { fakePtyLink } from "./fake-pty-link.js";

type Source = LoginSource | "none";
const SOURCES: readonly Source[] = ["keychain", "rc-key", "file", "helper", "none"];

interface Answer {
  output: string;
  exitCode: number;
}

interface Row {
  paths: string[];
  default: "bring" | "skip";
  detail?: string;
}

interface Reachable {
  tool: string;
  source: Source;
  /** This source alone on the laptop, and the row the collector makes of it; no row when the source alone makes none. */
  laptop: FakeLaptop;
  row?: Row;
  /** The row's answer on the Sign-ins screen; copy unless said otherwise. */
  choice?: "machine";
  /** What the tool prints on the guest with this source signed in (for none, with nothing landed); absent for a row with no status. */
  answer?: Answer;
  state: LoginState;
  note: string;
  /** How the guest cell is reached when the source alone makes no row, or a limit of what the check proves. */
  reach?: string;
}

interface Unreachable {
  tool: string;
  source: Source;
  unreachable: string;
  /** The source on the laptop when it can be set up, to prove the collector makes no row of it. */
  laptop?: FakeLaptop;
}

type Cell = Reachable | Unreachable;

/** The values the fake laptops carry; none may reach a row, a note or a typed line. */
const FAKE_VALUES = ["sk-ant-x", "gho_x", "cf-x", "AIza-x", "aws-x", "sk-oai-x"];
const SECRETS = new Map([["ANTHROPIC_API_KEY", "~/.zshrc"], ["GEMINI_API_KEY", "~/.zshrc"]]);

const OWN_FILES = "keeps its login in its own files; the collector reads no Keychain item, rc key or helper for it";
/** The other sources of a tool that keeps its login in files alone. */
const filesOnly = (tool: string, ...except: Source[]): Unreachable[] =>
  (["keychain", "rc-key", "helper"] as const).filter(s => !except.includes(s)).map(source => ({ tool, source, unreachable: `${tool} ${OWN_FILES}` }));

// Status outputs are what the tools printed on this Mac (gh 2.x, kubectl v1.36.1, wrangler 4.106.0, pi 0.84.1,
// Hermes Agent v0.20.0, opencode 1.18.18, Claude Code 2.1.257) or the fixtures the table tests carry, with fake names.
const GH_IN = "github.com\n  ✓ Logged in to github.com account someone (default)\n  - Active account: true\n  - Git operations protocol: ssh\n  - Token: gho_************************************";
const CLAUDE_HELPER = '{\n  "loggedIn": true,\n  "authMethod": "api_key_helper",\n  "apiKeySource": "apiKeyHelper"\n}';
const CLAUDE_OAUTH = '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}';
const PI_MODELS = "provider   model                       context  max-out  thinking  images\nanthropic  claude-haiku-4-5            200K     64K      yes       yes   ";
// opencode paints the path and the key name grey even into a pipe, with a reset up front and none after.
const OPENCODE_NONE = "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n└  0 credentials\n";
const HERMES_KEY = "anthropic (1 credentials):\n  #1  ANTHROPIC_API_KEY    api_key env:ANTHROPIC_API_KEY ←\n";

const MATRIX: readonly Cell[] = [
  // gh: hosts.yml names the account; on macOS the token is a Keychain item that lands inside hosts.yml on the machine.
  { tool: "gh", source: "file", laptop: { files: { "~/.config/gh/hosts.yml": 200 } }, row: { paths: ["~/.config/gh/hosts.yml"], default: "bring" }, answer: { output: GH_IN, exitCode: 0 }, state: "signed-in", note: "copied; gh auth status" },
  {
    tool: "gh",
    source: "keychain",
    laptop: { files: { "~/.config/gh/hosts.yml": 200 }, exec: { "security find-generic-password -s gh:github.com": "keychain: ...\n" } },
    row: { paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], default: "bring" },
    answer: { output: GH_IN, exitCode: 0 },
    state: "signed-in",
    note: "copied; gh auth status",
    reach: "the token read from the Keychain is placed into hosts.yml on the machine, so the status reads as for the copied file",
  },
  { tool: "gh", source: "rc-key", unreachable: "gh's row is its hosts.yml; GH_TOKEN alone makes no row and travels only as a secret with the rc file", laptop: { files: { "~/.zshrc": "export GH_TOKEN=gho_x\n" } } },
  { tool: "gh", source: "helper", unreachable: "only Claude Code reads an apiKeyHelper" },
  { tool: "gh", source: "none", laptop: {}, answer: { output: "You are not logged into any GitHub hosts. To log in, run: gh auth login", exitCode: 1 }, state: "not-signed-in", note: "copied, but gh auth status says not signed in" },

  {
    tool: "gcloud",
    source: "file",
    laptop: { files: { "~/.config/gcloud/credentials.db": 4000, "~/.config/gcloud/configurations/config_default": 50 } },
    row: { paths: ["~/.config/gcloud/credentials.db", "~/.config/gcloud/configurations"], default: "bring" },
    answer: { output: "someone@example.com", exitCode: 0 },
    state: "signed-in",
    note: "copied; gcloud auth list --filter=status:ACTIVE --format=value(account)",
  },
  ...filesOnly("gcloud"),
  { tool: "gcloud", source: "none", laptop: {}, answer: { output: "No credentialed accounts.", exitCode: 0 }, state: "not-signed-in", note: "copied, but gcloud auth list --filter=status:ACTIVE --format=value(account) says not signed in" },

  {
    tool: "wrangler",
    source: "file",
    laptop: { files: { "~/Library/Preferences/.wrangler/config/default.toml": 300 } },
    row: { paths: ["~/Library/Preferences/.wrangler/config/default.toml"], default: "bring" },
    answer: { output: "Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email someone@example.com.", exitCode: 0 },
    state: "signed-in",
    note: "copied; wrangler whoami",
  },
  {
    tool: "wrangler",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export CLOUDFLARE_API_TOKEN=cf-x\n" } },
    answer: { output: "Getting User settings...\n👋 You are logged in with an API Token. Unset the CLOUDFLARE_API_TOKEN in the environment to log in via OAuth.", exitCode: 0 },
    state: "signed-in",
    note: "copied; wrangler whoami",
    reach: "the token alone makes no row; it travels as a secret when the rc file comes along, and the check meets it beside the copied default.toml",
  },
  ...filesOnly("wrangler", "rc-key"),
  {
    tool: "wrangler",
    source: "none",
    laptop: {},
    answer: { output: "Getting User settings...\nYou are not authenticated. Please run `wrangler login`.\nTo deploy without logging in, run a command like `wrangler deploy --temporary` to use a temporary preview account.", exitCode: 0 },
    state: "not-signed-in",
    note: "copied, but wrangler whoami says not signed in",
  },

  { tool: "cloudflared", source: "file", laptop: { files: { "~/.cloudflared/cert.pem": 800 } }, row: { paths: ["~/.cloudflared/cert.pem"], default: "bring" }, answer: { output: "cert.pem", exitCode: 0 }, state: "signed-in", note: `copied; ${CLOUDFLARED_STATUS}` },
  ...filesOnly("cloudflared"),
  { tool: "cloudflared", source: "none", laptop: {}, answer: { output: "", exitCode: 1 }, state: "not-signed-in", note: `copied, but ${CLOUDFLARED_STATUS} says not signed in` },

  {
    tool: "vercel",
    source: "file",
    laptop: { files: { "~/Library/Application Support/com.vercel.cli/auth.json": 100 } },
    row: { paths: ["~/Library/Application Support/com.vercel.cli/auth.json"], default: "bring" },
    answer: { output: "someone", exitCode: 0 },
    state: "signed-in",
    note: "copied; vercel whoami",
  },
  ...filesOnly("vercel"),
  { tool: "vercel", source: "none", laptop: {}, answer: { output: 'Error: No existing credentials found. Please run `vercel login` or pass "--token"', exitCode: 1 }, state: "not-signed-in", note: "copied, but vercel whoami says not signed in" },

  {
    tool: "aws",
    source: "file",
    laptop: { files: { "~/.aws/credentials": 120, "~/.aws/config": 300 } },
    row: { paths: ["~/.aws/credentials", "~/.aws/config"], default: "bring" },
    answer: { output: '{\n    "UserId": "AIDAFAKE",\n    "Account": "123456789012",\n    "Arn": "arn:aws:iam::123456789012:user/someone"\n}', exitCode: 0 },
    state: "signed-in",
    note: `copied; ${AWS_STATUS}`,
  },
  {
    tool: "aws",
    source: "rc-key",
    unreachable: "the keys alone make no row; they travel as secrets with the rc file, and what sts prints for them was not measured",
    laptop: { files: { "~/.zshrc": "export AWS_ACCESS_KEY_ID=aws-x\nexport AWS_SECRET_ACCESS_KEY=aws-x\n" } },
  },
  ...filesOnly("aws", "rc-key"),
  { tool: "aws", source: "none", laptop: {}, answer: { output: "Error loading SSO Token: Token for https://example.awsapps.com/start does not exist", exitCode: 255 }, state: "not-signed-in", note: `copied, but ${AWS_STATUS} says not signed in` },

  // kubectl has no sign-in: the row shows its command bare, and what runs drops stderr (the kuberc warning glues onto the name).
  { tool: "kube", source: "file", laptop: { files: { "~/.kube/config": 6000 } }, row: { paths: ["~/.kube/config"], default: "bring" }, answer: { output: "minikube", exitCode: 0 }, state: "signed-in", note: "copied; context minikube; kubectl config current-context" },
  ...filesOnly("kube"),
  { tool: "kube", source: "none", laptop: {}, answer: { output: "", exitCode: 1 }, state: "not-signed-in", note: "copied, but kubectl config current-context says not signed in" },

  { tool: "codex", source: "file", laptop: { files: { "~/.codex/auth.json": 900 } }, row: { paths: ["~/.codex/auth.json"], default: "bring" }, answer: { output: "Logged in using ChatGPT", exitCode: 0 }, state: "signed-in", note: "copied; codex login status" },
  { tool: "codex", source: "rc-key", unreachable: "the key alone makes no row; it travels as a secret with the rc file, and what codex login status prints for it was not measured", laptop: { files: { "~/.zshrc": "export OPENAI_API_KEY=sk-oai-x\n" } } },
  ...filesOnly("codex", "rc-key"),
  { tool: "codex", source: "none", laptop: {}, answer: { output: "Not logged in", exitCode: 1 }, state: "not-signed-in", note: "copied, but codex login status says not signed in" },

  // Gemini CLI has no status command: the check is a shell line over its login file and the two key names its docs name.
  { tool: "gemini", source: "file", laptop: { files: { "~/.gemini/oauth_creds.json": 500 } }, row: { paths: ["~/.gemini/oauth_creds.json"], default: "bring" }, answer: { output: "oauth_creds.json", exitCode: 0 }, state: "signed-in", note: `copied; OAuth credentials; ${GEMINI_STATUS}` },
  {
    tool: "gemini",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export GEMINI_API_KEY=AIza-x\n" } },
    answer: { output: "GEMINI_API_KEY", exitCode: 0 },
    state: "signed-in",
    note: `copied; API key from ~/.zshrc, set on the machine as a secret; ${GEMINI_STATUS}`,
    reach: "the key alone makes no row; the row needs oauth_creds.json, which the check names first, so the key is named when that file did not land",
  },
  ...filesOnly("gemini", "rc-key"),
  { tool: "gemini", source: "none", laptop: {}, answer: { output: "", exitCode: 1 }, state: "not-signed-in", note: `copied, but ${GEMINI_STATUS} says not signed in` },

  {
    tool: "opencode",
    source: "file",
    laptop: { files: { "~/.local/share/opencode/auth.json": 200 } },
    row: { paths: ["~/.local/share/opencode/auth.json"], default: "bring" },
    answer: { output: "\x1b[0m\n┌  Credentials \x1b[90m~/.local/share/opencode/auth.json\n│\n●  Anthropic \x1b[90mapi\n│\n└  1 credentials\n", exitCode: 0 },
    state: "signed-in",
    note: "copied; opencode auth list",
  },
  {
    tool: "opencode",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
    answer: { output: `${OPENCODE_NONE}\n┌  Environment\n│\n●  Anthropic \x1b[90mANTHROPIC_API_KEY\n│\n└  1 environment variable\n`, exitCode: 0 },
    state: "signed-in",
    note: "copied; API key from ~/.zshrc, set on the machine as a secret; opencode auth list",
    reach: "the key alone makes an rc-key row for Claude Code, not for OpenCode; it travels as a secret with the rc file and the check lists it under Environment beside the copied auth.json",
  },
  ...filesOnly("opencode", "rc-key"),
  { tool: "opencode", source: "none", laptop: {}, answer: { output: OPENCODE_NONE, exitCode: 0 }, state: "not-signed-in", note: "copied, but opencode auth list says not signed in" },

  { tool: "pi", source: "file", laptop: { files: { "~/.pi/agent/auth.json": 900 } }, row: { paths: ["~/.pi/agent/auth.json"], default: "bring" }, answer: { output: PI_MODELS, exitCode: 0 }, state: "signed-in", note: "copied; pi --list-models" },
  {
    tool: "pi",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
    answer: { output: PI_MODELS, exitCode: 0 },
    state: "signed-in",
    note: "copied; pi --list-models",
    reach: "the key alone makes no pi row; pi lists a model for an exported key as for a stored login, so the check passes and names no source",
  },
  ...filesOnly("pi", "rc-key"),
  {
    tool: "pi",
    source: "none",
    laptop: {},
    answer: { output: "No models available. Use /login to log into a provider via OAuth or API key. See:\n  /usr/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md", exitCode: 0 },
    state: "not-signed-in",
    note: "copied, but pi --list-models says not signed in",
  },

  {
    tool: "hermes",
    source: "file",
    laptop: { files: { "~/.hermes/.env": 25_000, "~/.hermes/auth.json": 400 } },
    row: { paths: ["~/.hermes/.env", "~/.hermes/auth.json"], default: "bring" },
    answer: { output: "nous (1 credentials):\n  #1  device_code          oauth   device_code ←\n", exitCode: 0 },
    state: "signed-in",
    note: "copied; hermes auth list",
  },
  {
    tool: "hermes",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
    answer: { output: HERMES_KEY, exitCode: 0 },
    state: "signed-in",
    note: "copied; API key from ~/.zshrc, set on the machine as a secret; hermes auth list",
    reach: "the key alone makes no hermes row; it travels as a secret with the rc file and the pool lists it as env:ANTHROPIC_API_KEY beside the copied files",
  },
  ...filesOnly("hermes", "rc-key"),
  { tool: "hermes", source: "none", laptop: {}, answer: { output: "", exitCode: 0 }, state: "not-signed-in", note: "copied, but hermes auth list says not signed in" },

  // The 1Password CLI signs in through the desktop app: its row is the binary's presence, and nothing of it travels.
  ...(["keychain", "rc-key", "file", "helper"] as const).map((source): Unreachable => ({ tool: "op", source, unreachable: "op signs in through the 1Password desktop app; nothing of it is copied" })),
  { tool: "op", source: "none", laptop: { which: ["op"] }, row: { paths: [], default: "skip" }, choice: "machine", state: "skipped", note: "needs the 1Password desktop app; set OP_SERVICE_ACCOUNT_TOKEN on the machine instead" },

  // Claude Code: the env key wins over the helper, the helper over the OAuth credentials (measured on 2.1.257).
  {
    tool: "claude",
    source: "keychain",
    laptop: { exec: { "security find-generic-password -s Claude Code-credentials": "keychain: ...\n" } },
    row: { paths: ["Keychain: Claude Code-credentials"], default: "skip", detail: "Claude Code uses OAuth credentials" },
    answer: { output: CLAUDE_OAUTH, exitCode: 0 },
    state: "signed-in",
    note: "copied; OAuth credentials; claude auth status",
  },
  {
    tool: "claude",
    source: "file",
    laptop: { platform: "linux", files: { "~/.claude/.credentials.json": 800 } },
    row: { paths: ["~/.claude/.credentials.json"], default: "skip", detail: "Claude Code uses OAuth credentials" },
    answer: { output: CLAUDE_OAUTH, exitCode: 0 },
    state: "signed-in",
    note: "copied; OAuth credentials; claude auth status",
  },
  {
    tool: "claude",
    source: "rc-key",
    laptop: { files: { "~/.zshrc": "export ANTHROPIC_API_KEY=sk-ant-x\n" } },
    row: { paths: [], default: "bring", detail: "Claude Code uses the API key exported in ~/.zshrc (set on the machine in the secrets step if ~/.zshrc comes along)" },
    answer: { output: '{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}', exitCode: 0 },
    state: "signed-in",
    note: "copied; API key from ~/.zshrc, set on the machine as a secret; claude auth status",
  },
  {
    tool: "claude",
    source: "helper",
    laptop: { files: { "~/.claude/settings.json": '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w"}' } },
    row: { paths: ["Helper: ~/.claude/settings.json"], default: "bring", detail: "Claude Code uses the apiKeyHelper in ~/.claude/settings.json" },
    answer: { output: `${CLAUDE_HELPER}\nWSP_KEY_FILE`, exitCode: 0 },
    state: "signed-in",
    note: "copied; API key from the settings.json helper, key file present; claude auth status",
    reach: "measured on 2.1.257: with any apiKeyHelper configured the status says logged in without running the helper, so the typed line also proves the key file the helper reads is present and non-empty",
  },
  { tool: "claude", source: "none", laptop: {}, answer: { output: '{\n  "loggedIn": false,\n  "authMethod": "none"\n}', exitCode: 1 }, state: "not-signed-in", note: "copied, but claude auth status says not signed in" },
];

/** The shell's own 127 on a guest without the tool: the check cannot run, and the row says so. */
const MISSING: readonly string[] = ["gh", "gcloud", "wrangler", "vercel", "kube", "codex", "opencode", "pi", "hermes", "claude"];

const cellName = (tool: string, source: Source): string => `${tool} x ${source}`;
const reachable = (c: Cell): c is Reachable => !("unreachable" in c);
const entryFor = (tool: string, choice: "copy" | "machine"): ManifestEntry => ({ rung: "logins", id: `logins/${tool}`, label: tool, group: "CLI logins", paths: [], bytes: 0, default: "bring", choice });

/** The fake guest answers the status command with this output and exit code; a stage over it with one login. */
function guest(tool: string, choice: "copy" | "machine", answer: Answer | undefined) {
  const link = fakePtyLink();
  link.script = (pty, line) => {
    if (!line.includes("WSP_STATUS") || answer === undefined) return;
    link.data(pty, `${answer.output.replace(/\n/g, "\r\n")}\r\nWSP_STATUS ${answer.exitCode}\r\n`);
    link.exit(pty, answer.exitCode);
  };
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString()));
  // A copied login is checked whoever is here; a machine sign-in for a tool with none is skipped with the row's note and asks nothing.
  const run = signInStage({
    logins: [entryFor(tool, choice)],
    secrets: SECRETS,
    dial: async () => ({ link: link.dial(), close: () => {} }),
    terminal: { input: new PassThrough(), output },
    open: async () => true,
    flow: { armed: false },
    ...(choice === "copy" ? { skipWhy: "nobody here" } : {}),
  });
  return { run, link, text: () => stripVTControlCharacters(chunks.join("")) };
}

const typedLine = (tool: string): string => {
  const status = statusOf(SIGN_INS[tool]!);
  if (status === undefined) throw new Error(`${tool} has no status command`);
  return `${statusLine(status.typed ?? status.command)}; printf '\\nWSP_STATUS %s\\n' $?; exit\r`;
};

describe("the sign-in matrix covers every tool and source", () => {
  const tools = collectorLogins();

  it("has one cell per collector tool and source, names a missing or doubled cell, and lists an unreachable cell with its reason", () => {
    const seen = new Map<string, number>();
    for (const c of MATRIX) seen.set(cellName(c.tool, c.source), (seen.get(cellName(c.tool, c.source)) ?? 0) + 1);
    const missing = tools.flatMap(tool => SOURCES.filter(source => !seen.has(cellName(tool, source))).map(source => cellName(tool, source)));
    const doubled = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    const strays = [...seen.keys()].filter(k => !tools.includes(k.split(" x ")[0]!));
    expect({ missing, doubled, strays }).toEqual({ missing: [], doubled: [], strays: [] });
    for (const c of MATRIX) if (!reachable(c)) expect(c.unreachable, cellName(c.tool, c.source)).not.toBe("");
  });

  it("a source the table lists for a tool has a full cell: the laptop makes the row, the guest proves it; a table row nobody collects lists no source", () => {
    for (const [tool, s] of Object.entries(SIGN_INS)) {
      const sources = s.sources;
      if (!tools.includes(tool)) {
        expect(sources, tool).toEqual([]);
        continue;
      }
      for (const source of sources) {
        const cell = MATRIX.find(c => c.tool === tool && c.source === source);
        expect(cell !== undefined && reachable(cell) && cell.row !== undefined, cellName(tool, source)).toBe(true);
      }
    }
    // A cell with a row is a source the table lists, so the table and the collector cannot drift apart silently.
    for (const c of MATRIX) {
      if (!reachable(c) || c.row === undefined || c.source === "none") continue;
      const s = SIGN_INS[c.tool]!;
      expect(s.sources.includes(c.source), cellName(c.tool, c.source)).toBe(true);
    }
  });

  it("every status check is typed with the secrets file sourced first, so a key the secrets step set counts before any check reads", () => {
    for (const tool of tools) {
      const status = statusOf(SIGN_INS[tool]!);
      if (status === undefined) continue;
      expect(typedLine(tool), tool).toMatch(/^\. \/etc\/profile\.d\/wsp-secrets\.sh 2>\/dev\/null; /);
      expect(status.command, tool).not.toMatch(/2>\/dev\/null$/);
    }
  });
});

describe("the sign-in matrix, cell by cell", () => {
  it.each(MATRIX.map(c => ({ name: cellName(c.tool, c.source), c })))("$name", async ({ c }) => {
    if (!reachable(c)) {
      if (c.laptop === undefined) return;
      const rows = await detectLogins(fakeHost(c.laptop));
      expect(rows.filter(r => r.id === `logins/${c.tool}`), c.unreachable).toEqual([]);
      return;
    }
    // The laptop side: this source alone, the row the collector makes of it, and no value from the laptop in it.
    const rows = await detectLogins(fakeHost(c.laptop));
    const own = rows.filter(r => r.id === `logins/${c.tool}`);
    if (c.row === undefined) expect(own, c.reach).toEqual([]);
    else expect(own).toEqual([expect.objectContaining({ rung: "logins", id: `logins/${c.tool}`, ...c.row })]);
    for (const v of FAKE_VALUES) expect(JSON.stringify(rows)).not.toContain(v);

    // The guest side: the row's state and words, the exact line typed, and no value or escape byte in the note.
    const g = guest(c.tool, c.choice ?? "copy", c.answer);
    const [r] = await g.run;
    expect(r).toMatchObject({ id: `logins/${c.tool}`, state: c.state, note: c.note });
    if (c.answer === undefined) expect(g.link.ptys).toEqual([]);
    else {
      expect(g.link.ptys.map(p => p.writes)).toEqual([[typedLine(c.tool)]]);
      expect(g.link.ptys[0]!.created).toEqual({ cols: 200, rows: 50, shell: "/bin/sh", env: { PS1: "" } });
    }
    const words = JSON.stringify([r, g.text()]);
    for (const v of FAKE_VALUES) expect(words).not.toContain(v);
    expect(r!.note).not.toMatch(/\x1b/);
  });

  it("claude x helper, refused: the status names the helper while its key file is missing or empty, and the row says so instead of not signed in", async () => {
    const g = guest("claude", "copy", { output: CLAUDE_HELPER, exitCode: 0 });
    const [r] = await g.run;
    expect(r).toEqual({ id: "logins/claude", label: "claude", state: "not-signed-in", note: "copied, but claude auth status names the settings.json helper while its key file is missing or empty on the machine" });
    expect(g.link.ptys.map(p => p.writes)).toEqual([[typedLine("claude")]]);
  });

  it.each(MISSING)("%s: a guest without the tool leaves the copied login not verified, with the shell's own 127 and no status read", async tool => {
    const status = statusOf(SIGN_INS[tool]!)!;
    const [r] = await guest(tool, "copy", { output: `sh: 1: ${tool === "kube" ? "kubectl" : tool}: not found`, exitCode: 127 }).run;
    expect(r).toEqual({ id: `logins/${tool}`, label: tool, state: "copied", command: status.command, exit: 127, note: `not verified: ${tool === "kube" ? "kubectl" : tool} is not on the machine` });
  });

  it("aws and gemini have no missing-tool cell: aws's check runs inside sh -c and gemini's is shell builtins, so both answer not signed in instead", async () => {
    expect((await guest("aws", "copy", { output: "", exitCode: 1 }).run)[0]).toMatchObject({ state: "not-signed-in", note: `copied, but ${AWS_STATUS} says not signed in` });
    expect((await guest("gemini", "copy", { output: "", exitCode: 1 }).run)[0]).toMatchObject({ state: "not-signed-in", note: `copied, but ${GEMINI_STATUS} says not signed in` });
    expect(MISSING).not.toContain("aws");
    expect(MISSING).not.toContain("gemini");
    expect(MISSING.concat("aws", "gemini", "cloudflared", "op").sort()).toEqual(collectorLogins().sort());
  });
});
