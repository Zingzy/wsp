// SPDX-License-Identifier: AGPL-3.0-only
// The half of golden import that touches this computer: the archive of the
// ticked files with their modes, the Keychain reads behind an injected
// reader, and the import object the runtime hands to the builder.
import { execFile } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { ManifestEntry } from "@wsp/collect";
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
  type PackedFiles,
  type PathInfo,
  type SkippedPath,
} from "@wsp/engine";
import { CONFIG_DIR, GOLDEN_SETUP, GOLDEN_SMOKE, tarPackCommand } from "./doctor.js";

const execFileAsync = promisify(execFile);

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

export interface PackOptions {
  secrets: SecretReader;
  /** This computer's home, links resolved; a link inside a copied directory must resolve under it. */
  home: string;
}

/** Copies the planned files into a staging tree, renders each secret into it,
 * and tars the tree. Links are followed so the target's bytes land at the
 * link's path; one that leaves home or points at a refused path is left out
 * with a note. A secret that cannot be read is a note, not a failure: the
 * person can still sign in on the machine. */
export async function packPlan(plan: FilesPlan, opts: PackOptions): Promise<PackedFiles> {
  const stage = mkdtempSync(join(tmpdir(), "wsp-golden-import-"));
  const out = mkdtempSync(join(tmpdir(), "wsp-golden-import-tar-"));
  const tgz = join(out, "files.tgz");
  const skipped: SkippedPath[] = [];
  try {
    for (const f of plan.files) {
      const target = join(stage, f.dest);
      mkdirSync(dirname(target), { recursive: true });
      const keep = (src: string): boolean => {
        if (!lstatSync(src).isSymbolicLink()) return true;
        const shown = `~/${relative(opts.home, src)}`;
        const real = resolved(src);
        if (real === undefined) skipped.push({ id: f.id, path: shown, note: "a link whose target is gone" });
        else if (!(real === opts.home || real.startsWith(`${opts.home}/`))) skipped.push({ id: f.id, path: shown, note: `a link to ${real}, outside your home directory` });
        else {
          const why = refusedPath(relative(opts.home, real), statSync(real).isDirectory());
          if (why === undefined) return true;
          skipped.push({ id: f.id, path: shown, note: `a link to ~/${relative(opts.home, real)}: ${why}` });
        }
        return false;
      };
      cpSync(f.source, target, { recursive: true, dereference: true, filter: keep });
      chmodSync(target, f.mode);
    }
    for (const s of plan.secrets) {
      let secret: string;
      try {
        secret = await opts.secrets.read(s.service);
      } catch (e) {
        skipped.push({ id: s.id, path: `Keychain: ${s.service}`, note: `Keychain read failed (${secretFailure(e)}); sign in on the machine` });
        continue;
      }
      const target = join(stage, s.dest);
      mkdirSync(dirname(target), { recursive: true });
      const existing = existsSync(target) ? readFileSync(target, "utf8") : undefined;
      writeFileSync(target, s.place(secret, existing), { mode: 0o600 });
      chmodSync(target, 0o600);
    }
    if (existsSync(join(stage, ".ssh"))) chmodSync(join(stage, ".ssh"), 0o700);
    const unpacked = treeBytes(stage);
    // tar truncates an existing archive in place, so the mode set here is the one it keeps.
    writeFileSync(tgz, "", { mode: 0o600 });
    const { file, args, env } = tarPackCommand(stage, tgz);
    await execFileAsync(file, args, { env });
    const tar = readFileSync(tgz);
    return { tar, bytes: tar.length, unpacked, skipped };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
}

export interface ImportOptions {
  home: string;
  secrets: SecretReader;
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
  if (realpath === undefined) return { kind: "dangling", target: readlinkSync(abs) };
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
