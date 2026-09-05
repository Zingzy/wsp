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
  /** Nothing to run on a headless machine; the note says what to do instead. */
  | { kind: "none"; note: string };

const MIN = 60_000;

/** In a subshell so its exits never cut the quiet run's own exit marker. */
export const AWS_STATUS = `sh -c 'for p in $(aws configure list-profiles 2>/dev/null); do aws sts get-caller-identity --profile "$p" 2>/dev/null && exit 0; done; exit 1'`;

const has = (re: RegExp) => (output: string): boolean => re.test(output);
const ok = (re?: RegExp) => (output: string, exitCode: number): boolean => exitCode === 0 && (re === undefined || re.test(output));

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
  claude: { kind: "command", login: "claude auth login", status: { command: "claude auth status", signedIn: has(/"loggedIn":\s*true/) } },
  codex: { kind: "command", login: "codex login", fallback: "codex login --device-auth", status: { command: "codex login status", signedIn: ok(/Logged in using/) } },
  gemini: { kind: "command", login: "gemini", toolTimeoutMs: 5 * MIN },
  opencode: { kind: "command", login: "opencode auth login", note: "OpenCode dropped its Anthropic sign-in in 1.3.0; it takes an API key there", toolTimeoutMs: 5 * MIN },
  cloudflared: { kind: "command", login: "cloudflared tunnel login" },
  op: { kind: "none", note: "needs the 1Password desktop app; set OP_SERVICE_ACCOUNT_TOKEN on the machine instead" },
  kube: { kind: "none", note: "kubectl has no sign-in; copy the kubeconfig instead" },
  pi: { kind: "none", note: "takes API keys; set them on the machine" },
  hermes: { kind: "none", note: "takes API keys; set them on the machine" },
};

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
