// SPDX-License-Identifier: AGPL-3.0-only
// Golden import, the planning half: a saved recipe (the collector's rows with
// the person's ticks) becomes the list of laptop files that travel and where
// they land, the Brewfile and per-manager installs, and the pinned installer
// of every ticked agent. Nothing here touches a disk or a machine; golden.ts
// runs the plan on the builder.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MCP_ID_PREFIX, shellQuote, type RecipeDigest } from "@wsp/protocol";
import { APT, PRELUDE } from "./dotfiles-presets.js";
import { APT_ENV, APT_INDEX, APT_UPDATE, BREW, BREW_PREFIX, CATALOG_AGENTS, CLAUDE_KEY_FILE, HOMEBREW, HOMEBREW_STEP, NODE_PATH_LINE, NODE_RELEASES, UV_INSTALL, asLinuxbrew, asLinuxbrewScript, baseEntryFor, baseNote, catalogEntry, installLine, nodeInstallScript, pinStateOf, ROAD_MODULES, roadModule, smokeOf, type AgentEntry, type InstallRoad, type NodeMajor, type RoadName, type ToolPin } from "@wsp/catalog";

export { CLAUDE_KEY_FILE, HOMEBREW, NODE_PATH_LINE, NODE_RELEASES, UV, UV_INSTALL, nodeInstallScript, type NodeMajor, type NodeRelease, type ToolPin } from "@wsp/catalog";

export type { RecipeDigest };

/** The recipe row as this module reads it: a structural subset of the
 * collector's manifest entry, so a recipe file parses straight into it. */
export interface RecipeEntry {
  rung: string;
  id: string;
  label: string;
  paths: readonly string[];
  /** `~`-relative subtrees under paths that stay on the laptop. */
  excludes?: readonly string[];
  /** Entries of paths the tool rewrites while it runs; they travel but never decide the recipe hash. */
  volatile?: readonly string[];
  bytes: number;
  default: "bring" | "skip";
  reason?: string;
  required?: boolean;
  bring?: boolean;
  choice?: string;
  linux?: string;
  /** The version the laptop runs (tools rows); the install pins it. */
  version?: string;
  /** Only on a tools row installed from a release: the tag installed and its asset's sha256, recorded on the first install of that tag and checked while the tag stands. */
  pin?: ToolPin;
  /** Credential-shaped: copied only when `choice` is copy, never on the tick alone. */
  consent?: boolean;
  /** Exported names cut from the carried copy of this file, for the checklist; the pack strips every rc file it stages on its own. */
  secrets?: readonly string[];
  /** Shell rows: the name of the login shell the computer runs, when the collector could read it. */
  login?: string;
  /** Shell rows: the family the person's terminal draws with; the app's pane reads it and nothing on the machine does. */
  font?: string;
}

/** What the planner's injected stat says about one laptop path. A link reports
 * its target's kind, mode and size, and where it resolves to. */
export type PathInfo =
  | { kind: "file" | "dir"; mode: number; size: number; mtimeMs: number; realpath: string }
  | { kind: "dangling"; target: string };

export interface PlannedFile {
  id: string;
  /** Absolute path on this computer. */
  source: string;
  /** Path under the guest's home. */
  dest: string;
  mode: number;
  dir: boolean;
  /** Absolute laptop paths under `source` the copy leaves out. */
  excludes: string[];
  /** The tool rewrites this path while it runs: it ships, and an attach ships it again, but it never enters the recipe hash. */
  volatile: boolean;
}

/** A credential read on this computer at pack time, from the macOS Keychain or
 * by running a helper command; `place` renders the guest file from the secret
 * and whatever the plan already copied to `dest`. */
export interface PlannedSecret {
  id: string;
  /** The Keychain service, or with `command` the `~`-relative settings file the command was read from. */
  service: string;
  /** The account the item is filed under, for a tool that keeps one Keychain item per signed-in user. */
  account?: string;
  /** A shell line that prints the value on this computer, run in place of the Keychain lookup. */
  command?: string;
  dest: string;
  place: (secret: string, existing: string | undefined) => string;
  /** The file with this account taken out, for an account whose item was not read while another of the login's was. */
  drop?: (existing: string) => string;
}

/** The name a secret's value is kept and reported under: the service, with the account when the item is per user. */
export function secretKey(s: { service: string; account?: string }): string {
  return s.account === undefined ? s.service : `${s.service} (${s.account})`;
}

/** The path a secret is listed by, the way the collector's row names it. */
export function secretPath(s: { service: string; account?: string; command?: string }): string {
  return s.command === undefined ? `Keychain: ${secretKey(s)}` : `Helper: ${s.service}`;
}

export interface SkippedPath {
  id: string;
  path: string;
  note: string;
}

export interface FilesPlan {
  files: PlannedFile[];
  secrets: PlannedSecret[];
  skipped: SkippedPath[];
  /** The recipe's own byte estimate for what travels; the packed size is known only after packing. */
  bytes: number;
  /** Files that travel, counted per rung. */
  rungs: Record<string, number>;
}

export interface PlanFilesOptions {
  /** This computer's home with every link in it resolved, so link targets compare against it. */
  home: string;
  stat: (abs: string) => PathInfo | undefined;
  platform: "darwin" | "linux";
  /** Guest-side prefix rewrites tried before the built-in macOS ones (a config dir the guest keeps elsewhere). */
  rewrites?: readonly [string, string][];
  /** A small laptop file's text, for a login whose Keychain items are filed per account: the tool's own file names them. */
  read?: (abs: string) => string | undefined;
}

const ticked = (e: RecipeEntry): boolean => e.bring === true;
const name = (e: RecipeEntry): string => e.id.slice(e.id.indexOf("/") + 1);

/** An MCP server's row: under the agents rung, filed by the MCP id prefix; the one rule every reader of the agents rung asks. */
export const isMcpRow = (e: Pick<RecipeEntry, "rung" | "id">): boolean => e.rung === "agents" && e.id.startsWith(MCP_ID_PREFIX);

// Linux has no ~/Library; these are where the same programs read on XDG systems.
const MAC_REWRITES: readonly [string, string][] = [
  ["Library/Application Support/", ".config/"],
  ["Library/Preferences/", ".config/"],
];

const SSH_PUBLIC = /^(config|authorized_keys|allowed_signers|environment|rc|.*\.pub)$/;

