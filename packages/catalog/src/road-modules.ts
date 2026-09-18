// SPDX-License-Identifier: AGPL-3.0-only
// The install roads as modules, one per road kind: the bash line that puts a
// road's argument on a Linux machine (pinned where the road names a version),
// the line that takes it off again, the names a recipe row may carry for it,
// what it runs on top of, and how the install reads to a person. The stages
// and the wizard ask a module through roadModule(); nothing outside this file
// decides by a road's name. Every line is text: nothing here runs a command.
import { HOMEBREW_HOME as LINUXBREW_HOME, HOMEBREW_PREFIX as BREW_PREFIX, PNPM_HOME, shellQuote } from "@wsp/protocol";
import { APT_ENV, GUEST_HOME, ROADS, type InstallRoad, type PackageRoad, type RoadName, pinCheckLine, standingPin, versionOf } from "./roads.js";

type Road<K extends RoadName> = Extract<InstallRoad, { road: K }>;

/** A recipe's tools row as a manager road reads it: the package (or formula, or Go binary) after the manager in the
 * row's id, the version the laptop runs, and the paths and label the collector wrote, where a road keeps more there. */
export interface ToolRow {
  name: string;
  version?: string;
  paths: readonly string[];
  label: string;
}

export interface RoadModule<R extends { road: RoadName } = InstallRoad> {
  /** How an install by this road reads beside the tool's name: "by apt", "from its release". */
  words: string;
  /** Every directory on the machine this road writes an install into. A workspace on a computer somebody owns is
   * made of that computer's directories: it overlays the trees in the protocol's WORKSPACE_OVERLAID, binds /root,
   * and reads nothing else of the computer unless it is a shared tool root. A road that installs anywhere else
   * puts its tool on the computer and out of every workspace's sight, which is what the test below reads. */
  roots: readonly string[];
  /** The one line a person reads while the install runs, for a road whose install line is not that: the brew line
   * without its su, where a release comes from. Absent, the install line is its own. */
  shown?(road: R, bin: string): string;
  /** What the install runs on top of: a floor row by id, the one apt index read, or Homebrew. */
  after?: string;
  /** The road a recipe's tools row under this manager takes; absent for a road no manager row names. */
  fromRow?(row: ToolRow): R;
  /** The bash line that puts the road's argument on the machine, or why nothing can; `bin` is the command it puts on PATH. */
  install(road: R, bin: string): string | { note: string };
  /** The line that takes it off again, or why it stays. */
  uninstall(road: R, bin: string): { cmd: string } | { note: string };
  /** The package names a recipe's tools row may carry for the road's argument. */
  names(road: R): readonly string[];
  /** The command the install puts on PATH when the road alone knows it. */
  bin?(road: R): string | undefined;
  /** The road fixed to a version, for a road that pins one; absent for a road that installs what its source serves. */
  at?(road: R, version: string): R;
  /** One bash line that prints the installed version, in the form `at` takes, on the tools PATH once the row is on
   * the machine; nothing printed reads as unread. Absent for a road whose install line prints it itself. */
  installed?(road: R, bin: string): string;
}

/** Whether a copy built from this road's pin gets the version the seal read: the road installs at one (`at`), or
 * its script fixes one in its own text. Absent both, the road installs what its source serves on the day. */
export function fixesVersion(road: InstallRoad): boolean {
  return roadModule(road).at !== undefined || (road.road === "script" && road.version !== undefined);
}

// --- the network clock every road runs under -------------------------------------

/** A network read that has gone dead fails after this long and is tried this many more times, on every road whose
 * tool takes the knobs from its environment; the road's step limit below bounds whatever the tool cannot clock. */
export const NET_READ_S = 60;
export const NET_RETRIES = 1;
/** Seconds curl gives a connection to open, and the most npm waits before its one more try. */
const NET_CONNECT_S = 15;
const NET_RETRY_WAIT_S = 10;
const NPM_NET = `export npm_config_fetch_timeout=${NET_READ_S * 1000} npm_config_fetch_retries=${NET_RETRIES} npm_config_fetch_retry_maxtimeout=${NET_RETRY_WAIT_S * 1000}`;
const PIP_NET = `export PIP_TIMEOUT=${NET_READ_S} PIP_RETRIES=${NET_RETRIES}`;
const UV_NET = `export UV_HTTP_TIMEOUT=${NET_READ_S} UV_HTTP_RETRIES=${NET_RETRIES}`;
const CARGO_NET = `export CARGO_HTTP_TIMEOUT=${NET_READ_S} CARGO_NET_RETRY=${NET_RETRIES}`;
/** curl reads no environment for these, so every curl a road's script types goes through this function; under a
 * byte a second for the read window is a dead read to it. --silent with --show-error leaves curl's one error line as
 * the last thing on stderr, which is what the reason rule reads; a script types `curl -o file url` and nothing more. */
