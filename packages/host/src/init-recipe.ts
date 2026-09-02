// SPDX-License-Identifier: AGPL-3.0-only
// The manifest is what the collector found on this machine, one entry per
// thing that could be brought; the recipe file is the same list with the
// person's ticks, saved next to the state so golden v2 is a re-run of it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GoldenRecipe, Machine } from "@wsp/runtime";
import type { Keys } from "./cli.js";
import { GOLDEN_SETUP, GOLDEN_SMOKE, GUEST_ENVS, claudeEnvs } from "./doctor.js";

export const RUNGS = ["identity", "shell", "editors", "toolchains", "tools", "agents", "logins"] as const;
export type Rung = (typeof RUNGS)[number];

export const RUNG_TITLE: Record<Rung, string> = {
  identity: "Identity",
  shell: "Shell",
  editors: "Editors",
  toolchains: "Toolchains",
  tools: "Tools",
  agents: "Agents",
  logins: "Sign-ins",
};

/** What happens to a login: copied from this computer, signed in on the machine, or left out. */
export type LoginChoice = "copy" | "machine" | "skip";
export const LOGIN_CHOICES: readonly { value: LoginChoice; label: string }[] = [
  { value: "copy", label: "copy from this computer" },
  { value: "machine", label: "sign in on the machine" },
  { value: "skip", label: "skip" },
];

export interface ManifestEntry {
  rung: Rung;
  id: string;
  label: string;
  paths: string[];
  bytes: number;
  default: "bring" | "skip";
  /** Why the default is skip; with a reason the entry cannot be ticked (private key, macOS-only). */
  reason?: string;
  /** Heading the entry sits under inside its rung (a package manager, an editor). */
  group?: string;
  /** Always brought: shown, never unticked (git identity, public keys). */
  required?: boolean;
  /** The person's tick from a saved recipe; absent on a fresh collection. */
  bring?: boolean;
  /** The person's answer for a login, from a saved recipe. */
  choice?: LoginChoice;
}

export interface Manifest {
  entries: ManifestEntry[];
}

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

function isLoginChoice(v: unknown): v is LoginChoice {
  return LOGIN_CHOICES.some(c => c.value === v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRung(v: unknown): v is Rung {
  return typeof v === "string" && (RUNGS as readonly string[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === "string");
}

function parseEntry(v: unknown, at: string): ManifestEntry {
  if (!isRecord(v)) throw new Error(`${at} must be an object`);
  const { rung, id, label, paths, bytes, reason, group, required, bring, choice } = v;
  const dflt = v["default"];
  if (!isRung(rung)) throw new Error(`${at}.rung must be one of ${RUNGS.join(", ")}`);
  if (typeof id !== "string" || id === "") throw new Error(`${at}.id must be a string`);
  if (typeof label !== "string") throw new Error(`${at}.label must be a string`);
  if (!isStringArray(paths)) throw new Error(`${at}.paths must be a list of strings`);
  if (typeof bytes !== "number") throw new Error(`${at}.bytes must be a number`);
  if (dflt !== "bring" && dflt !== "skip") throw new Error(`${at}.default must be bring or skip`);
  if (reason !== undefined && typeof reason !== "string") throw new Error(`${at}.reason must be a string`);
  if (group !== undefined && typeof group !== "string") throw new Error(`${at}.group must be a string`);
  if (required !== undefined && typeof required !== "boolean") throw new Error(`${at}.required must be a boolean`);
  if (bring !== undefined && typeof bring !== "boolean") throw new Error(`${at}.bring must be a boolean`);
  if (choice !== undefined && !isLoginChoice(choice)) throw new Error(`${at}.choice must be copy, machine or skip`);
  return {
    rung,
    id,
    label,
    paths,
    bytes,
    default: dflt,
    ...(reason !== undefined ? { reason } : {}),
    ...(group !== undefined ? { group } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(bring !== undefined ? { bring } : {}),
    ...(choice !== undefined ? { choice } : {}),
  };
}

export function parseManifest(data: unknown): Manifest {
  if (!isRecord(data)) throw new Error("manifest must be an object");
  const entries = data["entries"];
  if (!Array.isArray(entries)) throw new Error("manifest.entries must be a list");
  return { entries: entries.map((e, i) => parseEntry(e, `entries[${i}]`)) };
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

interface AgentInstall {
  setup: string;
  smoke: string;
}

/** The agents wsp can install on a builder today. The Claude installer is the
 * one curl|sh the security rules allow; other agents wait for the pinned
 * recipe catalog and are carried in the recipe file only. */
const AGENT_INSTALLS: Record<string, AgentInstall> = {
  claude: { setup: GOLDEN_SETUP, smoke: GOLDEN_SMOKE },
};

export function agentName(e: ManifestEntry): string {
  return e.id.split("/").at(-1) ?? e.id;
}

export function installFor(e: ManifestEntry): AgentInstall | undefined {
  return e.rung === "agents" ? AGENT_INSTALLS[agentName(e)] : undefined;
}

/** What the builder runs: the install line of every ticked agent that has
 * one, and their version checks as the smoke. Nothing ticked means a bare
 * machine that still has to fork and boot to seal. */
export function goldenRecipeFor(
  bring: readonly ManifestEntry[],
  keys: Pick<Keys, "anthropic">,
  hooks: { deployDaemon?: (machine: Machine) => Promise<void | string> } = {},
): GoldenRecipe {
  const installs = bring.map(installFor).filter((i): i is AgentInstall => i !== undefined);
  const claude = bring.some(e => e.rung === "agents" && agentName(e) === "claude");
  return {
    setup: installs.length > 0 ? installs.map(i => i.setup).join(" && ") : "true",
    smoke: installs.length > 0 ? installs.map(i => i.smoke).join(" && ") : "true",
    cpu: 2,
    memMb: 4096,
    envs: claude ? claudeEnvs(keys.anthropic) : { ...GUEST_ENVS },
    ...(hooks.deployDaemon !== undefined ? { deployDaemon: hooks.deployDaemon } : {}),
  };
}
