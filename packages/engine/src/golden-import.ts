// SPDX-License-Identifier: AGPL-3.0-only
// Golden import, the planning half: a saved recipe (the collector's rows with
// the person's ticks) becomes the list of laptop files that travel and where
// they land, the Brewfile and per-manager installs, and the pinned installer
// of every ticked agent. Nothing here touches a disk or a machine; golden.ts
// runs the plan on the builder.
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { MCP_ID_PREFIX, type RecipeDigest } from "@wsp/protocol";
import { APT, PRELUDE } from "./dotfiles-presets.js";
import { caskVersion, linuxCaskFor } from "./linux-casks.js";

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
  /** Only on a hand-installed tools row that is a Linux binary: the arch its ELF header names. */
  arch?: string;
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
  /** A copied Linux binary's arch; the pack sets the file aside on a machine of another one. */
  arch?: string;
}

/** What the engine reads off the machine before the files are packed. */
export interface GuestFacts {
  /** `uname -m`; absent when the read failed. */
  arch?: string;
}

/** The planned files a machine can run and the ones set aside: a Linux binary built for another arch than the
 * machine's, or for any arch when the machine's could not be read, never lands. */
export function forGuest(plan: FilesPlan, guest: GuestFacts, home: string): { files: PlannedFile[]; skipped: SkippedPath[] } {
  const skipped: SkippedPath[] = [];
  const files = plan.files.filter(f => {
    if (f.arch === undefined || f.arch === guest.arch) return true;
    const machine = guest.arch === undefined ? "the machine's architecture could not be read" : `the machine is ${guest.arch}`;
    skipped.push({ id: f.id, path: `~/${relative(home, f.source)}`, note: `built for ${f.arch}; ${machine}` });
    return false;
  });
  return { files, skipped };
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
  "~/.claude/settings.json": { dest: ".claude/anthropic-api-key", command: apiKeyHelperOf },
};

