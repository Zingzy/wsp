// SPDX-License-Identifier: AGPL-3.0-only
// The bundle's trip home, this computer's side: the folder's archive off the machine lands beside its destination
// and moves into place in one rename, and the agents' state that came with it is keyed to that destination in a
// scratch copy of their homes, then laid over the real homes here. The homes here only gain files.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { PROJECT_STATE_RESOLVERS, countProjectState, destExists, moveProjectState } from "@wsp/engine";
import type { ProjectAgentResult } from "@wsp/protocol";
import type { LandRequest, LandedAgent, LandedProject, ProjectLander } from "@wsp/runtime";
import { CACHE_RULE, outcomeOf } from "./project-bundle.js";

/** A destination is spelled out in full; the wire and the MCP tool carry it as the caller wrote it, so a trailing
 * slash or a dot segment is dropped here before the path names a staging directory or a state key. */
function destination(dest: string): string {
  if (!isAbsolute(dest)) throw new Error(`the destination must be an absolute path, got ${dest}`);
  return resolve(dest);
}

/** Every regular file under a path, or the path itself when it is one. */
function filesAt(path: string): { files: number; bytes: number } | undefined {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(path, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    files++;
    bytes += statSync(join(e.parentPath, e.name)).size;
  }
  return { files, bytes };
}

/** Extracts a gzipped archive into dir with this computer's tar, the bytes fed on stdin. */
function extract(tar: Buffer, dir: string): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("tar", ["-xzf", "-", "-C", dir], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", fail);
    child.on("close", code => (code === 0 ? done() : fail(new Error(`extracting the archive into ${dir} failed (exit ${code}): ${stderr.trim().slice(-500)}`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(tar);
  });
}

/** The agents' state, keyed on the machine to `source`, brought into the homes here keyed to `target`, the real path
 * the folder will have: the archive is opened in a scratch directory, each agent's home there is a skeleton holding
 * its state roots alone, the move runs in the skeleton, and the files its module then names for the target are copied
 * over the home here, one by one. A row that lives in a shared store here (an index, a registry) is not written, so
 * that agent is transcript-only. */
async function landState(state: NonNullable<LandRequest["state"]>, source: string, target: string, homes: Readonly<Record<string, string>>): Promise<LandedAgent[]> {
  const scratch = mkdtempSync(join(tmpdir(), "wsp-home-"));
  try {
    await extract(state.tar, scratch);
    const skeletons = Object.fromEntries(Object.entries(state.homes).flatMap(([agent, home]) => (existsSync(join(scratch, home)) ? [[agent, join(scratch, home)]] : [])));
    const wanted = CATALOG_AGENTS.filter(a => state.agents === undefined || state.agents.includes(a.id));
    const rows = await countProjectState(source, skeletons, wanted);
    const readable = rows.filter(r => r.error === undefined);
    const reports = new Map((await moveProjectState({ from: source, to: target, homes: skeletons }, readable.map(r => ({ id: r.agent })))).map(r => [r.agent, r]));
    const landed: LandedAgent[] = [];
    for (const row of rows) {
      const report = reports.get(row.agent);
      const resolver = PROJECT_STATE_RESOLVERS.get(row.agent);
      const skeleton = skeletons[row.agent];
      const home = homes[row.agent];
      const base: ProjectAgentResult & { name: string } = { agent: row.agent, name: row.name, files: 0, bytes: 0, outcome: "nothing", sessions: row.sessions };
      if (row.error !== undefined || report?.outcome === "failed") {
        landed.push({ ...base, outcome: "failed", error: row.error ?? (report?.outcome === "failed" ? report.error : "no reason given") });
        continue;
      }
      if (resolver === undefined || skeleton === undefined || home === undefined) {
        landed.push(base);
        continue;
      }
      let bytes = 0;
      const files = await resolver.entries(skeleton, target);
      for (const f of files) {
        const copy = join(home, relative(skeleton, f));
        mkdirSync(dirname(copy), { recursive: true });
        copyFileSync(f, copy);
        bytes += statSync(f).size;
      }
      const skipped = report?.outcome === "moved" ? report.moved.reduce((n, m) => n + (m.skipped ?? 0), 0) : 0;
      landed.push({ ...base, files: files.length, bytes, outcome: outcomeOf(files.length, true, resolver.carry, report), ...(skipped > 0 ? { skipped } : {}) });
    }
    return landed;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Lands the folder's archive at dest and the agents' state that came with it. The folder is extracted into a
 * staging directory beside dest, the state is opened in a scratch home, keyed to the path dest will have and laid
 * over the homes here, and only then is the staging directory renamed onto dest, so a failure anywhere before that
 * rename leaves nothing at or beside the destination. An existing destination is refused first and again at the
 * rename, unless `replace` removes it. */
async function land(req: LandRequest, homes: Readonly<Record<string, string>>): Promise<LandedProject> {
  const dest = destination(req.dest);
  const at = filesAt(dest);
  if (at !== undefined && !req.replace) throw destExists(dest, at.files);
  const staging = `${dest}.wsp-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(staging, { recursive: true });
  try {
    await extract(req.tar, staging);
    const target = join(dirname(realpathSync(staging)), basename(dest));
    const agents = req.state === undefined ? [] : await landState(req.state, req.source, target, homes);
    const now = filesAt(dest);
    if (now !== undefined) {
      if (!req.replace) throw destExists(dest, now.files);
      rmSync(dest, { recursive: true, force: true });
    }
    renameSync(staging, dest);
    return { ...(filesAt(dest) ?? { files: 0, bytes: 0 }), agents };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** This computer's side of project.export; `homes` is each agent's home here by catalog id, the production caller's
 * under the real home directory, so a test never writes the homes on this computer. */
export function projectLander(homes: Readonly<Record<string, string>>): ProjectLander {
  return {
    caches: CACHE_RULE,
    probe: async dest => {
      const at = filesAt(destination(dest));
      return at === undefined ? undefined : { files: at.files };
    },
    land: req => land(req, homes),
  };
}