/** Paths that never travel whatever the tick says, by name; `dir` is known once the path is stat'ed. */
export function refusedPath(rel: string, dir: boolean | undefined): string | undefined {
  if (rel === ".gnupg" || rel.startsWith(".gnupg/")) return "GPG keys are never copied";
  if (rel === ".ssh") return "the .ssh directory is never copied whole; tick its config and public keys";
  if (rel.startsWith(".ssh/")) {
    if (dir === true) return "a directory under .ssh is never copied whole";
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (/known_hosts/.test(base)) return "known_hosts is never copied";
    if (!SSH_PUBLIC.test(base)) return "private key, never copied";
  }
  return undefined;
}

/** Why a row's path never travels, or nothing. Environment files and .netrc hold values, not config: they
 * copy only as a login row's own file or on a credential row the person answered copy. The name rule is
 * about files; a directory called .env is a Python environment more often than a secret. */
export function neverCopied(e: RecipeEntry, rel: string, dir: boolean | undefined): string | undefined {
  if (e.id.startsWith("identity/ssh-key")) return "private key, never copied";
  if (e.id === "identity/gpg") return "GPG keys are never copied";
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (e.rung !== "logins" && e.consent !== true && dir === false) {
    if (/^\.env(\..+)?$/.test(base)) return ".env files are never copied; set the values on the machine";
    if (base === ".netrc") return ".netrc is never copied; sign in on the machine";
  }
  return refusedPath(rel, dir);
}

const under = (home: string, abs: string): boolean => abs === home || abs.startsWith(`${home}/`);

/** The accounts gh's hosts.yml lists under a host, in file order, and the one it marks active. */
export function ghAccounts(hostsYml: string, host: string): { users: string[]; active?: string } {
  const users: string[] = [];
  let active: string | undefined;
  let inHost = false;
  let inUsers = false;
  for (const line of hostsYml.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0 && t !== "") {
      inHost = t === `${host}:`;
      inUsers = false;
    } else if (!inHost) {
      continue;
    } else if (indent === 4) {
      inUsers = t === "users:";
      const user = /^user:\s*(\S+)$/.exec(t);
      if (user !== null) active = user[1]!;
    } else if (indent === 8 && inUsers && t.endsWith(":")) {
      users.push(t.slice(0, -1));
    }
  }
  return { users, ...(active !== undefined ? { active } : {}) };
}

/** The account's lines leave the host's users block; when it was the active one,
 * `user:` moves to the first account left, and goes with the block when none is.
 * Other hosts and other users keep their lines. */