export function planFiles(entries: readonly RecipeEntry[], opts: PlanFilesOptions): FilesPlan {
  const rewrites = [...(opts.rewrites ?? []), ...remoteEditorRewrites(opts.platform), ...(opts.platform === "darwin" ? MAC_REWRITES : [])];
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
    if (!ticked(e) || (e.rung === "tools" && !handCopy(e))) continue;
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
      plan.files.push({ id: e.id, source, dest: rewrite(rel), mode: st.mode & 0o7777, dir: st.kind === "dir", excludes, volatile: (e.volatile ?? []).includes(p), ...(e.arch !== undefined ? { arch: e.arch } : {}) });
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

/** `github` is the road for a tap formula with no Linux bottle and for a cask that is a command: its release asset, else `go install` from its repository. */
export type ToolManager = "brew" | "npm" | "pnpm" | "bun" | "uv" | "pipx" | "cargo" | "go" | "github";

export interface ToolInstall {
  id: string;
  label: string;
  manager: ToolManager | EditorSource;
  /** One bash -c script; exits non-zero on failure. */
  cmd: string;
  /** The install this one needs on the machine first; when that one did not install, this is skipped. */
  after?: string;
  /** The command the install puts on PATH, when the row names it; checked with command -v after the stage. */
  bin?: string;
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
  /** Tap formulae with no Linux bottle whose source repository is known, and command casks; each installs from its release. */
  roads: PlannedRoad[];
}

export interface PlannedRoad {
  id: string;
  /** The command the road puts in /usr/local/bin. */
  name: string;
  source: ToolSource;
  pin?: ToolPin;
  /** The `module@version` go install falls back to; the repository at the tag when the row names none. */
  go?: string;
}

const CLI_PREFIX = "tools/cli/";
const HAND_PREFIX = "tools/hand/";

/** A hand-installed script or Linux binary is the one tools row that travels as a file, into the same bin directory. */
const handCopy = (e: RecipeEntry): boolean => e.id.startsWith(HAND_PREFIX) && e.linux !== "no";

/** A command cask's road, from its paths as the collector wrote them: the release's `github.com/owner/repo@tag`
 * first, a Go binary's `module@version` last when one folded into the row. */
export function cliRoad(e: RecipeEntry): Pick<PlannedRoad, "source" | "go"> | undefined {
  const m = /^github\.com\/([^/@]+\/[^/@]+)@(.+)$/.exec(e.paths[0] ?? "");
  if (m === null) return undefined;
  const go = e.paths.length > 1 ? e.paths[e.paths.length - 1] : undefined;
  return { source: { repo: m[1]!, tag: m[2]! }, ...(go !== undefined ? { go } : {}) };
}

/** The GitHub repository a formula builds from and the tag of the version the Mac has. */
export interface ToolSource {
  repo: string;
  tag: string;
}

/** What the first install of a release recorded: the tag it fetched and the asset's sha256. */
export interface ToolPin {
  tag: string;
  sha256: string;
}

/** How a road install stands against the recipe's pin: nothing recorded yet, the same tag (checked), or a
 * tag the Mac's Homebrew has since moved to (a first install again, re-recorded). */
export function pinState(pin: ToolPin | undefined, source: ToolSource): "none" | "same" | "moved" {
  if (pin === undefined) return "none";
  return pin.tag === source.tag ? "same" : "moved";
}

/** What this Mac's Homebrew says about one installed formula. */
export interface BrewFormula {
  name: string;
  /** With the tap prefix for a tap formula; the same as name for homebrew/core. */
  fullName: string;
  /** Runtime dependencies by full name, direct and transitive. */
  deps: string[];
  /** The Cellar entry's size on the Mac, when read. */
  bytes?: number;
  macosOnly: boolean;
  source?: ToolSource;
}

/** By full name. */
export type BrewTable = ReadonlyMap<string, BrewFormula>;

/** Tap formulae that only build for macOS and say nothing of it in their metadata. */
export const MACOS_ONLY_FORMULAE: ReadonlySet<string> = new Set(["felixkratz/formulae/sketchybar", "felixkratz/formulae/borders", "koekeishiya/formulae/yabai", "koekeishiya/formulae/skhd"]);

/** Homebrew itself is a git checkout at a release tag whose commit is checked
 * before anything runs (https://docs.brew.sh/Homebrew-on-Linux#alternative-installation). */
export const HOMEBREW = { tag: "6.0.21", commit: "560147012b9678b42ef5e83b690f0895552d1366" } as const;
const BREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const PNPM_HOME = "/root/.local/share/pnpm";
const GO_BIN = "/root/go/bin";

/** Where the guest finds what the tools stage installs; each install line exports it so
 * it does not depend on the machine's own environment, and login shells get it from profile.d. */
export const TOOLS_PATH = `/root/.local/bin:/usr/local/sbin:/usr/local/bin:${BREW_PREFIX}/bin:${BREW_PREFIX}/sbin:/root/go/bin:/root/.cargo/bin:${PNPM_HOME}:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const PATH_LINE = `export PATH=${TOOLS_PATH} PNPM_HOME=${PNPM_HOME}`;

// Install-time cleanup stays on: with it off, one recipe left 2.6 GB of bottles in the download cache on a 20 GB disk.
const BREW_ENV = "HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 NONINTERACTIVE=1";
const BREW = `${BREW_PREFIX}/bin/brew`;

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Homebrew refuses to run as root, so it lives under its own user at the
// prefix its Linux bottles are built for; anything else compiles from source.
function asLinuxbrewScript(script: string): string {
  return `su -s /bin/bash linuxbrew -c ${squote(`export ${BREW_ENV}\n${script}`)}`;
}

function asLinuxbrew(cmd: string): string {
  return `su -s /bin/bash linuxbrew -c ${squote(`${BREW_ENV} ${BREW} ${cmd}`)}`;
}

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
      `shared=$(${BREW} deps --for-each ${formulae.map(squote).join(" ")} | sed 's/^[^:]*: *//' | tr ' ' '\\n' | grep -vx -e '' ${keep} | sort | uniq -d || true)`,
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
    "export DEBIAN_FRONTEND=noninteractive",
    `if [ ! -x ${BREW_PREFIX}/bin/brew ]; then`,
    "  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq >/dev/null 2>&1 || true; apt-get install -y -qq procps curl file git >/dev/null 2>&1 || true; fi",
    "  id -u linuxbrew >/dev/null 2>&1 || useradd -m -s /bin/bash linuxbrew",
    `  git clone -q --depth 1 --branch ${HOMEBREW.tag} https://github.com/Homebrew/brew ${BREW_PREFIX}/Homebrew`,
    `  test "$(git -C ${BREW_PREFIX}/Homebrew rev-parse HEAD)" = "${HOMEBREW.commit}"`,
    `  mkdir -p ${BREW_PREFIX}/bin`,
    `  ln -sfn ../Homebrew/bin/brew ${BREW_PREFIX}/bin/brew`,
    "  chown -R linuxbrew:linuxbrew /home/linuxbrew",
    "fi",
    `printf '%s\\n' ${squote(PATH_LINE)} > /etc/profile.d/wsp-golden.sh`,
    `${asLinuxbrew("--version")} >/dev/null`,
  ].join("\n");
}