export const CURL_NET = `curl() { command curl --connect-timeout ${NET_CONNECT_S} --speed-limit 1 --speed-time ${NET_READ_S} --retry ${NET_RETRIES} --fail --silent --show-error --location "$@"; }`;

const atVersion = <R extends { version?: string }>(r: R, version: string): R => ({ ...r, version });
const pinned = (pkg: string, version: string | undefined, sep: string): string => (version === undefined ? pkg : `${pkg}${sep}${version}`);
/** The version field of a Node global's package.json under the manager's global root. */
const nodeGlobalVersion = (rootCmd: string, pkg: string): string => `node -p 'require(process.argv[1] + "/package.json").version' "$(${rootCmd})/"${shellQuote(pkg)}`;
/** The second column of the line a listing prints for the package, with the leading v and a trailing colon off. */
const listedVersion = (list: string, pkg: string): string => `${list} 2>/dev/null | awk -v p=${shellQuote(pkg)} '$1==p{sub(/^v/,"",$2); sub(/:$/,"",$2); print $2}'`;

/** The pseudo step every apt row waits on: the index read once, before the first of them. */
export const APT_INDEX = "apt-index";
/** The pseudo step every formula waits on: Homebrew with its toolchain. */
export const HOMEBREW_STEP = "homebrew";
/** The index read, as the stage runs it before the first apt row. */
export const APT_UPDATE = `${APT_ENV}\napt-get update -qq`;

// --- Homebrew ------------------------------------------------------------------

/** Homebrew itself is a git checkout at a release tag whose commit is checked
 * before anything runs (https://docs.brew.sh/Homebrew-on-Linux#alternative-installation). */
export const HOMEBREW = { tag: "6.0.21", commit: "560147012b9678b42ef5e83b690f0895552d1366" } as const;
/** The user Homebrew runs as and the home useradd makes for it, and the prefix under it. The protocol's, since a
 * workspace on a computer somebody owns is made of that computer's directories and the daemon binds this prefix in
 * for the tools installed here to answer inside: the road that installs them and the bundle that brings them in
 * cannot name two directories. */
export { HOMEBREW_HOME as LINUXBREW_HOME, HOMEBREW_PREFIX as BREW_PREFIX } from "@wsp/protocol";
/** Homebrew's own checkout, where its Linux install puts it. */
export const BREW_REPO = `${BREW_PREFIX}/Homebrew`;
// Install-time cleanup stays on: with it off, one recipe left 2.6 GB of bottles in the download cache on a 20 GB disk.
export const BREW_ENV = `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 NONINTERACTIVE=1 HOMEBREW_CURL_RETRIES=${NET_RETRIES}`;
/** The one brew anything on this machine types, a person's shell included: the shim below, in the directory Homebrew
 * puts its own on, so a dotfiles line that prepends that directory (`brew shellenv` does) still lands on the shim. */
export const BREW = `${BREW_PREFIX}/bin/brew`;
/** What the shim runs: brew reads its prefix off the path it was called by, two directories up, so calling the
 * checkout's own bin/brew would make the checkout the prefix and every keg with it. This link is at that depth and
 * in a directory no PATH carries and no keg links into, so it is the shim's alone. */
export const BREW_REAL = `${BREW_PREFIX}/libexec/brew`;

/** su hands linuxbrew the directory the caller stood in, and Homebrew stops before it starts on one linuxbrew
 * cannot read: root's home is 0700 on the images a box boots, and every formula row failed behind it. Stay where
 * the call was made when linuxbrew can read it, so a person's own brew still reads the folder they are in. */
export const FROM_A_READABLE_DIR = `cd . 2>/dev/null || cd ${LINUXBREW_HOME}`;