export function dropGhAccount(host: string, existing: string, account: string): string {
  const left = ghAccounts(existing, host).users.filter(u => u !== account);
  const out: string[] = [];
  let inHost = false;
  let inUsers = false;
  let inAccount = false;
  for (const line of existing.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0 && t !== "") {
      inHost = t === `${host}:`;
      inUsers = false;
      inAccount = false;
    }
    if (!inHost) {
      out.push(line);
      continue;
    }
    if (indent === 4) {
      inUsers = t === "users:";
      inAccount = false;
    }
    if (indent === 8 && inUsers) inAccount = t === `${account}:`;
    if (inAccount && t !== "") continue;
    if (indent === 4 && t === "users:" && left.length === 0) continue;
    if (indent === 4 && /^user:\s*(\S+)$/.exec(t)?.[1] === account) {
      if (left.length > 0) out.push(`    user: ${left[0]}`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** An account's token goes under its own users block, and under the host too when
 * the file marks that account active; with no account the host line alone is
 * written. Other hosts and other users keep their lines. A file without the host
 * gets the block appended, with no account marked active. */
export function placeGhToken(host: string, token: string, existing: string | undefined, account?: string): string {
  const block = account === undefined ? `${host}:\n    oauth_token: ${token}\n    git_protocol: https\n` : `${host}:\n    git_protocol: https\n    users:\n        ${account}:\n            oauth_token: ${token}\n`;
  if (existing === undefined) return block;
  const atHost = account === undefined || ghAccounts(existing, host).active === account;
  const out: string[] = [];
  let inHost = false;
  let inUsers = false;
  let inAccount = false;
  let seen = false;
  for (const line of existing.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (indent === 0 && t !== "") {
      inHost = t === `${host}:`;
      inUsers = false;
      inAccount = false;
      if (inHost) seen = true;
    }
    if (!inHost) {
      out.push(line);
      continue;
    }
    if (indent === 4) {
      inUsers = t === "users:";
      inAccount = false;
    }
    if (indent === 8 && inUsers) inAccount = t === `${account}:`;
    if (t.startsWith("oauth_token:") && ((indent === 4 && atHost) || (indent === 12 && inAccount))) continue;
    if (indent === 0 && t.endsWith(":")) out.push(line, ...(atHost ? [`    oauth_token: ${token}`] : []));
    else if (indent === 8 && inAccount && t.endsWith(":")) out.push(line, `            oauth_token: ${token}`);
    else out.push(line);
  }
  if (seen) return out.join("\n");
  const body = out.join("\n");
  return `${body.endsWith("\n") ? body : `${body}\n`}${block}`;
}

interface KeychainItem {
  dest: string;
  place: (secret: string, existing: string | undefined, account?: string) => string;
  /** The laptop file, home-relative, that names the accounts the tool keeps one item each for, and how one leaves it. */
  accounts?: { file: string; list(text: string): string[]; drop(text: string, account: string): string };
}

/** Where a Keychain item the recipe lists as `Keychain: <service>` lands on the
 * guest and how; on Linux the same tools keep the token in the file itself. */
const KEYCHAIN: Record<string, KeychainItem> = {
  "Claude Code-credentials": { dest: ".claude/.credentials.json", place: secret => secret },
  "gh:github.com": {
    dest: ".config/gh/hosts.yml",
    place: (secret, existing, account) => placeGhToken("github.com", secret, existing, account),
    accounts: { file: ".config/gh/hosts.yml", list: text => ghAccounts(text, "github.com").users, drop: (text, account) => dropGhAccount("github.com", text, account) },
  },
};

/** The apiKeyHelper command a Claude Code settings file names, when the file parses and has one. */
function apiKeyHelperOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const helper = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["apiKeyHelper"] : undefined;
    return typeof helper === "string" && helper.trim() !== "" ? helper : undefined;
  } catch {
    return undefined;
  }
}

/** The settings file with its apiKeyHelper set to the line given, or taken out with none; a file that is not
 * JSON or names no helper is returned as it is. Absent, a file is made for the helper alone. */
export function withApiKeyHelper(text: string | undefined, helper: string | undefined): string | undefined {
  if (text === undefined) return helper === undefined ? undefined : `${JSON.stringify({ apiKeyHelper: helper }, null, 2)}\n`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text;
  const settings = parsed as Record<string, unknown>;
  if (!("apiKeyHelper" in settings) && helper === undefined) return text;
  if (helper === undefined) delete settings["apiKeyHelper"];
  else settings["apiKeyHelper"] = helper;
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Where the key a settings file's helper prints lands on the guest, and how the command is read from the file. */
const HELPERS: Record<string, { dest: string; command: (text: string | undefined) => string | undefined }> = {
  "~/.claude/settings.json": { dest: `.claude/${CLAUDE_KEY_FILE}`, command: apiKeyHelperOf },
};

export function planFiles(entries: readonly RecipeEntry[], opts: PlanFilesOptions): FilesPlan {
  const rewrites = [...(opts.rewrites ?? []), ...(opts.platform === "darwin" ? MAC_REWRITES : [])];
  // A prefix rewrite also moves the directory itself when a row names it bare.
  const rewrite = (rel: string): string => {
    for (const [from, to] of rewrites) {
      if (rel.startsWith(from)) return to + rel.slice(from.length);
      if (from.endsWith("/") && rel === from.slice(0, -1)) return to.endsWith("/") ? to.slice(0, -1) : to;
    }
    return rel;
  };
  const plan: FilesPlan = { files: [], secrets: [], skipped: [], bytes: 0, rungs: {} };
  for (const e of entries) {
    if (!ticked(e) || e.rung === "tools") continue;
    if (e.rung === "logins" && e.choice !== "copy") continue;
    let brought = 0;
    for (const p of e.paths) {
      const skip = (note: string): void => void plan.skipped.push({ id: e.id, path: p, note });
      if (e.consent === true && e.choice !== "copy") {
        skip("credential-shaped; not copied without your answer on its row");
        continue;
      }
      const keychainPath = /^keychain:\s*(.+)$/i.exec(p);
      if (keychainPath !== null) {
        const service = keychainPath[1]!.trim();
        const keychain = KEYCHAIN[service];
        if (opts.platform !== "darwin") skip("a macOS Keychain item; sign in on the machine");
        else if (keychain === undefined) skip("no Keychain reader for this login yet; sign in on the machine");
        else {
          const dest = rewrite(keychain.dest);
          const perAccount = keychain.accounts;
          const accounts = perAccount !== undefined && opts.read !== undefined ? perAccount.list(opts.read(join(opts.home, perAccount.file)) ?? "") : [];
          if (perAccount === undefined || accounts.length === 0) plan.secrets.push({ id: e.id, service, dest, place: keychain.place });
          else for (const account of accounts) plan.secrets.push({ id: e.id, service, account, dest, place: (secret, existing) => keychain.place(secret, existing, account), drop: existing => perAccount.drop(existing, account) });
          brought++;
        }
        continue;
      }
      const helperPath = /^helper:\s*(.+)$/i.exec(p);
      if (helperPath !== null) {
        const file = helperPath[1]!.trim();
        const helper = HELPERS[file];
        if (helper === undefined) {
          skip("no helper reader for this login yet; sign in on the machine");
          continue;
        }
        const command = helper.command(opts.read?.(join(opts.home, file.slice(2))));
        if (command === undefined) {
          skip(`no apiKeyHelper in ${file} any more; sign in on the machine`);
          continue;
        }
        plan.secrets.push({ id: e.id, service: file, command, dest: rewrite(helper.dest), place: secret => `${secret}\n` });
        brought++;
        continue;
      }
      if (!p.startsWith("~/")) {
        skip("not under your home directory");
        continue;
      }
      const rel = p.slice(2);
      const source = join(opts.home, rel);
      const st = opts.stat(source);
      const dir = st === undefined || st.kind === "dangling" ? undefined : st.kind === "dir";
      const blocked = neverCopied(e, rel, dir);
      if (blocked !== undefined) {
        skip(blocked);
        continue;
      }
      if (!st) {
        skip("no longer on this computer");
        continue;
      }
      if (st.kind === "dangling") {
        skip(`a link to ${under(opts.home, st.target) ? `~/${st.target.slice(opts.home.length + 1)}` : st.target}, which is gone`);
        continue;
      }
      if (st.realpath !== source) {
        if (!under(opts.home, st.realpath)) {
          skip(`a link to ${st.realpath}, outside your home directory`);
          continue;
        }
        const targetRel = st.realpath.slice(opts.home.length + 1);
        const blockedTarget = neverCopied(e, targetRel, dir === true);
        if (blockedTarget !== undefined) {
          skip(`a link to ~/${targetRel}: ${blockedTarget}`);
          continue;
        }
      }
      const excludes = (e.excludes ?? []).filter(x => x.startsWith(`${p}/`)).map(x => join(opts.home, x.slice(2)));
      plan.files.push({ id: e.id, source, dest: rewrite(rel), mode: st.mode & 0o7777, dir: st.kind === "dir", excludes, volatile: (e.volatile ?? []).includes(p) });
      brought++;
    }
    if (brought > 0) {
      plan.bytes += e.bytes;
      plan.rungs[e.rung] = (plan.rungs[e.rung] ?? 0) + brought;
    }
  }
  return plan;
}

/** A planned path with a digest of the bytes that would travel; the host
 * computes it, since the planner never reads a disk. */
export interface DigestedFile {
  id: string;
  /** `~`-relative laptop path, the one the person knows it by. */
  path: string;
  dest: string;
  digest: string;
  /** Recorded but never hashed: the tool rewrites it while it runs, or it is a login value rendered on the machine. */
  volatile?: boolean;
}

const sorted = <T extends object>(rows: T[]): T[] => rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

/** What a golden is built from: the ticked ids with their login answers and
 * tool pins, the computer's login shell once when a shell row is ticked, and
 * every planned path with its digest, volatile ones marked. Labels, row order,
 * disk stats and the terminal font row do not enter, so a file rewritten with
 * the same bytes reads the same and a font tick changes no golden. */
export function recipeDigest(entries: readonly RecipeEntry[], files: readonly DigestedFile[] = []): RecipeDigest {
  const login = entries.find(e => ticked(e) && e.rung === "shell" && e.login !== undefined)?.login;
  return {
    ticks: sorted(entries.filter(e => ticked(e) && e.font === undefined).map(e => ({ id: e.id, ...(e.choice !== undefined ? { choice: e.choice } : {}), ...(e.version !== undefined ? { version: e.version } : {}) }))),
    ...(login !== undefined ? { login } : {}),
    files: sorted(files.map(f => ({ id: f.id, path: f.path, dest: f.dest, digest: f.digest, ...(f.volatile === true ? { volatile: true } : {}) }))),
  };
}

/** The digest's hash, the same for any key or row order, with the volatile entries left out; a builder
 * carrying it needs nothing re-applied but those. */
export function recipeHash(digest: RecipeDigest): string {
  const ticks = sorted(digest.ticks.map(t => [t.id, t.choice ?? null, t.version ?? null]));
  const files = sorted(digest.files.filter(f => f.volatile !== true).map(f => [f.id, f.path, f.dest, f.digest]));
  return createHash("sha256").update(JSON.stringify({ ticks, login: digest.login ?? null, files })).digest("hex");
}

// --- tools -------------------------------------------------------------------

export interface ToolInstall {
  id: string;
  label: string;
  /** The road the step takes; an extension list written as a file is a script. */
  manager: RoadName;
  /** One bash -c script; exits non-zero on failure. */
  cmd: string;
  /** The install this one needs on the machine first; when that one did not install, this is skipped. */
  after?: string;
  /** The command the install puts on PATH, when the row names it; checked with command -v after the stage. */
  bin?: string;
  /** What the result says beside the install once it lands: a road no golden build has proven yet, a version the road could not pin. */
  note?: string;
}

export interface SkippedItem {
  id: string;
  note: string;
}

export interface Brewfile {
  text: string;
  taps: string[];
  formulae: string[];
  skipped: SkippedItem[];
  /** Tap formulae with no Linux bottle whose source repository is known; each installs from its release. */
  roads: PlannedRoad[];
  /** Rows the base stage already put on every golden, by the base row's name; nothing installs them twice. */
  base: BaseRow[];
}

export interface BaseRow {
  id: string;
  /** The base row it stands for, as the catalog names it. */
  name: string;
  /** What the build reports for the row: the base row's name, and this Mac's major beside the floor's when they differ. */
  note: string;
}

export interface PlannedRoad {
  id: string;
  /** The command the road puts in /usr/local/bin. */
  name: string;
  source: ToolSource;
  pin?: ToolPin;
}

/** A tools row the recipe added for a catalog tool this computer has no row for: the tool's catalog id after the prefix. */
export const CATALOG_PREFIX = "tools/catalog/";
/** The note beside a catalog road's install when no golden build has proven the road yet. */
export const UNMEASURED_ROAD = "by an unmeasured road";

/** The package a tools row names: what follows its manager in the id (a tap formula keeps its slashes). */
export const packageOf = (e: RecipeEntry): string => e.id.split("/").slice(2).join("/");

/** The base row a tools row stands for, when the base stage installs the same tool on every golden. The Mac's
 * version is the row's, or the brew table's for a formula. */
export function baseRowFor(e: RecipeEntry, brew: BrewTable = new Map()): BaseRow | undefined {
  if (e.rung !== "tools") return undefined;
  const pkg = packageOf(e);
  const entry = baseEntryFor(pkg);
  return entry === undefined ? undefined : { id: e.id, name: entry.name, note: baseNote(entry, e.version ?? brew.get(pkg)?.version) };
}

/** The GitHub repository a formula builds from and the tag of the version the Mac has. */
export interface ToolSource {
  repo: string;
  tag: string;
}

/** How a road install stands against the recipe's pin: nothing recorded yet, the same tag (checked), or a
 * tag the Mac's Homebrew has since moved to (a first install again, re-recorded). */
export const pinState = (pin: ToolPin | undefined, source: ToolSource): "none" | "same" | "moved" => pinStateOf(source.tag, pin);

/** What this Mac's Homebrew says about one installed formula. */
export interface BrewFormula {
  name: string;
  /** With the tap prefix for a tap formula; the same as name for homebrew/core. */
  fullName: string;
  /** Runtime dependencies by full name, direct and transitive. */
  deps: string[];
  /** The Cellar entry's size on the Mac, when read. */
  bytes?: number;
  /** The version installed on the Mac, as brew reported it. */
  version?: string;
  macosOnly: boolean;
  source?: ToolSource;
}

/** By full name. */
export type BrewTable = ReadonlyMap<string, BrewFormula>;

/** Tap formulae that only build for macOS and say nothing of it in their metadata. */
export const MACOS_ONLY_FORMULAE: ReadonlySet<string> = new Set(["felixkratz/formulae/sketchybar", "felixkratz/formulae/borders", "koekeishiya/formulae/yabai", "koekeishiya/formulae/skhd"]);

const PNPM_HOME = "/root/.local/share/pnpm";

/** Where the guest finds what the tools stage installs; each install line exports it so
 * it does not depend on the machine's own environment, and login shells get it from profile.d. */
export const TOOLS_PATH = `/root/.local/bin:/usr/local/sbin:/usr/local/bin:${BREW_PREFIX}/bin:${BREW_PREFIX}/sbin:/root/go/bin:/root/.cargo/bin:${PNPM_HOME}:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
export const PATH_LINE = `export PATH=${TOOLS_PATH} PNPM_HOME=${PNPM_HOME}`;

/** After the tools loop: dependencies no formula needs any more (a failed formula
 * left a 2.4 GB llvm@21 behind), then the bottle cache and old kegs (5.5 GB measured). */
export const BREW_HOUSEKEEPING: readonly string[] = [`${PATH_LINE}\n${asLinuxbrew("autoremove")}`, `${PATH_LINE}\n${asLinuxbrew("cleanup -s --prune=all")}`];

/** Dependencies two or more of the formulae share install in one brew process before any
 * of them, marked as dependencies so autoremove still owns them; each formula then finds
 * its shared dependencies present and installs only its own. */
function brewSharedDeps(formulae: readonly string[]): string {
  const keep = BREW_TOOLCHAIN.map(f => `-e ${f}`).join(" ");
  return asLinuxbrewScript(
    [
      "set -uo pipefail",
      `shared=$(${BREW} deps --for-each ${formulae.map(shellQuote).join(" ")} | sed 's/^[^:]*: *//' | tr ' ' '\\n' | grep -vx -e '' ${keep} | sort | uniq -d || true)`,
      'if [ -z "$shared" ]; then echo "no shared dependencies"; exit 0; fi',
      'echo "shared: $(echo $shared)"',
      `${BREW} install $shared; rc=$?`,
      `${BREW} tab --no-installed-on-request $shared || true`,
      "exit $rc",
    ].join("\n"),
  );
}

function homebrewBootstrap(): string {
  return [
    "set -euo pipefail",
    APT_ENV,
    `if [ ! -x ${BREW_PREFIX}/bin/brew ]; then`,
    "  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null 2>&1 || true; apt-get install -y -qq procps curl file git >/dev/null 2>&1 || true; fi",
    "  id -u linuxbrew >/dev/null 2>&1 || useradd -m -s /bin/bash linuxbrew",
    `  git clone -q --depth 1 --branch ${HOMEBREW.tag} https://github.com/Homebrew/brew ${BREW_PREFIX}/Homebrew`,
    `  test "$(git -C ${BREW_PREFIX}/Homebrew rev-parse HEAD)" = "${HOMEBREW.commit}"`,
    `  mkdir -p ${BREW_PREFIX}/bin`,
    `  ln -sfn ../Homebrew/bin/brew ${BREW_PREFIX}/bin/brew`,
    "  chown -R linuxbrew:linuxbrew /home/linuxbrew",
    "fi",
    `printf '%s\\n' ${shellQuote(PATH_LINE)} > /etc/profile.d/wsp-golden.sh`,
    `${asLinuxbrew("--version")} >/dev/null`,
  ].join("\n");
}

