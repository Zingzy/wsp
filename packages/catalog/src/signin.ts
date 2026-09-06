// SPDX-License-Identifier: AGPL-3.0-only
// How a catalog entry is signed into on the machine: the command to run, the
// variant that needs no browser there (the retry when the shim and the
// callback forward did not land), the tool's own status command that proves
// the login, and how long the tool itself waits before it gives up. Nothing
// here reads the tool's output beyond the status lines named below.
import { CLAUDE_CONFIG_DIR, CLAUDE_KEY_FILE } from "./roads.js";

export interface StatusCheck {
  /** The command as the row and the golden's notes show it. */
  command: string;
  /** The line typed on the guest when it carries shell plumbing the shown command leaves out; absent, the command is typed as shown. */
  typed?: string;
  /** Reads the status command's exit code and output; never anything the login printed. */
  signedIn(output: string, exitCode: number): boolean;
  /** Which of a tool's login sources the status says is in use, for the row; `secrets` maps a name the
   * secrets step set on the machine to the file it was cut from. Absent or undefined: the row names none. */
  detail?(output: string, secrets: ReadonlyMap<string, string>): string | undefined;
  /** Why a status was refused when its own words would not say; absent, the row says the command said not signed in. */
  why?(output: string): string | undefined;
}

/** How a login is present on this computer and how it travels: a Keychain item (found by service name, read at copy
 * time with consent, placed as the tool's file on the machine), an API key exported in a shell rc file (found by name,
 * cut from the file and set on the machine before any check), a credential file (found by path and copied), or an
 * apiKeyHelper command in a settings file (run here at copy time, its key placed in a 0600 file the copied settings
 * read). Verification is the row's status, whichever source signed the tool in. */
export type LoginSource = "keychain" | "rc-key" | "file" | "helper";

/** The flow a tool's sign-in takes: a browser with a callback (oauth), a code typed on a page the machine names
 * (device), a key pasted or exported (key), or nothing to run on a headless machine (none). */
export type SignInKind = "oauth" | "device" | "key" | "none";

/** Key files beside a login that no sign-in on the machine produces: they travel only by copy, as a row of their
 * own under the login's id plus "-keys", and the login's own status proves them once landed. */
export interface KeyFiles {
  /** `~/`-relative. */
  paths: readonly string[];
  /** The keys row's second detail line: what the files hold and why only a copy brings them. */
  note: string;
}

export type SignIn =
  | {
      kind: Exclude<SignInKind, "none">;
      login: string;
      /** The sources the collector finds and the pack carries for this tool; empty when nothing of it travels. */
      sources: readonly LoginSource[];
      /** The device-code, paste-code or no-browser variant, offered on a retry. */
      fallback?: string;
      /** The shape the one-time code prints in, for a flow whose page asks for one; matched against what the tool
       * printed, past the URLs it printed. Absent, the flow shows no code and none is read out of its output. */
      code?: RegExp;
      /** The variable the tool reads an API key from; a key loaded on this computer is set under it on the machine. */
      keyEnv?: string;
      /** Absent when the tool has no status command: the login is then "not verified". */
      status?: StatusCheck;
      /** What the tool itself waits for the person, measured or read from its source; absent when it never gives up. */
      toolTimeoutMs?: number;
      note?: string;
      keys?: KeyFiles;
    }
  /** Nothing to run on a headless machine; the note, when there is one, says what to do instead. A status still proves copied files. */
  | { kind: "none"; note?: string; sources: readonly LoginSource[]; status?: StatusCheck };

export type LoginSignIn = Extract<SignIn, { login: string }>;

/** A sign-in the wizard runs as a command on the machine. */
export function hasLogin(s: SignIn | { kind: "shell" }): s is LoginSignIn {
  return s.kind !== "none" && s.kind !== "shell";
}

/** Whether a login starts as a sign-in on the machine: a browser or device flow the relay finishes there. A key has no
 * browser flow to produce it and a tool with no sign-in has nothing to run, so those start as a copy. */
