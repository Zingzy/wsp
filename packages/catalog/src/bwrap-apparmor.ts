// SPDX-License-Identifier: AGPL-3.0-only
// Ubuntu 24.04 turns on kernel.apparmor_restrict_unprivileged_userns, so bwrap run by any user but root dies with
// `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` and Codex's sandbox with it. Codex's own fix
// (https://learn.chatgpt.com/docs/sandboxing, Linux prerequisites) is Ubuntu's bwrap-userns-restrict profile from
// apparmor-profiles, loaded with apparmor_parser. Installing that package would also drop about twenty enforce
// profiles (dnsmasq, smbd, avahi) into /etc/apparmor.d, so the setup reads the one file out of its .deb instead.
// The profile covers /usr/bin/bwrap alone: Codex 0.155.1 runs that one before the bwrap it ships in codex-resources.
import type { SetupNeed } from "./catalog.js";

const PROFILE = "/etc/apparmor.d/bwrap-userns-restrict";

/** bwrap as nobody makes the network namespace Codex's sandbox asks for, which is what a turn as any user but root
 * needs; on failure it prints bwrap's own line, which the setup row reads as its note. */
const NOBODY_BWRAP = `out="$(setpriv --reuid=65534 --regid=65534 --clear-groups bwrap --ro-bind / / --unshare-net true 2>&1)" || { echo "bwrap fails for users other than root: $out"; exit 1; }`;

const LOAD = [
  `f=${PROFILE}`,
  `if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != 1 ]; then echo "users other than root cannot run bwrap here, and AppArmor's userns restriction is not what stops them" >&2; exit 1; fi`,
  `command -v apparmor_parser >/dev/null 2>&1 || { echo "apparmor_parser is not on this computer to load a profile for bwrap" >&2; exit 1; }`,
  `if [ -e "$f" ]; then echo "$f is there but not loaded; apparmor_parser -r $f loads it" >&2; exit 1; fi`,
  `d="$(mktemp -d)"`,
  // apt's _apt user cannot write into a folder mktemp made for root.
  `if ! (cd "$d" && apt-get download -qq -o APT::Sandbox::User=root apparmor-profiles && dpkg-deb --fsys-tarfile apparmor-profiles_*.deb | tar -xO ./usr/share/apparmor/extra-profiles/bwrap-userns-restrict > profile && [ -s profile ]); then rm -rf "$d"; echo "Ubuntu's bwrap-userns-restrict profile could not be read out of apparmor-profiles" >&2; exit 1; fi`,
  `install -m 0644 "$d/profile" "$f"; rm -rf "$d"`,
  `apparmor_parser -r -W "$f" || { rm -f "$f"; echo "AppArmor here refused the bwrap-userns-restrict profile" >&2; exit 1; }`,
  // A failed row is never undone, so a profile that leaves bwrap failing comes off here.
  `(${NOBODY_BWRAP}) >&2 || { apparmor_parser -R "$f" 2>/dev/null; rm -f "$f"; exit 1; }`,
].join("\n");

const UNLOAD = `f=${PROFILE}\nif [ -f "$f" ]; then apparmor_parser -R "$f" 2>/dev/null; rm -f "$f" /var/cache/apparmor/*/bwrap-userns-restrict; fi`;

/** Lets bwrap make its namespaces for users other than root where AppArmor stops them, after bubblewrap is on. */
export const BWRAP_APPARMOR: SetupNeed = { id: "bwrap-apparmor", label: "bwrap AppArmor profile", after: "bubblewrap", cmd: LOAD, check: NOBODY_BWRAP, off: UNLOAD };