export function brewfileFor(entries: readonly RecipeEntry[], brew: BrewTable = new Map()): Brewfile {
  const out: Brewfile = { text: "", taps: [], formulae: [], skipped: [], roads: [], base: [] };
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "tools") continue;
    const base = baseRowFor(e, brew);
    if (base !== undefined) {
      out.base.push(base);
    } else if (e.id.startsWith("tools/brew-tap/")) {
      out.taps.push(e.id.slice("tools/brew-tap/".length));
    } else if (e.id.startsWith("tools/brew/")) {
      const formula = e.id.slice("tools/brew/".length);
      const info = brew.get(formula);
      if (e.linux === "no") out.skipped.push({ id: e.id, note: "no Linux bottle" });
      else if (e.linux === "unknown" && (MACOS_ONLY_FORMULAE.has(formula) || info?.macosOnly === true)) out.skipped.push({ id: e.id, note: "macOS only" });
      // Only a tap formula takes the road: a core formula unknown to the snapshot may well have a Linux bottle by now.
      else if (e.linux === "unknown" && formula.includes("/") && info?.source !== undefined) out.roads.push({ id: e.id, name: info.name, source: info.source, ...(e.pin !== undefined ? { pin: e.pin } : {}) });
      else if (e.linux === "unknown") out.skipped.push({ id: e.id, note: "no Linux bottle known" });
      else out.formulae.push(formula);
    }
  }
  const lines = [...out.taps.map(t => `tap "${t}"`), ...out.formulae.map(f => `brew "${f}"`)];
  out.text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return out;
}

