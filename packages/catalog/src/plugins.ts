// SPDX-License-Identifier: AGPL-3.0-only
// How wsp reads an agent's plugins on a computer and turns one on or off. An
// agent entry names its own module here; the reader runs every entry's, so an
// agent the catalog gains needs nothing in the reader.
import type { PluginBrings, PluginMissing, PluginScope } from "@wsp/protocol";

/** Files and folders under each of some roots, asked of a computer in one round trip: each file's text, and each
 * folder's names to `depth` levels down (`name`, then `name/inner`), as paths relative to that folder. The roots are
 * named, or read on the computer off a JSON file there: every plain string value of `key` in it, so a read that needs
 * a file's paths first asks no second round trip. */
export interface PeekGroup {
  roots?: readonly string[];
  rootsFrom?: { file: string; key: string };
  files?: readonly string[];
  dirs?: readonly { path: string; depth: 1 | 2 }[];
}

/** What a peek found, by absolute path: a file's text, a folder's names, nothing for what is not there; and whether a
 * root was looked under at all, which a root read off a file it could not take is not. */
export interface Peeked {
  text(path: string): string | undefined;
  list(dir: string): readonly string[] | undefined;
  looked(root: string): boolean;
}

/** The plain string values of `key` in a JSON text, as a peek reads roots off a file: a value holding an escape is
 * left for the reader to ask for by name. */
export const plainValues = (text: string, key: string): string[] => [...text.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*)"`, "g"))].map(m => m[1]!);

/** What a plugin module may ask of the computer it reads: files and folders in one round trip a batch, and a shell line
 * run as the agent's own commands run there, pointed at its store. Paths are absolute. */
export interface PluginIo {
  readonly home: string;
  /** The folder the agent's store variable names there, where wsp points it somewhere of its own. */
  readonly store?: string;
  /** Nothing where the computer did not answer. */
  peek(groups: readonly PeekGroup[]): Promise<Peeked | undefined>;
  /** The line's stdout where it exits 0; nothing where it fails or could not run. */
  run(line: string): Promise<string | undefined>;
  /** A config file there changed to the text `change` makes of it (nothing where there is no file), written as the
   * login by the one config write, inside `base`. Only a switch has it; it throws the write's refusal. */
  edit?(file: string, base: string, change: (text: string | undefined) => string): Promise<void>;
}

/** A project whose folders a read covers, its path absolute. */
export interface PluginProject {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

/** One plugin as an agent's module finds it, every path absolute. `skills` are the folders of `<name>/SKILL.md` it
 * brings, which the skills reader lists under `prefix`, the name the agent announces each of them under. */
export interface FoundPlugin {
  id: string;
  name: string;
  marketplace: string;
  version?: string;
  scope: PluginScope;
  project?: PluginProject;
  on: boolean;
  missing?: PluginMissing;
  path?: string;
  setIn?: string;
  description?: string;
  source?: string;
  brings: PluginBrings;
  skills?: { dirs: readonly string[]; prefix: string };
}

/** What one agent's module read: its plugins, a line per part it could not read, and the version of the config a
 * switch writes against where the agent checks one. */
export interface PluginsFound {
  plugins: FoundPlugin[];
  refused: string[];
  version?: string;
  /** The config file that version is of. */
  file?: string;
}

/** An agent's plugins: read where the agent reads them, and one plugin turned on or off for the login by the agent's
 * own road, answering why where it did not take. */
export interface PluginShelf {
  read(io: PluginIo, projects: readonly PluginProject[]): Promise<PluginsFound>;
  turn(io: PluginIo, plugin: FoundPlugin, on: boolean, read: PluginsFound): Promise<{ refused?: string }>;
}

export const NOTHING_BROUGHT: PluginBrings = { skills: [], commands: [], subagents: [], hooks: [], servers: [], lsp: [], apps: [] };

/** The id's plugin name and marketplace, split at its last `@`. */
export function pluginIdParts(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf("@");
  return at <= 0 ? { name: id, marketplace: "" } : { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/** A `~/<stateHome>/...` path where the agent reads it: under its store where wsp points it at one, else the home. */
export function inStore(a: { stateHome: string }, path: string, at: { home: string; store?: string | undefined }): string {
  const own = `~/${a.stateHome}`;
  if (at.store !== undefined && (path === own || path.startsWith(`${own}/`))) return `${at.store}${path.slice(own.length)}`;
  if (path === "~") return at.home;
  return path.startsWith("~/") ? `${at.home}/${path.slice(2)}` : path;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON a text holds, or nothing where it does not parse. */
export function jsonOf(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Absolute paths joined and made plain, `.` and `..` resolved, as posix does; the catalog is bundled into the app,
 * which has no node:path. */
export function joinPath(...parts: readonly string[]): string {
  const out: string[] = [];
  for (const seg of parts.join("/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

export const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1) ?? "";
