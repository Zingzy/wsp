// SPDX-License-Identifier: AGPL-3.0-only
// The roads a catalog entry or a recipe's tools row can take onto a Linux
// machine (the modules that walk them are in road-modules.ts), and the pinned
// installers the script road carries: uv, Node and Docker's compose plugin by
// their checksummed releases, Hermes by a git checkout at a commit, Claude Code
// by its vendor's installer. Every pin here is checked on the machine before
// anything runs.
import { shellQuote } from "@wsp/protocol";
import type { LinuxCask } from "./linux-casks.js";

export const MIB = 1024 * 1024;

/** What the first install of a release recorded: the tag it fetched and the asset's sha256. */
export interface ToolPin {
  tag: string;
  sha256: string;
}

/** How an install stands against the recipe's pin: nothing recorded, the same version (checked), or a version the
 * source has since moved to (a first install again, re-recorded). Without a version the pin's own stands. */
export function pinStateOf(version: string | undefined, pin: ToolPin | undefined): "none" | "same" | "moved" {
  if (pin === undefined) return "none";
  return version === undefined || version === pin.tag ? "same" : "moved";
}

/** A package manager's global; `version` absent means the current one, or the laptop's when a row mirrors one. */
export interface PackageRoad<K extends string> {
  road: K;
  package: string;
  version?: string;
}

export type InstallRoad =
  | { road: "brew"; formula: string }
  | (PackageRoad<"npm"> & { ignoreScripts?: true })
  | PackageRoad<"pnpm">
  | PackageRoad<"bun">
  | PackageRoad<"uv">
  | PackageRoad<"pipx">
  | PackageRoad<"cargo">
  /** `go install` of a module at a version; a row whose module nobody could read carries none and installs nothing. */
  | { road: "go"; module?: string; version?: string }
  /** A GitHub repository's Linux asset for the arch, at `version` (a tag) or the current release; `pin` is what the first
   * install of that tag recorded and `go` the main package `go install` falls back to, at its own version or the tag's;
   * with none there is no fall-through. A row that came back from a golden's digest names no repository: it only ever comes off. */
  | { road: "release"; repo?: string; version?: string; pin?: ToolPin; go?: string }
  /** A vendor's own Linux download, as its cask row scripts and hashes it. */
  | { road: "vendor"; cask: LinuxCask; version?: string; pin?: ToolPin }
  | { road: "apt"; packages: readonly string[] }
  /** A vendor installer with its own pin, as the stage runs it. */
  | { road: "script"; script: string };

export type RoadName = InstallRoad["road"];
export const ROADS: readonly RoadName[] = ["brew", "npm", "pnpm", "bun", "uv", "pipx", "cargo", "go", "release", "vendor", "apt", "script"];

/** A vendor installer its vendor documents as curl piped into bash, run the one way a road may: the script is
 * downloaded to a file through the road's curl function, so a retry re-reads the download and never a body a shell
 * has begun to run; checked to be a shell script, since the vendor publishes no sum; then run from the file with
 * nothing on stdin. */
export function installerScript(url: string): string {
  return [
    'f="$(mktemp)"',
    `trap 'rm -f "$f"' EXIT`,
    `curl -o "$f" ${shellQuote(url)}`,
    `test "$(head -c 2 "$f")" = '#!' || { echo ${shellQuote(`Error: what ${url} served is not a shell script`)} >&2; exit 1; }`,
    'bash "$f" </dev/null',
  ].join("\n");
}

/** The one vendor installer the rules allow: the harness vendor's own, run on a first-life builder and recorded in
 * the manifest as setupSha; the smoke is what proves the result. */
export const GOLDEN_SETUP = installerScript("https://claude.ai/install.sh");
export const GOLDEN_SMOKE = "claude --version";

/** The guest's home directory: every machine runs as root. */
export const GUEST_HOME = "/root";
/** The one line every apt run exports, so no prompt can wait on a machine nobody types at. */
export const APT_ENV = "export DEBIAN_FRONTEND=noninteractive";
/** Claude Code's config dir on the guest, always CLAUDE_CONFIG_DIR and never HOME. */
export const CLAUDE_CONFIG_DIR = `${GUEST_HOME}/.claude-cfg`;
/** The file under Claude Code's config dir that the apiKeyHelper's key is placed in and the copied settings read. */
export const CLAUDE_KEY_FILE = "anthropic-api-key";

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
  `  curl -o "/tmp/$pkg" "https://github.com/astral-sh/uv/releases/download/${UV.version}/$pkg"`,
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

