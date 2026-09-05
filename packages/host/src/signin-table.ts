// SPDX-License-Identifier: AGPL-3.0-only
// One row per CLI the init terminal can sign into: the command to run, the
// variant that needs no browser on the machine (the retry when the shim and
// the callback forward did not land), the tool's own status command that
// proves the login, and how long the tool itself waits before it gives up.
// Nothing here reads the tool's output beyond the status lines named below.

export interface StatusCheck {
  command: string;
  /** Reads the status command's exit code and output; never anything the login printed. */
  signedIn(output: string, exitCode: number): boolean;
  /** Which of a tool's login sources the status says is in use, for the row; `secrets` maps a name the
   * secrets step set on the machine to the file it was cut from. Absent or undefined: the row names none. */
  detail?(output: string, secrets: ReadonlyMap<string, string>): string | undefined;
}

export type SignIn =
  | {
      kind: "command";
      login: string;
      /** The device-code, paste-code or no-browser variant, offered on a retry. */
      fallback?: string;
      /** Absent when the tool has no status command: the login is then "not verified". */
      status?: StatusCheck;
      /** What the tool itself waits for the person, measured or read from its source; absent when it never gives up. */
      toolTimeoutMs?: number;
      note?: string;
    }
  /** No table row: a shell where the person types the tool's own command. */
  | { kind: "shell" }
  /** Nothing to run on a headless machine; the note says what to do instead. A status still proves copied files. */
  | { kind: "none"; note: string; status?: StatusCheck };

const MIN = 60_000;

/** In a subshell so its exits never cut the quiet run's own exit marker. */
export const AWS_STATUS = `sh -c 'for p in $(aws configure list-profiles 2>/dev/null); do aws sts get-caller-identity --profile "$p" 2>/dev/null && exit 0; done; exit 1'`;

/** Gemini CLI has no status command: its Google sign-in caches oauth_creds.json under ~/.gemini and its other two
 * sign-ins are these keys, so the line echoes what it finds. No exit, so a miss never cuts the quiet run's marker. */
export const GEMINI_STATUS = `if test -s "$HOME/.gemini/oauth_creds.json"; then echo oauth_creds.json; elif test -n "$GEMINI_API_KEY"; then echo GEMINI_API_KEY; elif test -n "$GOOGLE_API_KEY"; then echo GOOGLE_API_KEY; else false; fi`;

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

/** What claude auth status says the key comes from (measured on 2.1.257): apiKeySource names ANTHROPIC_API_KEY or
 * apiKeyHelper when an API key is in use, authMethod is claude.ai on OAuth credentials alone. */
export function claudeSource(output: string, secrets: ReadonlyMap<string, string>): string | undefined {
  const json = /\{[\s\S]*\}/.exec(output)?.[0];
  if (json === undefined) return undefined;
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (status["apiKeySource"] === "ANTHROPIC_API_KEY") return keyFrom("ANTHROPIC_API_KEY", secrets);
  if (status["apiKeySource"] === "apiKeyHelper") return "API key from the settings.json helper";
  if (status["loggedIn"] === true && status["authMethod"] === "claude.ai") return "OAuth credentials";
  return undefined;
}