// Homebrew refuses to run as root, so it lives under its own user at the
// prefix its Linux bottles are built for; anything else compiles from source.
export function asLinuxbrewScript(script: string): string {
  return `su -s /bin/bash linuxbrew -c ${shellQuote(`${FROM_A_READABLE_DIR}\nexport ${BREW_ENV}\n${script}`)}`;
}

export function asLinuxbrew(cmd: string): string {
  return `su -s /bin/bash linuxbrew -c ${shellQuote(`${FROM_A_READABLE_DIR}\n${BREW_ENV} ${BREW} ${cmd}`)}`;
}

/** The file that sits at BREW, so every brew on the machine runs as the user that owns the tree however it was
 * reached. Root running Homebrew's own brew writes root-owned files into that tree and git then refuses to read it,
 * which reads as "No remote origin, skipping update". It sets no Homebrew environment: a person's brew is meant to
 * update, and a caller that wants otherwise exports it, which su carries through. */
export const LINUXBREW_SHIM = ["#!/bin/sh", `if [ "$(id -un)" = linuxbrew ]; then exec ${BREW_REAL} "$@"; fi`, `exec su -s /bin/bash linuxbrew -c ${shellQuote(`${FROM_A_READABLE_DIR}\nexec "$0" "$@"`)} -- ${BREW_REAL} "$@"`].join("\n");

/** A formula's own short name, the part after the tap: the name Homebrew links it under in the prefix, and the
 * name the road below installs the binary under where a tap formula has no Linux bottle. Not the command the
 * formula puts on PATH, which is the formula's business and often another word (git-delta puts delta on PATH,
 * gnupg puts gpg, c-ares puts adig and ahost); nothing a recipe carries names those. */
export const formulaShortName = (formula: string): string => formula.slice(formula.lastIndexOf("/") + 1);

/** Whether a formula is on a machine, as one shell test a workspace can answer, and neither half runs brew, which
 * cannot run inside a workspace at all: the prefix keeps an `opt/<short name>` link per formula it installed,
 * whatever binaries that formula puts on PATH, and that link alone is the answer for a core formula. A tap formula
 * falls back to a command of that name, since a tap formula with no Linux bottle took the road to /usr/local/bin
 * under it, which is the same split the uninstall above reads. A core formula is never read by its name: the base
 * stage's node and the release road's gh are on the PATH under theirs, and a formula Homebrew never installed
 * would read present off another road's work. */
export const formulaPresent = (formula: string): string => {
  const short = formulaShortName(formula);
  const linked = `test -e ${BREW_PREFIX}/opt/${short}`;
  return formula.includes("/") ? `${linked} || command -v ${shellQuote(short)} >/dev/null 2>&1` : linked;
};

const brew: RoadModule<Road<"brew">> = {
  words: "with Homebrew",
  // A formula lands in the prefix; a tap formula with no Linux bottle takes the road to /usr/local/bin.
  roots: [BREW_PREFIX, "/usr/local/bin"],
  after: HOMEBREW_STEP,
  fromRow: r => ({ road: "brew", formula: r.name }),
  shown: r => `brew install ${r.formula}`,
  install: r => asLinuxbrew(`install ${r.formula}`),
  uninstall: r => {
    if (!r.formula.includes("/")) return { cmd: asLinuxbrew(`uninstall ${r.formula}`) };
    // A tap formula with no Linux bottle took the road to /usr/local/bin under the formula's name, not to the cellar.
    const bin = formulaShortName(r.formula);
    return { cmd: `if [ -x ${BREW} ] && ${asLinuxbrew(`list --formula ${r.formula}`)} >/dev/null 2>&1; then ${asLinuxbrew(`uninstall ${r.formula}`)}; else rm -f /usr/local/bin/${shellQuote(bin)}; fi` };
  },
  names: r => [r.formula],
  installed: r => `${asLinuxbrew(`list --versions ${r.formula}`)} 2>/dev/null | awk '{print $2}'`,
};

// --- package managers ----------------------------------------------------------