export interface NodeRelease {
  version: string;
  sha256: { x86_64: string; aarch64: string };
  eol: string;
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
    `curl -o "/tmp/$pkg" "https://nodejs.org/dist/v${v}/$pkg"`,
    'echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
    'tar -xzf "/tmp/$pkg" -C /usr/local --strip-components=1',
    'rm -f "/tmp/$pkg"',
    // The install is only real once the node the agents will run is this one.
    NODE_PATH_LINE,
    `test "$(node --version)" = "v${v}"`,
    `echo "NODE_INSTALLED v${v}"`,
  ].join("\n");
}

/** Docker Compose by its release binary, checksummed against the sums Docker
 * publishes next to it (https://github.com/docker/compose/releases). */
export const COMPOSE = {
  version: "v5.5.1",
  sha256: {
    x86_64: "db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576",
    aarch64: "732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7",
  },
} as const;

/** Where the docker cli looks for its plugins system-wide, so `docker compose` finds the binary. */
export const COMPOSE_PLUGIN = "/usr/libexec/docker/cli-plugins/docker-compose";

/** The engine from the distro, compose from its release: Debian bookworm, the machines' base, packages
 * docker.io but no compose v2, so the plugin is fetched pinned and put where the cli reads it. */
export const DOCKER_INSTALL = [
  APT_ENV,
  "apt-get install -y -qq docker.io",
  'arch="$(uname -m)"',
  'case "$arch" in',
  `  x86_64) sha=${COMPOSE.sha256.x86_64} ;;`,
  `  aarch64) sha=${COMPOSE.sha256.aarch64} ;;`,
  '  *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
  "esac",
  `curl -o /tmp/docker-compose "https://github.com/docker/compose/releases/download/${COMPOSE.version}/docker-compose-linux-$arch"`,
  'echo "$sha  /tmp/docker-compose" | sha256sum -c - >/dev/null',
  `install -D -m 0755 /tmp/docker-compose ${COMPOSE_PLUGIN}`,
  "rm -f /tmp/docker-compose",
].join("\n");

/** Python 3.12 as uv's managed interpreter: uv pins the python-build-standalone release and checks its sha256,
 * so the pin is uv's own; python3 on PATH is a link to that interpreter, ahead of whatever the image ships. */
export const PYTHON_INSTALL = [
  UV_INSTALL,
  "uv python install 3.12",
  'ln -sfn "$(uv python find --managed-python 3.12)" /usr/local/bin/python3',
].join("\n");

/** Debian ships fd as fdfind to dodge a name clash; agents type fd, so the row links it onto PATH under that name. */
export const FD_INSTALL = [APT_ENV, "apt-get install -y -qq fd-find", "ln -sfn /usr/bin/fdfind /usr/local/bin/fd"].join("\n");

/** Yarn through the corepack Node 22 ships, pinned to the current stable line, with the download prompt off. */
export const YARN_INSTALL = ["corepack enable yarn", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack install -g yarn@stable"].join("\n");

const HERMES = { tag: "v2026.8.31", commit: "29112bef099274229cadff79cdff7bf7b99c4b77" } as const;

/** https://hermes-agent.nousresearch.com/docs/developer-guide/contributing#manual-clone-fallback */
export const HERMES_INSTALL = [
  UV_INSTALL,
  "if [ ! -d /root/.hermes/hermes-agent/.git ]; then",
  `  git clone -q --depth 1 --branch ${HERMES.tag} https://github.com/NousResearch/hermes-agent.git /root/.hermes/hermes-agent`,
  "fi",
  `test "$(git -C /root/.hermes/hermes-agent rev-parse HEAD)" = "${HERMES.commit}"`,
  "uv venv --python 3.11 /root/.hermes/venvs/hermes",
  "uv pip install --python /root/.hermes/venvs/hermes/bin/python -e /root/.hermes/hermes-agent",
  "ln -sfn /root/.hermes/venvs/hermes/bin/hermes /usr/local/bin/hermes",
].join("\n");
