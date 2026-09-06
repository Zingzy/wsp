// SPDX-License-Identifier: AGPL-3.0-only
// The half of golden import that touches this computer: the archive of the
// ticked files with their modes, the Keychain reads behind an injected
// reader, and the import object the runtime hands to the builder.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { AGENTS, FISH_CONF_D, MCP_BIN_DIRS, type ManifestEntry, RC_NAMES, guardSources, isRcPath, rcFiles, sourcedPaths, stripExports } from "@wsp/collect";
import {
  agentInstallsFor,
  mcpPlanFor,
  planFiles,
  recipeDigest,
  recipeHash,
  refusedPath,
  shellInstallFor,
  toolInstallsFor,
  type BrewTable,
  type FilesPlan,
  type GoldenImport,
  type ImportResult,
  type CutNames,
  type PackedFiles,
  type PathInfo,
  type PlannedFile,
  type PlannedSecret,
  type SkippedPath,
  secretKey,
  secretPath,
  withApiKeyHelper,
} from "@wsp/engine";
import { CATALOG_AGENTS, CLAUDE_CONFIG_DIR, CLAUDE_SETTINGS_FILE, MCP_AGENTS } from "@wsp/catalog";
import type { GoldenLeftBehind, RecipeCustomRow } from "@wsp/protocol";
import { tarPackCommand } from "./doctor.js";

const execFileAsync = promisify(execFile);
const GUEST_HOME = "/root";
/** The largest file read whole here: an rc file or a login's own settings, never anything bigger. */
const READ_LIMIT = 1024 * 1024;

/** An rc file by name at HOME or one directory deep (a dotfiles directory keeps dotted copies), plus fish's own config
 * and conf.d; a same-named file deeper down belongs to some program and is left as found. */
