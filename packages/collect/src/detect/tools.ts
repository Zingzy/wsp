// SPDX-License-Identifier: AGPL-3.0-only
import { linuxSupport } from "../brew-bottles.js";
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { exists, firstLine, found, entry, item, present } from "./common.js";

export interface BrewLine {
  kind: "tap" | "brew" | "cask" | "mas";
  name: string;
}

/** The Brewfile lines that name something installable; vscode lines are the editors rung's job. */
export function parseBrewfile(text: string): BrewLine[] {
  const out: BrewLine[] = [];
  for (const line of text.split("\n")) {
    const m = /^(tap|brew|cask|mas)\s+"([^"]+)"/.exec(line.trim());
    if (m === null) continue;
    const kind = m[1];
    const name = m[2];
    if ((kind === "tap" || kind === "brew" || kind === "cask" || kind === "mas") && name !== undefined) out.push({ kind, name });
  }
  return out;
}

export interface Pkg {
  name: string;
  version?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const NPM_OWN = new Set(["npm", "corepack"]);

export function parseNpmGlobals(text: string): Pkg[] {
  const data = tryJson(text);
  if (!isRecord(data) || !isRecord(data["dependencies"])) return [];
  const out: Pkg[] = [];
  for (const [name, info] of Object.entries(data["dependencies"])) {
    if (NPM_OWN.has(name)) continue;
    const version = isRecord(info) && typeof info["version"] === "string" ? info["version"] : undefined;
    out.push(version === undefined ? { name } : { name, version });
  }
  return out;
}

export function parsePipxList(text: string): Pkg[] {
  const data = tryJson(text);
  if (!isRecord(data) || !isRecord(data["venvs"])) return [];
  const out: Pkg[] = [];
  for (const [name, venv] of Object.entries(data["venvs"])) {
    const meta = isRecord(venv) && isRecord(venv["metadata"]) ? venv["metadata"] : undefined;
    const main = meta !== undefined && isRecord(meta["main_package"]) ? meta["main_package"] : undefined;
    const version = main !== undefined && typeof main["package_version"] === "string" ? main["package_version"] : undefined;
    out.push(version === undefined ? { name } : { name, version });
  }
  return out;
}

/** Top-level lines of `uv tool list` and `cargo install --list`: `name v1.2.3` with optional trailing decoration. */
function parseNameVersionLines(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || /^[\s-]/.test(line)) continue;
    const m = /^(\S+)\s+v(\S+?)(?::|\s|$)/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    out.push({ name: m[1], version: m[2] });
  }
  return out;
}

export const parseUvToolList = parseNameVersionLines;
export const parseCargoInstalls = parseNameVersionLines;

/** `pnpm ls -g --json`: one object per global dir, each with a dependencies map. */
export function parsePnpmGlobals(text: string): Pkg[] {
  const data = tryJson(text);
  if (!Array.isArray(data)) return [];
  const out: Pkg[] = [];
  for (const dir of data) {
    if (!isRecord(dir) || !isRecord(dir["dependencies"])) continue;
    for (const [name, info] of Object.entries(dir["dependencies"])) {
      const version = isRecord(info) && typeof info["version"] === "string" ? info["version"] : undefined;
      out.push(version === undefined ? { name } : { name, version });
    }
  }
  return out;
}

/** `bun pm ls -g`: a header naming the global dir, then tree lines of `name@version`. */
export function parseBunGlobals(text: string): Pkg[] {
  const out: Pkg[] = [];
  for (const line of text.split("\n")) {
    const m = /^[│├└─\s]+(@?[^@\s]+)@(\S+)$/.exec(line);
    if (m?.[1] === undefined || m[2] === undefined) continue;
    out.push({ name: m[1], version: m[2] });
  }
  return out;
}

export interface GoModule {
  path: string;
  version: string;
}