const npm: RoadModule<Road<"npm">> = {
  words: "as an npm global",
  // npm's global root under the Node the base stage unpacks into /usr/local.
  roots: ["/usr/local/lib/node_modules", "/usr/local/bin"],
  after: "node",
  fromRow: r => ({ road: "npm", package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `npm install -g ${r.ignoreScripts === true ? "--ignore-scripts " : ""}${pinned(r.package, versionOf(r), "@")}`,
  uninstall: r => ({ cmd: `npm uninstall -g ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
  installed: r => nodeGlobalVersion("npm root -g", r.package),
};

/** pnpm and bun keep npm's global shape under their own verbs; bun lists its globals as a tree and keeps no root command. */
const nodeGlobal = <K extends "pnpm" | "bun">(road: K): RoadModule<PackageRoad<K>> => ({
  words: `with ${road}`,
  roots: [road === "pnpm" ? PNPM_HOME : "/root/.bun"],
  fromRow: r => ({ road, package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `${road} add -g ${pinned(r.package, versionOf(r), "@")}`,
  uninstall: r => ({ cmd: `${road} remove -g ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
  installed: r => (road === "bun" ? `bun pm ls -g 2>/dev/null | grep -oE "(^| )${r.package}@[^[:space:]]+" | head -n 1 | sed 's/.*@//'` : nodeGlobalVersion("pnpm root -g", r.package)),
});

/** uv and pipx install a Python tool into its own environment, pinned the pip way. */
const pythonTool = <K extends "uv" | "pipx">(road: K, cmd: string): RoadModule<PackageRoad<K>> => ({
  words: `with ${road}`,
  // Both install a tool into an environment under the machine's home and link its command into /root/.local/bin.
  roots: [`${GUEST_HOME}/.local`],
  fromRow: r => ({ road, package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `${cmd} install ${pinned(r.package, versionOf(r), "==")}`,
  uninstall: r => ({ cmd: `${cmd} uninstall ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
  installed: r => listedVersion(road === "uv" ? "uv tool list" : "pipx list --short", r.package),
});

const cargo: RoadModule<Road<"cargo">> = {
  words: "with cargo",
  roots: ["/root/.cargo"],
  fromRow: r => ({ road: "cargo", package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => {
    const version = versionOf(r);
    return version === undefined ? `cargo install ${r.package}` : `cargo install ${r.package} --version ${version}`;
  },
  uninstall: r => ({ cmd: `cargo uninstall ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
  installed: r => listedVersion("cargo install --list", r.package),
};

const GO_BIN = "/root/go/bin";

/** The collector puts a Go binary's `path@version` in its first path; recipes saved
 * before that carried it in the label as `name (path@version)`. */
function goModule(row: ToolRow): { path: string; version: string } | undefined {
  const spec = row.paths[0] ?? /\(([^()\s]+)\)/.exec(row.label)?.[1];
  const at = spec?.lastIndexOf("@") ?? -1;
  if (spec === undefined || at <= 0 || at === spec.length - 1) return undefined;
  return { path: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** The file `go install` writes for a module: its last path element, skipping a major-version suffix. */
export function goBinary(module: string): string {
  const at = module.lastIndexOf("@");
  const parts = (at > 0 ? module.slice(0, at) : module).split("/");
  const last = parts.at(-1)!;
  return /^v[1-9]\d*$/.test(last) && parts.length > 1 ? parts.at(-2)! : last;
}

const go: RoadModule<Road<"go">> = {
  words: "with go install",
  roots: [GO_BIN],
  fromRow: r => {
    const mod = goModule(r);
    return mod === undefined ? { road: "go" } : { road: "go", module: mod.path, version: r.version ?? mod.version };
  },
  install: r => (r.module === undefined ? { note: "no module to install from" } : `go install ${pinned(r.module, versionOf(r), "@")}`),
  uninstall: () => ({ note: `go has no uninstall; the binary stays in ${GO_BIN}` }),
  names: () => [],
  bin: r => (r.module === undefined ? undefined : goBinary(r.module)),
  at: atVersion,
  // The module's version as the binary records it, with its v: what `go install path@version` takes.
  installed: (_r, bin) => `go version -m ${GO_BIN}/${shellQuote(bin)} 2>/dev/null | awk '$1=="mod"{print $3}'`,
};

// --- releases ------------------------------------------------------------------

/** A tool from its repository: the release asset built for this arch, unpacked and its binary put in
 * /usr/local/bin; with no Linux asset, a main package named and go on the machine, `go install` of that package
 * at the tag (or at the version it carries), moved to the row's command when its name differs. The asset's sha256
 * is checked against `pin`, the recorded sum for this tag when the recipe has one, and printed with the tag on the
 * WSP_ROAD line the stage reads either way, so the first install of a tag records it. Without a tag the current
 * release is fetched and its tag read. */
function releaseInstall(name: string, repo: string, tag: string | undefined, pin: string | undefined, go: string | undefined): string {
  const api = tag === undefined ? `https://api.github.com/repos/${repo}/releases/latest` : `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const goAt = go === undefined || go.includes("@") ? go : `${go}@${tag ?? "latest"}`;
  return [
    "set -euo pipefail",
    `name=${shellQuote(name)}`,
    'arch="$(uname -m)"',
    'case "$arch" in x86_64) pat="amd64|x86_64|x64" ;; aarch64) pat="arm64|aarch64" ;; *) echo "Error: unsupported arch: $arch" >&2; exit 1 ;; esac',
    'tmp="$(mktemp -d /tmp/wsp-road-XXXXXX)"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `release="$(curl ${shellQuote(api)} || true)"`,
    tag === undefined ? `tag="$(printf '%s\\n' "$release" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)"` : `tag=${shellQuote(tag)}`,
    `urls="$(printf '%s\\n' "$release" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 || true)"`,
    `url="$(printf '%s\\n' "$urls" | grep -i linux | grep -iE "$pat" | grep -viE '\\.(sha256|sha256sum|sha512|sig|asc|txt|md5|pem|deb|rpm|apk|zst|tar\\.zst|json)$' | head -1 || true)"`,
    'if [ -n "$url" ]; then',
    '  asset="${url##*/}"',
    '  curl -o "$tmp/$asset" "$url"',
    `  sum="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"`,
    ...(pin !== undefined ? [`  ${pinCheckLine("$asset", "$tag", pin)}`] : []),
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
    '  echo "WSP_ROAD release ${asset:-$url} $sum $tag"',
    ...(goAt === undefined
      ? []
      : [
          "elif command -v go >/dev/null 2>&1; then",
          `  GOBIN=/usr/local/bin go install ${shellQuote(goAt)}`,
          ...(goBinary(goAt) === name ? [] : [`  mv ${shellQuote(`/usr/local/bin/${goBinary(goAt)}`)} "/usr/local/bin/$name"`]),
          `  echo "WSP_ROAD go "${shellQuote(goAt)}`,
        ]),
    "else",
    `  echo "Error: ${tag === undefined ? "the current release" : `release "${shellQuote(tag)}"`} of "${shellQuote(repo)}" has no Linux build${goAt === undefined ? "" : ", and go is not on the machine"}" >&2`,
    "  exit 1",
    "fi",
  ].join("\n");
}

const NO_RELEASE = "no GitHub release to install from";

const release: RoadModule<Road<"release">> = {
  words: "from its release",
  roots: ["/usr/local/bin"],
  shown: r => (r.repo === undefined ? NO_RELEASE : `the ${versionOf(r) ?? "latest"} release of github.com/${r.repo}`),
  install: (r, bin) => {
    if (r.repo === undefined) return { note: NO_RELEASE };
    // Without a version the pinned tag stands, as a vendor install does; a first install with neither takes the current release.
    return releaseInstall(bin, r.repo, versionOf(r), standingPin(r)?.sha256, r.go);
  },
  uninstall: (_r, bin) => ({ cmd: `rm -f /usr/local/bin/${shellQuote(bin)}` }),
  names: () => [],
  at: atVersion,
};

const vendor: RoadModule<Road<"vendor">> = {
  words: "from its vendor's release",
  // The cask's own prefix under /opt and the links it puts on PATH; the cask rows carry the paths themselves.
  roots: ["/opt", "/usr/local/bin"],
  shown: r => r.cask.from,
  install: r => r.cask.install(r),
  uninstall: r => ({ cmd: r.cask.uninstall }),
  names: () => [],
  bin: r => r.cask.bin,
  at: atVersion,
};

// --- the distro and plain scripts ----------------------------------------------

const apt: RoadModule<Road<"apt">> = {
  words: "by apt",
  roots: ["/usr", "/etc", "/var"],
  after: APT_INDEX,
  shown: r => `apt-get install ${r.packages.join(" ")}`,
  install: r => `${APT_ENV}\napt-get install -y -qq ${r.packages.join(" ")}`,
  uninstall: r => ({ cmd: `${APT_ENV}\napt-get purge -y -qq ${r.packages.join(" ")} && apt-get autoremove -y -qq --purge` }),
  names: r => r.packages,
  // The row's first package names it; Debian's version string, epoch and revision included, is what dpkg holds.
  installed: r => `dpkg-query -W -f='\${Version}\\n' ${shellQuote(r.packages[0] ?? "")} 2>/dev/null`,
};

const script: RoadModule<Road<"script">> = {
  words: "by its own installer",
  // A vendor's own installer: every script the catalogue carries unpacks under /usr/local or /opt, installs by apt,
  // or writes under the machine's home, which is the /root every workspace on a computer somebody owns shares.
  roots: ["/usr", "/opt", "/root"],
  install: r => r.script,
  uninstall: (_r, bin) => ({ note: `${bin} has no uninstaller; left on the machine` }),
  names: () => [],
  // The command's own version line, cut to its version token: what a script leaves is whatever its vendor prints.
  installed: (_r, bin) => `${shellQuote(bin)} --version 2>/dev/null | head -n 1 | grep -oE '[0-9][^ ,()]*\\.[0-9][^ ,()]*' | head -n 1`,
};

export const ROAD_MODULES: { readonly [K in RoadName]: RoadModule<Road<K>> } = {
  brew,
  npm,
  pnpm: nodeGlobal("pnpm"),
  bun: nodeGlobal("bun"),
  uv: pythonTool("uv", "uv tool"),
  pipx: pythonTool("pipx", "pipx"),
  cargo,
  go,
  release,
  vendor,
  apt,
  script,
};

/** Whether the build can read a package's install road off a tools row a manager filed under its own id, the same
 * question `rowRoad` answers with the reader itself. Every language manager can. apt cannot: it is on every
 * machine and brings no row of its own, so a row it filed can neither install the package nor stand in for the
 * catalog row of a tool the catalog carries, whose own road installs that one. The collector and the recipe verb
 * read this before filing or ticking such a row. */
export const readsRowRoad = (manager: string): boolean => (ROADS as readonly string[]).includes(manager) && ROAD_MODULES[manager as RoadName].fromRow !== undefined;

/** What a road's step gets from the guard that runs it. */
export interface RoadStep {
  /** Seconds the step may run before the guard ends it. */
  limitS: number;
  /** Whether a step that ran the limit out is run once more: a download that did was a dead read, a compile that did will do it again. */
  retry: boolean;
  /** The lines ahead of the install that put the road's own network reads on the clock above. */
  env: readonly string[];
}

/** A script road's step is a whole script whose last line may be a cleanup, so the road runs it under set -e:
 * without it a failed download reads as an install on a machine that already carries the tool. */
const SHELL_STRICT = "set -euo pipefail";

/** A package manager or a download finishes in a couple of minutes or is stuck; Homebrew, go, apt and a script may
 * build or configure for longer; cargo compiles every crate from source. Homebrew's retry count rides BREW_ENV; apt
 * clocks its own reads (two minutes and three tries by default); bun and go expose no knob. */
const DOWNLOAD_S = 300;
const MIXED_S = 600;
const COMPILE_S = 1200;
export const ROAD_STEPS: { readonly [K in RoadName]: RoadStep } = {
  brew: { limitS: MIXED_S, retry: false, env: [] },
  npm: { limitS: DOWNLOAD_S, retry: true, env: [NPM_NET] },
  pnpm: { limitS: DOWNLOAD_S, retry: true, env: [NPM_NET] },
  bun: { limitS: DOWNLOAD_S, retry: true, env: [] },
  uv: { limitS: DOWNLOAD_S, retry: true, env: [UV_NET] },
  pipx: { limitS: DOWNLOAD_S, retry: true, env: [PIP_NET] },
  cargo: { limitS: COMPILE_S, retry: false, env: [CARGO_NET] },
  go: { limitS: MIXED_S, retry: false, env: [] },
  release: { limitS: DOWNLOAD_S, retry: true, env: [CURL_NET] },
  vendor: { limitS: DOWNLOAD_S, retry: true, env: [CURL_NET] },
  apt: { limitS: MIXED_S, retry: false, env: [] },
  script: { limitS: MIXED_S, retry: false, env: [SHELL_STRICT, NPM_NET, PIP_NET, UV_NET, CARGO_NET, CURL_NET] },
};

/** The module that walks a road, typed to it. */
export function roadModule<R extends InstallRoad>(road: R): RoadModule<R> {
  return ROAD_MODULES[road.road] as unknown as RoadModule<R>;
}
