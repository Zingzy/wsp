// SPDX-License-Identifier: AGPL-3.0-only
// What wsp init does with the collector's manifest: which rows start ticked,
// what a login defaults to, the recipe file (the same list with the person's
// ticks, saved next to the state so golden v2 is a re-run of it), and the
// golden recipe the ticked rows add up to.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type LoginChoice, type Manifest, type ManifestEntry, type Rung, parseManifest } from "@wsp/collect";
import { linuxCaskByBin, linuxCaskFor } from "@wsp/catalog";
import { agentOwning, neverCopied, type RecipeDigest } from "@wsp/engine";
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
  everything: "Everything else",
};

/** The prompt's words for each login choice; the choices themselves are the collector's. */
export const LOGIN_CHOICES: readonly { value: LoginChoice; label: string }[] = [
  { value: "copy", label: "copy" },
  { value: "machine", label: "sign in" },
  { value: "skip", label: "skip" },
];

/** A credential-shaped row's two answers: copy it, or leave it here. */
export const CONSENT_CHOICES: readonly { value: LoginChoice; label: string }[] = [
  { value: "copy", label: "copy" },
  { value: "skip", label: "skip" },
];

/** The plan's note when every path of a row is refused by name, asked of the same rule the pack asks with the
 * same answer about what is on disk (`isDir`: true, false, or undefined when the path is not there). */
export function refusedNote(e: ManifestEntry, isDir: (rel: string) => boolean | undefined): string | undefined {
  if (e.rung === "tools" || e.paths.length === 0 || !e.paths.every(p => p.startsWith("~/"))) return undefined;
  const notes = e.paths.map(p => neverCopied({ ...e, bring: true, choice: "copy" }, p.slice(2), isDir(p.slice(2))));
  return notes.every(n => n !== undefined) ? notes[0] : undefined;
}

/** The manifest with the plan's own reason written onto every row the pack would refuse whole, so the screen
 * locks it up front instead of taking a tick the pack throws away; every other row is left as it was. */
export function lockRefused(manifest: Manifest, isDir: (rel: string) => boolean | undefined): Manifest {
  return {
    ...manifest,
    entries: manifest.entries.map(e => {
      const note = e.reason === undefined ? refusedNote(e, isDir) : undefined;
      return note === undefined ? e : { ...e, default: "skip", reason: note };
    }),
  };
}

/** The tools rows for casks that are commands with a Linux release of their own: open to a tick, unticked unless saved so. */
export function linuxCaskRows(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return entries.map(e => {
    if (e.rung !== "tools" || linuxCaskFor(e.id) === undefined) return e;
    const { reason: _reason, ...rest } = e;
    return { ...rest, default: "skip", linux: "yes" };
  });
}

/** The tools rows without a package an agent on the Agents screen installs itself: one tool, one row, one install. */
export function withoutAgentTools(entries: readonly ManifestEntry[]): ManifestEntry[] {
  const agents = new Set(entries.filter(e => e.rung === "agents").map(e => e.id));
  return entries.filter(e => {
    const agent = e.rung === "tools" ? agentOwning(e.id) : undefined;
    return agent === undefined || !agents.has(`agents/${agent}`);
  });
}

/** The command a CLI login is for; an agent's login follows its agent row instead (see loginShown). */
const LOGIN_BIN: Readonly<Record<string, string>> = { gh: "gh", gcloud: "gcloud", wrangler: "wrangler", cloudflared: "cloudflared", vercel: "vercel", aws: "aws", kube: "kubectl" };
/** Packages not named for the command they put on PATH. */
const ROW_BIN: Readonly<Record<string, string>> = { awscli: "aws", "kubernetes-cli": "kubectl", "cloudflare-wrangler": "wrangler" };
/** What would bring a command no tools row lists, when the Linux cask table does not say; the detail pane has 76 columns. */
const BRINGS: Readonly<Record<string, string>> = { gh: "brew install gh", cloudflared: "brew install cloudflared", aws: "brew install awscli", wrangler: "npm install -g wrangler", vercel: "npm install -g vercel" };

/** The command a tools row puts on PATH, when the row is a package or a cask that is a command. */
function rowBin(t: ManifestEntry): string | undefined {
  const cask = linuxCaskFor(t.id);
  if (cask !== undefined) return cask.bin;
  const m = /^tools\/(?:brew|cli|npm|pnpm|bun|uv|pipx|cargo|go)\/(.+)$/.exec(t.id);
  if (m === null) return undefined;
  const pkg = m[1]!;
  return ROW_BIN[pkg] ?? pkg.slice(pkg.lastIndexOf("/") + 1);
}

function brings(bin: string): string {
  const cask = linuxCaskByBin(bin);
  return cask !== undefined ? `a ${cask.casks[0]} cask would bring it` : `${BRINGS[bin] ?? `installing ${bin}`} brings it`;
}

export interface LoginTool {
  /** The command the login is for. */
  bin: string;
  /** The tools row that puts it on the machine, when this computer has one. */
  row?: ManifestEntry;
  /** Whether the command lands on the machine with the ticks as they stand. */
  coming: boolean;
  /** When it is not coming: why, and what brings it. */
  why?: string;
}