/** `go version -m <binary>`: the `path` line is the install target, the `mod` line carries the version. */
export function parseGoVersionM(text: string): GoModule | undefined {
  let path: string | undefined;
  let version: string | undefined;
  for (const line of text.split("\n")) {
    const cols = line.split("\t");
    if (cols[1] === "path" && cols[2] !== undefined) path = cols[2];
    if (cols[1] === "mod" && cols[3] !== undefined) version = cols[3];
  }
  return path !== undefined && version !== undefined ? { path, version } : undefined;
}

const versioned = (p: Pkg, sep: string) => (p.version === undefined ? p.name : `${p.name}${sep}${p.version}`);

interface GlobalManager {
  id: string;
  bin: string;
  group: string;
  /** The packages, when one listing is not the whole story; args and parse otherwise. */
  list?: (host: Host) => Promise<Pkg[]>;
  args: string[];
  parse: (out: string) => Pkg[];
  sep: string;
}

const NPM_LS = ["ls", "-g", "--depth=0", "--json"];
/** Where another node once kept its globals; a laptop that moved to a new node still runs them from PATH. */
const NPM_PREFIXES = ["/opt/homebrew", "/usr/local"];

/** npm's own prefix, then every other prefix on this laptop that holds globals; a name in both is the own prefix's. */
async function npmGlobals(host: Host): Promise<Pkg[]> {
  const own = firstLine(await host.exec.run("npm", ["prefix", "-g"]));
  const out = new Map<string, Pkg>();
  const add = (pkgs: Pkg[]): void => {
    for (const p of pkgs) if (!out.has(p.name)) out.set(p.name, p);
  };
  add(parseNpmGlobals((await host.exec.run("npm", NPM_LS)) ?? ""));
  for (const prefix of NPM_PREFIXES) {
    if (prefix === own || !(await exists(host, `${prefix}/lib/node_modules`))) continue;
    add(parseNpmGlobals((await host.exec.run("npm", [...NPM_LS, "--prefix", prefix])) ?? ""));
  }
  return [...out.values()];
}

const GLOBALS: readonly GlobalManager[] = [
  { id: "npm", bin: "npm", group: "npm globals", list: npmGlobals, args: NPM_LS, parse: parseNpmGlobals, sep: "@" },
  { id: "pnpm", bin: "pnpm", group: "pnpm globals", args: ["ls", "-g", "--depth=0", "--json"], parse: parsePnpmGlobals, sep: "@" },
  { id: "bun", bin: "bun", group: "bun globals", args: ["pm", "ls", "-g"], parse: parseBunGlobals, sep: "@" },
  { id: "pipx", bin: "pipx", group: "pipx", args: ["list", "--json"], parse: parsePipxList, sep: " " },
  { id: "uv", bin: "uv", group: "uv tools", args: ["tool", "list"], parse: parseUvToolList, sep: " " },
  { id: "cargo", bin: "cargo", group: "cargo installs", args: ["install", "--list"], parse: parseCargoInstalls, sep: " " },
];

// A formula the laptop already runs on Linux needs no snapshot to vouch for it. A formula nothing vouches
// for starts unticked without a reason, so the row stays open to a tick that tries it.
function formulaRow(host: Host, name: string): ManifestEntry {
  const linux = host.platform === "linux" ? "yes" : linuxSupport(name);
  const base = { rung: "tools" as const, id: `tools/brew/${name}`, label: name, group: "Homebrew", linux };
  if (linux === "no") return item({ ...base, default: "skip", reason: "no Linux bottle" });
  return linux === "unknown" ? item({ ...base, default: "skip" }) : item(base);
}

/** The heading of the casks that are commands, not apps; each row is named for the command it puts on PATH. */
export const CLI_GROUP = "Command-line tools";