export function signsInByDefault(s: SignIn | { kind: "shell" }): boolean {
  return s.kind === "oauth" || s.kind === "device";
}

/** The login id the collector files an entry's row under, where it differs from the entry's id: kubectl's row is its kubeconfig. */
const LOGIN_IDS: Readonly<Record<string, string>> = { kubectl: "kube" };

export function loginIdOf(entryId: string): string {
  return LOGIN_IDS[entryId] ?? entryId;
}

const KEYS_SUFFIX = "-keys";

/** The login id the collector files an entry's key files under. */
export function keysIdOf(entryId: string): string {
  return `${loginIdOf(entryId)}${KEYS_SUFFIX}`;
}

/** The row a login's key files make: nothing to run on the machine, and the login's own status proves the copy. */
export function keysRowOf(keys: KeyFiles, status: StatusCheck | undefined): SignIn {
  return { kind: "none", sources: ["file"], note: keys.note, ...(status !== undefined ? { status } : {}) };
}

/** No sign-in and nothing to say about it. */
export const NO_SIGN_IN: SignIn = { kind: "none", sources: [] };

const MIN = 60_000;

/** In a subshell so its exits never cut the quiet run's own exit marker. */
export const AWS_STATUS = `sh -c 'for p in $(aws configure list-profiles 2>/dev/null); do aws sts get-caller-identity --profile "$p" 2>/dev/null && exit 0; done; exit 1'`;

/** Gemini CLI has no status command: its Google sign-in caches oauth_creds.json under ~/.gemini and its other two
 * sign-ins are these keys, so the line echoes what it finds. No exit, so a miss never cuts the quiet run's marker. */
export const GEMINI_STATUS = `if test -s "$HOME/.gemini/oauth_creds.json"; then echo oauth_creds.json; elif test -n "$GEMINI_API_KEY"; then echo GEMINI_API_KEY; elif test -n "$GOOGLE_API_KEY"; then echo GOOGLE_API_KEY; else false; fi`;

/** cloudflared has no status command: its login writes the origin certificate and nothing else, so the line proves the file. */
export const CLOUDFLARED_STATUS = `if test -s "$HOME/.cloudflared/cert.pem"; then echo cert.pem; else false; fi`;

/** The helper's key on the guest: the pack places it under Claude Code's config dir and rewrites the copied settings to cat it. */
export const CLAUDE_KEY_PATH = `${CLAUDE_CONFIG_DIR}/${CLAUDE_KEY_FILE}`;
const KEY_MARK = "WSP_KEY_FILE";

/** Measured on 2.1.257: with any apiKeyHelper configured the status says logged in without running the helper, so the
 * typed line also proves the key file is present and non-empty; claude's own exit is kept for the marker. */
export const CLAUDE_STATUS = `claude auth status; s=$?; test -s ${CLAUDE_KEY_PATH} && echo ${KEY_MARK}; (exit $s)`;

const has = (re: RegExp) => (output: string): boolean => re.test(output);
const ok = (re?: RegExp) => (output: string, exitCode: number): boolean => exitCode === 0 && (re === undefined || re.test(output));

/** A key named by the status, by the file the secrets step cut it from, or as the machine's own when that step did not set it. */
function keyFrom(name: string, secrets: ReadonlyMap<string, string>): string {
  const from = secrets.get(name);
  return from === undefined ? `API key from ${name} on the machine` : `API key from ${from}, set on the machine as a secret`;
}

/** The first key the secrets step set that the status output names as a word: that key is the login's source. */
export function secretNamed(output: string, secrets: ReadonlyMap<string, string>): string | undefined {
  const words = new Set(output.split(/[^A-Za-z0-9_]+/));
  for (const [name, from] of secrets) if (words.has(name)) return `API key from ${from}, set on the machine as a secret`;
  return undefined;
}

/** What the gemini line echoed: the cached Google sign-in, or the key it found. */
export function geminiSource(output: string, secrets: ReadonlyMap<string, string>): string | undefined {
  const found = output.trim().split(/\s+/).at(-1);
  if (found === "oauth_creds.json") return "OAuth credentials";
  if (found === "GEMINI_API_KEY" || found === "GOOGLE_API_KEY") return keyFrom(found, secrets);
  return undefined;
}

