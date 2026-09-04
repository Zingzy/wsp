// SPDX-License-Identifier: AGPL-3.0-only
// The half of golden import that touches this computer: the archive of the
// ticked files with their modes, the Keychain reads behind an injected
// reader, and the import object the runtime hands to the builder.
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type ManifestEntry, RC_PATHS, stripExports } from "@wsp/collect";
import {
  agentInstallsFor,
  planFiles,
  recipeHash,
  refusedPath,
  toolInstallsFor,
  type AgentInstaller,
  type FilesPlan,
  type GoldenImport,
  type ImportResult,
  type CutNames,
  type PackedFiles,
  type PathInfo,
  type PlannedFile,
  type PlannedSecret,
  type SkippedPath,
} from "@wsp/engine";
import { CONFIG_DIR, GOLDEN_SETUP, GOLDEN_SMOKE, tarPackCommand } from "./doctor.js";

const execFileAsync = promisify(execFile);

/** An rc file by name at HOME or one directory deep (a dotfiles directory keeps dotted copies), plus fish's own config;
 * a same-named file deeper down belongs to some program and is left as found. Inside a dotfiles manager's home
 * the copies are plain files whose names lost their dot or gained chezmoi's `dot_`, so the name is mapped back first. */
const RC_NAMES = new Set(RC_PATHS.map(p => p.slice(p.lastIndexOf("/") + 1)));
const MANAGER_HOMES = [".dotfiles", "dotfiles", ".local/share/chezmoi", ".local/share/yadm", ".config/yadm"];
const rcByName = (rel: string): boolean => {
  const segs = rel.split("/");
  const name = segs.at(-1) ?? "";
  if (RC_PATHS.includes(rel as (typeof RC_PATHS)[number]) || (segs.length <= 2 && RC_NAMES.has(name))) return true;
  if (!MANAGER_HOMES.some(h => rel.startsWith(`${h}/`))) return false;
  const mapped = name.startsWith("dot_") ? `.${name.slice(4)}` : name.startsWith(".") ? name : `.${name}`;
  return RC_NAMES.has(name) || RC_NAMES.has(mapped);
};

export interface SecretReader {
  /** The secret stored under a Keychain service; rejects when the item is missing or the person refuses the consent dialog. */
  read(service: string): Promise<string>;
}

/** macOS's own consent dialog stands between this call and the secret; nothing is cached or logged. */
export function keychainReader(): SecretReader & { command(service: string): { file: string; args: string[] } } {
  const command = (service: string) => ({ file: "security", args: ["find-generic-password", "-s", service, "-w"] });
  return {
    command,
    async read(service) {
      const { file, args } = command(service);
      const { stdout } = await execFileAsync(file, args);
      return stdout.replace(/\n$/, "");
    },
  };
}

/** Claude Code's installer is the one curl into a shell the rules allow. */
export const CLAUDE_INSTALLER: AgentInstaller = { name: "Claude Code", install: GOLDEN_SETUP, smoke: GOLDEN_SMOKE };

/** The last line `security` printed; its stderr names the cause and never the secret. */
function secretFailure(e: unknown): string {
  const lines = (e instanceof Error ? e.message : String(e)).split("\n").map(l => l.trim()).filter(l => l !== "");
  return lines.at(-1) ?? "unknown error";
}

export interface ReadSecrets {
  /** Secret by Keychain service, for the pack. */
  values: Map<string, string>;
  /** Logins whose read failed or was refused, with the reason security gave. */
  refused: { id: string; service: string; reason: string }[];
}

/** The Keychain logins the ticked rows would copy, in plan order. Runs before
 * anything boots so a refused consent dialog never costs a machine. */
export function keychainLogins(picked: readonly ManifestEntry[], platform: "darwin" | "linux"): PlannedSecret[] {
  return planFiles(picked.map(e => ({ ...e, bring: true })), { home: "/", stat: () => undefined, platform }).secrets;
}

export async function readSecrets(wanted: readonly PlannedSecret[], reader: SecretReader): Promise<ReadSecrets> {
  const out: ReadSecrets = { values: new Map(), refused: [] };
  for (const s of wanted) {
    try {
      out.values.set(s.service, await reader.read(s.service));
    } catch (e) {
      out.refused.push({ id: s.id, service: s.service, reason: secretFailure(e) });
    }
  }
  return out;
}

/** Bytes a tree takes once extracted, links counted as their targets since the archive ships those. */
function treeBytes(path: string): number {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, name) => n + treeBytes(join(path, name)), 0);
}

const resolved = (abs: string): string | undefined => {
  try {
    return realpathSync(abs);
  } catch {
    return undefined;
  }
};

/** The laptop directory each guest parent directory stands for, paired from the end since a
 * rewrite may change the depth (~/Library/Application Support/x lands at .config/x, ~/.claude at
 * .claude-cfg). A guest directory several laptop directories map onto takes the one with the same
 * relative path, else the mode when they all agree, else the umask; tick order never decides. */
