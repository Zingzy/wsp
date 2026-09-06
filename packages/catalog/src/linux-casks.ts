// SPDX-License-Identifier: AGPL-3.0-only
// Commands with a Linux build of their own, outside Homebrew, that the
// catalog's vendor road installs. Each installs from its vendor's release,
// hashed on the guest and printed on the WSP_ROAD line the tools stage reads,
// so the first install of a version records the checksum and the next install
// of that version checks it. The vendor's current version is fetched once and
// the pin holds it from then on.
import { shellQuote } from "@wsp/protocol";
import { type ToolPin, pinStateOf } from "./roads.js";

export interface LinuxCask {
  /** The command the install puts on PATH. */
  bin: string;
  /** Where the Linux build comes from, for the row's column. */
  from: string;
  /** The row's detail line, under 76 columns: what lands on the machine. */
  detail: string;
  /** One bash script; version is the road's when it names one, pin what a first install recorded. */
  install(version: string | undefined, pin: ToolPin | undefined): string;
  uninstall: string;
}

/** The version the script installs: the Mac's, else the pinned one, else the vendor's current one by `latest`. */
function versionLines(version: string | undefined, pin: ToolPin | undefined, latest: string): string[] {
  const fixed = version ?? pin?.tag;
  return fixed !== undefined ? [`ver=${shellQuote(fixed)}`] : [`ver="$(${latest})"`, '[ -n "$ver" ] || { echo "Error: could not read the current version" >&2; exit 1; }'];
}

/** The checksum check, only when the version installed is the one the pin recorded. */
function pinLines(version: string | undefined, pin: ToolPin | undefined, what: string): string[] {
  if (pinStateOf(version, pin) !== "same") return [];
  return [`[ "$sum" = ${shellQuote(pin!.sha256)} ] || { echo "Error: ${what} does not match the checksum recorded on the first install of $ver" >&2; exit 1; }`];
}

const PRELUDE = ["set -euo pipefail", 'arch="$(uname -m)"', 'tmp="$(mktemp -d /tmp/wsp-cask-XXXXXX)"', "trap 'rm -rf \"$tmp\"' EXIT"];
const ARCH = (x86: string, arm: string): string => `case "$arch" in x86_64) a=${x86} ;; aarch64) a=${arm} ;; *) echo "Error: unsupported arch: $arch" >&2; exit 1 ;; esac`;

const GCLOUD_HOME = "/opt/google-cloud-sdk";
const GCLOUD_BINS = ["gcloud", "gsutil", "bq"];

/** Google publishes the tarball per version and arch; the rapid channel's component list names the current version.
 * The x86_64 tarball bundles a Python; the arm one runs on the machine's python3. */
export const GCLOUD: LinuxCask = {
  bin: "gcloud",
  from: "Google's Linux release",
  detail: "from Google's Linux release, checksum recorded on first install",
  install: (version, pin) =>
    [
      ...PRELUDE,
      ARCH("x86_64", "arm"),
      `[ "$a" != arm ] || command -v python3 >/dev/null || { echo "Error: gcloud on arm needs python3 on the machine; Google's arm tarball bundles none" >&2; exit 1; }`,
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

/** The static binary from the Kubernetes release, checked against the sum published beside it. */
export const KUBECTL: LinuxCask = {
  bin: "kubectl",
  from: "Kubernetes release",
  detail: "kubectl only, from the Kubernetes release; Docker itself has no Linux build",
  install: (version, pin) =>
    [
      ...PRELUDE,
      ARCH("amd64", "arm64"),
      ...versionLines(version, pin, "curl -fsSL https://dl.k8s.io/release/stable.txt"),
      'url="https://dl.k8s.io/release/$ver/bin/linux/$a/kubectl"',
      'curl -fsSL -o "$tmp/kubectl" "$url"',
      'curl -fsSL -o "$tmp/kubectl.sha256" "$url.sha256"',
      'echo "$(cat "$tmp/kubectl.sha256")  $tmp/kubectl" | sha256sum -c - >/dev/null',
      `sum="$(sha256sum "$tmp/kubectl" | cut -d' ' -f1)"`,
      ...pinLines(version, pin, "kubectl $ver"),
      'install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl',
      'echo "WSP_ROAD release kubectl-$ver-linux-$a $sum $ver"',
    ].join("\n"),
  uninstall: "rm -f /usr/local/bin/kubectl",
};

export const LINUX_CASKS: readonly LinuxCask[] = [GCLOUD, KUBECTL];