export function brewfileFor(entries: readonly RecipeEntry[], brew: BrewTable = new Map()): Brewfile {
  const out: Brewfile = { text: "", taps: [], formulae: [], skipped: [], roads: [] };
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "tools") continue;
    if (e.id.startsWith("tools/brew-tap/")) {
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
    } else if (e.id.startsWith(CLI_PREFIX)) {
      const road = cliRoad(e);
      if (road === undefined) {
        if (linuxCaskFor(e.id) === undefined) out.skipped.push({ id: e.id, note: "no GitHub release to install from" });
      }
      else out.roads.push({ id: e.id, name: e.id.slice(CLI_PREFIX.length), ...road, ...(e.pin !== undefined ? { pin: e.pin } : {}) });
    } else if (e.id.startsWith("tools/brew-cask/")) {
      if (linuxCaskFor(e.id) === undefined) out.skipped.push({ id: e.id, note: "macOS app, no Linux build" });
    } else if (e.id.startsWith("tools/mas/")) {
      out.skipped.push({ id: e.id, note: "Mac App Store, macOS only" });
    } else if (e.id.startsWith(HAND_PREFIX) && !handCopy(e)) {
      out.skipped.push({ id: e.id, note: e.reason ?? "no Linux build" });
    }
  }
  const lines = [...out.taps.map(t => `tap "${t}"`), ...out.formulae.map(f => `brew "${f}"`)];
  out.text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return out;
}

const MANAGER_ORDER: readonly Exclude<ToolManager, "brew" | "github">[] = ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go"];

// Homebrew's Linux bottles are built against a newer glibc than the base image
// ships, so its first formula pulls Homebrew's own glibc and gcc in and, on
// 6.0.21, a nested brew racing the parent for those locks fails one run in
// two (measured: 4 of 7 plain runs failed, 3 of 3 passed with these first).
// Each is its own single brew process, in this order, before any formula.
export const BREW_TOOLCHAIN: readonly string[] = ["glibc", "gcc"];

/** How each manager gets onto the machine before its first tool: uv by its
 * checksummed release, the rest as Homebrew for Linux formulae (npm rides the base Node). */
export const MANAGER_FORMULA: Record<Exclude<ToolManager, "brew" | "npm" | "uv" | "github">, string> = { pnpm: "pnpm", bun: "bun", pipx: "pipx", cargo: "rust", go: "go" };

/** The collector puts a Go binary's `path@version` in its first path; recipes saved
 * before that carried it in the label as `name (path@version)`. */
function goModule(e: RecipeEntry): { path: string; version: string } | undefined {
  const spec = e.paths[0] ?? /\(([^()\s]+)\)/.exec(e.label)?.[1];
  const at = spec?.lastIndexOf("@") ?? -1;
  if (spec === undefined || at <= 0 || at === spec.length - 1) return undefined;
  return { path: spec.slice(0, at), version: spec.slice(at + 1) };
}

function managerCommand(e: RecipeEntry, manager: Exclude<ToolManager, "github">): { cmd: string } | { note: string } {
  const pkg = e.id.slice(`tools/${manager}/`.length);
  const v = e.version;
  switch (manager) {
    case "npm":
    case "pnpm":
    case "bun": {
      const spec = v === undefined ? pkg : `${pkg}@${v}`;
      return { cmd: manager === "npm" ? `npm install -g ${spec}` : `${manager} add -g ${spec}` };
    }
    case "uv":
    case "pipx": {
      const spec = v === undefined ? pkg : `${pkg}==${v}`;
      return { cmd: manager === "uv" ? `uv tool install ${spec}` : `pipx install ${spec}` };
    }
    case "cargo":
      return { cmd: v === undefined ? `cargo install ${pkg}` : `cargo install ${pkg} --version ${v}` };
    case "go": {
      const mod = goModule(e);
      return mod ? { cmd: `go install ${mod.path}@${v ?? mod.version}` } : { note: "no module to install from" };
    }
    case "brew":
      return { cmd: asLinuxbrew(`install ${pkg}`) };
  }
}

/** The file `go install` writes for a module: its last path element, skipping a major-version suffix. */
function goBinary(module: string): string {
  const at = module.lastIndexOf("@");
  const parts = (at > 0 ? module.slice(0, at) : module).split("/");
  const last = parts.at(-1)!;
  return /^v[1-9]\d*$/.test(last) && parts.length > 1 ? parts.at(-2)! : last;
}

/** A tool from its repository: the release asset built for this arch, unpacked and its binary put in
 * /usr/local/bin; with no Linux asset and go on the machine, `go install` of the module at the tag, moved to
 * the row's command when the module is named otherwise. The asset's sha256 is checked against the pin when
 * the recipe has one for this tag, and printed with the tag on the WSP_ROAD line the stage reads either way,
 * so the first install of a tag records it. */