export interface CaskInfo {
  token: string;
  fullToken: string;
  tap: string;
  version: string;
  url: string;
  /** The commands the binary artifacts put on PATH, in stanza order: the target when the stanza names one, else the file's basename. */
  binaries: string[];
  /** Whether an .app artifact is among them: an app that also ships a CLI is an app. */
  app: boolean;
}

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** `brew info --json=v2 --cask`: each cask under its token and its full token, with the artifacts that decide what it is. */
export function parseCaskInfo(json: unknown): Map<string, CaskInfo> {
  const out = new Map<string, CaskInfo>();
  if (!isRecord(json) || !Array.isArray(json["casks"])) return out;
  for (const c of json["casks"]) {
    if (!isRecord(c) || typeof c["token"] !== "string") continue;
    const artifacts = Array.isArray(c["artifacts"]) ? c["artifacts"].filter(isRecord) : [];
    const binaries = artifacts.flatMap(a => {
      if (!Array.isArray(a["binary"]) || typeof a["binary"][0] !== "string") return [];
      const opts = a["binary"][1];
      return [isRecord(opts) && typeof opts["target"] === "string" ? basename(opts["target"]) : basename(a["binary"][0])];
    });
    const fullToken = typeof c["full_token"] === "string" ? c["full_token"] : c["token"];
    const info: CaskInfo = {
      token: c["token"],
      fullToken,
      tap: typeof c["tap"] === "string" ? c["tap"] : "",
      version: typeof c["version"] === "string" ? c["version"] : "",
      url: typeof c["url"] === "string" ? c["url"] : "",
      binaries,
      app: artifacts.some(a => "app" in a),
    };
    out.set(c["token"], info);
    out.set(fullToken, info);
  }
  return out;
}

const GITHUB_RELEASE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\//;

const appRow = (name: string): ManifestEntry => item({ rung: "tools", id: `tools/brew-cask/${name}`, label: name, group: "Homebrew casks", default: "skip", reason: "macOS app, no Linux build", linux: "no" });

/** A cask that is a command: its row is the command, installed from the GitHub release the cask itself downloads,
 * the tag riding in the first path as a Go row's module does. A release stanza with an on_linux block is a
 * Linux yes; without one the release may still carry a Linux asset, so the row stays open to a tick. */
async function caskRow(host: Host, name: string, info: CaskInfo | undefined): Promise<ManifestEntry> {
  if (info === undefined || info.app || info.binaries.length === 0) return appRow(name);
  const bin = info.binaries.find(b => b === info.token) ?? info.binaries.find(b => info.token.includes(b)) ?? info.binaries[0]!;
  const label = bin === info.token ? bin : `${bin} (${info.token})`;
  const base = { rung: "tools" as const, id: `tools/cli/${bin}`, label, group: CLI_GROUP, ...(info.version === "" ? {} : { version: info.version }) };
  const m = GITHUB_RELEASE.exec(info.url);
  if (m === null) return item({ ...base, default: "skip", reason: "command-line tool, but not from a GitHub release; no Linux install path", linux: "no" });
  const stanza = (await host.exec.run("brew", ["cat", info.fullToken])) ?? "";
  const linux = /^\s*on_linux\b/m.test(stanza) ? "yes" : "unknown";
  return entry({ ...base, paths: [`github.com/${m[1]}@${m[2]}`], bytes: 0, linux, ...(linux === "yes" ? {} : { default: "skip" }) });
}

/** One brew info for every cask; a token brew cannot resolve fails the whole call with no JSON, so then each token is asked alone. */
async function caskInfos(host: Host, casks: string[]): Promise<Map<string, CaskInfo>> {
  if (casks.length === 0) return new Map();
  const ask = async (tokens: string[]): Promise<unknown> => tryJson((await host.exec.run("brew", ["info", "--json=v2", "--cask", ...tokens])) ?? "");
  const batch = await ask(casks);
  if (batch !== undefined) return parseCaskInfo(batch);
  const out = new Map<string, CaskInfo>();
  for (const c of casks) for (const [k, v] of parseCaskInfo(await ask([c]))) out.set(k, v);
  return out;
}