/** The manager rows the collector writes (`tools/<manager>/<package>`), in the order their steps run. */
const MANAGER_ORDER: readonly ("npm" | "pnpm" | "bun" | "uv" | "pipx" | "cargo" | "go")[] = ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go"];

// Homebrew's Linux bottles are built against a newer glibc than the base image
// ships, so its first formula pulls Homebrew's own glibc and gcc in and, on
// 6.0.21, a nested brew racing the parent for those locks fails one run in
// two (measured: 4 of 7 plain runs failed, 3 of 3 passed with these first).
// Each is its own single brew process, in this order, before any formula.
export const BREW_TOOLCHAIN: readonly string[] = ["glibc", "gcc"];

/** How a manager the base does not carry gets onto the machine before its first tool: as a Homebrew for Linux
 * formula. A manager the floor brings (see baseEntryFor) needs none. */
export const MANAGER_FORMULA: Readonly<Partial<Record<RoadName, string>>> = { bun: "bun", pipx: "pipx", cargo: "rust", go: "go" };

const pinOf = (e: { pin?: ToolPin }): { pin?: ToolPin } => (e.pin !== undefined ? { pin: e.pin } : {});

/** The release road of a tap row whose GitHub release is known, with the pin its first install recorded and the
 * repository's main package for `go install` to fall back to. */
const releaseRoad = (r: Pick<PlannedRoad, "source" | "pin">): InstallRoad => ({ road: "release", repo: r.source.repo, version: r.source.tag, ...pinOf(r), go: `github.com/${r.source.repo}@${r.source.tag}` });

/** What a tools row installs by, with the command it puts on PATH where known: a catalog row its entry's road at the
 * row's version where the road pins one (noted when no golden build has proven the road, or when the version could not
 * be pinned), a formula row the brew road, a manager row its manager's road at the row's version; nothing for a row no
 * road installs. A road carries the pin the row's first install recorded. */
export function rowRoad(e: RecipeEntry): PlannedRow | undefined {
  const pkg = packageOf(e);
  if (e.id.startsWith(CATALOG_PREFIX)) {
    const entry = catalogEntry(pkg);
    if (entry?.kind !== "tool") return undefined;
    const mod = roadModule(entry.installRoad);
    const road = e.version !== undefined && mod.at !== undefined ? mod.at(entry.installRoad, e.version) : entry.installRoad;
    const notes = [
      ...(entry.source.road === "unmeasured" ? [UNMEASURED_ROAD] : []),
      ...(e.version !== undefined && mod.at === undefined ? [`${e.version} asked, installed ${mod.words} at its current version`] : []),
    ];
    return { road: { ...road, ...pinOf(e) }, bin: entry.bin, ...(notes.length > 0 ? { note: notes.join("; ") } : {}) };
  }
  const manager = (["brew", ...MANAGER_ORDER] as const).find(m => e.id.startsWith(`tools/${m}/`));
  if (manager === undefined) return undefined;
  const road = ROAD_MODULES[manager].fromRow!({ name: pkg, ...(e.version !== undefined ? { version: e.version } : {}), paths: e.paths, label: e.label });
  const bin = roadModule(road).bin?.(road);
  return { road, ...(bin !== undefined ? { bin } : {}) };
}

