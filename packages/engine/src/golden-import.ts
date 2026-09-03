// SPDX-License-Identifier: AGPL-3.0-only
// Golden import, the planning half: a saved recipe (the collector's rows with
// the person's ticks) becomes the list of laptop files that travel and where
// they land, the Brewfile and per-manager installs, and the pinned installer
// of every ticked agent. Nothing here touches a disk or a machine; golden.ts
// runs the plan on the builder.
import { createHash } from "node:crypto";
import { join } from "node:path";

/** The recipe row as this module reads it: a structural subset of the
 * collector's manifest entry, so a recipe file parses straight into it. */
export interface RecipeEntry {
  rung: string;
  id: string;
  label: string;
  paths: readonly string[];
  bytes: number;
  default: "bring" | "skip";
  reason?: string;
  required?: boolean;
  bring?: boolean;
  choice?: string;
  linux?: string;
  /** The version the laptop runs (tools rows); the install pins it. */
  version?: string;
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
  size: number;
  mtimeMs: number;
}

/** A credential read from the macOS Keychain at pack time; `place` renders the
 * guest file from the secret and whatever the plan already copied to `dest`. */
export interface PlannedSecret {
  id: string;
  service: string;
  dest: string;
  place: (secret: string, existing: string | undefined) => string;
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

function neverCopied(e: RecipeEntry, rel: string, dir: boolean | undefined): string | undefined {
  if (e.id.startsWith("identity/ssh-key")) return "private key, never copied";
  if (e.id === "identity/gpg") return "GPG keys are never copied";
  return refusedPath(rel, dir);
}

const under = (home: string, abs: string): boolean => abs === home || abs.startsWith(`${home}/`);

/** The token goes under one host block and its users, and nowhere else; other
 * hosts in the file keep their own lines. A file without the host gets the block appended. */
export function placeGhToken(host: string, token: string, existing: string | undefined): string {
  const block = `${host}:\n    oauth_token: ${token}\n    git_protocol: https\n`;
  if (existing === undefined) return block;
  const out: string[] = [];
  let inHost = false;
  let inUsers = false;
  let seen = false;
  for (const line of existing.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const key = line.trim().endsWith(":");
    if (indent === 0 && line.trim() !== "") {
      inHost = line.trim() === `${host}:`;
      inUsers = false;
      if (inHost) seen = true;
    }
    if (!inHost) {
      out.push(line);
      continue;
    }
    if (/^\s*oauth_token:/.test(line)) continue;
    if (indent === 4) inUsers = line.trim() === "users:";
    if (indent === 0 && key) {
      out.push(line, `    oauth_token: ${token}`);
    } else if (indent === 8 && inUsers && key) {
      out.push(line, `            oauth_token: ${token}`);
    } else {
      out.push(line);
    }
  }
  if (seen) return out.join("\n");
  const body = out.join("\n");
  return `${body.endsWith("\n") ? body : `${body}\n`}${block}`;
}

/** Logins whose macOS copy lives in the Keychain rather than in the files the
 * recipe lists; on Linux the same tools keep the token in the file itself. */
const KEYCHAIN: Record<string, Omit<PlannedSecret, "id">> = {
  "logins/claude": { service: "Claude Code-credentials", dest: ".claude/.credentials.json", place: secret => secret },
  "logins/gh": { service: "gh:github.com", dest: ".config/gh/hosts.yml", place: (secret, existing) => placeGhToken("github.com", secret, existing) },
};

export function planFiles(entries: readonly RecipeEntry[], opts: PlanFilesOptions): FilesPlan {
  const rewrites = [...(opts.rewrites ?? []), ...(opts.platform === "darwin" ? MAC_REWRITES : [])];
  const rewrite = (rel: string): string => {
    for (const [from, to] of rewrites) if (rel.startsWith(from)) return to + rel.slice(from.length);
    return rel;
  };
  const plan: FilesPlan = { files: [], secrets: [], skipped: [], bytes: 0, rungs: {} };
  for (const e of entries) {
    if (!ticked(e) || e.rung === "tools") continue;
    if (e.rung === "logins" && e.choice !== "copy") continue;
    let brought = 0;
    for (const p of e.paths) {
      const skip = (note: string): void => void plan.skipped.push({ id: e.id, path: p, note });
      if (p.startsWith("Keychain:")) {
        if (opts.platform !== "darwin") skip("a macOS Keychain item; sign in on the machine");
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
      plan.files.push({ id: e.id, source, dest: rewrite(rel), mode: st.mode & 0o7777, dir: st.kind === "dir", size: st.size, mtimeMs: st.mtimeMs });
      brought++;
    }
    const keychain = opts.platform === "darwin" && e.rung === "logins" ? KEYCHAIN[e.id] : undefined;
    if (keychain) {
      plan.secrets.push({ id: e.id, ...keychain, dest: rewrite(keychain.dest) });
      brought++;
    }
    if (brought > 0) {
      plan.bytes += e.bytes;
      plan.rungs[e.rung] = (plan.rungs[e.rung] ?? 0) + brought;
    }
  }
  return plan;
}

/** What a golden was built from: the ticked ids with their login answers and
 * tool pins, and for every file that travels its size and mtime. Contents,
 * labels and row order do not enter; a builder carrying the same hash needs
 * nothing re-applied. */
export function recipeHash(entries: readonly RecipeEntry[], files: readonly Pick<PlannedFile, "id" | "dest" | "size" | "mtimeMs">[] = []): string {
  const byKey = <T extends readonly unknown[]>(rows: T[]): T[] => rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  const ticks = byKey(entries.filter(ticked).map(e => [e.id, e.choice ?? null, e.version ?? null] as const));
  const shipped = byKey(files.map(f => [f.id, f.dest, f.size, f.mtimeMs] as const));
  return createHash("sha256").update(JSON.stringify({ ticks, files: shipped })).digest("hex");
}

// --- tools -------------------------------------------------------------------

export type ToolManager = "brew" | "npm" | "pnpm" | "bun" | "uv" | "pipx" | "cargo" | "go";

export interface ToolInstall {
  id: string;
  label: string;
  manager: ToolManager;
  /** One bash -c script; exits non-zero on failure. */
  cmd: string;
  /** The install this one needs on the machine first; when that one did not install, this is skipped. */
  after?: string;
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
}

/** Homebrew itself is a git checkout at a release tag whose commit is checked
 * before anything runs (https://docs.brew.sh/Homebrew-on-Linux#alternative-installation). */
export const HOMEBREW = { tag: "6.0.21", commit: "560147012b9678b42ef5e83b690f0895552d1366" } as const;
const BREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const PNPM_HOME = "/root/.local/share/pnpm";

/** Where the guest finds what the tools stage installs; each install line exports it so
 * it does not depend on the machine's own environment, and login shells get it from profile.d. */
export const TOOLS_PATH = `/root/.local/bin:/usr/local/sbin:/usr/local/bin:${BREW_PREFIX}/bin:${BREW_PREFIX}/sbin:/root/go/bin:/root/.cargo/bin:${PNPM_HOME}:/root/.bun/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const PATH_LINE = `export PATH=${TOOLS_PATH} PNPM_HOME=${PNPM_HOME}`;

const BREW_ENV = "HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 NONINTERACTIVE=1";

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Homebrew refuses to run as root, so it lives under its own user at the
// prefix its Linux bottles are built for; anything else compiles from source.
function asLinuxbrew(cmd: string): string {
  return `su -s /bin/bash linuxbrew -c ${squote(`${BREW_ENV} ${BREW_PREFIX}/bin/brew ${cmd}`)}`;
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

export function brewfileFor(entries: readonly RecipeEntry[]): Brewfile {
  const out: Brewfile = { text: "", taps: [], formulae: [], skipped: [] };
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "tools") continue;
    if (e.id.startsWith("tools/brew-tap/")) {
      out.taps.push(e.id.slice("tools/brew-tap/".length));
    } else if (e.id.startsWith("tools/brew/")) {
      const formula = e.id.slice("tools/brew/".length);
      if (e.linux === "no") out.skipped.push({ id: e.id, note: "no Linux bottle" });
      else if (e.linux === "unknown") out.skipped.push({ id: e.id, note: "no Linux bottle known" });
      else out.formulae.push(formula);
    } else if (e.id.startsWith("tools/brew-cask/")) {
      out.skipped.push({ id: e.id, note: "macOS app, no Linux build" });
    } else if (e.id.startsWith("tools/mas/")) {
      out.skipped.push({ id: e.id, note: "Mac App Store, macOS only" });
    }
  }
  const lines = [...out.taps.map(t => `tap "${t}"`), ...out.formulae.map(f => `brew "${f}"`)];
  out.text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return out;
}

const MANAGER_ORDER: readonly Exclude<ToolManager, "brew">[] = ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go"];

// Homebrew's Linux bottles are built against a newer glibc than the base image
// ships, so its first formula pulls Homebrew's own glibc and gcc in and, on
// 6.0.21, a nested brew racing the parent for those locks fails one run in
// two (measured: 4 of 7 plain runs failed, 3 of 3 passed with these first).
// Each is its own single brew process, in this order, before any formula.
const BREW_TOOLCHAIN: readonly string[] = ["glibc", "gcc"];

/** How each manager gets onto the machine before its first tool: uv by its
 * checksummed release, the rest as Homebrew for Linux formulae (npm rides the base Node). */
const MANAGER_FORMULA: Record<Exclude<ToolManager, "brew" | "npm" | "uv">, string> = { pnpm: "pnpm", bun: "bun", pipx: "pipx", cargo: "rust", go: "go" };

/** The collector puts a Go binary's `path@version` in its first path; recipes saved
 * before that carried it in the label as `name (path@version)`. */
function goModule(e: RecipeEntry): { path: string; version: string } | undefined {
  const spec = e.paths[0] ?? /\(([^()\s]+)\)/.exec(e.label)?.[1];
  const at = spec?.lastIndexOf("@") ?? -1;
  if (spec === undefined || at <= 0 || at === spec.length - 1) return undefined;
  return { path: spec.slice(0, at), version: spec.slice(at + 1) };
}

function managerCommand(e: RecipeEntry, manager: ToolManager): { cmd: string } | { note: string } {
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

export interface ToolsPlan {
  installs: ToolInstall[];
  skipped: SkippedItem[];
  brewfile: string;
}

export function toolInstallsFor(entries: readonly RecipeEntry[]): ToolsPlan {
  const brew = brewfileFor(entries);
  const installs: ToolInstall[] = [];
  const skipped: SkippedItem[] = [...brew.skipped];
  const withPath = (cmd: string): string => `${PATH_LINE}\n${cmd}`;
  const rowsOf = (manager: ToolManager): RecipeEntry[] => entries.filter(e => ticked(e) && e.rung === "tools" && e.id.startsWith(`tools/${manager}/`));
  const npmTicked = new Set(rowsOf("npm").map(e => e.id.slice("tools/npm/".length)));

  // One step per manager that has rows, unless it already comes along as a formula or an npm global.
  const managers = new Map<ToolManager, { after: string; step?: ToolInstall }>();
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
    else managers.set(manager, { after: own, step: { id: own, label: manager, manager: "brew", cmd: withPath(asLinuxbrew(`install ${formula}`)), after: `tools/brew-toolchain/${BREW_TOOLCHAIN.at(-1)}` } });
  }

  if (brew.taps.length + brew.formulae.length > 0 || [...managers.values()].some(m => m.step?.manager === "brew")) {
    installs.push({ id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: withPath(homebrewBootstrap()) });
    let prior = "tools/homebrew";
    for (const f of BREW_TOOLCHAIN) {
      installs.push({ id: `tools/brew-toolchain/${f}`, label: `${f} (Homebrew's Linux toolchain)`, manager: "brew", cmd: withPath(asLinuxbrew(`install ${f}`)), after: prior });
      prior = `tools/brew-toolchain/${f}`;
    }
    for (const t of brew.taps) installs.push({ id: `tools/brew-tap/${t}`, label: t, manager: "brew", cmd: withPath(asLinuxbrew(`tap ${t}`)), after: prior });
    for (const f of brew.formulae) installs.push({ id: `tools/brew/${f}`, label: f, manager: "brew", cmd: withPath(asLinuxbrew(`install ${f}`)), after: prior });
  }
  for (const manager of MANAGER_ORDER) {
    const rows = rowsOf(manager);
    if (rows.length === 0) continue;
    const m = managers.get(manager);
    if (m?.step !== undefined) installs.push(m.step);
    for (const e of rows) {
      const r = managerCommand(e, manager);
      if ("note" in r) skipped.push({ id: e.id, note: r.note });
      else installs.push({ id: e.id, label: e.label, manager, cmd: withPath(r.cmd), ...(m !== undefined ? { after: m.after } : {}) });
    }
  }
  return { installs, skipped, brewfile: brew.text };
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

const UV_INSTALL = [
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

/** The one Node step a golden gets when a ticked agent's engines floor may be
 * above the base image's: the lowest pinned major that satisfies every ticked agent. */
export interface NodeInstall {
  floor: number;
  version: string;
  /** The agents whose engines asked for it, in recipe order. */
  agents: string[];
  cmd: string;
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
    if (!ticked(e) || e.rung !== "agents") continue;
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