/** The JSON claude auth status printed, when it did. */
function claudeStatus(output: string): Record<string, unknown> | undefined {
  const json = /\{[\s\S]*\}/.exec(output)?.[0];
  if (json === undefined) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const keyFileSeen = (output: string): boolean => new RegExp(`^${KEY_MARK}$`, "m").test(output);
const helperNamed = (status: Record<string, unknown> | undefined): boolean => status?.["loggedIn"] === true && status["apiKeySource"] === "apiKeyHelper";

/** Logged in, and when the helper is the source, its key file is there to read. */
export function claudeSignedIn(output: string): boolean {
  const status = claudeStatus(output);
  return status?.["loggedIn"] === true && (!helperNamed(status) || keyFileSeen(output));
}

export function claudeWhy(output: string): string | undefined {
  return helperNamed(claudeStatus(output)) && !keyFileSeen(output) ? "claude auth status names the settings.json helper while its key file is missing or empty on the machine" : undefined;
}

/** What claude auth status says the key comes from (measured on 2.1.257): apiKeySource names ANTHROPIC_API_KEY or
 * apiKeyHelper when an API key is in use, authMethod is claude.ai on OAuth credentials alone. */
export function claudeSource(output: string, secrets: ReadonlyMap<string, string>): string | undefined {
  const status = claudeStatus(output);
  if (status === undefined) return undefined;
  if (status["apiKeySource"] === "ANTHROPIC_API_KEY") return keyFrom("ANTHROPIC_API_KEY", secrets);
  if (status["apiKeySource"] === "apiKeyHelper") return `API key from the settings.json helper${keyFileSeen(output) ? ", key file present" : ""}`;
  if (status["loggedIn"] === true && status["authMethod"] === "claude.ai") return "OAuth credentials";
  return undefined;
}

/** The sign-in rows of the entries that have one, by the tool's name; a row's words are the wizard's. */
export const SIGN_IN_ROWS = {
  // Device flow by default; the shim opens the device page and the person types the code there. The status lists
  // every account of the host, so one is signed in only when none of them failed.
  gh: {
    kind: "device",
    sources: ["file", "keychain"],
    login: "gh auth login",
    // Two groups of four, as gh prints it: "! First copy your one-time code: XXXX-XXXX".
    code: /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/,
    status: { command: "gh auth status", signedIn: o => /Logged in to/.test(o) && !/Failed to log in/.test(o) },
    toolTimeoutMs: 15 * MIN,
  },
  // Under the daemon pty DISPLAY is unset, so gcloud, gemini and railway take their paste or device flow by themselves.
  gcloud: {
    kind: "oauth",
    sources: ["file"],
    login: "gcloud auth login",
    status: { command: "gcloud auth list --filter=status:ACTIVE --format=value(account)", signedIn: ok(/@/) },
  },
  // A fresh machine has no sso-session profile, so the login is the one that writes it first; it names
  // the profile {role}-{account} by default, so the check tries every configured profile.
  aws: {
    kind: "oauth",
    sources: ["file"],
    login: "aws configure sso",
    fallback: "aws configure sso --use-device-code",
    status: { command: AWS_STATUS, signedIn: ok(/"Arn"/) },
    toolTimeoutMs: 10 * MIN,
    note: "the check tries every configured profile",
  },
  // --browser=false still binds the callback port, so there is no flag around the callback.
  wrangler: {
    kind: "oauth",
    sources: ["file"],
    login: "wrangler login",
    status: { command: "wrangler whoami", signedIn: has(/You are logged in/) },
    toolTimeoutMs: 2 * MIN,
    note: "needs the callback forward; CLOUDFLARE_API_TOKEN on the machine is the alternative",
  },
  vercel: { kind: "oauth", sources: ["file"], login: "vercel login", status: { command: "vercel whoami", signedIn: (o, c) => c === 0 && !/No existing credentials/.test(o) }, toolTimeoutMs: 15 * MIN },
  netlify: { kind: "oauth", sources: [], login: "netlify login", status: { command: "netlify status", signedIn: (o, c) => c === 0 && !/Not logged in/i.test(o) }, toolTimeoutMs: 5 * MIN },
  fly: { kind: "oauth", sources: [], login: "fly auth login", status: { command: "fly auth whoami", signedIn: ok(/@/) }, toolTimeoutMs: 15 * MIN },
  supabase: { kind: "oauth", sources: [], login: "supabase login", fallback: "supabase login --no-browser", status: { command: "supabase projects list", signedIn: ok() } },
  railway: { kind: "oauth", sources: [], login: "railway login", status: { command: "railway whoami", signedIn: ok(/Logged in as/) }, toolTimeoutMs: 5 * MIN },
  doppler: { kind: "oauth", sources: [], login: "doppler login", status: { command: "doppler me", signedIn: ok() }, toolTimeoutMs: 5 * MIN },
  // The shim gets the localhost-callback URL and the terminal the hosted paste-code one; either finishes the login.
  claude: {
    kind: "oauth",
    sources: ["keychain", "rc-key", "file", "helper"],
    keyEnv: "ANTHROPIC_API_KEY",
    login: "claude auth login",
    status: { command: "claude auth status", typed: CLAUDE_STATUS, signedIn: claudeSignedIn, detail: claudeSource, why: claudeWhy },
  },
  codex: { kind: "oauth", sources: ["file"], login: "codex login", fallback: "codex login --device-auth", status: { command: "codex login status", signedIn: ok(/Logged in using/) } },
  gemini: { kind: "oauth", sources: ["file"], login: "gemini", status: { command: GEMINI_STATUS, signedIn: ok(), detail: geminiSource }, toolTimeoutMs: 5 * MIN },
  // Both counts print on exit 0; a provider key exported on the machine is listed under Environment and counts as a login.
  opencode: {
    kind: "key",
    sources: ["file"],
    login: "opencode auth login",
    status: { command: "opencode auth list", signedIn: ok(/[1-9]\d* (credentials|environment variable)/), detail: secretNamed },
    note: "OpenCode dropped its Anthropic sign-in in 1.3.0; it takes an API key there",
    toolTimeoutMs: 5 * MIN,
  },
  cloudflared: { kind: "oauth", sources: ["file"], login: "cloudflared tunnel login", status: { command: CLOUDFLARED_STATUS, signedIn: ok() } },
  op: { kind: "none", sources: [], note: "needs the 1Password desktop app; set OP_SERVICE_ACCOUNT_TOKEN on the machine instead" },
  // kubectl v1.36.1 puts a kuberc warning on stderr with no newline, so on the merged pty it would glue onto the context.
  kubectl: {
    kind: "none",
    sources: ["file"],
    note: "kubectl has no sign-in; copy the kubeconfig instead",
    status: { command: "kubectl config current-context", typed: "kubectl config current-context 2>/dev/null", signedIn: ok(/\S/), detail: o => `context ${o.trim()}` },
  },
  // pi lists a model only for a provider it holds credentials for, and prints a /login hint on exit 0 when it holds none.
  pi: { kind: "oauth", sources: ["file"], login: "pi", status: { command: "pi --list-models", signedIn: ok(/^provider\s+model\b/m) }, note: "type /login inside pi and pick a provider, then /exit; a key on the machine counts" },
  // The pool lists keys from ~/.hermes/.env and the environment beside stored logins; with none it prints nothing on exit 0.
  hermes: {
    kind: "device",
    sources: ["file"],
    login: "hermes auth",
    status: { command: "hermes auth list", signedIn: ok(/\(\d+ credentials\):/), detail: secretNamed },
    note: "pick Add a credential in the menu; keys in ~/.hermes/.env count",
    keys: { paths: ["~/.hermes/.env"], note: "the keys in ~/.hermes/.env travel only by copy; no sign-in produces them" },
  },
} satisfies Record<string, SignIn>;
