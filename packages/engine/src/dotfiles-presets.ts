// SPDX-License-Identifier: AGPL-3.0-only

// Guest exec is bash -c with no HOME in the environment (measured live on
// Solari sandboxes); under set -u the first "$HOME" would abort the script.
export const PRELUDE = `set -euo pipefail
export HOME="\${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"`;

export const APT = (pkg: string, cmd = pkg): string =>
  `command -v ${cmd} >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq ${pkg}; }`;