export interface PlannedRow {
  road: InstallRoad;
  bin?: string;
  note?: string;
}

/** How a removed tool comes off the machine: through its road's module, on the tools PATH; a row no road installed is noted. */
export function toolUninstall(e: RecipeEntry): { cmd: string } | { note: string } {
  const withPath = (cmd: string): string => `${PATH_LINE}\n${cmd}`;
  const base = baseRowFor(e);
  if (base !== undefined) return { note: `${base.name} is part of the base and stays` };
  if (e.id.startsWith("tools/brew-tap/")) return { cmd: withPath(asLinuxbrew(`untap ${e.id.slice("tools/brew-tap/".length)}`)) };
  const planned = rowRoad(e);
  if (planned === undefined) return { note: "no manager known for this row" };
  const r = roadModule(planned.road).uninstall(planned.road, planned.bin ?? packageOf(e));
  return "cmd" in r ? { cmd: withPath(r.cmd) } : r;
}

export interface ToolsPlan {
  installs: ToolInstall[];
  skipped: SkippedItem[];
  /** Ticked rows the base stage covers; they count as installed without a step. */
  base: BaseRow[];
  brewfile: string;
}

export function toolInstallsFor(entries: readonly RecipeEntry[], table: BrewTable = new Map()): ToolsPlan {
  const brew = brewfileFor(entries, table);
  const installs: ToolInstall[] = [];
  const skipped: SkippedItem[] = [...brew.skipped];
  const withPath = (cmd: string): string => `${PATH_LINE}\n${cmd}`;
  const toolRows = entries.filter(e => ticked(e) && e.rung === "tools" && baseRowFor(e) === undefined);
  const rowsOf = (manager: RoadName): RecipeEntry[] => toolRows.filter(e => e.id.startsWith(`tools/${manager}/`));
  // A catalog row installs by its entry's road; a package road's rows go with the manager's, the rest after everything else.
  const catalog = toolRows.flatMap(e => {
    if (!e.id.startsWith(CATALOG_PREFIX)) return [];
    const planned = rowRoad(e);
    if (planned === undefined) skipped.push({ id: e.id, note: "not in the catalog" });
    return planned === undefined ? [] : [{ e, planned }];
  });
  const catalogRowsOf = (manager: RoadName): RecipeEntry[] => catalog.filter(c => c.planned.road.road === manager).map(c => c.e);
  const npmTicked = new Set(rowsOf("npm").map(e => e.id.slice("tools/npm/".length)));

  // Homebrew's own toolchain, each step waiting on the one before; everything brew installs waits on the last.
  const toolchain = BREW_TOOLCHAIN.reduce<{ steps: ToolInstall[]; last: string }>(
    (acc, f) => {
      const id = `tools/brew-toolchain/${f}`;
      acc.steps.push({ id, label: `Homebrew's ${f}`, manager: "brew", cmd: withPath(asLinuxbrew(`install ${f}`)), after: acc.last });
      return { steps: acc.steps, last: id };
    },
    { steps: [], last: "tools/homebrew" },
  );

  // One step per manager that has rows, unless the base carries it or it already comes along as a formula, a catalog row or an npm global.
  const managers = new Map<RoadName, { after: string; step?: ToolInstall; row?: { e: RecipeEntry; planned: PlannedRow } }>();
  const managerFormulae: string[] = [];
  for (const manager of MANAGER_ORDER) {
    if (rowsOf(manager).length + catalogRowsOf(manager).length === 0 || baseEntryFor(manager) !== undefined) continue;
    const own = `tools/manager/${manager}`;
    const formula = MANAGER_FORMULA[manager];
    if (formula === undefined) throw new Error(`${manager} is neither in the base nor a formula`);
    const fromCatalog = catalog.find(c => c.planned.road.road === "brew" && roadModule(c.planned.road).names(c.planned.road).includes(formula));
    if (brew.formulae.includes(formula)) managers.set(manager, { after: `tools/brew/${formula}` });
    else if (fromCatalog !== undefined) managers.set(manager, { after: fromCatalog.e.id, row: fromCatalog });
    else if (npmTicked.has(manager)) managers.set(manager, { after: `tools/npm/${manager}` });
    else {
      managers.set(manager, { after: own, step: { id: own, label: manager, manager: "brew", cmd: withPath(asLinuxbrew(`install ${formula}`)), after: toolchain.last } });
      managerFormulae.push(formula);
    }
  }
  const catalogFormulae = catalog.flatMap(c => (c.planned.road.road === "brew" ? roadModule(c.planned.road).names(c.planned.road) : []));

  if (brew.taps.length + brew.formulae.length > 0 || managerFormulae.length + catalogFormulae.length > 0) {
    installs.push({ id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: withPath(homebrewBootstrap()) });
    installs.push(...toolchain.steps);
    for (const t of brew.taps) installs.push({ id: `tools/brew-tap/${t}`, label: t, manager: "brew", cmd: withPath(asLinuxbrew(`tap ${t}`)), after: toolchain.last });
    const formulae = [...brew.formulae, ...managerFormulae, ...catalogFormulae];
    if (formulae.length > 1) installs.push({ id: "tools/brew-shared", label: "shared Homebrew dependencies", manager: "brew", cmd: withPath(brewSharedDeps(formulae)), after: toolchain.last });
    for (const f of brew.formulae) installs.push({ id: `tools/brew/${f}`, label: f, manager: "brew", cmd: withPath(asLinuxbrew(`install ${f}`)), after: toolchain.last });
  }
  // What a row waits on: the apt index read once by its own step, Homebrew's toolchain, the manager's step; a floor row is there already.
  const APT_STEP = `tools/${APT_INDEX}`;
  const afterFor = (road: InstallRoad): string | undefined => {
    const dep = roadModule(road).after;
    if (dep === APT_INDEX) {
      if (!installs.some(t => t.id === APT_STEP)) installs.push({ id: APT_STEP, label: "apt index", manager: "apt", cmd: withPath(APT_UPDATE) });
      return APT_STEP;
    }
    if (dep === HOMEBREW_STEP) return toolchain.last;
    return managers.get(road.road)?.after;
  };
  const plan = (e: RecipeEntry, planned: PlannedRow): void => {
    const line = roadModule(planned.road).install(planned.road, planned.bin ?? packageOf(e));
    if (typeof line !== "string") {
      skipped.push({ id: e.id, note: line.note });
      return;
    }
    const after = afterFor(planned.road);
    installs.push({ id: e.id, label: e.label, manager: planned.road.road, cmd: withPath(line), ...(after !== undefined ? { after } : {}), ...(planned.bin !== undefined ? { bin: planned.bin } : {}), ...(planned.note !== undefined ? { note: planned.note } : {}) });
  };
  for (const manager of MANAGER_ORDER) {
    const rows = rowsOf(manager);
    const fromCatalog = catalogRowsOf(manager);
    if (rows.length + fromCatalog.length === 0) continue;
    const brings = managers.get(manager);
    if (brings?.step !== undefined) installs.push(brings.step);
    if (brings?.row !== undefined) plan(brings.row.e, brings.row.planned);
    for (const e of rows) {
      const planned = rowRoad(e);
      if (planned !== undefined) plan(e, planned);
    }
    for (const e of fromCatalog) plan(e, rowRoad(e)!);
  }
  // Last, after any go the plan brings: a road install needs no brew and waits on nothing.
  for (const r of brew.roads) plan(entries.find(e => e.id === r.id)!, { road: releaseRoad(r), bin: r.name });
  // The catalog rows on every other road: Homebrew's (unless one went out as a manager's step above), apt's, a release, a vendor's, a script.
  const asManager = new Set([...managers.values()].flatMap(m => (m.row !== undefined ? [m.row.e.id] : [])));
  for (const { e, planned } of catalog) if (!(MANAGER_ORDER as readonly string[]).includes(planned.road.road) && !asManager.has(e.id)) plan(e, planned);
  return { installs, skipped, base: brew.base, brewfile: brew.text };
}

