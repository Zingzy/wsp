// SPDX-License-Identifier: AGPL-3.0-only
// What wsp init does with the collector's manifest: which rows start ticked,
// what a login defaults to, the recipe file (the same list with the person's
// ticks, saved next to the state so golden v2 is a re-run of it), and the
// golden recipe the ticked rows add up to.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type LoginChoice, type Manifest, type ManifestEntry, type Rung, parseManifest } from "@wsp/collect";
import type { GoldenImport, GoldenRecipe, Machine } from "@wsp/runtime";
import type { Keys } from "./cli.js";
import { GUEST_ENVS, claudeEnvs } from "./doctor.js";

export const RUNG_TITLE: Record<Rung, string> = {
  identity: "Identity",
  shell: "Shell",
  editors: "Editors",
  toolchains: "Toolchains",
  tools: "Tools",
  agents: "Agents",
  logins: "Sign-ins",
};

/** The prompt's words for each login choice; the choices themselves are the collector's. */
export const LOGIN_CHOICES: readonly { value: LoginChoice; label: string }[] = [
  { value: "copy", label: "copy" },
  { value: "machine", label: "sign in" },
  { value: "skip", label: "skip" },
];

export function isTickable(e: ManifestEntry): boolean {
  return !(e.default === "skip" && e.reason !== undefined);
}

export function initialTicks(e: ManifestEntry): boolean {
  if (!isTickable(e)) return false;
  if (e.required) return true;
  return e.bring ?? e.default === "bring";
}

/** A login that cannot be copied (a reason, or a skip default) is signed in on the machine. */
export function initialChoice(e: ManifestEntry): LoginChoice {
  if (e.choice !== undefined) return e.choice;
  if (!isTickable(e)) return "machine";
  if (e.bring !== undefined) return e.bring ? "copy" : "machine";
  return e.default === "bring" ? "copy" : "machine";
}

const SIGN_IN_COMMANDS: Record<string, string> = {
  gh: "gh auth login",
  claude: "claude, then /login",
  codex: "codex login",
  gemini: "gemini",
  opencode: "opencode auth login",
  gcloud: "gcloud auth login",
  aws: "aws sso login",
  wrangler: "wrangler login",
  vercel: "vercel login",
  cloudflared: "cloudflared tunnel login",
};

export function signInCommand(e: ManifestEntry): string | undefined {
  return SIGN_IN_COMMANDS[agentName(e)];
}

export interface ChecklistItem {
  label: string;
  command: string;
}

/** The sign-ins the person chose to do on the machine, for the browser's checklist. */
export function checklistFor(manifest: Manifest, choices: ReadonlyMap<string, string>): ChecklistItem[] {
  return manifest.entries
    .filter(e => e.rung === "logins" && choices.get(e.id) === "machine")
    .map(e => ({ label: e.label, command: signInCommand(e) ?? "sign in as the tool asks" }));
}

/** A login that belongs to an agent is only offered when that agent comes along. */
export function loginShown(e: ManifestEntry, manifest: Manifest, ticks: ReadonlySet<string>): boolean {
  if (e.rung !== "logins") return true;
  const agent = manifest.entries.find(a => a.rung === "agents" && agentName(a) === agentName(e));
  return agent === undefined || ticks.has(agent.id);
}

export function isLoginChoice(v: unknown): v is LoginChoice {
  return LOGIN_CHOICES.some(c => c.value === v);
}

export function loadManifest(path: string): Manifest {
  if (!existsSync(path)) throw new Error(`no manifest at ${path}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return parseManifest(data);
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function recipePath(statePath: string): string {
  return join(dirname(statePath), "golden-recipe.json");
}

export function saveRecipe(path: string, manifest: Manifest, ticks: ReadonlySet<string>, choices: ReadonlyMap<string, string> = new Map()): void {
  const entries = manifest.entries.map(e => {
    const choice = choices.get(e.id);
    return { ...e, bring: ticks.has(e.id), ...(isLoginChoice(choice) ? { choice } : {}) };
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ entries }, null, 2)}\n`);
}

export function agentName(e: ManifestEntry): string {
  return e.id.split("/").at(-1) ?? e.id;
}

/** What the builder runs. The harness line and smoke are bare: the import
 * carries every ticked agent with its own installer and version check, and
 * the builder's seal smokes the ones that installed. Nothing ticked means a
 * bare machine that still has to fork and boot to seal. */
export function goldenRecipeFor(
  bring: readonly ManifestEntry[],
  keys: Pick<Keys, "anthropic">,
  hooks: { deployDaemon?: (machine: Machine) => Promise<void | string>; import?: GoldenImport } = {},
): GoldenRecipe {
  const claude = bring.some(e => e.rung === "agents" && agentName(e) === "claude");
  return {
    setup: "true",
    smoke: "true",
    cpu: 2,
    memMb: 4096,
    envs: claude ? claudeEnvs(keys.anthropic) : { ...GUEST_ENVS },
    ...(hooks.deployDaemon !== undefined ? { deployDaemon: hooks.deployDaemon } : {}),
    ...(hooks.import !== undefined ? { import: hooks.import } : {}),
  };
}
