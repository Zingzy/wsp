// SPDX-License-Identifier: AGPL-3.0-only
// The install roads as modules, one per road kind: the bash line that puts a
// road's argument on a Linux machine (pinned where the road names a version),
// the line that takes it off again, the names a recipe row may carry for it,
// what it runs on top of, and how the install reads to a person. The stages
// and the wizard ask a module through roadModule(); nothing outside this file
// decides by a road's name. Every line is text: nothing here runs a command.
import { shellQuote } from "@wsp/protocol";
import { APT_ENV, type InstallRoad, type PackageRoad, type RoadName, pinStateOf } from "./roads.js";

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
export const BREW_PREFIX = "/home/linuxbrew/.linuxbrew";
// Install-time cleanup stays on: with it off, one recipe left 2.6 GB of bottles in the download cache on a 20 GB disk.
export const BREW_ENV = `HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_ENV_HINTS=1 NONINTERACTIVE=1 HOMEBREW_CURL_RETRIES=${NET_RETRIES}`;
export const BREW = `${BREW_PREFIX}/bin/brew`;

// Homebrew refuses to run as root, so it lives under its own user at the
// prefix its Linux bottles are built for; anything else compiles from source.
export function asLinuxbrewScript(script: string): string {
  return `su -s /bin/bash linuxbrew -c ${shellQuote(`export ${BREW_ENV}\n${script}`)}`;
}

export function asLinuxbrew(cmd: string): string {
  return `su -s /bin/bash linuxbrew -c ${shellQuote(`${BREW_ENV} ${BREW} ${cmd}`)}`;
}

/** A `brew` for a script that runs as root and types its own formula line: the two above take the whole command as
 * one quoted word, this one takes the arguments as they were typed and hands them on with their quoting intact. */
export const LINUXBREW_SHIM = `brew() { su -s /bin/bash linuxbrew -c ${shellQuote(`export ${BREW_ENV}; exec "$0" "$@"`)} -- ${BREW} "$@"; }`;

const brew: RoadModule<Road<"brew">> = {
  words: "with Homebrew",
  after: HOMEBREW_STEP,
  fromRow: r => ({ road: "brew", formula: r.name }),
  shown: r => `brew install ${r.formula}`,
  install: r => asLinuxbrew(`install ${r.formula}`),
  uninstall: r => {
    if (!r.formula.includes("/")) return { cmd: asLinuxbrew(`uninstall ${r.formula}`) };
    // A tap formula with no Linux bottle took the road to /usr/local/bin under the formula's name, not to the cellar.
    const bin = r.formula.slice(r.formula.lastIndexOf("/") + 1);
    return { cmd: `if [ -x ${BREW} ] && ${asLinuxbrew(`list --formula ${r.formula}`)} >/dev/null 2>&1; then ${asLinuxbrew(`uninstall ${r.formula}`)}; else rm -f /usr/local/bin/${shellQuote(bin)}; fi` };
  },
  names: r => [r.formula],
};

// --- package managers ----------------------------------------------------------

