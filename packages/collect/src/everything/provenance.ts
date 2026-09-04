// SPDX-License-Identifier: AGPL-3.0-only
// Pass 1. Every executable on PATH is resolved and classified by where the
// real file lives; the owner's receipt supplies package and version where
// one exists. What no prefix claims is the leftover list.
import { parseGoVersionM, parseNpmGlobals, parseUvToolList } from "../detect/tools.js";
import type { Entry, EnvName, Fs, Machine } from "./host.js";

export const OWNERS = ["homebrew", "nix", "mise", "asdf", "cargo", "pipx", "uv", "npm", "bun", "go", "app", "system"] as const;
export type Owner = (typeof OWNERS)[number];

export interface Tool {
  name: string;
  /** Where PATH found it. */
  path: string;
  resolved: string;
  owner: Owner;
  package?: string;
  version?: string;
  /** Homebrew only: asked for by the person rather than pulled in as a dependency. */
  onRequest?: boolean;
  bytes: number;
  mtime: number;
}

export interface Leftover {
  name: string;
  path: string;
  resolved: string;
  bytes: number;
  mtime: number;
  /** The dot-directory in HOME the binary lives in or is named after. */
  neighbour?: string;
}

export interface Provenance {
  tools: Tool[];
  leftovers: Leftover[];
}

interface Claim {
  owner: Owner;
  package?: string;
  version?: string;
}

interface Prefix {
  root: string;
  claim: (rest: string[]) => Claim | undefined;
}

const SYSTEM_ROOTS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/libexec", "/usr/lib", "/System", "/Library/Apple", "/Library/Developer/CommandLineTools", "/var/run/com.apple.security.cryptexd"];

function pkgOf(rest: string[]): string | undefined {
  const first = rest[0];
  if (first === undefined) return undefined;
  return first.startsWith("@") && rest[1] !== undefined ? `${first}/${rest[1]}` : first;
}

function cellar(rest: string[]): Claim | undefined {
  const [formula, version] = rest;
  if (formula === undefined) return undefined;
  return version === undefined ? { owner: "homebrew", package: formula } : { owner: "homebrew", package: formula, version };
}

/** `/nix/store/<32 chars>-<name>-<version>`: the hash is fixed width, the version is whatever trails the last `-digit`. */
function nixStore(rest: string[]): Claim | undefined {
  const entry = rest[0];
  if (entry === undefined || entry.length < 34) return undefined;
  const full = entry.slice(33);
  const m = /^(.*?)-(\d.*)$/.exec(full);
  return m?.[1] !== undefined && m[2] !== undefined ? { owner: "nix", package: m[1], version: m[2] } : { owner: "nix", package: full };
}

function mise(rest: string[]): Claim | undefined {
  if (rest[0] === "installs" && rest[1] !== undefined) {
    return rest[2] === undefined ? { owner: "mise", package: rest[1] } : { owner: "mise", package: rest[1], version: rest[2] };
  }
  return rest[0] === "shims" && rest[1] !== undefined ? { owner: "mise", package: rest[1] } : undefined;
}

function asdf(rest: string[]): Claim | undefined {
  if (rest[0] === "installs" && rest[1] !== undefined) {
    return rest[2] === undefined ? { owner: "asdf", package: rest[1] } : { owner: "asdf", package: rest[1], version: rest[2] };
  }
  return rest[0] === "shims" && rest[1] !== undefined ? { owner: "asdf", package: rest[1] } : undefined;
}

function caskroom(rest: string[]): Claim | undefined {
  const [cask, version] = rest;
  if (cask === undefined) return undefined;
  return version === undefined ? { owner: "homebrew", package: cask } : { owner: "homebrew", package: cask, version };
}

/** The Homebrew prefix outside Cellar and Caskroom: brew itself, casks that install under share/. A stray file in bin/ is not brew's. */
function brewPrefix(rest: string[]): Claim | undefined {
  if (rest[0] === "bin") return rest[1] === "brew" ? { owner: "homebrew", package: "brew" } : undefined;
  return { owner: "homebrew" };
}

function app(rest: string[]): Claim | undefined {
  const bundle = rest.find(s => s.endsWith(".app"));
  return bundle === undefined ? undefined : { owner: "app", package: bundle.slice(0, -4) };
}