function parentModes(files: readonly PlannedFile[], home: string): Map<string, number> {
  const sources = new Map<string, Set<string>>();
  for (const f of files) {
    const laptop = relative(home, f.source).split("/").slice(0, -1);
    const guest = f.dest.split("/").slice(0, -1);
    for (let back = 1; back <= Math.min(laptop.length, guest.length); back++) {
      const g = guest.slice(0, guest.length - back + 1).join("/");
      (sources.get(g) ?? sources.set(g, new Set()).get(g)!).add(laptop.slice(0, laptop.length - back + 1).join("/"));
    }
  }
  const modes = new Map<string, number>();
  for (const [g, from] of sources) {
    const pick = from.has(g) ? [g] : [...from];
    const found = pick.map(rel => statOf(join(home, rel))).filter((i): i is PathInfo & { kind: "dir" } => i !== undefined && i.kind === "dir");
    if (found.length > 0 && found.every(i => i.mode === found[0]!.mode)) modes.set(g, found[0]!.mode);
  }
  return modes;
}

export interface PackOptions {
  /** Secrets already read from the Keychain, by service; a planned secret with no value is left out with a note. */
  secrets: ReadonlyMap<string, string>;
  /** This computer's home, links resolved; a link inside a copied directory must resolve under it. */
  home: string;
}

/** Copies the planned files into a staging tree, renders each secret into it,
 * and tars the tree. Links are followed so the target's bytes land at the
 * link's path; one that leaves home, points at a refused path, or points back
 * into its own directory is left out with a note. */
export async function packPlan(plan: FilesPlan, opts: PackOptions): Promise<PackedFiles> {
  const stage = mkdtempSync(join(tmpdir(), "wsp-golden-import-"));
  const out = mkdtempSync(join(tmpdir(), "wsp-golden-import-tar-"));
  const tgz = join(out, "files.tgz");
  const skipped: SkippedPath[] = [];
  try {
    // A login whose Keychain item was not read was changed to a sign-in on the machine: none of its files travel.
    const refused = new Set(plan.secrets.filter(s => !opts.secrets.has(s.service)).map(s => s.id));
    const files = plan.files.filter(f => {
      if (!refused.has(f.id)) return true;
      skipped.push({ id: f.id, path: `~/${relative(opts.home, f.source)}`, note: "not read from the Keychain; sign in on the machine" });
      return false;
    });
    const modes = parentModes(files, opts.home);
    // The laptop's rc files by identity, so the target of a linked rc carried under another row is stripped too.
    const rcReal = new Set(RC_PATHS.map(rc => resolved(join(opts.home, rc))).filter((p): p is string => p !== undefined));
    const twins = new Set<string>();
    for (const f of files) {
      const target = join(stage, f.dest);
      mkdirSync(dirname(target), { recursive: true });
      // Directories this copy has walked, by realpath: a link back to any of them would loop the walk.
      const entered = new Set<string>();
      const keep = (src: string, dest: string): boolean => {
        if (f.excludes.some(x => src === x || src.startsWith(`${x}/`))) return false;
        if (rcReal.has(resolved(src) ?? "")) twins.add(dest);
        if (!lstatSync(src).isSymbolicLink()) {
          if (statSync(src).isDirectory()) entered.add(resolved(src) ?? src);
          return true;
        }
        const shown = `~/${relative(opts.home, src)}`;
        const real = resolved(src);
        if (real === undefined) skipped.push({ id: f.id, path: shown, note: "a link whose target is gone" });
        else if (!(real === opts.home || real.startsWith(`${opts.home}/`))) skipped.push({ id: f.id, path: shown, note: `a link to ${real}, outside your home directory` });
        else if (resolved(dirname(src)) === real || (resolved(dirname(src)) ?? "").startsWith(`${real}/`)) skipped.push({ id: f.id, path: shown, note: "a link into its own directory" });
        else if (entered.has(real)) skipped.push({ id: f.id, path: shown, note: "a link into a directory already copied" });
        else {
          const dir = statSync(real).isDirectory();
          const why = refusedPath(relative(opts.home, real), dir);
          if (why === undefined) {
            if (dir) entered.add(real);
            return true;
          }
          skipped.push({ id: f.id, path: shown, note: `a link to ~/${relative(opts.home, real)}: ${why}` });
        }
        return false;
      };
      cpSync(f.source, target, { recursive: true, dereference: true, filter: keep });
      chmodSync(target, f.mode);
    }
    // Every rc file staged, by name where dotfiles live or by identity with one of the laptop's, ships as its
    // carried copy: secret exports are set on the machine by hand, never carried in the file. The copy keeps
    // the laptop's mode, so a read-only file is opened writable for the one write and closed again.
    const cut: CutNames[] = [];
    const strip = (staged: string): void => {
      const { names, carried } = stripExports(readFileSync(staged, "utf8"));
      if (names.length === 0) return;
      const mode = statSync(staged).mode & 0o7777;
      chmodSync(staged, 0o600);
      writeFileSync(staged, carried);
      chmodSync(staged, mode);
      cut.push({ path: `~/${relative(stage, staged)}`, names });
    };
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile() && (rcByName(relative(stage, p)) || twins.has(p))) strip(p);
      }
    };
    walk(stage);
    cut.sort((a, b) => (a.path < b.path ? -1 : 1));
    for (const s of plan.secrets) {
      const secret = opts.secrets.get(s.service);
      if (secret === undefined) {
        skipped.push({ id: s.id, path: `Keychain: ${s.service}`, note: "not read from the Keychain; sign in on the machine" });
        continue;
      }
      const target = join(stage, s.dest);
      mkdirSync(dirname(target), { recursive: true });
      const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      writeFileSync(target, s.place(secret, existing), { mode: 0o600 });
      chmodSync(target, 0o600);
    }
    for (const [g, mode] of modes) if (existsSync(join(stage, g))) chmodSync(join(stage, g), mode);
    if (existsSync(join(stage, ".ssh"))) chmodSync(join(stage, ".ssh"), 0o700);
    const unpacked = treeBytes(stage);
    // tar truncates an existing archive in place, so the mode set here is the one it keeps.
    writeFileSync(tgz, "", { mode: 0o600 });
    const { file, args, env } = tarPackCommand(stage, tgz);
    await execFileAsync(file, args, { env });
    const tar = readFileSync(tgz);
    return { tar, bytes: tar.length, unpacked, skipped, cut };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

