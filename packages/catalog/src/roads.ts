// SPDX-License-Identifier: AGPL-3.0-only
// The roads a catalog entry can take onto a Linux machine, and the pinned
// installers the script road carries: uv and Node by their checksummed
// releases, Hermes by a git checkout at a commit, Claude Code by its vendor's
// installer. Every pin here is checked on the machine before anything runs.
import type { LinuxCask } from "./linux-casks.js";

export const MIB = 1024 * 1024;

/** What the first install of a release recorded: the tag it fetched and the asset's sha256. */
export interface ToolPin {
  tag: string;
  sha256: string;
}

/** A release asset: a GitHub repository whose Linux asset for the arch is picked at install and pinned by its
 * sha256 on the first install, or a vendor's own download the cask's script names and hashes the same way. */
export type ReleaseAsset = { github: string } | { vendor: LinuxCask };

export type InstallRoad =
  | { road: "brew"; formula: string }
  /** An npm global; `version` absent means the version the laptop runs when the row mirrors one, else the current one. */
  | { road: "npm"; package: string; version?: string; ignoreScripts?: true }
  | { road: "release"; asset: ReleaseAsset }
  | { road: "apt"; packages: readonly string[] }
  /** A vendor installer with its own pin, as the stage runs it. */
  | { road: "script"; script: string };

export type RoadName = InstallRoad["road"];
export const ROADS: readonly RoadName[] = ["brew", "npm", "release", "apt", "script"];

/** The one curl into a shell the rules allow: the harness vendor's own installer, run on a first-life builder and
 * recorded in the manifest as setupSha; the smoke is what proves the result. */
export const GOLDEN_SETUP = "curl -fsSL https://claude.ai/install.sh | bash";
export const GOLDEN_SMOKE = "claude --version";

/** Claude Code's config dir on the guest, always CLAUDE_CONFIG_DIR and never HOME. */
export const CLAUDE_CONFIG_DIR = "/root/.claude-cfg";
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