// --- shell -------------------------------------------------------------------

export type LoginShell = "zsh" | "fish";

export interface ShellInstall {
  /** The login shell the ticked rows belong to; chsh sets it for the guest's uid. */
  shell: LoginShell;
  /** The ticked framework rows reinstalled into their homes, in recipe order. */
  frameworks: string[];
  /** One bash -c script under set -e. */
  cmd: string;
}

/** A shell framework as a git checkout at a pinned commit under the home its rc
 * file expects; fetched by the commit itself, since none of them tags releases. */
export interface PinnedRepo {
  url: string;
  branch: string;
  commit: string;
  /** Relative to the guest's home. */
  home: string;
}

export const SHELL_FRAMEWORKS: Record<string, PinnedRepo> = {
  // https://github.com/ohmyzsh/ohmyzsh#manual-installation
  "shell/oh-my-zsh": { url: "https://github.com/ohmyzsh/ohmyzsh.git", branch: "master", commit: "421d95782d369f266b8087a0eae11eac2f6a6041", home: ".oh-my-zsh" },
  // https://github.com/zdharma-continuum/zinit#manual (the XDG home; the rc file's own installer keeps any other)
  "shell/zinit": { url: "https://github.com/zdharma-continuum/zinit.git", branch: "main", commit: "db9e267184c85a26056c2646222f48df609cecd5", home: ".local/share/zinit/zinit.git" },
  // https://github.com/zplug/zplug#manually
  "shell/zplug": { url: "https://github.com/zplug/zplug.git", branch: "main", commit: "cc6906ea7ea18a5058e8b4862d4086148434ddde", home: ".zplug" },
  // https://github.com/mattmc3/antidote#install
  "shell/antidote": { url: "https://github.com/mattmc3/antidote.git", branch: "main", commit: "db19ea3aa9ad83dbe6ac465ecce0a0afc5a752a5", home: ".antidote" },
};

/** Rows only zsh can read: its rc files, its prompt, and the frameworks above. */
const ZSH_ROWS = new Set(["shell/zshrc", "shell/zshenv", "shell/zprofile", "shell/zlogin", "shell/p10k", ...Object.keys(SHELL_FRAMEWORKS)]);

function pinnedClone(repo: PinnedRepo): string {
  const dir = `"$HOME/${repo.home}"`;
  return [
    `if [ ! -d ${dir}/.git ]; then`,
    `  git init -q ${dir}`,
    `  git -C ${dir} remote add origin ${repo.url}`,
    `  git -C ${dir} fetch -q --depth 1 origin ${repo.commit}`,
    // A kept builder may already hold the person's custom directory; the upload that follows puts it back.
    `  git -C ${dir} checkout -q -f -B ${repo.branch} FETCH_HEAD`,
    "fi",
    `test "$(git -C ${dir} rev-parse HEAD)" = "${repo.commit}"`,
  ].join("\n");
}

/** The shell the ticked rows are for and how the builder gets it: each ticked shell by apt,
 * each ticked framework at its pin, then chsh for the uid. With zsh and fish rows both ticked,
 * the computer's own login shell decides which one chsh sets, zsh when the collector could
 * not read it. Runs before the files land, so a framework's home is empty when its clone
 * arrives and the copied custom directory lands on top of it. */
export function shellInstallFor(entries: readonly RecipeEntry[]): ShellInstall | undefined {
  const shellRows = entries.filter(e => ticked(e) && e.rung === "shell");
  const zsh = shellRows.some(e => ZSH_ROWS.has(e.id));
  const fish = shellRows.some(e => e.id === "shell/fish");
  if (!zsh && !fish) return undefined;
  const login = entries.find(e => e.rung === "shell" && e.login !== undefined)?.login;
  const shell: LoginShell = fish && (!zsh || login === "fish") ? "fish" : "zsh";
  const frameworks = shellRows.map(e => e.id).filter(id => id in SHELL_FRAMEWORKS);
  const lines = [PRELUDE, APT_ENV];
  if (zsh) lines.push(APT("zsh"));
  if (fish) lines.push(APT("fish"));
  if (frameworks.length > 0) lines.push(APT("git"), ...frameworks.map(id => pinnedClone(SHELL_FRAMEWORKS[id]!)));
  // Debian's zprofile is empty, so a zsh login shell would skip the PATH and BROWSER lines the golden puts in profile.d.
  if (zsh) lines.push(`grep -qs 'source /etc/profile' /etc/zsh/zprofile || printf '%s\\n' "emulate sh -c 'source /etc/profile'" >> /etc/zsh/zprofile`);
  lines.push(`chsh -s "$(command -v ${shell})" "$(id -un)"`);
  return { shell, frameworks, cmd: lines.join("\n") };
}

