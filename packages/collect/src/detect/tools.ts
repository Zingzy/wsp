// SPDX-License-Identifier: AGPL-3.0-only
import { linuxSupport } from "../brew-bottles.js";
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { exists, found, entry, item, present } from "./common.js";

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
  args: string[];
  parse: (out: string) => Pkg[];
  sep: string;
}

const GLOBALS: readonly GlobalManager[] = [
  { id: "npm", bin: "npm", group: "npm globals", args: ["ls", "-g", "--depth=0", "--json"], parse: parseNpmGlobals, sep: "@" },
  { id: "pnpm", bin: "pnpm", group: "pnpm globals", args: ["ls", "-g", "--depth=0", "--json"], parse: parsePnpmGlobals, sep: "@" },
  { id: "bun", bin: "bun", group: "bun globals", args: ["pm", "ls", "-g"], parse: parseBunGlobals, sep: "@" },
  { id: "pipx", bin: "pipx", group: "pipx", args: ["list", "--json"], parse: parsePipxList, sep: " " },
  { id: "uv", bin: "uv", group: "uv tools", args: ["tool", "list"], parse: parseUvToolList, sep: " " },
  { id: "cargo", bin: "cargo", group: "cargo installs", args: ["install", "--list"], parse: parseCargoInstalls, sep: " " },
];

// A formula the laptop already runs on Linux needs no snapshot to vouch for it.
function formulaRow(host: Host, name: string): ManifestEntry {
  const linux = host.platform === "linux" ? "yes" : linuxSupport(name);
  const base = { rung: "tools" as const, id: `tools/brew/${name}`, label: name, group: "Homebrew", linux };
  return linux === "no" ? item({ ...base, default: "skip", reason: "no Linux bottle" }) : item(base);
}

async function brewRows(host: Host): Promise<ManifestEntry[]> {
  if (!(await host.exec.which("brew"))) return [];
  const dump = await host.exec.run("brew", ["bundle", "dump", "--file=-"]);
  return parseBrewfile(dump ?? "").map(l => {
    switch (l.kind) {
      case "tap":
        return item({ rung: "tools", id: `tools/brew-tap/${l.name}`, label: l.name, group: "Homebrew taps", linux: "yes" });
      case "brew":
        return formulaRow(host, l.name);
      case "cask":
        return item({ rung: "tools", id: `tools/brew-cask/${l.name}`, label: l.name, group: "Homebrew casks", default: "skip", reason: "macOS app, no Linux build", linux: "no" });
      case "mas":
        return item({ rung: "tools", id: `tools/mas/${l.name}`, label: l.name, group: "Mac App Store", default: "skip", reason: "Mac App Store, macOS only", linux: "no" });
      default: {
        const _exhaustive: never = l.kind;
        return _exhaustive;
      }
    }
  });
}

async function goRows(host: Host): Promise<ManifestEntry[]> {
  if (!(await host.exec.which("go"))) return [];
  const bin = `${host.home}/go/bin`;
  const rows: ManifestEntry[] = [];
  for (const name of await host.fs.list(bin)) {
    const mod = parseGoVersionM((await host.exec.run("go", ["version", "-m", `${bin}/${name}`])) ?? "");
    rows.push(mod === undefined
      ? item({ rung: "tools", id: `tools/go/${name}`, label: `${name} (no module info)`, group: "Go binaries", default: "skip", linux: "yes" })
      : item({ rung: "tools", id: `tools/go/${name}`, label: `${name} (${mod.path}@${mod.version})`, group: "Go binaries", linux: "yes" }));
  }
  return rows;
}

export async function detectTools(host: Host): Promise<ManifestEntry[]> {
  const rows: (ManifestEntry | undefined)[] = [...(await brewRows(host))];

  if ((await exists(host, "~/.config/home-manager")) || (await exists(host, "~/.config/nixpkgs/home.nix"))) {
    rows.push(entry({ rung: "tools", id: "tools/nix-home-manager", label: "Nix home-manager config", linux: "yes", ...(await found(host, ["~/.config/home-manager", "~/.config/nixpkgs/home.nix"])) }));
  }

  // Language package managers run on Linux and fetch each package's own Linux build.
  for (const g of GLOBALS) {
    if (!(await host.exec.which(g.bin))) continue;
    const out = await host.exec.run(g.bin, g.args);
    for (const p of g.parse(out ?? "")) {
      rows.push(item({ rung: "tools", id: `tools/${g.id}/${p.name}`, label: versioned(p, g.sep), group: g.group, linux: "yes" }));
    }
  }
  rows.push(...(await goRows(host)));
  return present(rows);
}