function roadInstall(name: string, source: ToolSource, pin?: string, go = `github.com/${source.repo}@${source.tag}`): string {
  const api = `https://api.github.com/repos/${source.repo}/releases/tags/${source.tag}`;
  const goBin = goBinary(go);
  return [
    "set -euo pipefail",
    `name=${squote(name)}`,
    'arch="$(uname -m)"',
    'case "$arch" in x86_64) pat="amd64|x86_64|x64" ;; aarch64) pat="arm64|aarch64" ;; *) echo "Error: unsupported arch: $arch" >&2; exit 1 ;; esac',
    'tmp="$(mktemp -d /tmp/wsp-road-XXXXXX)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `urls="$(curl -fsSL ${squote(api)} | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 || true)"`,
    `url="$(printf '%s\\n' "$urls" | grep -i linux | grep -iE "$pat" | grep -viE '\\.(sha256|sha256sum|sha512|sig|asc|txt|md5|pem|deb|rpm|apk)$' | head -1 || true)"`,
    'if [ -n "$url" ]; then',
    '  asset="${url##*/}"',
    '  curl -fsSL -o "$tmp/$asset" "$url"',
    `  sum="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"`,
    ...(pin !== undefined ? [`  [ "$sum" = ${squote(pin)} ] || { echo "Error: $asset does not match the checksum recorded on the first install of "${squote(source.tag)} >&2; exit 1; }`] : []),
    '  case "$asset" in',
    '    *.tar.gz|*.tgz) tar -xzf "$tmp/$asset" -C "$tmp" ;;',
    '    *.tar.xz) tar -xJf "$tmp/$asset" -C "$tmp" ;;',
    '    *.zip) if command -v unzip >/dev/null 2>&1; then unzip -qo "$tmp/$asset" -d "$tmp"; else python3 -m zipfile -e "$tmp/$asset" "$tmp"; fi ;;',
    '    *) mv "$tmp/$asset" "$tmp/$name"; chmod +x "$tmp/$name"; asset="" ;;',
    "  esac",
    '  bin="$(find "$tmp" -type f -name "$name" | head -1)"',
    `  [ -n "$bin" ] || bin="$(find "$tmp" -type f -perm -u+x ! -name "\${asset:-.}" ! -name '*.md' ! -name '*.txt' -printf '%s %p\\n' | sort -rn | head -1 | cut -d' ' -f2-)"`,
    '  [ -n "$bin" ] || { echo "Error: no binary in ${asset:-the release}" >&2; exit 1; }',
    '  install -m 0755 "$bin" "/usr/local/bin/$name"',
    `  echo "WSP_ROAD release \${asset:-$url} $sum "${squote(source.tag)}`,
    "elif command -v go >/dev/null 2>&1; then",
    `  GOBIN=/usr/local/bin go install ${squote(go)}`,
    ...(goBin === name ? [] : [`  mv ${squote(`/usr/local/bin/${goBin}`)} "/usr/local/bin/$name"`]),
    `  echo "WSP_ROAD go "${squote(go)}`,
    "else",
    `  echo "Error: release "${squote(source.tag)}" of "${squote(source.repo)}" has no Linux build, and go is not on the machine" >&2`,
    "  exit 1",
    "fi",
  ].join("\n");
}

/** How a removed tool comes off the machine; Go has no uninstall, so its binary is noted and left. */
export function toolUninstall(e: RecipeEntry): { cmd: string } | { note: string } {
  const withPath = (cmd: string): string => `${PATH_LINE}\n${cmd}`;
  if (e.id.startsWith("tools/brew-tap/")) return { cmd: withPath(asLinuxbrew(`untap ${e.id.slice("tools/brew-tap/".length)}`)) };
  const cask = linuxCaskFor(e.id);
  if (cask !== undefined) return { cmd: withPath(cask.uninstall) };
  if (e.id.startsWith("tools/brew-cask/") || e.id.startsWith("tools/mas/")) return { note: "never installed on Linux" };
  if (e.id.startsWith(CLI_PREFIX)) return { cmd: withPath(`rm -f /usr/local/bin/${squote(e.id.slice(CLI_PREFIX.length))}`) };
  if (e.id.startsWith(HAND_PREFIX)) return { note: "a copied file; it comes off with the files" };
  const manager = (["brew", ...MANAGER_ORDER] as const).find(m => e.id.startsWith(`tools/${m}/`));
  if (manager === undefined) return { note: "no manager known for this row" };
  const pkg = e.id.slice(`tools/${manager}/`.length);
  switch (manager) {
    case "brew": {
      if (!pkg.includes("/")) return { cmd: withPath(asLinuxbrew(`uninstall ${pkg}`)) };
      // A tap formula with no Linux bottle took the road to /usr/local/bin under the formula's name, not to the cellar.
      const bin = pkg.slice(pkg.lastIndexOf("/") + 1);
      return { cmd: withPath(`if [ -x ${BREW} ] && ${asLinuxbrew(`list --formula ${pkg}`)} >/dev/null 2>&1; then ${asLinuxbrew(`uninstall ${pkg}`)}; else rm -f /usr/local/bin/${squote(bin)}; fi`) };
    }
    case "npm":
      return { cmd: withPath(`npm uninstall -g ${pkg}`) };
    case "pnpm":
    case "bun":
      return { cmd: withPath(`${manager} remove -g ${pkg}`) };
    case "uv":
      return { cmd: withPath(`uv tool uninstall ${pkg}`) };
    case "pipx":
      return { cmd: withPath(`pipx uninstall ${pkg}`) };
    case "cargo":
      return { cmd: withPath(`cargo uninstall ${pkg}`) };
    case "go":
      return { note: `go has no uninstall; the binary stays in ${GO_BIN}` };
  }
}