function prefixes(m: Machine, npmRoots: string[]): Prefix[] {
  const h = m.home;
  const env = (k: EnvName, fallback: string): string => m.env[k] ?? fallback;
  const cargoBin = `${env("CARGO_HOME", `${h}/.cargo`)}/bin`;
  const goBin = env("GOBIN", `${env("GOPATH", `${h}/go`)}/bin`);
  const pipxHomes = [m.env["PIPX_HOME"], `${h}/.local/share/pipx`, `${h}/Library/Application Support/pipx`, `${h}/.local/pipx`].filter((p): p is string => p !== undefined);
  const uvTools = env("UV_TOOL_DIR", `${h}/.local/share/uv/tools`);
  const named = (owner: Owner) => (rest: string[]): Claim | undefined => {
    const p = pkgOf(rest);
    return p === undefined ? undefined : { owner, package: p };
  };
  return [
    { root: env("MISE_DATA_DIR", `${h}/.local/share/mise`), claim: mise },
    { root: env("ASDF_DATA_DIR", `${h}/.asdf`), claim: asdf },
    { root: "/opt/homebrew/Cellar", claim: cellar },
    { root: "/usr/local/Cellar", claim: cellar },
    { root: "/home/linuxbrew/.linuxbrew/Cellar", claim: cellar },
    { root: "/opt/homebrew/Caskroom", claim: caskroom },
    { root: "/usr/local/Caskroom", claim: caskroom },
    { root: "/nix/store", claim: nixStore },
    { root: cargoBin, claim: () => ({ owner: "cargo" }) },
    ...pipxHomes.map(p => ({ root: `${p}/venvs`, claim: named("pipx") })),
    { root: uvTools, claim: named("uv") },
    { root: `${h}/.local/share/uv/python`, claim: () => ({ owner: "uv", package: "python" }) },
    ...npmRoots.map(r => ({ root: r, claim: named("npm") })),
    { root: `${h}/.bun/install/global/node_modules`, claim: named("bun") },
    { root: `${h}/.bun/bin`, claim: named("bun") },
    { root: goBin, claim: () => ({ owner: "go" }) },
    { root: "/Applications", claim: app },
    { root: `${h}/Applications`, claim: app },
    ...SYSTEM_ROOTS.map(r => ({ root: r, claim: (): Claim => ({ owner: "system" }) })),
    { root: "/opt/homebrew", claim: brewPrefix },
    { root: "/usr/local/Homebrew", claim: brewPrefix },
    { root: "/home/linuxbrew/.linuxbrew", claim: brewPrefix },
  ];
}

function under(path: string, root: string): string[] | undefined {
  if (path === root) return [];
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1).split("/") : undefined;
}

// The PATH entry is tried before its target: a mise shim resolves into the cellar mise was installed from.
function classify(rules: Prefix[], path: string, resolved: string): Claim | undefined {
  const candidates = path === resolved ? [path] : [path, resolved];
  for (const rule of rules) {
    for (const p of candidates) {
      const rest = under(p, rule.root);
      if (rest === undefined) continue;
      const c = rule.claim(rest);
      if (c !== undefined) return c;
    }
  }
  return undefined;
}

interface Receipts {
  cargo: Map<string, { package: string; version: string }>;
  uv: Map<string, string>;
  npm: Map<string, string>;
}

/** `.crates2.json`: `"name 1.2.3 (registry+...)": { bins: [...] }`, keyed here by bin. */
export function parseCrates2(text: string): Map<string, { package: string; version: string }> {
  const out = new Map<string, { package: string; version: string }>();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (typeof data !== "object" || data === null) return out;
  const installs = (data as Record<string, unknown>)["installs"];
  if (typeof installs !== "object" || installs === null) return out;
  for (const [key, info] of Object.entries(installs as Record<string, unknown>)) {
    const [pkg, version] = key.split(" ");
    const bins = typeof info === "object" && info !== null ? (info as Record<string, unknown>)["bins"] : undefined;
    if (pkg === undefined || version === undefined || !Array.isArray(bins)) continue;
    for (const b of bins) if (typeof b === "string") out.set(b, { package: pkg, version });
  }
  return out;
}

async function receipts(m: Machine, tools: Tool[]): Promise<Receipts> {
  const r: Receipts = { cargo: new Map(), uv: new Map(), npm: new Map() };
  const owners = new Set(tools.map(t => t.owner));
  if (owners.has("cargo")) {
    r.cargo = parseCrates2((await m.fs.readText(`${m.env["CARGO_HOME"] ?? `${m.home}/.cargo`}/.crates2.json`)) ?? "");
  }
  if (owners.has("uv") && (await m.exec.which("uv"))) {
    for (const p of parseUvToolList((await m.exec.run("uv", ["tool", "list"])) ?? "")) if (p.version !== undefined) r.uv.set(p.name, p.version);
  }
  if (owners.has("npm") && (await m.exec.which("npm"))) {
    for (const p of parseNpmGlobals((await m.exec.run("npm", ["ls", "-g", "--depth=0", "--json"])) ?? "")) if (p.version !== undefined) r.npm.set(p.name, p.version);
  }
  return r;
}

