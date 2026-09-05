// SPDX-License-Identifier: AGPL-3.0-only
// Casks that are commands with a Linux build of their own, outside Homebrew.
// Each installs from its vendor's release, hashed on the guest and printed on
// the WSP_ROAD line the tools stage reads, so the first install of a version
// records the checksum and the next install of that version checks it. The
// version is the Mac's when the row carries one; otherwise the vendor's
// current one is fetched once and the pin holds it from then on.
import type { ToolPin } from "./golden-import.js";

export interface LinuxCask {
  /** The cask tokens that ship the command on macOS. */
  casks: readonly string[];
  /** The command the install puts on PATH. */
  bin: string;
  /** Where the Linux build comes from, for the row's column. */
  from: string;
  /** The row's detail line, under 76 columns: what lands on the machine. */
  detail: string;
  /** One bash script; version is the Mac's when the row carries one, pin what a first install recorded. */
  install(version: string | undefined, pin: ToolPin | undefined): string;
  uninstall: string;
}

function squote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** How a cask install stands against the recipe's pin: nothing recorded, the same version (checked), or a
 * version the Mac has since moved to (a first install again, re-recorded). Without a Mac version the pin's own stands. */
export function caskPinState(e: { version?: string; pin?: ToolPin }): "none" | "same" | "moved" {
  if (e.pin === undefined) return "none";
  return e.version === undefined || e.version === e.pin.tag ? "same" : "moved";
}

/** The version the script installs: the Mac's, else the pinned one, else the vendor's current one by `latest`. */
function versionLines(version: string | undefined, pin: ToolPin | undefined, latest: string): string[] {
  const fixed = version ?? pin?.tag;
  return fixed !== undefined ? [`ver=${squote(fixed)}`] : [`ver="$(${latest})"`, '[ -n "$ver" ] || { echo "Error: could not read the current version" >&2; exit 1; }'];
}

/** The checksum check, only when the version installed is the one the pin recorded. */
function pinLines(version: string | undefined, pin: ToolPin | undefined, what: string): string[] {
  if (caskPinState({ version, pin }) !== "same") return [];
  return [`[ "$sum" = ${squote(pin!.sha256)} ] || { echo "Error: ${what} does not match the checksum recorded on the first install of $ver" >&2; exit 1; }`];
}

const PRELUDE = ["set -euo pipefail", 'arch="$(uname -m)"', 'tmp="$(mktemp -d /tmp/wsp-cask-XXXXXX)"', "trap 'rm -rf \"$tmp\"' EXIT"];
const ARCH = (x86: string, arm: string): string => `case "$arch" in x86_64) a=${x86} ;; aarch64) a=${arm} ;; *) echo "Error: unsupported arch: $arch" >&2; exit 1 ;; esac`;

const GCLOUD_HOME = "/opt/google-cloud-sdk";
const GCLOUD_BINS = ["gcloud", "gsutil", "bq"];

/** Google publishes the tarball per version and arch; the rapid channel's component list names the current version. */
const GCLOUD: LinuxCask = {
  casks: ["gcloud-cli", "google-cloud-sdk"],
  bin: "gcloud",
  from: "Google's Linux release",
  detail: "from Google's Linux release, checksum recorded on first install",
  install: (version, pin) =>
    [
      ...PRELUDE,
      ARCH("x86_64", "arm"),
      ...versionLines(version, pin, `curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/components-2.json | grep -o '"version": *"[0-9.]*"' | head -1 | grep -o '[0-9][0-9.]*[0-9]'`),
      'pkg="google-cloud-cli-$ver-linux-$a.tar.gz"',
      'curl -fsSL -o "$tmp/$pkg" "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/$pkg"',
      `sum="$(sha256sum "$tmp/$pkg" | cut -d' ' -f1)"`,
      ...pinLines(version, pin, "$pkg"),
      `rm -rf ${GCLOUD_HOME}`,
      'tar -xzf "$tmp/$pkg" -C /opt',
      ...GCLOUD_BINS.map(b => `ln -sf ${GCLOUD_HOME}/bin/${b} /usr/local/bin/${b}`),
      'echo "WSP_ROAD release $pkg $sum $ver"',
    ].join("\n"),
  uninstall: `rm -rf ${GCLOUD_HOME} ${GCLOUD_BINS.map(b => `/usr/local/bin/${b}`).join(" ")}`,
};

/** Docker Desktop ships kubectl on the Mac; on Linux the static binary comes from the Kubernetes release, checked
 * against the sum published beside it. The cask's version is Docker's, so the Mac's version is never used here. */
const KUBECTL: LinuxCask = {
  casks: ["docker-desktop", "docker"],
  bin: "kubectl",
  from: "Kubernetes release",
  detail: "kubectl only, from the Kubernetes release; Docker itself has no Linux build",
  install: (_version, pin) =>
    [
      ...PRELUDE,
      ARCH("amd64", "arm64"),
      ...versionLines(undefined, pin, "curl -fsSL https://dl.k8s.io/release/stable.txt"),
      'url="https://dl.k8s.io/release/$ver/bin/linux/$a/kubectl"',
      'curl -fsSL -o "$tmp/kubectl" "$url"',
      'curl -fsSL -o "$tmp/kubectl.sha256" "$url.sha256"',
      'echo "$(cat "$tmp/kubectl.sha256")  $tmp/kubectl" | sha256sum -c - >/dev/null',
      `sum="$(sha256sum "$tmp/kubectl" | cut -d' ' -f1)"`,
      ...pinLines(undefined, pin, "kubectl $ver"),
      'install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl',
      'echo "WSP_ROAD release kubectl-$ver-linux-$a $sum $ver"',
    ].join("\n"),
  uninstall: "rm -f /usr/local/bin/kubectl",
};

export const LINUX_CASKS: readonly LinuxCask[] = [GCLOUD, KUBECTL];

const CASK_PREFIX = "tools/brew-cask/";
const CLI_PREFIX = "tools/cli/";

/** The table's entry for a tools row: a command row by its command, an app cask row by its token. */
export function linuxCaskFor(id: string): LinuxCask | undefined {
  if (id.startsWith(CLI_PREFIX)) return linuxCaskByBin(id.slice(CLI_PREFIX.length));
  if (!id.startsWith(CASK_PREFIX)) return undefined;
  const token = id.slice(CASK_PREFIX.length);
  return LINUX_CASKS.find(c => c.casks.includes(token));
}

/** The table's entry for a command, when one of the casks ships it. */
export function linuxCaskByBin(bin: string): LinuxCask | undefined {
  return LINUX_CASKS.find(c => c.bin === bin);
}