export interface ToolsPlan {
  installs: ToolInstall[];
  skipped: SkippedItem[];
  brewfile: string;
}

export function toolInstallsFor(entries: readonly RecipeEntry[], table: BrewTable = new Map()): ToolsPlan {
  const brew = brewfileFor(entries, table);
  const installs: ToolInstall[] = [];
  const skipped: SkippedItem[] = [...brew.skipped];
  const withPath = (cmd: string): string => `${PATH_LINE}\n${cmd}`;
  const rowsOf = (manager: ToolManager): RecipeEntry[] => entries.filter(e => ticked(e) && e.rung === "tools" && e.id.startsWith(`tools/${manager}/`));
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

  // One step per manager that has rows, unless it already comes along as a formula or an npm global.
  const managers = new Map<ToolManager, { after: string; step?: ToolInstall }>();
  const managerFormulae: string[] = [];
  for (const manager of MANAGER_ORDER) {
    if (manager === "npm" || rowsOf(manager).length === 0) continue;
    const own = `tools/manager/${manager}`;
    if (manager === "uv") {
      managers.set(manager, { after: own, step: { id: own, label: "uv", manager: "uv", cmd: withPath(`set -euo pipefail\n${UV_INSTALL}`) } });
      continue;
    }
    const formula = MANAGER_FORMULA[manager];
    if (brew.formulae.includes(formula)) managers.set(manager, { after: `tools/brew/${formula}` });
    else if (npmTicked.has(manager)) managers.set(manager, { after: `tools/npm/${manager}` });
    else {
      managers.set(manager, { after: own, step: { id: own, label: manager, manager: "brew", cmd: withPath(asLinuxbrew(`install ${formula}`)), after: toolchain.last } });
      managerFormulae.push(formula);
    }
  }

  if (brew.taps.length + brew.formulae.length > 0 || managerFormulae.length > 0) {
    installs.push({ id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: withPath(homebrewBootstrap()) });
    installs.push(...toolchain.steps);
    for (const t of brew.taps) installs.push({ id: `tools/brew-tap/${t}`, label: t, manager: "brew", cmd: withPath(asLinuxbrew(`tap ${t}`)), after: toolchain.last });
    const formulae = [...brew.formulae, ...managerFormulae];
    if (formulae.length > 1) installs.push({ id: "tools/brew-shared", label: "shared Homebrew dependencies", manager: "brew", cmd: withPath(brewSharedDeps(formulae)), after: toolchain.last });
    for (const f of brew.formulae) installs.push({ id: `tools/brew/${f}`, label: f, manager: "brew", cmd: withPath(asLinuxbrew(`install ${f}`)), after: toolchain.last });
  }
  for (const manager of MANAGER_ORDER) {
    const rows = rowsOf(manager);
    if (rows.length === 0) continue;
    const m = managers.get(manager);
    if (m?.step !== undefined) installs.push(m.step);
    for (const e of rows) {
      const r = managerCommand(e, manager);
      if ("note" in r) skipped.push({ id: e.id, note: r.note });
      else installs.push({ id: e.id, label: e.label, manager, cmd: withPath(r.cmd), ...(m !== undefined ? { after: m.after } : {}), ...(manager === "go" ? { bin: e.id.slice("tools/go/".length) } : {}) });
    }
  }
  // Last, after any go the plan brings: a road install needs no brew and waits on nothing.
  for (const r of brew.roads) {
    const label = entries.find(e => e.id === r.id)?.label ?? r.name;
    installs.push({ id: r.id, label, manager: "github", cmd: withPath(roadInstall(r.name, r.source, pinState(r.pin, r.source) === "same" ? r.pin!.sha256 : undefined, r.go)), bin: r.name });
  }
  // A cask that is a command installs from its vendor's Linux release, hashed on the guest as a road is; a command row
  // with a GitHub release already went out as a road above.
  for (const e of entries) {
    const cask = ticked(e) && e.rung === "tools" && cliRoad(e) === undefined ? linuxCaskFor(e.id) : undefined;
    if (cask !== undefined) installs.push({ id: e.id, label: e.label, manager: "release", cmd: withPath(cask.install(caskVersion(cask, e), e.pin)), bin: cask.bin });
  }
  return { installs, skipped, brewfile: brew.text };
}

// --- editors -----------------------------------------------------------------

/** How an editors row gets onto the machine: a distro package, a pinned release tarball, or a list file for the person. */
export type EditorSource = "apt" | "release" | "list";

/** Helix by its release tarball (https://github.com/helix-editor/helix/releases), hashed at pin time; the
 * release publishes no sums file. The tarball carries the runtime directory beside the binary. */