async function brewReceipt(fs: Fs, resolved: string): Promise<boolean | undefined> {
  const m = /^(.*\/Cellar\/[^/]+\/[^/]+)\//.exec(resolved);
  if (m?.[1] === undefined) return undefined;
  const text = await fs.readText(`${m[1]}/INSTALL_RECEIPT.json`);
  if (text === undefined) return undefined;
  try {
    const v = (JSON.parse(text) as Record<string, unknown>)["installed_on_request"];
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

async function pipxVersion(fs: Fs, resolved: string): Promise<string | undefined> {
  const m = /^(.*\/venvs\/[^/]+)\//.exec(resolved);
  if (m?.[1] === undefined) return undefined;
  const text = await fs.readText(`${m[1]}/pipx_metadata.json`);
  if (text === undefined) return undefined;
  try {
    const main = (JSON.parse(text) as Record<string, unknown>)["main_package"];
    const v = typeof main === "object" && main !== null ? (main as Record<string, unknown>)["package_version"] : undefined;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

async function goModule(m: Machine, resolved: string): Promise<{ package: string; version: string } | undefined> {
  const mod = parseGoVersionM((await m.exec.run("go", ["version", "-m", resolved])) ?? "");
  return mod === undefined ? undefined : { package: mod.path, version: mod.version };
}

async function npmRoots(m: Machine): Promise<string[]> {
  const roots = [`${m.home}/.local/lib/node_modules`, `${m.home}/.npm-global/lib/node_modules`, "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"];
  if (await m.exec.which("npm")) {
    const out = (await m.exec.run("npm", ["root", "-g"]))?.trim();
    if (out !== undefined && out !== "" && !roots.includes(out)) roots.unshift(out);
  }
  return roots;
}

function isExecutable(e: Entry): boolean {
  return e.kind === "file" && (e.mode & 0o111) !== 0;
}

async function neighbour(m: Machine, name: string, resolved: string): Promise<string | undefined> {
  const inHome = under(resolved, m.home) ?? [];
  const top = inHome[0];
  if (top !== undefined && top.startsWith(".") && top !== ".local" && top !== ".config" && inHome.length > 1) return `${m.home}/${top}`;
  for (const c of [`${m.home}/.${name}`, `${m.home}/.config/${name}`]) {
    if ((await m.fs.stat(c))?.kind === "dir") return c;
  }
  return undefined;
}

export async function provenance(m: Machine): Promise<Provenance> {
  const rules = prefixes(m, await npmRoots(m));
  const seen = new Set<string>();
  const tools: Tool[] = [];
  const pending: Leftover[] = [];
  for (const dir of [...new Set(m.path)]) {
    for (const name of await m.fs.list(dir)) {
      if (seen.has(name)) continue;
      const path = `${dir}/${name}`;
      const own = await m.fs.stat(path);
      if (own === undefined || own.kind === "dir") continue;
      const resolved = own.kind === "link" ? await m.fs.realpath(path) : path;
      if (resolved === undefined) continue;
      const target = resolved === path ? own : await m.fs.stat(resolved);
      if (target === undefined || !isExecutable(target)) continue;
      seen.add(name);
      const claim = classify(rules, path, resolved);
      if (claim === undefined) {
        pending.push({ name, path, resolved, bytes: target.bytes, mtime: target.mtime });
        continue;
      }
      tools.push({ name, path, resolved, bytes: target.bytes, mtime: target.mtime, ...claim });
    }
  }

  const r = await receipts(m, tools);
  for (const t of tools) {
    if (t.owner === "homebrew") {
      const onRequest = await brewReceipt(m.fs, t.resolved);
      if (onRequest !== undefined) t.onRequest = onRequest;
    }
    if (t.owner === "cargo") Object.assign(t, r.cargo.get(t.name));
    if (t.owner === "uv" && t.package !== undefined && r.uv.has(t.package)) t.version = r.uv.get(t.package);
    if (t.owner === "npm" && t.package !== undefined && r.npm.has(t.package)) t.version = r.npm.get(t.package);
    if (t.owner === "pipx") {
      const v = await pipxVersion(m.fs, t.resolved);
      if (v !== undefined) t.version = v;
    }
    if (t.owner === "go") Object.assign(t, await goModule(m, t.resolved));
  }

  // A Go binary anywhere self-identifies; that is the last receipt before a binary is called unknown.
  const goPresent = await m.exec.which("go");
  const leftovers: Leftover[] = [];
  for (const l of pending) {
    const mod = goPresent ? await goModule(m, l.resolved) : undefined;
    if (mod !== undefined) {
      tools.push({ name: l.name, path: l.path, resolved: l.resolved, bytes: l.bytes, mtime: l.mtime, owner: "go", ...mod });
      continue;
    }
    const n = await neighbour(m, l.name, l.resolved);
    leftovers.push(n === undefined ? l : { ...l, neighbour: n });
  }
  return { tools, leftovers };
}

/** Binary names on PATH, whatever their owner; the passes after this one pair by name against it. */
export function binaryNames(p: Provenance): Set<string> {
  return new Set([...p.tools.map(t => t.name), ...p.leftovers.map(l => l.name)]);
}