/** Whether the command a CLI login needs is coming with the ticks so far; undefined for a login that follows an agent. */
export function loginTool(e: ManifestEntry, manifest: Manifest, coming: ReadonlySet<string>): LoginTool | undefined {
  const bin = e.rung === "logins" ? LOGIN_BIN[agentName(e)] : undefined;
  if (bin === undefined) return undefined;
  const rows = manifest.entries.filter(t => t.rung === "tools" && rowBin(t) === bin);
  const row = rows.find(r => coming.has(r.id)) ?? rows.find(isTickable) ?? rows[0];
  if (row === undefined) return { bin, coming: false, why: `${bin} is not coming: no row lists it; ${brings(bin)}` };
  if (!isTickable(row)) return { bin, row, coming: false, why: `${bin} is not coming: its tool row cannot come (${row.reason})` };
  if (!coming.has(row.id)) return { bin, row, coming: false, why: `${bin} is not coming: its tool row is unticked; copy or sign in ticks it` };
  return { bin, row, coming: true };
}

/** Every login answered copy or sign in ticks the row of the command it needs, when that row can come; the rows ticked, by label. */
export function tickLoginTools(manifest: Manifest, choices: ReadonlyMap<string, string>, ticks: Set<string>): string[] {
  const added: string[] = [];
  for (const e of manifest.entries) {
    const choice = e.rung === "logins" ? choices.get(e.id) : undefined;
    if (choice === undefined || choice === "skip") continue;
    const tool = loginTool(e, manifest, ticks);
    if (tool?.row === undefined || tool.coming || !isTickable(tool.row)) continue;
    ticks.add(tool.row.id);
    added.push(tool.row.label);
  }
  return added;
}

export function isTickable(e: ManifestEntry): boolean {
  return !(e.default === "skip" && e.reason !== undefined);
}

/** A row answered rather than ticked: a login (copy, sign in, skip) or a credential-shaped row (copy, skip). */
export function hasChoices(e: ManifestEntry): boolean {
  return e.rung === "logins" || e.consent === true;
}

export function initialTicks(e: ManifestEntry): boolean {
  if (!isTickable(e)) return false;
  if (e.required) return true;
  return e.bring ?? e.default === "bring";
}

/** A login that cannot be copied (a reason, or a skip default) is signed in on the machine. */
export function initialChoice(e: ManifestEntry): LoginChoice {
  // A credential-shaped row copies only on a saved copy answer; a tick alone, or an answer it never offered, is skip.
  if (e.consent === true) return e.choice === "copy" ? "copy" : "skip";
  if (e.choice !== undefined) return e.choice;
  if (!isTickable(e)) return "machine";
  if (e.bring !== undefined) return e.bring ? "copy" : "machine";
  return e.default === "bring" ? "copy" : "machine";
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
  writeFileSync(path, `${JSON.stringify({ entries, ...(manifest.groups !== undefined ? { groups: manifest.groups } : {}) }, null, 2)}\n`);
}

export function agentName(e: ManifestEntry): string {
  return e.id.split("/").at(-1) ?? e.id;
}

/** What differs between the recipe a builder carries and this run's, in the
 * person's words: a row ticked or unticked, a login answer or tool pin changed,
 * a file added, gone or changed. A row whose tick changed is named once; the
 * files that came or went with it are not listed again. */
export function recipeChanges(from: RecipeDigest, to: RecipeDigest, manifest: Manifest): string[] {
  const label = (id: string): string => manifest.entries.find(e => e.id === id)?.label ?? id;
  const word = (choice: string | undefined): string => LOGIN_CHOICES.find(c => c.value === choice)?.label ?? choice ?? "ticked";
  const out: string[] = [];
  const noted = new Set<string>();
  const was = new Map(from.ticks.map(t => [t.id, t]));
  const now = new Map(to.ticks.map(t => [t.id, t]));
  for (const [id, t] of now) {
    const b = was.get(id);
    if (b === undefined) out.push(`${label(id)} ticked`);
    else if (b.choice !== t.choice) out.push(`${label(id)} now ${word(t.choice)}`);
    else if (b.version !== t.version) out.push(`${label(id)} now ${t.version ?? "unpinned"}`);
    else continue;
    noted.add(id);
  }
  for (const id of was.keys()) {
    if (now.has(id)) continue;
    out.push(`${label(id)} unticked`);
    noted.add(id);
  }
  // Volatile entries are recorded, never hashed, so they never made the hash differ and are not named.
  const had = new Map(from.files.filter(f => f.volatile !== true).map(f => [f.path, f]));
  const has = new Map(to.files.filter(f => f.volatile !== true).map(f => [f.path, f]));
  for (const [path, f] of has) {
    if (noted.has(f.id)) continue;
    const b = had.get(path);
    if (b === undefined) out.push(`${path} added`);
    else if (b.digest !== f.digest || b.dest !== f.dest) out.push(`${path} changed`);
  }
  for (const [path, f] of had) if (!has.has(path) && !noted.has(f.id)) out.push(`${path} gone`);
  return out;
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