export const HELIX = {
  version: "25.07.1",
  sha256: {
    x86_64: "3f08e63ecd388fff657ad39722f88bb03dcf326f1f2da2700d99e1dc40ab2e8b",
    aarch64: "ce23fa8d395e633e3e54c052012f11965d91d8d5c2bfa659685f50430b4f8175",
  },
} as const;

const HELIX_INSTALL = [
  "if ! command -v hx >/dev/null 2>&1; then",
  "  command -v xz >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq xz-utils; }",
  '  arch="$(uname -m)"',
  '  case "$arch" in',
  `    x86_64) pkg=helix-${HELIX.version}-x86_64-linux.tar.xz sha=${HELIX.sha256.x86_64} ;;`,
  `    aarch64) pkg=helix-${HELIX.version}-aarch64-linux.tar.xz sha=${HELIX.sha256.aarch64} ;;`,
  '    *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "  esac",
  `  curl -fsSL -o "/tmp/$pkg" "https://github.com/helix-editor/helix/releases/download/${HELIX.version}/$pkg"`,
  '  echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
  "  rm -rf /opt/helix && mkdir -p /opt/helix",
  '  tar -xJf "/tmp/$pkg" -C /opt/helix --strip-components=1',
  "  ln -sfn /opt/helix/hx /usr/local/bin/hx",
  '  rm -f "/tmp/$pkg"',
  "fi",
].join("\n");

const APT_EDITORS: Record<string, { name: string; pkg: string; bin: string }> = {
  nvim: { name: "neovim", pkg: "neovim", bin: "nvim" },
  vim: { name: "vim", pkg: "vim", bin: "vim" },
  emacs: { name: "emacs", pkg: "emacs-nox", bin: "emacs" },
};

/** An editors row that puts a binary on the machine: its name as the stage says it, and how it comes off (the apt
 * package purged with what it alone pulled in; helix's tree and link). Undefined for a row that is only its files. */
export function terminalEditor(id: string): { name: string; uninstall: string } | undefined {
  if (!id.startsWith("editors/")) return undefined;
  const key = id.slice("editors/".length);
  const apt = APT_EDITORS[key];
  if (apt !== undefined) return { name: apt.name, uninstall: `export DEBIAN_FRONTEND=noninteractive\napt-get purge -y -qq ${apt.pkg} && apt-get autoremove -y -qq --purge` };
  if (key === "helix") return { name: "helix", uninstall: "rm -rf /opt/helix /usr/local/bin/hx" };
  return undefined;
}

export interface RemoteEditor {
  name: string;
  /** The remote server's data directory under the guest home. */
  dir: string;
  /** The command the editor's own terminal has, which installs onto the remote. */
  cli: string;
}

/** The editors that open a machine over SSH through a server of their own on it; their rows carry what that server reads. */
const REMOTE_EDITORS: Record<string, RemoteEditor & { userDir: { darwin: string; linux: string } }> = {
  vscode: { name: "VS Code", dir: ".vscode-server", cli: "code", userDir: { darwin: "Library/Application Support/Code/User", linux: ".config/Code/User" } },
  "vscode-insiders": { name: "VS Code Insiders", dir: ".vscode-server-insiders", cli: "code-insiders", userDir: { darwin: "Library/Application Support/Code - Insiders/User", linux: ".config/Code - Insiders/User" } },
  cursor: { name: "Cursor", dir: ".cursor-server", cli: "cursor", userDir: { darwin: "Library/Application Support/Cursor/User", linux: ".config/Cursor/User" } },
};

/** The remote editor an editors row belongs to (its settings row or one of its extension rows), or nothing. */
export function remoteEditorFor(id: string): RemoteEditor | undefined {
  const key = /^editors\/([a-z-]+?)(?:-ext(?:\/|$)|$)/.exec(id)?.[1];
  const ed = key === undefined ? undefined : REMOTE_EDITORS[key];
  return ed === undefined ? undefined : { name: ed.name, dir: ed.dir, cli: ed.cli };
}

/** Machine-scope settings the server reads on connect: the server's data dir is `--server-data-dir` (~/.vscode-server by
 * default) and its user data lives at data/ under it, so the Machine settings file sits at data/Machine/settings.json. */
export function remoteSettingsPath(dir: string): string {
  return `${dir}/data/Machine/settings.json`;
}

/** The ticked extension ids, one per line, for the person to install from the editor's own terminal on the machine. */
export function extensionsFile(dir: string): string {
  return `${dir}/extensions.txt`;
}

function remoteEditorRewrites(platform: "darwin" | "linux"): [string, string][] {
  return Object.values(REMOTE_EDITORS).map(ed => [`${ed.userDir[platform]}/settings.json`, remoteSettingsPath(ed.dir)]);
}

const EXTENSION_ID = /^[\w-]+\.[\w-]+$/;

export interface EditorsPlan {
  installs: ToolInstall[];
  skipped: SkippedItem[];
}

