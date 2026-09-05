// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in rows the init terminal runs, read off the catalog by the login
// id the collector emits; a tool the catalog does not know gets a shell where
// the person types the tool's own command.
import { CATALOG, hasLogin, type SignIn as CatalogSignIn, type StatusCheck } from "@wsp/catalog";

export type { LoginSource, StatusCheck } from "@wsp/catalog";
export { AWS_STATUS, CLAUDE_KEY_PATH, CLAUDE_STATUS, CLOUDFLARED_STATUS, GEMINI_STATUS, claudeSource, claudeWhy, geminiSource, hasLogin, secretNamed } from "@wsp/catalog";

/** A catalog row, or a shell for a tool with no row. */
export type SignIn = CatalogSignIn | { kind: "shell" };

/** The collector files kubectl's kubeconfig row under the directory's name. */
const LOGIN_IDS: Readonly<Record<string, string>> = { kubectl: "kube" };

/** Every catalog entry with a sign-in to run or a note about it, by the login id the collector emits. */
export const SIGN_INS: Readonly<Record<string, CatalogSignIn>> = Object.fromEntries(CATALOG.filter(e => hasLogin(e.signIn) || e.signIn.note !== undefined).map(e => [LOGIN_IDS[e.id] ?? e.id, e.signIn]));

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
  if (hasLogin(s)) return s.login;
  return s.kind === "shell" ? "sign in as the tool asks" : (s.note ?? "no sign-in");
}