async function brewRows(host: Host): Promise<ManifestEntry[]> {
  if (!(await host.exec.which("brew"))) return [];
  const lines = parseBrewfile((await host.exec.run("brew", ["bundle", "dump", "--file=-"])) ?? "");
  const casks = lines.filter(l => l.kind === "cask").map(l => l.name);
  const info = await caskInfos(host, casks);
  const rows: ManifestEntry[] = [];
  for (const l of lines) {
    switch (l.kind) {
      case "tap":
        rows.push(item({ rung: "tools", id: `tools/brew-tap/${l.name}`, label: l.name, group: "Homebrew taps", linux: "yes" }));
        break;
      case "brew":
        rows.push(formulaRow(host, l.name));
        break;
      case "cask":
        rows.push(await caskRow(host, l.name, info.get(l.name)));
        break;
      case "mas":
        rows.push(item({ rung: "tools", id: `tools/mas/${l.name}`, label: l.name, group: "Mac App Store", default: "skip", reason: "Mac App Store, macOS only", linux: "no" }));
        break;
      default: {
        const _exhaustive: never = l.kind;
        return _exhaustive;
      }
    }
  }
  // The tap a command's cask came from serves nothing on Linux once no formula line names it: the release is the road.
  const used = new Set(lines.filter(l => l.kind === "brew" && l.name.includes("/")).map(l => l.name.slice(0, l.name.lastIndexOf("/"))));
  const folded = new Set(casks.map(c => info.get(c)).filter((c): c is CaskInfo => c !== undefined && !c.app && c.binaries.length > 0 && !used.has(c.tap)).map(c => c.tap));
  return rows.filter(r => !(r.id.startsWith("tools/brew-tap/") && folded.has(r.id.slice("tools/brew-tap/".length))));
}

async function goRows(host: Host): Promise<ManifestEntry[]> {
  if (!(await host.exec.which("go"))) return [];
  const bin = `${host.home}/go/bin`;
  const rows: ManifestEntry[] = [];
  for (const name of await host.fs.list(bin)) {
    const mod = parseGoVersionM((await host.exec.run("go", ["version", "-m", `${bin}/${name}`])) ?? "");
    rows.push(mod === undefined
      ? item({ rung: "tools", id: `tools/go/${name}`, label: `${name} (no module info)`, group: "Go binaries", default: "skip", linux: "yes" })
      // The module path rides in paths so the detail pane shows it first; bytes 0 says there is nothing to upload.
      : entry({ rung: "tools", id: `tools/go/${name}`, label: name, group: "Go binaries", paths: [`${mod.path}@${mod.version}`], bytes: 0, linux: "yes", version: mod.version }));
  }
  return rows;
}

/** A Go binary named for a command's cask is the same tool: its module joins the command's row as the
 * fallback road, after the release, and its own row goes. A locked-off row takes nothing: the Go row stays installable. */
function groupCli(rows: ManifestEntry[]): ManifestEntry[] {
  const cli = new Map(rows.filter(r => r.id.startsWith("tools/cli/") && r.reason === undefined).map(r => [r.id.slice("tools/cli/".length), r]));
  return rows.flatMap(r => {
    if (!r.id.startsWith("tools/go/")) return [r];
    const tool = cli.get(r.id.slice("tools/go/".length));
    if (tool === undefined) return [r];
    const spec = r.paths[0];
    if (spec !== undefined && !tool.paths.includes(spec)) tool.paths.push(spec);
    return [];
  });
}

export async function detectTools(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [...(await brewRows(host))];

  if ((await exists(host, "~/.config/home-manager")) || (await exists(host, "~/.config/nixpkgs/home.nix"))) {
    rows.push(entry({ rung: "tools", id: "tools/nix-home-manager", label: "Nix home-manager config", linux: "yes", ...(await found(host, ["~/.config/home-manager", "~/.config/nixpkgs/home.nix"])) }));
  }

  // Language package managers run on Linux and fetch each package's own Linux build.
  for (const g of GLOBALS) {
    if (!(await host.exec.which(g.bin))) continue;
    const pkgs = g.list !== undefined ? await g.list(host) : g.parse((await host.exec.run(g.bin, g.args)) ?? "");
    for (const p of pkgs) {
      rows.push(item({ rung: "tools", id: `tools/${g.id}/${p.name}`, label: versioned(p, g.sep), group: g.group, linux: "yes", ...(p.version !== undefined ? { version: p.version } : {}) }));
    }
  }
  rows.push(...(await goRows(host)));
  return groupCli(present(rows));
}