export interface ImportOptions {
  home: string;
  /** Keychain secrets already read, by service (see readSecrets). */
  secrets: ReadonlyMap<string, string>;
  platform: "darwin" | "linux";
  onResult?: (result: ImportResult) => void;
}

/** What is at a laptop path: a link is followed and reports where it lands. */
export function statOf(abs: string): PathInfo | undefined {
  let link: boolean;
  try {
    link = lstatSync(abs).isSymbolicLink();
  } catch {
    return undefined;
  }
  const realpath = link ? resolved(abs) : abs;
  if (realpath === undefined) return { kind: "dangling", target: resolve(dirname(abs), readlinkSync(abs)) };
  const st = statSync(realpath);
  return { kind: st.isDirectory() ? "dir" : "file", mode: st.mode & 0o7777, size: st.size, mtimeMs: st.mtimeMs, realpath };
}

/** The guest's Claude config dir, relative to its home; the laptop's ~/.claude lands there. */
const CLAUDE_REL = CONFIG_DIR.replace(/^\/root\//, "");

/** What the ticked rows add up to for the builder. Results reported back carry
 * the rows the plan itself set aside (a formula with no Linux bottle) so the
 * saved list is complete. */
export function importFor(picked: readonly ManifestEntry[], opts: ImportOptions): GoldenImport {
  // Rows arrive as the person's selection; a fresh collection carries no bring flag yet.
  const bring = picked.map(e => ({ ...e, bring: true }));
  const home = resolved(opts.home) ?? opts.home;
  const plan = planFiles(bring, {
    home,
    stat: statOf,
    platform: opts.platform,
    rewrites: [[".claude/", `${CLAUDE_REL}/`], [".claude.json", `${CLAUDE_REL}/.claude.json`]],
  });
  const tools = toolInstallsFor(bring);
  const agents = agentInstallsFor(bring, { claude: CLAUDE_INSTALLER });
  const label = (id: string) => bring.find(e => e.id === id)?.label ?? id;
  const anyFiles = bring.some(e => e.bring && e.rung !== "tools" && e.paths.length > 0 && (e.rung !== "logins" || e.choice === "copy"));
  const count = plan.files.length + plan.secrets.length;
  return {
    recipeHash: recipeHash(bring, plan.files),
    ...(anyFiles
      ? { files: { count, rungs: plan.rungs, bytes: plan.bytes, skipped: plan.skipped, pack: () => packPlan(plan, { secrets: opts.secrets, home }) } }
      : {}),
    tools: tools.installs,
    ...(agents.node !== undefined ? { node: agents.node } : {}),
    agents: agents.installs,
    skippedAgents: agents.skipped.map(s => ({ id: s.id, name: label(s.id), note: s.note })),
    ...(opts.onResult !== undefined
      ? {
          onResult: (r: ImportResult) =>
            opts.onResult!({ ...r, tools: [...tools.skipped.map(s => ({ id: s.id, label: label(s.id), outcome: "skipped" as const, note: s.note })), ...r.tools] }),
        }
      : {}),
  };
}

export function importResultPath(statePath: string): string {
  return join(dirname(statePath), "golden-import.json");
}