/** What the ticked editors rows do on the machine: each terminal editor installed (its config travels with the files),
 * and per remote editor one file listing the ticked extensions. The rows run with the tools, before them. */
export function editorInstallsFor(entries: readonly RecipeEntry[]): EditorsPlan {
  const out: EditorsPlan = { installs: [], skipped: [] };
  const rows = entries.filter(e => ticked(e) && e.rung === "editors");
  for (const e of rows) {
    const key = name(e);
    const apt = APT_EDITORS[key];
    if (apt !== undefined) out.installs.push({ id: e.id, label: apt.name, manager: "apt", cmd: `${PRELUDE}\nexport DEBIAN_FRONTEND=noninteractive\n${APT(apt.pkg, apt.bin)}` });
    else if (key === "helix") out.installs.push({ id: e.id, label: "helix", manager: "release", cmd: `${PRELUDE}\nexport DEBIAN_FRONTEND=noninteractive\n${HELIX_INSTALL}` });
  }
  for (const [key, ed] of Object.entries(REMOTE_EDITORS)) {
    const prefix = `editors/${key}-ext/`;
    const ids: string[] = [];
    for (const e of rows.filter(e => e.id.startsWith(prefix))) {
      const ext = e.id.slice(prefix.length);
      if (EXTENSION_ID.test(ext)) ids.push(ext);
      else out.skipped.push({ id: e.id, note: "not an extension id" });
    }
    if (ids.length === 0) continue;
    const list = ids.map(squote).join(" ");
    out.installs.push({
      id: `editors/${key}-ext`,
      label: `${ed.name} extension list`,
      manager: "list",
      cmd: `${PRELUDE}\nmkdir -p "$HOME/${ed.dir}"\nprintf '%s\\n' ${list} > "$HOME/${extensionsFile(ed.dir)}"`,
    });
  }
  return out;
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
  const lines = [PRELUDE, "export DEBIAN_FRONTEND=noninteractive"];
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

/** uv by its release tarball, checksummed against the sums astral publishes
 * next to it (https://github.com/astral-sh/uv/releases). */
export const UV = {
  version: "0.12.9",
  sha256: {
    x86_64: "ec7a99cd05e0cd7f80243f135ce1361c76835cb0ee60055d14d20eba8eba1460",
    aarch64: "c36fe17937ff6bd16dc42fc13854b5465999fcab2efe0af559381e945e3c6001",
  },
} as const;

export const UV_INSTALL = [
  "if ! command -v uv >/dev/null 2>&1; then",
  '  arch="$(uname -m)"',
  '  case "$arch" in',
  `    x86_64) sha=${UV.sha256.x86_64} ;;`,
  `    aarch64) sha=${UV.sha256.aarch64} ;;`,
  '    *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "  esac",
  '  pkg="uv-$arch-unknown-linux-gnu.tar.gz"',
  `  curl -fsSL -o "/tmp/$pkg" "https://github.com/astral-sh/uv/releases/download/${UV.version}/$pkg"`,
  '  echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
  '  tar -xzf "/tmp/$pkg" -C /tmp',
  '  install -m 0755 "/tmp/uv-$arch-unknown-linux-gnu/uv" /usr/local/bin/uv',
  '  install -m 0755 "/tmp/uv-$arch-unknown-linux-gnu/uvx" /usr/local/bin/uvx',
  '  rm -rf "/tmp/$pkg" "/tmp/uv-$arch-unknown-linux-gnu"',
  "fi",
].join("\n");

/** Node releases the guest may get, one per major, pinned to nodejs.org's
 * SHASUMS256.txt entries (https://nodejs.org/dist/); `eol` is the day the
 * release schedule ends maintenance (https://github.com/nodejs/Release). */
export const NODE_RELEASES = {
  20: {
    version: "20.20.2",
    sha256: { x86_64: "19e56f0825510207dd904f087fe52faa0a4eb6b2aab5f0ea7a33830d04888b8b", aarch64: "47ef73d543ecf6eb19435f6c03a0ac4809b3bf0dd6b26c7c571efc2a6572a74d" },
    eol: "2026-04-30",
  },
  22: {
    version: "22.23.2",
    sha256: { x86_64: "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a", aarch64: "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30" },
    eol: "2027-04-30",
  },
} as const;

export type NodeMajor = keyof typeof NODE_RELEASES;

/** The line a guest gets when no supported pinned major meets an agent's floor. */
export const CURRENT_LTS: NodeMajor = 22;

export interface NodeRelease {
  version: string;
  sha256: { x86_64: string; aarch64: string };
  eol: string;
}

/** The major a set of engines floors gets: the lowest pinned major at or above the
 * floor that is still in active or maintenance support on `now`, else the current
 * LTS; nothing when the floor is above every pinned major. */
export function nodeMajorFor(floor: number, now: Date): NodeMajor | undefined {
  const majors = (Object.keys(NODE_RELEASES).map(Number) as NodeMajor[]).sort((a, b) => a - b);
  if (floor > majors.at(-1)!) return undefined;
  const supported = (m: NodeMajor): boolean => now.getTime() < Date.parse(`${NODE_RELEASES[m].eol}T23:59:59Z`);
  return majors.find(m => m >= floor && supported(m)) ?? CURRENT_LTS;
}

/** Puts the Node the golden installed ahead of any the image shipped, so the
 * agents and their version checks run on it. */
export const NODE_PATH_LINE = 'export PATH="/usr/local/bin:$PATH"';

/** Installs the release into /usr/local when the guest's Node major is under
 * `floor`, and reports what it had and what it did on stdout. */
export function nodeInstallScript(floor: number, release: NodeRelease): string {
  const v = release.version;
  return [
    "node_have=\"$(node --version 2>/dev/null || echo v0)\"",
    "node_major=\"$(printf '%s' \"$node_have\" | sed 's/^v//; s/\\..*//')\"",
    'echo "NODE_HAVE $node_have"',
    `if [ "\${node_major:-0}" -ge ${floor} ]; then echo "NODE_KEPT $node_have"; exit 0; fi`,
    'arch="$(uname -m)"',
    'case "$arch" in',
    `  x86_64) pkg=node-v${v}-linux-x64.tar.gz sha=${release.sha256.x86_64} ;;`,
    `  aarch64) pkg=node-v${v}-linux-arm64.tar.gz sha=${release.sha256.aarch64} ;;`,
    '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
    "esac",
    `curl -fsSL -o "/tmp/$pkg" "https://nodejs.org/dist/v${v}/$pkg"`,
    'echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
    'tar -xzf "/tmp/$pkg" -C /usr/local --strip-components=1',
    'rm -f "/tmp/$pkg"',
    // The install is only real once the node the agents will run is this one.
    NODE_PATH_LINE,
    `test "$(node --version)" = "v${v}"`,
    `echo "NODE_INSTALLED v${v}"`,
  ].join("\n");
}

const HERMES = { tag: "v2026.8.31", commit: "29112bef099274229cadff79cdff7bf7b99c4b77" } as const;

/** Every installer pins a version; npm checks the registry's integrity hash
 * for each tarball, uv is checksummed above, git checkouts compare the commit.
 * `node` is the package's engines floor, read from the registry at pin time. */
export const AGENT_INSTALLERS: Record<string, AgentInstaller> = {
  // https://github.com/openai/codex#quickstart
  codex: { name: "Codex", install: "npm install -g @openai/codex@0.153.0", smoke: "codex --version", node: 16 },
  // https://github.com/google-gemini/gemini-cli#quickstart
  gemini: { name: "Gemini CLI", install: "npm install -g @google/gemini-cli@0.58.0", smoke: "gemini --version", node: 20 },
  // https://opencode.ai/docs/#install
  opencode: { name: "OpenCode", install: "npm install -g opencode-ai@1.18.27", smoke: "opencode --version" },
  // https://aider.chat/docs/install.html (the uv tool line, with the version pinned)
  aider: { name: "Aider", install: `${UV_INSTALL}\nuv tool install --force --python 3.12 --with pip aider-chat==0.86.2`, smoke: "aider --version" },
  // https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md
  pi: { name: "Pi", install: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4", smoke: "pi --version", node: 22 },
  // https://hermes-agent.nousresearch.com/docs/developer-guide/contributing#manual-clone-fallback
  hermes: {
    name: "Hermes Agent",
    install: [
      UV_INSTALL,
      "if [ ! -d /root/.hermes/hermes-agent/.git ]; then",
      `  git clone -q --depth 1 --branch ${HERMES.tag} https://github.com/NousResearch/hermes-agent.git /root/.hermes/hermes-agent`,
      "fi",
      `test "$(git -C /root/.hermes/hermes-agent rev-parse HEAD)" = "${HERMES.commit}"`,
      "uv venv --python 3.11 /root/.hermes/venvs/hermes",
      "uv pip install --python /root/.hermes/venvs/hermes/bin/python -e /root/.hermes/hermes-agent",
      "ln -sfn /root/.hermes/venvs/hermes/bin/hermes /usr/local/bin/hermes",
    ].join("\n"),
    smoke: "hermes --version",
  },
};

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

/** The ticked agents with an installer, in recipe order; `extra` adds or
 * overrides installers the table lacks (the host owns the Claude Code line). */
export function agentInstallsFor(entries: readonly RecipeEntry[], extra: Record<string, AgentInstaller> = {}, now: Date = new Date()): AgentsPlan {
  const table = { ...AGENT_INSTALLERS, ...extra };
  const out: AgentsPlan = { installs: [], skipped: [] };
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "agents" || e.id.startsWith(MCP_ID_PREFIX)) continue;
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