export const SIGN_INS: Readonly<Record<string, SignIn>> = {
  // Device flow by default; the shim opens the device page and the person types the code there. The status lists
  // every account of the host, so one is signed in only when none of them failed.
  gh: { kind: "command", login: "gh auth login", status: { command: "gh auth status", signedIn: o => /Logged in to/.test(o) && !/Failed to log in/.test(o) }, toolTimeoutMs: 15 * MIN },
  // Under the daemon pty DISPLAY is unset, so gcloud, gemini and railway take their paste or device flow by themselves.
  gcloud: {
    kind: "command",
    login: "gcloud auth login",
    status: { command: "gcloud auth list --filter=status:ACTIVE --format=value(account)", signedIn: ok(/@/) },
  },
  // A fresh machine has no sso-session profile, so the login is the one that writes it first; it names
  // the profile {role}-{account} by default, so the check tries every configured profile.
  aws: {
    kind: "command",
    login: "aws configure sso",
    fallback: "aws configure sso --use-device-code",
    status: { command: AWS_STATUS, signedIn: ok(/"Arn"/) },
    toolTimeoutMs: 10 * MIN,
    note: "the check tries every configured profile",
  },
  // --browser=false still binds the callback port, so there is no flag around the callback.
  wrangler: {
    kind: "command",
    login: "wrangler login",
    status: { command: "wrangler whoami", signedIn: has(/You are logged in/) },
    toolTimeoutMs: 2 * MIN,
    note: "needs the callback forward; CLOUDFLARE_API_TOKEN on the machine is the alternative",
  },
  vercel: { kind: "command", login: "vercel login", status: { command: "vercel whoami", signedIn: (o, c) => c === 0 && !/No existing credentials/.test(o) }, toolTimeoutMs: 15 * MIN },
  netlify: { kind: "command", login: "netlify login", status: { command: "netlify status", signedIn: (o, c) => c === 0 && !/Not logged in/i.test(o) }, toolTimeoutMs: 5 * MIN },
  fly: { kind: "command", login: "fly auth login", status: { command: "fly auth whoami", signedIn: ok(/@/) }, toolTimeoutMs: 15 * MIN },
  supabase: { kind: "command", login: "supabase login", fallback: "supabase login --no-browser", status: { command: "supabase projects list", signedIn: ok() } },
  railway: { kind: "command", login: "railway login", status: { command: "railway whoami", signedIn: ok(/Logged in as/) }, toolTimeoutMs: 5 * MIN },
  doppler: { kind: "command", login: "doppler login", status: { command: "doppler me", signedIn: ok() }, toolTimeoutMs: 5 * MIN },
  // The shim gets the localhost-callback URL and the terminal the hosted paste-code one; either finishes the login.
  claude: { kind: "command", login: "claude auth login", status: { command: "claude auth status", signedIn: has(/"loggedIn":\s*true/), detail: claudeSource } },
  codex: { kind: "command", login: "codex login", fallback: "codex login --device-auth", status: { command: "codex login status", signedIn: ok(/Logged in using/) } },
  gemini: { kind: "command", login: "gemini", status: { command: GEMINI_STATUS, signedIn: ok(), detail: geminiSource }, toolTimeoutMs: 5 * MIN },
  // Both counts print on exit 0; a provider key exported on the machine is listed under Environment and counts as a login.
  opencode: {
    kind: "command",
    login: "opencode auth login",
    status: { command: "opencode auth list", signedIn: ok(/[1-9]\d* (credentials|environment variable)/), detail: secretNamed },
    note: "OpenCode dropped its Anthropic sign-in in 1.3.0; it takes an API key there",
    toolTimeoutMs: 5 * MIN,
  },
  cloudflared: { kind: "command", login: "cloudflared tunnel login" },
  op: { kind: "none", note: "needs the 1Password desktop app; set OP_SERVICE_ACCOUNT_TOKEN on the machine instead" },
  kube: { kind: "none", note: "kubectl has no sign-in; copy the kubeconfig instead", status: { command: "kubectl config current-context", signedIn: ok(/\S/), detail: o => `context ${o.trim()}` } },
  // pi lists a model only for a provider it holds credentials for, and prints a /login hint on exit 0 when it holds none.
  pi: { kind: "command", login: "pi", status: { command: "pi --list-models", signedIn: ok(/^provider\s+model\b/m) }, note: "type /login inside pi and pick a provider, then /exit; a key on the machine counts" },
  // The pool lists keys from ~/.hermes/.env and the environment beside stored logins; with none it prints nothing on exit 0.
  hermes: { kind: "command", login: "hermes auth", status: { command: "hermes auth list", signedIn: ok(/\(\d+ credentials\):/), detail: secretNamed }, note: "pick Add a credential in the menu; keys in ~/.hermes/.env count" },
};

/** The status check a row carries, whichever kind it is. */
export function statusOf(s: SignIn): StatusCheck | undefined {
  return s.kind === "shell" ? undefined : s.status;
}

/** The row for a tool by its name (the last segment of a manifest id). */
export function signInFor(name: string): SignIn {
  return SIGN_INS[name] ?? { kind: "shell" };
}

/** The words a step header shows for the row. */
export function signInWords(s: SignIn): string {
  switch (s.kind) {
    case "command":
      return s.login;
    case "shell":
      return "sign in as the tool asks";
    case "none":
      return s.note;
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}