// --- agents ------------------------------------------------------------------

export interface AgentInstaller {
  name: string;
  /** One bash -c script under set -e; may span lines. */
  install: string;
  /** Exits 0 once the agent is on the machine. */
  smoke: string;
  /** The lowest Node major its package's engines field accepts; absent when it declares none. */
  node?: number;
}

export interface AgentInstall extends AgentInstaller {
  id: string;
}

/** The line a guest gets when no supported pinned major meets an agent's floor. */
export const CURRENT_LTS: NodeMajor = 22;

/** The major a set of engines floors gets: the lowest pinned major at or above the
 * floor that is still in active or maintenance support on `now`, else the current
 * LTS; nothing when the floor is above every pinned major. */
export function nodeMajorFor(floor: number, now: Date): NodeMajor | undefined {
  const majors = (Object.keys(NODE_RELEASES).map(Number) as NodeMajor[]).sort((a, b) => a - b);
  if (floor > majors.at(-1)!) return undefined;
  const supported = (m: NodeMajor): boolean => now.getTime() < Date.parse(`${NODE_RELEASES[m].eol}T23:59:59Z`);
  return majors.find(m => m >= floor && supported(m)) ?? CURRENT_LTS;
}

/** Every installer pins a version; npm checks the registry's integrity hash for each tarball, uv is checksummed
 * by its release, git checkouts compare the commit. The catalog's agents install by their roads. Aider is not a
 * catalog agent (its project state has no measured resolver, so wsp does not ship it); its line stays for recipes
 * that tick it: https://aider.chat/docs/install.html, the uv tool line. */
export function agentInstallers(agents: readonly AgentEntry[]): Record<string, AgentInstaller> {
  return {
    ...Object.fromEntries(agents.map(a => [a.id, { name: a.name, install: installLine(a), smoke: smokeOf(a), ...(a.node !== undefined ? { node: a.node } : {}) }])),
    aider: { name: "Aider", install: `${UV_INSTALL}\nuv tool install --force --python 3.12 --with pip aider-chat==0.86.2`, smoke: "aider --version" },
  };
}

export const AGENT_INSTALLERS: Record<string, AgentInstaller> = agentInstallers(CATALOG_AGENTS);

/** The package an installer's npm or uv line puts on the machine, read off the line's pinned spec. */
const NPM_INSTALL_LINE = /^npm install -g (?:--ignore-scripts )?(\S+?)@\S+$/m;
const UV_INSTALL_LINE = /^uv tool install .*?([\w.-]+)==[\w.-]+$/m;

/** The inverse of an installer, read off its install line: an npm global is
 * uninstalled, a uv tool uninstalled, Hermes's checkout and venv removed;
 * anything else (Claude Code's own installer) has no inverse and is noted. */
export function agentUninstall(installer: AgentInstaller): { cmd: string } | { note: string } {
  const npm = NPM_INSTALL_LINE.exec(installer.install);
  if (npm !== null) return { cmd: `${NODE_PATH_LINE}\nnpm uninstall -g ${npm[1]}` };
  const uv = UV_INSTALL_LINE.exec(installer.install);
  if (uv !== null) return { cmd: `uv tool uninstall ${uv[1]}` };
  if (installer.install.includes("/root/.hermes/")) return { cmd: "rm -rf /root/.hermes/venvs/hermes /root/.hermes/hermes-agent /usr/local/bin/hermes" };
  return { note: `${installer.name} has no uninstaller; left on the machine` };
}

/** The one Node step a golden gets when a ticked agent's engines floor may be
 * above the base image's: the lowest pinned major that satisfies every ticked agent. */
export interface NodeInstall {
  floor: number;
  version: string;
  /** The agents whose engines asked for it, in recipe order. */
  agents: string[];
  cmd: string;
}

/** The package each agent installer puts on the machine through a manager the tools rung also lists, as that rung's row id. */
const AGENT_TOOL_ROWS: ReadonlyMap<string, string> = new Map(
  Object.entries(AGENT_INSTALLERS).flatMap(([agent, a]) => {
    const npm = NPM_INSTALL_LINE.exec(a.install)?.[1];
    const uv = UV_INSTALL_LINE.exec(a.install)?.[1];
    return [...(npm !== undefined ? [[`tools/npm/${npm}`, agent] as const] : []), ...(uv !== undefined ? [[`tools/uv/${uv}`, agent] as const] : [])];
  }),
);

/** The agent whose installer would put this tools row's package on the machine a second time, by id. */
export function agentOwning(toolId: string): string | undefined {
  return AGENT_TOOL_ROWS.get(toolId);
}

export interface AgentsPlan {
  installs: AgentInstall[];
  skipped: SkippedItem[];
  node?: NodeInstall;
}

/** The ticked agents with an installer, in recipe order, from the installers of `agents`, the catalog's by default. */
export function agentInstallsFor(entries: readonly RecipeEntry[], agents: readonly AgentEntry[] = CATALOG_AGENTS, now: Date = new Date()): AgentsPlan {
  const table = agentInstallers(agents);
  const out: AgentsPlan = { installs: [], skipped: [] };
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "agents" || isMcpRow(e)) continue;
    const installer = table[name(e)];
    if (installer) out.installs.push({ id: e.id, ...installer });
    else out.skipped.push({ id: e.id, note: "no installer known" });
  }
  // An agent whose floor no pinned major meets is set aside rather than installed on a Node its engines refuse.
  const pinnable = out.installs.filter(a => {
    if (a.node === undefined || nodeMajorFor(a.node, now) !== undefined) return true;
    out.skipped.push({ id: a.id, note: `needs Node ${a.node}, none pinned` });
    return false;
  });
  out.installs = pinnable;
  const floors = out.installs.filter(a => a.node !== undefined);
  if (floors.length > 0) {
    const floor = Math.max(...floors.map(a => a.node!));
    const release = NODE_RELEASES[nodeMajorFor(floor, now)!];
    out.node = { floor, version: release.version, agents: floors.map(a => a.name), cmd: nodeInstallScript(floor, release) };
  }
  return out;
}
