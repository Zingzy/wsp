// SPDX-License-Identifier: AGPL-3.0-only
import {
  INLINE_EXEC_MS,
  goldenHead,
  imageHash,
  recipeHash,
  type GoldenManifest,
  type GoldenVersion,
  type Machine,
  type MachineBackend,
  type MachineShape,
  MEM_READ,
  memMbOf,
  readValues,
} from "@wsp/engine";
import type {
  RecipeDigest,
  SealedImage,
  ProjectGolden,
  WorkspaceProject,
  WorkspaceSize,
  WorkspaceView,
} from "@wsp/protocol";
import { forksNoMachines, sizeWord } from "@wsp/protocol";
import {
  WORKSPACES,
  GOLDENS,
  GOLDEN_RECIPES,
  PROJECT_GOLDENS,
  IMAGES,
  copyKey,
  recipeKey,
  WORKSPACE_NAMES,
  type NamedWorkspace,
} from "../types/internal.js";
import type { RuntimeContext, RecordsArea } from "../context.js";
import type { WorkspaceRecord } from "../types/wiring.js";

export function recordsArea(ctx: RuntimeContext): RecordsArea {
  const { backend, store, hostId, live, places } = ctx;
  const view = (r: WorkspaceRecord): WorkspaceView => ({
    ...((): { folder?: string } => {
      const folder = ctx.moduleOf(r.kind).folder(r);
      return folder !== undefined ? { folder } : {};
    })(),
    ...ctx.homeOf(r),
    id: r.id,
    name: r.name,
    machineId: r.machineId,
    phase: r.phase,
    kind: r.kind,
    golden: r.golden,
    createdAt: r.createdAt,
    project: ctx.refOf(ctx.projectHeld(r.project)),
    ...(r.worktree !== undefined ? { worktree: r.worktree } : {}),
    ...(r.from !== undefined ? { from: r.from } : {}),
    ...(r.review !== undefined ? { review: r.review } : {}),
    ...(r.claudeSessionId !== undefined ? { claudeSessionId: r.claudeSessionId } : {}),
    ...(r.screen !== undefined ? { screen: r.screen } : {}),
    ...(r.gone !== undefined ? { gone: r.gone } : {}),
    ...(r.theme !== undefined ? { theme: r.theme } : {}),
    ...(r.glyph !== undefined ? { glyph: r.glyph } : {}),
    ...(ctx.daemonNotes.has(r.id) ? { daemonNote: ctx.daemonNotes.get(r.id)! } : {}),
    ...(r.daemonRefusedAt !== undefined ? { daemonRefusedAt: r.daemonRefusedAt } : {}),
    ...(r.vaultedAt !== undefined ? { vaultedAt: r.vaultedAt } : {}),
    ...(r.vaultRefused !== undefined ? { vaultRefused: r.vaultRefused } : {}),
    ...(r.wakeRefused !== undefined ? { wakeRefused: r.wakeRefused } : {}),
    ...(ctx.agentsOf(r) !== undefined ? { agents: ctx.agentsOf(r)! } : {}),
    ...(r.parentThreadId !== undefined ? { parentThreadId: r.parentThreadId } : {}),
    ...(r.rootThreadId !== undefined ? { rootThreadId: r.rootThreadId } : {}),
    ...(r.parentWorkspaceId !== undefined ? { parentWorkspaceId: r.parentWorkspaceId } : {}),
    ...(r.place !== undefined ? { place: r.place } : {}),
    ...(ctx.providerOf(r) !== undefined ? { provider: ctx.providerOf(r)! } : {}),
  });

  /** One fact of a workspace's look: a value sets it, null clears it back to none, and undefined leaves what the
   * record holds, so a picker sends its own fact without reading the other's. */
  const putLook = <K extends "theme" | "glyph">(r: WorkspaceRecord, key: K, value: WorkspaceRecord[K] | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) delete r[key];
    else r[key] = value;
  };

  const persist = async (r: WorkspaceRecord): Promise<void> => {
    const entry = live.get(r.id);
    if (entry !== undefined) entry.generation++;
    await store.put(WORKSPACES, r.id, r);
    // The two facts a machine's own labels cannot carry, written beside the record rather than only on a rename:
    // a sweep that finds the machine after this document is lost puts the record back under both.
    await store.put(WORKSPACE_NAMES, r.id, { workspaceId: r.id, name: r.name, project: r.project } satisfies NamedWorkspace);
  };

  const shapeOf = async (m: Machine): Promise<MachineShape | undefined> => {
    if (!m.describe) return undefined;
    return m.describe().catch(() => undefined);
  };

  /** The provider's word on what it built, falling back to the request where it has none. */
  const sizeBuilt = (shape: MachineShape | undefined, asked: WorkspaceSize): WorkspaceSize => ({
    cpu: shape?.cpu ?? asked.cpu,
    memMb: shape?.memMb ?? asked.memMb,
  });

  /** The guest's own count of its memory onto the row, since the provider's view echoes the memory asked for; true
   * where the count was read. A place's daemon already answers the size it applied and is never asked. */
  const readMemory = async (record: WorkspaceRecord, machine: Machine, sizes: MachineBackend["capabilities"]["sizes"]): Promise<boolean> => {
    const memMb = await machine.exec(MEM_READ, { timeoutMs: INLINE_EXEC_MS }).then(
      res => (res.exitCode === 0 ? memMbOf(readValues(res.stdout)) : `exit ${res.exitCode}${res.stderr.trim() === "" ? "" : `: ${res.stderr.trim().slice(-200)}`}`),
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (typeof memMb === "string") console.warn(`workspace ${record.id}: memory not read on ${machine.id} (${memMb}); the row keeps ${sizeWord(record.size)}`);
    if (typeof memMb !== "number") return false;
    // The kernel keeps a few percent back: 4032 MB read on a 4096 MB machine.
    const offered = sizes.find(s => Math.abs(s.memMb - memMb) <= s.memMb / 16);
    // The count is the guest's word, and a guest can print any figure: no row or rate goes past the largest offer.
    const largest = Math.max(0, ...sizes.map(s => s.memMb));
    record.size = { ...record.size, memMb: offered?.memMb ?? (largest > 0 ? Math.min(memMb, largest) : memMb) };
    return true;
  };

  /** The workspaces forked from this snapshot, whatever their phase: the lineage retention must not cut. */
  const forkedFrom = (snapshotId: string): string[] => [...live.values()].filter(e => e.record.golden === snapshotId).map(e => e.record.name);
  /** A place's copy of a golden. A state file the boot has not migrated yet carries the wired place's copy under
   * the bare name, so that key is read as a fallback for the wired place and for no other: a copy under the bare
   * key was built where this host forks, and reading it as another place's would say a place holds an image it has
   * never seen. */
  const bareFallback = (place: string): boolean => place === places.wired;
  const copyOf = async (place: string, name: string): Promise<GoldenManifest | undefined> =>
    ((await store.get(GOLDENS, copyKey(place, name))) ?? (bareFallback(place) ? await store.get(GOLDENS, name) : undefined)) as GoldenManifest | undefined;
  const putCopy = (place: string, name: string, manifest: GoldenManifest): Promise<void> => store.put(GOLDENS, copyKey(place, name), manifest);
  const copyRecipeOf = async (place: string, name: string, version: number): Promise<RecipeDigest | undefined> =>
    ((await store.get(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)))) ??
      (bareFallback(place) ? await store.get(GOLDEN_RECIPES, recipeKey(name, version)) : undefined)) as RecipeDigest | undefined;
  const putCopyRecipe = (place: string, name: string, version: number, digest: RecipeDigest): Promise<void> =>
    store.put(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)), digest);
  const dropCopyRecipe = async (place: string, name: string, version: number): Promise<void> => {
    await store.delete(GOLDEN_RECIPES, copyKey(place, recipeKey(name, version)));
    if (bareFallback(place)) await store.delete(GOLDEN_RECIPES, recipeKey(name, version));
  };

  /** A state file written before a golden was one place's copy holds its manifests and recipes under the bare name.
   * Each one moves under the wired place, and the old key goes only once the new one is there to be read: a put
   * that did not land leaves the copy where it was rather than taking it with the key.
   *
   * A host whose module forks nothing has no place to file a copy under: it is the module a host with no provider
   * key starts on, and the key it is given later swaps a different module in. Filing the golden under that module
   * would put it out of reach of every boot after the swap, so nothing moves until a boot knows what it forks on.
   * Runs once, at boot. */
  const migrateCopies = async (): Promise<void> => {
    if (forksNoMachines((places.backend(places.wired) ?? backend).capabilities)) return;
    for (const collection of [GOLDENS, GOLDEN_RECIPES]) {
      for (const key of await store.keys(collection)) {
        if (key.includes("/")) continue;
        const moved = copyKey(places.wired, key);
        if ((await store.get(collection, moved)) === undefined) {
          await store.put(collection, moved, await store.get(collection, key));
          // Read back before the old key goes: a put that did not land would take the copy with it.
          if ((await store.get(collection, moved)) === undefined) continue;
        }
        await store.delete(collection, key);
      }
    }
  };

  /** The image record this host owns for a golden: the one written at the seal, or, for a golden sealed before
   * records existed, what its wired copy's head already says. A backfilled record carries no small recipe and no
   * vault, so `wsp image` says the sign-ins are not held and a copy of it is refused until the next version. */
  const recordOf = async (name: string): Promise<SealedImage | undefined> => {
    const stored = (await store.get(IMAGES, name)) as SealedImage | undefined;
    if (stored !== undefined) return stored;
    const head = goldenHead(await copyOf(places.wired, name));
    if (head === undefined) return undefined;
    const digest = await copyRecipeOf(places.wired, name, head.version);
    const hash = digest === undefined ? "" : recipeHash(digest);
    return {
      name,
      version: head.version,
      hash: imageHash(hash, undefined, []),
      recipeHash: hash,
      logins: head.logins ?? [],
      sealedAt: head.createdAt,
      sealedFrom: hostId,
      ...(head.usedBytes !== undefined ? { usedBytes: head.usedBytes } : {}),
    };
  };

  /** Every snapshot and template id this state file stands on: each golden's versions and their templates, each
   * project golden, and the image every live workspace forks from. A row wsp made that is in none of them is an
   * orphan, whatever its name; a row in one of them is kept even when its name predates the owner mark. */
  const recordedImages = async (): Promise<Set<string>> => {
    const ids = new Set<string>();
    for (const raw of await store.list(GOLDENS)) {
      for (const v of (raw as GoldenManifest).versions) {
        ids.add(v.snapshotId);
        if (v.templateId !== undefined) ids.add(v.templateId);
      }
    }
    for (const raw of await store.list(PROJECT_GOLDENS)) ids.add((raw as ProjectGolden).snapshotId);
    for (const e of live.values()) ids.add(e.record.golden);
    return ids;
  };

  /** The manifest holding this snapshot as one of its versions, if any does. */
  const goldenManifestOf = async (snapshotId: string): Promise<GoldenManifest | undefined> => {
    for (const raw of await store.list(GOLDENS)) {
      const m = raw as GoldenManifest;
      if (m.versions.some(v => v.snapshotId === snapshotId)) return m;
    }
    return undefined;
  };

  /** The sealed version behind this snapshot, if any manifest knows it. */
  const goldenVersionOf = async (snapshotId: string): Promise<GoldenVersion | undefined> =>
    (await goldenManifestOf(snapshotId))?.versions.find(v => v.snapshotId === snapshotId);

  /** Whether the small recipe this version was sealed from asks for the engine socket on every fork: the sealed
   * record of the image whose wired copy holds this version says. A version no record names asks for none. */
  const recipeAsksEngine = async (version: GoldenVersion): Promise<boolean> => {
    for (const raw of await store.list(IMAGES)) {
      const image = raw as SealedImage;
      // A copy at any place carries the record's hash it was built from, whatever version number that place gave it.
      if (version.imageHash !== undefined && version.imageHash === image.hash) return image.recipe?.engine === true;
      if (image.version !== version.version) continue;
      const manifest = await copyOf(places.wired, image.name);
      if (manifest?.versions.some(v => v.snapshotId === version.snapshotId && v.version === version.version)) return image.recipe?.engine === true;
    }
    return false;
  };

  /** What stands behind a snapshot a workspace forks from: a golden version, or a project golden and the version at
   * the root of its lineage. `golden` is that root's snapshot id, the one a snapshot taken from the fork records. */
  const imageOf = async (snapshotId: string): Promise<{ golden: string; version?: GoldenVersion; projects?: WorkspaceProject[] }> => {
    const version = await goldenVersionOf(snapshotId);
    if (version !== undefined) return { golden: snapshotId, version };
    const stored = await store.get(PROJECT_GOLDENS, snapshotId);
    if (stored === undefined) return { golden: snapshotId };
    const project = projectGoldenOf(stored);
    const root = await goldenVersionOf(project.golden);
    return { golden: project.golden, ...(root !== undefined ? { version: root } : {}), projects: project.projects };
  };

  /** A project golden as stored, read as one of today: a manifest from before a snapshot carried every project on
   * the disk named the one it was taken for under `project`, and reads as a golden of that one. */
  const projectGoldenOf = (raw: unknown): ProjectGolden => {
    const { project: single, ...rest } = raw as Omit<ProjectGolden, "projects"> & { projects?: WorkspaceProject[]; project?: WorkspaceProject };
    return { ...rest, projects: rest.projects ?? (single !== undefined ? [single] : []) };
  };
  return {
    view, putLook, persist, shapeOf, sizeBuilt, readMemory, forkedFrom, copyOf, putCopy, copyRecipeOf, putCopyRecipe,
    dropCopyRecipe, migrateCopies, recordOf, recordedImages, goldenManifestOf, recipeAsksEngine, imageOf,
    projectGoldenOf,
  };
}