const npm: RoadModule<Road<"npm">> = {
  words: "as an npm global",
  after: "node",
  fromRow: r => ({ road: "npm", package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `npm install -g ${r.ignoreScripts === true ? "--ignore-scripts " : ""}${pinned(r.package, r.version, "@")}`,
  uninstall: r => ({ cmd: `npm uninstall -g ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
};

/** pnpm and bun keep npm's global shape under their own verbs. */
const nodeGlobal = <K extends "pnpm" | "bun">(road: K): RoadModule<PackageRoad<K>> => ({
  words: `with ${road}`,
  fromRow: r => ({ road, package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `${road} add -g ${pinned(r.package, r.version, "@")}`,
  uninstall: r => ({ cmd: `${road} remove -g ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
});

/** uv and pipx install a Python tool into its own environment, pinned the pip way. */
const pythonTool = <K extends "uv" | "pipx">(road: K, cmd: string): RoadModule<PackageRoad<K>> => ({
  words: `with ${road}`,
  fromRow: r => ({ road, package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => `${cmd} install ${pinned(r.package, r.version, "==")}`,
  uninstall: r => ({ cmd: `${cmd} uninstall ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
});

const cargo: RoadModule<Road<"cargo">> = {
  words: "with cargo",
  fromRow: r => ({ road: "cargo", package: r.name, ...(r.version !== undefined ? { version: r.version } : {}) }),
  install: r => (r.version === undefined ? `cargo install ${r.package}` : `cargo install ${r.package} --version ${r.version}`),
  uninstall: r => ({ cmd: `cargo uninstall ${r.package}` }),
  names: r => [r.package],
  at: atVersion,
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
  fromRow: r => {
    const mod = goModule(r);
    return mod === undefined ? { road: "go" } : { road: "go", module: mod.path, version: r.version ?? mod.version };
  },
  install: r => (r.module === undefined ? { note: "no module to install from" } : `go install ${pinned(r.module, r.version, "@")}`),
  uninstall: () => ({ note: `go has no uninstall; the binary stays in ${GO_BIN}` }),
  names: () => [],
  bin: r => (r.module === undefined ? undefined : goBinary(r.module)),
  at: atVersion,
};

// --- releases ------------------------------------------------------------------

/** A tool from its repository: the release asset built for this arch, unpacked and its binary put in
 * /usr/local/bin; with no Linux asset, a main package named and go on the machine, `go install` of that package
 * at the tag (or at the version it carries), moved to the row's command when its name differs. The asset's sha256
 * is checked against the pin when the recipe has one for this tag, and printed with the tag on the WSP_ROAD line
 * the stage reads either way, so the first install of a tag records it. Without a tag the current release is
 * fetched and its tag read. */
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
    ...(tag === undefined ? [`tag="$(printf '%s\\n' "$release" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4 || true)"`] : []),
    `urls="$(printf '%s\\n' "$release" | grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 || true)"`,
    `url="$(printf '%s\\n' "$urls" | grep -i linux | grep -iE "$pat" | grep -viE '\\.(sha256|sha256sum|sha512|sig|asc|txt|md5|pem|deb|rpm|apk)$' | head -1 || true)"`,
    'if [ -n "$url" ]; then',
    '  asset="${url##*/}"',
    '  curl -o "$tmp/$asset" "$url"',
    `  sum="$(sha256sum "$tmp/$asset" | cut -d' ' -f1)"`,
    ...(pin !== undefined && tag !== undefined ? [`  [ "$sum" = ${shellQuote(pin)} ] || { echo "Error: $asset does not match the checksum recorded on the first install of "${shellQuote(tag)} >&2; exit 1; }`] : []),
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
    tag === undefined ? '  echo "WSP_ROAD release ${asset:-$url} $sum $tag"' : `  echo "WSP_ROAD release \${asset:-$url} $sum "${shellQuote(tag)}`,
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

/** The tag a release install fetches: the row's version, else the pinned tag, else the current release. */
const releaseTag = (r: Road<"release">): string | undefined => r.version ?? r.pin?.tag;
const NO_RELEASE = "no GitHub release to install from";

const release: RoadModule<Road<"release">> = {
  words: "from its release",
  shown: r => (r.repo === undefined ? NO_RELEASE : `the ${releaseTag(r) ?? "latest"} release of github.com/${r.repo}`),
  install: (r, bin) => {
    if (r.repo === undefined) return { note: NO_RELEASE };
    // Without a version the pinned tag stands, as a vendor install does; a first install with neither takes the current release.
    const tag = releaseTag(r);
    return releaseInstall(bin, r.repo, tag, pinStateOf(tag, r.pin) === "same" ? r.pin!.sha256 : undefined, r.go);
  },
  uninstall: (_r, bin) => ({ cmd: `rm -f /usr/local/bin/${shellQuote(bin)}` }),
  names: () => [],
  at: atVersion,
};

const vendor: RoadModule<Road<"vendor">> = {
  words: "from its vendor's release",
  shown: r => r.cask.from,
  install: r => r.cask.install(r.version, r.pin),
  uninstall: r => ({ cmd: r.cask.uninstall }),
  names: () => [],
  bin: r => r.cask.bin,
  at: atVersion,
};

// --- the distro and plain scripts ----------------------------------------------

const apt: RoadModule<Road<"apt">> = {
  words: "by apt",
  after: APT_INDEX,
  shown: r => `apt-get install ${r.packages.join(" ")}`,
  install: r => `${APT_ENV}\napt-get install -y -qq ${r.packages.join(" ")}`,
  uninstall: r => ({ cmd: `${APT_ENV}\napt-get purge -y -qq ${r.packages.join(" ")} && apt-get autoremove -y -qq --purge` }),
  names: r => r.packages,
};

const script: RoadModule<Road<"script">> = {
  words: "by its own installer",
  install: r => r.script,
  uninstall: (_r, bin) => ({ note: `${bin} has no uninstaller; left on the machine` }),
  names: () => [],
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

/** What a road's step gets from the guard that runs it. */
export interface RoadStep {
  /** Seconds the step may run before the guard ends it. */
  limitS: number;
  /** Whether a step that ran the limit out is run once more: a download that did was a dead read, a compile that did will do it again. */
  retry: boolean;
  /** The lines ahead of the install that put the road's own network reads on the clock above. */
  env: readonly string[];
}

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
  script: { limitS: MIXED_S, retry: false, env: [NPM_NET, PIP_NET, UV_NET, CARGO_NET, CURL_NET] },
};

/** The module that walks a road, typed to it. */
export function roadModule<R extends InstallRoad>(road: R): RoadModule<R> {
  return ROAD_MODULES[road.road] as unknown as RoadModule<R>;
}