function isRcFile(rel: string): boolean {
  const segs = rel.split("/");
  return isRcPath(rel) || (segs.length <= 2 && RC_NAMES.has(segs.at(-1) ?? ""));
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** A regular file's text, within the collector's read limit. */
function readSmall(abs: string): string | undefined {
  return isFile(abs) && statSync(abs).size <= READ_LIMIT ? readFileSync(abs, "utf8") : undefined;
}

/** The laptop's rc files by identity, plus one level of what they source by a literal path, so a copy of any of them
 * carried under another row is stripped too. */
function rcIdentities(home: string): Set<string> {
  const out = new Set(rcFiles(listDir(join(home, FISH_CONF_D))).map(rc => resolved(join(home, rc))).filter((p): p is string => p !== undefined));
  for (const rc of [...out]) {
    const text = readSmall(rc);
    if (text === undefined) continue;
    for (const s of sourcedPaths(text, home)) {
      const real = resolved(s);
      if (real !== undefined && (real === home || real.startsWith(`${home}/`)) && isFile(real)) out.add(real);
    }
  }
  return out;
}

export interface SecretReader {
  /** The secret stored under a Keychain service, filed under the account when one is given; rejects when the item is missing or the person refuses the consent dialog. */
  read(service: string, account?: string): Promise<string>;
  /** What a helper command prints on this computer, run under sh as the tool would run it; rejects when it fails. */
  run(command: string): Promise<string>;
}

/** go-keyring, the library gh stores through, writes every macOS Keychain value as this prefix plus the base64 of
 * the bytes and undoes it on read; gh on Linux reads hosts.yml as written, so the value is unwrapped before it lands. */
const GO_KEYRING_PREFIX = "go-keyring-base64:";

/** macOS's own consent dialog stands between this call and the secret; nothing is cached or logged. A helper
 * command that reads the Keychain raises the same dialog, under the same read. */
export function keychainReader(run: (file: string, args: string[]) => Promise<{ stdout: string }> = execFileAsync): SecretReader & { command(service: string, account?: string): { file: string; args: string[] } } {
  const command = (service: string, account?: string) => ({ file: "security", args: ["find-generic-password", "-s", service, ...(account === undefined ? [] : ["-a", account]), "-w"] });
  return {
    command,
    async read(service, account) {
      const { file, args } = command(service, account);
      const { stdout } = await run(file, args);
      const value = stdout.replace(/\n$/, "");
      return value.startsWith(GO_KEYRING_PREFIX) ? Buffer.from(value.slice(GO_KEYRING_PREFIX.length), "base64").toString("utf8") : value;
    },
    async run(line) {
      const { stdout } = await run("/bin/sh", ["-c", line]);
      return stdout.replace(/\n$/, "");
    },
  };
}

/** The last line `security` printed, since its stderr names the cause and never the secret. A helper's failure is its
 * exit status alone: the command line and whatever it printed may carry the key. */
function secretFailure(e: unknown, helper: boolean): string {
  if (helper) {
    const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
    return typeof code === "number" ? `exit status ${code}` : typeof code === "string" ? code : "no exit status";
  }
  const lines = (e instanceof Error ? e.message : String(e)).split("\n").map(l => l.trim()).filter(l => l !== "");
  return lines.at(-1) ?? "unknown error";
}

export interface ReadSecrets {
  /** Secret by its key (see secretKey), for the pack. */
  values: Map<string, string>;
  /** Logins none of whose items were read, with the reason security gave for each, after the account when the item is per user; `command` names a helper that failed. */
  refused: { id: string; service: string; command?: string; reason: string }[];
  /** Items not read on a login another of whose items was read: the login copies without them; `left` is the row detail. */
  dropped: { id: string; service: string; account?: string; left: string; reason: string }[];
}

/** The row detail for an item the copy went without: an account's Keychain token, or another of a login's items. */
export const leftBehind = (what: string, why = "no token in the Keychain"): string => `${what} left behind: ${why}`;

const leftBehindItem = (s: PlannedSecret): string => (s.command === undefined ? leftBehind(s.service) : leftBehind("the helper's key", "the helper did not run here"));

/** The Keychain items the ticked rows would copy, in plan order, one per account where the tool files them so.
 * Runs before anything boots so a refused consent dialog never costs a machine. */
export function keychainLogins(picked: readonly ManifestEntry[], platform: "darwin" | "linux", home: string): PlannedSecret[] {
  return planFiles(picked.map(e => ({ ...e, bring: true })), { home, stat: () => undefined, read: readSmall, platform }).secrets;
}

export async function readSecrets(wanted: readonly PlannedSecret[], reader: SecretReader): Promise<ReadSecrets> {
  const out: ReadSecrets = { values: new Map(), refused: [], dropped: [] };
  const failed: { s: PlannedSecret; reason: string }[] = [];
  for (const s of wanted) {
    // One value per key: a helper two guest files render from runs once, so the consent dialog shows once.
    if (out.values.has(secretKey(s)) || failed.some(f => secretKey(f.s) === secretKey(s))) continue;
    try {
      out.values.set(secretKey(s), s.command === undefined ? await reader.read(s.service, s.account) : await reader.run(s.command));
    } catch (e) {
      failed.push({ s, reason: secretFailure(e, s.command !== undefined) });
    }
  }
  const read = new Set(wanted.filter(s => out.values.has(secretKey(s))).map(s => s.id));
  for (const { s, reason } of failed) {
    if (read.has(s.id)) {
      out.dropped.push({ id: s.id, service: s.service, ...(s.account !== undefined ? { account: s.account } : {}), left: s.account !== undefined ? leftBehind(s.account) : leftBehindItem(s), reason });
      continue;
    }
    const named = s.account === undefined ? reason : `${s.account}: ${reason}`;
    const row = out.refused.find(r => r.id === s.id);
    if (row === undefined) out.refused.push({ id: s.id, service: s.service, ...(s.command !== undefined ? { command: s.command } : {}), reason: named });
    else row.reason = `${row.reason}; ${named}`;
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
  /** Secrets already read from the Keychain, by key (see secretKey); a planned secret with no value is left out with a note. */
  secrets: ReadonlyMap<string, string>;
  /** This computer's home, links resolved; a link inside a copied directory must resolve under it. */
  home: string;
  /** Whether ~/.claude/settings.json is among the plan's files, in this pack or an earlier one this pack lands over; left out, this pack's files decide. */
  settingsPlanned?: boolean;
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
    // A login none of whose Keychain items was read was changed to a sign-in on the machine: none of its files
    // travel. One with an item read copies without the accounts whose items were not.
    const readIds = new Set(plan.secrets.filter(s => opts.secrets.has(secretKey(s))).map(s => s.id));
    const refused = new Set(plan.secrets.filter(s => !readIds.has(s.id)).map(s => s.id));
    const files = plan.files.filter(f => {
      if (!refused.has(f.id)) return true;
      skipped.push({ id: f.id, path: `~/${relative(opts.home, f.source)}`, note: "not read from the Keychain; sign in on the machine" });
      return false;
    });
    const modes = parentModes(files, opts.home);
    const rcReal = rcIdentities(opts.home);
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
    // carried copy: secret exports are set on the machine by hand, never carried in the file, and a bare source
    // of a file under home that is not in this pack is wrapped so the machine skips it instead of printing an
    // error. The copy keeps the laptop's mode, so a read-only file is opened writable for the one write.
    const cut: CutNames[] = [];
    const strip = (staged: string): void => {
      const text = readFileSync(staged, "utf8");
      const { names, carried } = stripExports(text);
      const guarded = staged.endsWith(".fish") ? carried : guardSources(carried, opts.home, rel => existsSync(join(stage, rel)));
      if (names.length > 0) cut.push({ path: `~/${relative(stage, staged)}`, names });
      if (guarded === text) return;
      const mode = statSync(staged).mode & 0o7777;
      chmodSync(staged, 0o600);
      writeFileSync(staged, guarded);
      chmodSync(staged, mode);
    };
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile() && (isRcFile(relative(stage, p)) || twins.has(p))) strip(p);
      }
    };
    walk(stage);
    cut.sort((a, b) => (a.path < b.path ? -1 : 1));
    // A dropped account leaves the staged file before any token lands, so the active mark has moved by the time
    // the account it moved to is placed and the host token follows it.
    for (const s of plan.secrets) {
      if (opts.secrets.has(secretKey(s))) continue;
      if (refused.has(s.id)) {
        skipped.push({ id: s.id, path: secretPath(s), note: s.command === undefined ? "not read from the Keychain; sign in on the machine" : "the helper did not run here; sign in on the machine" });
        continue;
      }
      if (s.account === undefined || s.drop === undefined) {
        skipped.push({ id: s.id, path: secretPath(s), note: leftBehindItem(s) });
        continue;
      }
      skipped.push({ id: s.id, path: secretPath(s), note: leftBehind(s.account) });
      const target = join(stage, s.dest);
      if (existsSync(target)) writeFileSync(target, s.drop(readFileSync(target, "utf8")));
    }
    for (const s of plan.secrets) {
      const secret = opts.secrets.get(secretKey(s));
      if (secret === undefined) continue;
      const target = join(stage, s.dest);
      mkdirSync(dirname(target), { recursive: true });
      const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      writeFileSync(target, s.place(secret, existing), { mode: 0o600 });
      chmodSync(target, 0o600);
    }
    // The copied Claude settings name a helper that runs on this computer. On the machine it reads the key file the
    // login row placed, or goes when no key travelled: Claude Code runs a configured helper for every request, so
    // one that fails there would shadow any other login (measured on 2.1.257).
    // A laptop config file is staged by its own row or by the row of the directory holding it.
    const stagedFor = (tildePath: string): { owner: PlannedFile; staged: string } | undefined => {
      const source = join(opts.home, tildePath.slice(2));
      const owner = files.find(f => f.source === source || f.source === dirname(source));
      return owner === undefined ? undefined : { owner, staged: join(stage, owner.dir ? `${owner.dest}/${basename(source)}` : owner.dest) };
    };
    const settings = stagedFor(CLAUDE_SETTINGS_FILE);
    const claude = settings?.owner;
    const key = plan.secrets.find(s => s.command !== undefined && opts.secrets.has(secretKey(s)));
    const reads = (k: PlannedSecret): string => `cat ${GUEST_HOME}/${k.dest}`;
    if (settings !== undefined && existsSync(settings.staged)) {
      const text = readFileSync(settings.staged, "utf8");
      const rewritten = withApiKeyHelper(text, key === undefined ? undefined : reads(key));
      if (rewritten !== undefined && rewritten !== text) {
        writeFileSync(settings.staged, rewritten);
        if (key === undefined) skipped.push({ id: settings.owner.id, path: CLAUDE_SETTINGS_FILE, note: "apiKeyHelper left out of the copy: the command runs on this computer only" });
      }
    } else if (key !== undefined && (claude !== undefined || !opts.settingsPlanned)) {
      // A settings.json that did not travel stays here whole, by the person's tick; the one written names the key file and nothing else.
      const minimal = withApiKeyHelper(undefined, reads(key));
      if (minimal !== undefined) {
        const target = join(stage, dirname(key.dest), "settings.json");
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, minimal);
        skipped.push({ id: key.id, path: secretPath(key), note: "the machine's settings.json names only the key file; your Claude Code config stayed here" });
      }
    }
    // A hook's script travels beside the settings when it is a plain file under home, at the path the machine reads
    // it from; a hook the machine could not run comes out, since the agent prints not found for it on every start.
    const left: GoldenLeftBehind[] = [];
    for (const a of CATALOG_AGENTS) {
      if (a.hooks === undefined) continue;
      const found = stagedFor(a.hooks.file);
      if (found === undefined || !existsSync(found.staged)) continue;
      const { owner, staged } = found;
      const text = readFileSync(staged, "utf8");
      const carried = a.hooks.carry(text, opts.home, abs => hookDest(abs, opts.home));
      for (const c of carried.carried) {
        const target = join(stage, c.to.slice(GUEST_HOME.length + 1));
        if (existsSync(target)) continue;
        mkdirSync(dirname(target), { recursive: true });
        cpSync(c.from, target, { dereference: true });
        chmodSync(target, statSync(c.from).mode & 0o7777);
      }
      for (const path of carried.left) left.push({ id: owner.id, path: a.hooks.file, note: leftBehind("hook", path) });
      if (carried.text !== text) writeFileSync(staged, carried.text);
    }
    skipped.push(...left);
    for (const [g, mode] of modes) if (existsSync(join(stage, g))) chmodSync(join(stage, g), mode);
    if (existsSync(join(stage, ".ssh"))) chmodSync(join(stage, ".ssh"), 0o700);
    const unpacked = treeBytes(stage);
    // tar truncates an existing archive in place, so the mode set here is the one it keeps.
    writeFileSync(tgz, "", { mode: 0o600 });
    const { file, args, env } = tarPackCommand(stage, tgz);
    await execFileAsync(file, args, { env });
    const tar = readFileSync(tgz);
    return { tar, bytes: tar.length, unpacked, skipped, cut, ...(left.length > 0 ? { leftBehind: left } : {}) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

/** Where a script a hook names lands on the guest: a plain file under home, resolving there, that the pack would
 * copy, at the rewrite the plan applies to its directory; nothing otherwise. */
function hookDest(abs: string, home: string): string | undefined {
  if (!under(abs, home) || !under(resolved(abs) ?? "", home) || !isFile(abs)) return undefined;
  const rel = relative(home, abs);
  return refusedPath(rel, false) === undefined ? guestPath(`~/${rel}`) : undefined;
}

export interface ImportOptions {
  home: string;
  /** Keychain secrets already read, by key (see readSecrets). */
  secrets: ReadonlyMap<string, string>;
  platform: "darwin" | "linux";
  /** Every row of the manifest with its tick, so the MCP stage knows which servers stay and which come out; without it no MCP plan is made. */
  rows?: readonly ManifestEntry[];
  /** This Mac's Homebrew, for the tap formulae with no Linux bottle: their source repositories. */
  brew?: BrewTable;
  /** The recipe's rows outside the catalog; they install after every catalog road and are never offered a sign-in. */
  custom?: readonly RecipeCustomRow[];
  onResult?: (result: ImportResult) => void;
  onContext?: GoldenImport["onContext"];
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

export const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** sha256 of what a planned path ships: every entry under it by relative path,
 * mode and bytes, excludes left out, links followed only into home and never
 * into a refused path or a directory already walked, as the pack follows them.
 * Stat times never enter, so a file rewritten with the same bytes digests the
 * same. An entry that cannot be read digests by its error; the pack is what
 * fails on it, with the person watching. */
export function digestOf(source: string, excludes: readonly string[], home: string): string {
  const hash = createHash("sha256");
  const entered = new Set<string>();
  const walk = (abs: string, rel: string): void => {
    if (excludes.some(x => abs === x || abs.startsWith(`${x}/`))) return;
    try {
      let real = abs;
      if (lstatSync(abs).isSymbolicLink()) {
        const target = resolved(abs);
        if (target === undefined) {
          hash.update(`L ${rel} ${relative(home, resolve(dirname(abs), readlinkSync(abs)))} gone\n`);
          return;
        }
        // The pack's rules for a link, in its order: never out of home, never back into the directory being
        // walked or one already walked, never into a refused path.
        const parent = resolved(dirname(abs)) ?? dirname(abs);
        const own = parent === target || parent.startsWith(`${target}/`);
        const why = !under(target, home) ? "outside home" : own ? "own directory" : entered.has(target) ? "already walked" : refusedPath(relative(home, target), statSync(target).isDirectory());
        if (why !== undefined) {
          hash.update(`L ${rel} ${relative(home, target)} ${why}\n`);
          return;
        }
        real = target;
      }
      const st = statSync(real);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isDirectory()) {
        entered.add(real);
        hash.update(`D ${rel} ${mode}\n`);
        for (const name of readdirSync(real).sort()) walk(join(abs, name), `${rel}/${name}`);
      } else {
        hash.update(`F ${rel} ${mode} ${st.size}\n`);
        hash.update(readFileSync(real));
      }
    } catch (e) {
      hash.update(`X ${rel} ${(e as { code?: string }).code ?? "error"}\n`);
    }
  };
  walk(source, "");
  return hash.digest("hex");
}

/** The guest's Claude config dir, relative to its home; the laptop's ~/.claude lands there. */
const CLAUDE_REL = CLAUDE_CONFIG_DIR.replace(/^\/root\//, "");

/** Where a laptop config lands on the guest, by the same rewrite the files plan applies. */
function guestPath(tildePath: string): string {
  const rel = tildePath.slice(2);
  const moved = rel === ".claude.json" ? `${CLAUDE_REL}/.claude.json` : rel.startsWith(".claude/") ? `${CLAUDE_REL}/${rel.slice(".claude/".length)}` : rel;
  return `${GUEST_HOME}/${moved}`;
}

const MCP_SOURCES = Object.fromEntries(MCP_AGENTS.map(a => [a.id, { label: a.name, format: a.mcp.format, files: a.mcp.files.map(guestPath) }]));

/** Which of a row's paths its tool rewrites while it runs. Volatility is the tool's property, not a saved choice:
 * the catalog decides for every row it knows, so a recipe file saved before the list existed, or with a list the
 * catalog never gave, reads the same as a fresh collection; the saved field stands only for a row the catalog
 * does not know. */
function volatileOf(e: ManifestEntry): string[] | undefined {
  const known = AGENTS.find(a => `agents/${a.id}` === e.id);
  const list = known !== undefined ? (known.volatile ?? []).filter(p => e.paths.includes(p)) : e.volatile;
  return list !== undefined && list.length > 0 ? [...list] : undefined;
}

/** What the ticked rows add up to for the builder, the rows the plan itself set
 * aside (a formula with no Linux bottle) beside the installs so the saved result
 * is complete. */
export function importFor(picked: readonly ManifestEntry[], opts: ImportOptions): GoldenImport {
  // Rows arrive as the person's selection; a fresh collection carries no bring flag yet.
  const bring = picked.map(e => {
    const row: ManifestEntry = { ...e };
    delete row.volatile;
    const volatile = volatileOf(e);
    return { ...row, bring: true, ...(volatile !== undefined ? { volatile } : {}) };
  });
  const home = resolved(opts.home) ?? opts.home;
  const plan = planFiles(bring, {
    home,
    stat: statOf,
    read: readSmall,
    platform: opts.platform,
    rewrites: [[".claude/", `${CLAUDE_REL}/`], [".claude.json", `${CLAUDE_REL}/.claude.json`]],
  });
  const shell = shellInstallFor(bring);
  const tools = toolInstallsFor(bring, opts.brew, opts.custom);
  const agents = agentInstallsFor(bring);
  const mcp = opts.rows !== undefined ? mcpPlanFor(opts.rows, { home, guestHome: GUEST_HOME, agents: MCP_SOURCES, binDirs: MCP_BIN_DIRS }) : undefined;
  const label = (id: string) => bring.find(e => e.id === id)?.label ?? id;
  const anyFiles = plan.files.length + plan.secrets.length + plan.skipped.length > 0;
  // A login's Keychain items count once, however many accounts they are read for.
  const count = plan.files.length + new Set(plan.secrets.map(s => `${s.id} ${s.service}`)).size;
  const tilde = (f: PlannedFile): string => `~/${relative(home, f.source)}`;
  // A login whose value comes from the Keychain is one unit with its file: a re-login is the same golden with a
  // fresher token, so the file is volatile too and the pair re-renders on attach.
  const withSecret = new Set(plan.secrets.map(s => s.id));
  const files = plan.files.map(f => (withSecret.has(f.id) && !f.volatile ? { ...f, volatile: true } : f));
  const digested = files.map(f => ({ id: f.id, path: tilde(f), dest: f.dest, digest: digestOf(f.source, f.excludes, home), volatile: f.volatile }));
  // The values are read after the earlier-builder check, so they are digested when the recipe is read, not here.
  const secretDigests = () =>
    plan.secrets.flatMap(s => {
      const value = opts.secrets.get(secretKey(s));
      return value === undefined ? [] : [{ id: s.id, path: secretPath(s), dest: s.dest, digest: createHash("sha256").update(value).digest("hex"), volatile: true }];
    });
  const hash = recipeHash(recipeDigest(bring, digested, opts.custom));
  const settingsSource = join(home, CLAUDE_SETTINGS_FILE.slice(2));
  const packOpts: PackOptions = { secrets: opts.secrets, home, settingsPlanned: plan.files.some(f => f.source === settingsSource || f.source === dirname(settingsSource)) };
  const pack = (): Promise<PackedFiles> => packPlan(plan, packOpts);
  const volatileFiles = files.filter(f => f.volatile);
  const volatile =
    volatileFiles.length > 0 || plan.secrets.length > 0
      ? { paths: [...volatileFiles.map(tilde), ...plan.secrets.map(secretPath)], pack: () => packPlan({ ...plan, files: volatileFiles }, packOpts) }
      : undefined;
  return {
    recipeHash: hash,
    get recipe() {
      return recipeDigest(bring, [...digested, ...secretDigests()], opts.custom);
    },
    ...(anyFiles
      ? { files: { count, rungs: plan.rungs, bytes: plan.bytes, skipped: plan.skipped, pack, ...(volatile !== undefined ? { volatile } : {}) } }
      : {}),
    ...(shell !== undefined ? { shell } : {}),
    tools: tools.installs,
    ...(agents.node !== undefined ? { node: agents.node } : {}),
    agents: agents.installs,
    skippedAgents: agents.skipped.map(s => ({ id: s.id, name: label(s.id), note: s.note })),
    skippedTools: tools.skipped.map(s => ({ id: s.id, label: label(s.id), note: s.note })),
    baseTools: tools.base.map(b => ({ id: b.id, label: label(b.id), note: b.note })),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(opts.onResult !== undefined ? { onResult: opts.onResult } : {}),
    ...(opts.onContext !== undefined ? { onContext: opts.onContext } : {}),
  };
}

export function importResultPath(statePath: string): string {
  return join(dirname(statePath), "golden-import.json");
}
