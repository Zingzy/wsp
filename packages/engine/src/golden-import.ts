// SPDX-License-Identifier: AGPL-3.0-only
// Golden import, the planning half: a saved recipe (the collector's rows with
// the person's ticks) becomes the list of laptop files that travel and where
// they land, the Brewfile and per-manager installs, and the pinned installer
// of every ticked agent. Nothing here touches a disk or a machine; golden.ts
// runs the plan on the builder.
import { createHash } from "node:crypto";

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
}

export interface PlannedFile {
  id: string;
  /** Absolute path on this computer. */
  source: string;
  /** Path under the guest's home. */
  dest: string;
  mode: number;
  dir: boolean;
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
  home: string;
  stat: (abs: string) => { mode: number; dir: boolean } | undefined;
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

const SSH_PUBLIC = /^(config|authorized_keys|allowed_signers|environment|rc|.*\.pub|.*known_hosts.*)$/;

function neverCopied(e: RecipeEntry, rel: string): string | undefined {
  if (e.id.startsWith("identity/ssh-key")) return "private key, never copied";
  if (e.id === "identity/gpg" || rel === ".gnupg" || rel.startsWith(".gnupg/")) return "GPG keys are never copied";
  const m = /^\.ssh\/([^/]+)$/.exec(rel);
  if (m && !SSH_PUBLIC.test(m[1]!)) return "private key, never copied";
  return undefined;
}

function placeGhToken(token: string, existing: string | undefined): string {
  if (existing === undefined) return `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n`;
  const out: string[] = [];
  let inUsers = false;
  for (const line of existing.split("\n")) {
    if (/^\s*oauth_token:/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const key = line.trim().endsWith(":");
    if (indent === 4) inUsers = line.trim() === "users:";
    if (indent === 0 && key) {
      out.push(line, `    oauth_token: ${token}`);
    } else if (indent === 8 && inUsers && key) {
      out.push(line, `            oauth_token: ${token}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Logins whose macOS copy lives in the Keychain rather than in the files the
 * recipe lists; on Linux the same tools keep the token in the file itself. */
const KEYCHAIN: Record<string, Omit<PlannedSecret, "id">> = {
  "logins/claude": { service: "Claude Code-credentials", dest: ".claude/.credentials.json", place: secret => secret },
  "logins/gh": { service: "gh:github.com", dest: ".config/gh/hosts.yml", place: placeGhToken },
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
      if (p.startsWith("Keychain:")) {
        if (opts.platform !== "darwin") plan.skipped.push({ id: e.id, path: p, note: "a macOS Keychain item; sign in on the machine" });
        continue;
      }
      if (!p.startsWith("~/")) {
        plan.skipped.push({ id: e.id, path: p, note: "not under your home directory" });
        continue;
      }
      const rel = p.slice(2);
      const blocked = neverCopied(e, rel);
      if (blocked !== undefined) {
        plan.skipped.push({ id: e.id, path: p, note: blocked });
        continue;
      }
      const source = `${opts.home}/${rel}`;
      const st = opts.stat(source);
      if (!st) {
        plan.skipped.push({ id: e.id, path: p, note: "no longer on this computer" });
        continue;
      }
      plan.files.push({ id: e.id, source, dest: rewrite(rel), mode: st.mode & 0o7777, dir: st.dir });
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

/** What a golden was built from, as far as the person's choices go: the ticked
 * ids and the login answers. Bytes and labels change between runs without
 * changing what should be on the machine. */
export function recipeHash(entries: readonly RecipeEntry[]): string {
  const ticks = entries
    .filter(ticked)
    .map(e => [e.id, e.choice ?? null] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(ticks)).digest("hex");
}

// --- tools -------------------------------------------------------------------

export type ToolManager = "brew" | "npm" | "pnpm" | "bun" | "uv" | "pipx" | "cargo" | "go";

export interface ToolInstall {
  id: string;
  label: string;
  manager: ToolManager;
  /** One bash -c script; exits non-zero on failure. */
  cmd: string;
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

/** Where the guest finds what the tools stage installs; each install line exports it so
 * it does not depend on the machine's own environment, and login shells get it from profile.d. */
export const TOOLS_PATH = `/root/.local/bin:/usr/local/sbin:/usr/local/bin:${BREW_PREFIX}/bin:${BREW_PREFIX}/sbin:/root/go/bin:/root/.cargo/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const PATH_LINE = `export PATH=${TOOLS_PATH}`;

const BREW_ENV = "HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 HOMEBREW_NO_INSTALL_CLEANUP=1 NONINTERACTIVE=1";

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Homebrew refuses to run as root, so it lives under its own user at the
// prefix its Linux bottles are built for; anything else compiles from source.
function asLinuxbrew(cmd: string): string {
  return `su -s /bin/bash linuxbrew -c ${squote(`${BREW_ENV} ${BREW_PREFIX}/bin/brew ${cmd}`)}`;
}

function homebrewBootstrap(brewfile: string): string {
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
    "cat > /root/.Brewfile <<'WSP_BREWFILE'",
    brewfile.trimEnd(),
    "WSP_BREWFILE",
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

const MANAGER_ORDER: readonly ToolManager[] = ["npm", "pnpm", "bun", "uv", "pipx", "cargo", "go"];

/** `name@version` labels (npm, pnpm, bun) and `name version` labels (uv, pipx, cargo). */
function pinOf(e: RecipeEntry, sep: "@" | " "): string | undefined {
  const n = name(e).slice(name(e).indexOf("/") + 1);
  if (!e.label.startsWith(n + sep)) return undefined;
  const v = e.label.slice(n.length + 1).trim();
  return v === "" ? undefined : v;
}

function managerCommand(e: RecipeEntry, manager: ToolManager): { cmd: string } | { note: string } {
  const pkg = e.id.slice(`tools/${manager}/`.length);
  switch (manager) {
    case "npm":
    case "pnpm":
    case "bun": {
      const v = pinOf(e, "@");
      const spec = v === undefined ? pkg : `${pkg}@${v}`;
      return { cmd: manager === "npm" ? `npm install -g ${spec}` : `${manager} add -g ${spec}` };
    }
    case "uv":
    case "pipx": {
      const v = pinOf(e, " ");
      const spec = v === undefined ? pkg : `${pkg}==${v}`;
      return { cmd: manager === "uv" ? `uv tool install ${spec}` : `pipx install ${spec}` };
    }
    case "cargo": {
      const v = pinOf(e, " ");
      return { cmd: v === undefined ? `cargo install ${pkg}` : `cargo install ${pkg} --version ${v}` };
    }
    case "go": {
      const m = /\(([^()@\s]+@[^()\s]+)\)/.exec(e.label);
      return m ? { cmd: `go install ${m[1]}` } : { note: "no module to install from" };
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
  if (brew.taps.length + brew.formulae.length > 0) {
    installs.push({ id: "tools/homebrew", label: "Homebrew", manager: "brew", cmd: withPath(homebrewBootstrap(brew.text)) });
    for (const t of brew.taps) installs.push({ id: `tools/brew-tap/${t}`, label: t, manager: "brew", cmd: withPath(asLinuxbrew(`tap ${t}`)) });
    for (const f of brew.formulae) installs.push({ id: `tools/brew/${f}`, label: f, manager: "brew", cmd: withPath(asLinuxbrew(`install ${f}`)) });
  }
  for (const manager of MANAGER_ORDER) {
    for (const e of entries) {
      if (!ticked(e) || e.rung !== "tools" || !e.id.startsWith(`tools/${manager}/`)) continue;
      const r = managerCommand(e, manager);
      if ("note" in r) skipped.push({ id: e.id, note: r.note });
      else installs.push({ id: e.id, label: e.label, manager, cmd: withPath(r.cmd) });
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

const HERMES = { tag: "v2026.8.31", commit: "29112bef099274229cadff79cdff7bf7b99c4b77" } as const;

/** Every installer pins a version; npm checks the registry's integrity hash
 * for each tarball, uv is checksummed above, git checkouts compare the commit. */
export const AGENT_INSTALLERS: Record<string, AgentInstaller> = {
  // https://github.com/openai/codex#quickstart
  codex: { name: "Codex", install: "npm install -g @openai/codex@0.153.0", smoke: "codex --version" },
  // https://github.com/google-gemini/gemini-cli#quickstart
  gemini: { name: "Gemini CLI", install: "npm install -g @google/gemini-cli@0.58.0", smoke: "gemini --version" },
  // https://opencode.ai/docs/#install
  opencode: { name: "OpenCode", install: "npm install -g opencode-ai@1.18.27", smoke: "opencode --version" },
  // https://aider.chat/docs/install.html (the uv tool line, with the version pinned)
  aider: { name: "Aider", install: `${UV_INSTALL}\nuv tool install --force --python 3.12 --with pip aider-chat==0.86.2`, smoke: "aider --version" },
  // https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md
  pi: { name: "Pi", install: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.4", smoke: "pi --version" },
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

export interface AgentsPlan {
  installs: AgentInstall[];
  skipped: SkippedItem[];
}

/** The ticked agents with an installer, in recipe order; `extra` adds or
 * overrides installers the table lacks (the host owns the Claude Code line). */
export function agentInstallsFor(entries: readonly RecipeEntry[], extra: Record<string, AgentInstaller> = {}): AgentsPlan {
  const table = { ...AGENT_INSTALLERS, ...extra };
  const out: AgentsPlan = { installs: [], skipped: [] };
  for (const e of entries) {
    if (!ticked(e) || e.rung !== "agents") continue;
    const installer = table[name(e)];
    if (installer) out.installs.push({ id: e.id, ...installer });
    else out.skipped.push({ id: e.id, note: "no installer known" });
  }
  return out;
}
