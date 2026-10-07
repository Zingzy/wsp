// SPDX-License-Identifier: AGPL-3.0-only
import {
  goldenHead,
  importImageVault,
  refuseForeignMembers,
  killUntilGone,
  type GoldenManifest,
  type GoldenVersion,
  type MachineBackend,
  isPlaceAbsent,
} from "@wsp/engine";
import type { SealedImage, SealedImageBuilt, SealedImageCopy, SealedProjectImage } from "@wsp/protocol";
import {
  vaultUnlistedRefusal,
  COPY_BUILD_FIX,
  copyAsksSignIns,
  refusal,
  buildsImages,
  copyIsCurrent,
  fmtBytes,
  placeBuildsNoImageLine,
  placeWentAwayLine,
} from "@wsp/protocol";
import type { Runtime } from "../types/api.js";
import { GOLDENS, IMAGES, IMAGE_VAULTS, copyKey, copyKeyParts, vaultKey } from "../types/internal.js";
import type { RuntimeContext, ImageArea } from "../context.js";

export function imageArea(ctx: RuntimeContext): ImageArea {
  const {
    opts, store, placeDoor, builders, copyBuilds, copyRows, rowSaysFailure, placeAway, frameStopped, places,
  } = ctx;
  /** The sizes a place's provider reports the snapshots named restore to, keyed by id; empty where it has no listing
   * or would not answer, and none for a snapshot it reports only the stored size of, since a size nobody read is left
   * absent rather than guessed. */
  const snapshotSizes = async (at: MachineBackend, ids: readonly string[]): Promise<Map<string, number>> => {
    if (ids.length === 0 || !at.capabilities.snapshotListing || at.listSnapshots === undefined) return new Map();
    const rows = await at.listSnapshots().catch(() => []);
    return new Map(rows.flatMap(r => (ids.includes(r.id) && r.restoredBytes !== undefined ? [[r.id, r.restoredBytes] as const] : [])));
  };

  /** The copy each place holds of this golden, newest version per place, with the record's hash it was built at. */
  const copiesOf = async (name: string): Promise<SealedImageCopy[]> => {
    const rows: { place: string; head: GoldenVersion }[] = [];
    for (const key of await store.keys(GOLDENS)) {
      const parts = copyKeyParts(key);
      if (parts.name !== name) continue;
      const head = goldenHead((await store.get(GOLDENS, key)) as GoldenManifest | undefined);
      if (head !== undefined) rows.push({ place: parts.place ?? places.wired, head });
    }
    const copies: SealedImageCopy[] = [];
    for (const { place, head } of rows) {
      const at = places.backend(place) ?? placeDoor?.backendOf(place);
      const sizes = at === undefined ? new Map<string, number>() : await snapshotSizes(at, [head.snapshotId]);
      copies.push({
        place,
        version: head.version,
        ...(head.imageHash !== undefined ? { hash: head.imageHash } : {}),
        snapshotId: head.snapshotId,
        ...(head.templateId !== undefined ? { templateId: head.templateId } : {}),
        builtAt: head.createdAt,
        ...(sizes.has(head.snapshotId) ? { sizeBytes: sizes.get(head.snapshotId)! } : {}),
      });
    }
    return copies.sort((a, b) => (a.place === places.wired ? -1 : b.place === places.wired ? 1 : a.place.localeCompare(b.place)));
  };

  const conflict = (message: string): Error => Object.assign(new Error(message), { kind: "conflict" });

  /** Every project golden, oldest first, with its size off the listing of the place each record names: one listing
   * per place, and none for a place this host no longer holds. */
  const projectImagesSized = async (): Promise<SealedProjectImage[]> => {
    const projects = await ctx.golden.projects();
    const sizes = new Map<string, number>();
    for (const place of new Set(projects.map(p => p.place ?? places.wired))) {
      let at: MachineBackend;
      try {
        at = ctx.backendAt(place);
      } catch {
        continue;
      }
      for (const [id, bytes] of await snapshotSizes(at, projects.filter(p => (p.place ?? places.wired) === place).map(p => p.snapshotId))) sizes.set(id, bytes);
    }
    return projects.map(p => (sizes.has(p.snapshotId) ? { ...p, sizeBytes: sizes.get(p.snapshotId)! } : p));
  };

  const image: Runtime["image"] = {
    async get(name) {
      await ctx.ready();
      const key = name ?? "default";
      return {
        image: (await ctx.recordOf(key)) ?? null,
        copies: await copiesOf(key),
        projects: await projectImagesSized(),
      };
    },

    async vault(name) {
      await ctx.ready();
      const key = name ?? "default";
      const record = await ctx.recordOf(key);
      if (record === undefined) throw conflict(`this host owns no image named ${key} yet; wsp init seals one`);
      if (record.vault === undefined) throw conflict(`${key} v${record.version} was sealed before its sign-ins were held, so there is nothing to export; cut the next version to hold them`);
      const tar = await store.getBlob(IMAGE_VAULTS, vaultKey(key, record.version));
      if (tar === undefined) throw conflict(`the vault of ${key} v${record.version} is not on this computer any more; cut the next version to take it again`);
      return { image: record, tar };
    },

    async build(o) {
      await ctx.ready();
      const name = o.name ?? "default";
      const { place, at } = await ctx.placeAt(o.place);
      const where = ctx.placeName(place);
      if (!buildsImages(at.capabilities)) throw refusal(placeBuildsNoImageLine(where), COPY_BUILD_FIX.noCopy, "conflict");
      const record = await ctx.recordOf(name);
      if (record === undefined) throw refusal(`this host owns no image named ${name} yet`, COPY_BUILD_FIX.noImage, "conflict");
      if (record.recipe === undefined) throw refusal(`${name} v${record.version} was sealed before the image record kept the recipe it was built from, so no other place can build it`, COPY_BUILD_FIX.noRecipe, "conflict");
      if (copyAsksSignIns(record) && o.force !== true) {
        throw refusal(`${name} v${record.version} holds no sign-ins, so a copy at ${where} would ask for every one of them again`, COPY_BUILD_FIX.noVault, "conflict");
      }
      const held = goldenHead(await ctx.copyOf(place, name));
      // The same rule the line under Settings > Image reads, so a copy is never current in one place and stale in
      // the other. A place already standing on the record is answered with what it holds: a fork there asks this
      // before it builds, and a second ask must cost nothing.
      if (held !== undefined && copyIsCurrent(record, { hash: held.imageHash })) {
        const standing = (await copiesOf(name)).find(c => c.place === place);
        if (standing === undefined) throw new Error(`${where} holds ${name} v${held.version} and no copy of it was recorded there`);
        return { copy: standing, built: false };
      }
      // Every refusal above is this call's own, so a second caller is told the same thing about its own `force`
      // rather than inheriting a build it would have refused; what is joined is the build itself.
      const key = copyKey(place, name);
      const running = copyBuilds.get(key);
      o.starting?.();
      if (running !== undefined) return running;
      const run = buildCopy({ place, where, at, name, record, ...(o.signal !== undefined ? { signal: o.signal } : {}) })
        .catch((e: unknown) => {
          // Not every road out of a build frames its failure, and a building frame left standing reads building for
          // good on the row and the card and is put back by the computer's next link.
          if (copyRows.get(place)?.stopped === false) frameStopped(place, name, placeAway(place) || isPlaceAbsent(e) ? placeWentAwayLine(where) : e);
          throw e;
        })
        .finally(() => copyBuilds.delete(key));
      copyBuilds.set(key, run);
      return run;
    },

    async keepCurrent(place, name) {
      const key = name ?? "default";
      // A computer that is not connected owes nothing now: a fork there builds its copy. Read before anything is
      // composed or framed, so no row says a build stopped that never started, and read again on a failure, since
      // the link going mid-ask is a laptop sleeping.
      const before = copyRows.get(place);
      try {
        await ctx.ready();
        if ((await ctx.recordOf(key)) === undefined || placeAway(place)) return;
        // A place that builds no copy at all owes none: a provider that forks nothing, a computer that keeps no disk.
        const { at } = await ctx.placeAt(place);
        if (!buildsImages(at.capabilities)) return;
        // A build joined here may have been sealing an older record; the copy it leaves is stamped with the record
        // it was built from, so it reads stale against the record as it stands now and is built once more.
        for (;;) {
          const built = await image.build({ place, name: key });
          const record = await ctx.recordOf(key);
          if (record === undefined || copyIsCurrent(record, built.copy)) return;
        }
      } catch (e) {
        // A build that already framed its stop has said it; a refusal before any build is said here, and stands
        // until the next build there takes the row over.
        const now = copyRows.get(place);
        if (now !== before && now?.stopped === true) return;
        if (rowSaysFailure(place, e)) frameStopped(place, key, e);
      }
    },
  };

  /** One copy built at one place: the record's vault landed on a fresh builder there and sealed under the record's
   * hash. Called once every refusal has passed and only while no build for the same place and name is in flight. */
  const buildCopy = async (o: { place: string; where: string; at: MachineBackend; name: string; record: SealedImage; signal?: AbortSignal }): Promise<SealedImageBuilt> => {
    const { place, where, at, name, record } = o;
    // Read before the blob and before a builder is asked for: a record with no path list cannot have its archive
    // judged anywhere, and an archive carrying a member the seal never asked for boots nothing here.
    if (record.vault !== undefined && record.vault.held === undefined) throw conflict(vaultUnlistedRefusal(name, record.version));
    const tar = record.vault === undefined ? undefined : await store.getBlob(IMAGE_VAULTS, vaultKey(name, record.version));
    if (record.vault !== undefined && tar === undefined) throw conflict(`the vault of ${name} v${record.version} is not on this computer any more; cut the next version to take it again`);
    if (tar !== undefined && record.vault?.held !== undefined) {
      try {
        refuseForeignMembers("import", tar, record.vault.held);
      } catch (e) {
        throw conflict(e instanceof Error ? e.message : String(e));
      }
    }
    const recipe = await ctx.copyRecipeOrThrow()(record);
    const view = await ctx.golden.prepare({ name, place, copy: true, recipe, ...(o.signal !== undefined ? { signal: o.signal } : {}) });
    const entry = builders.get(view.id);
    if (entry === undefined) throw new Error(`the builder ${view.id} prepared at ${where} left no record here; nothing was sealed`);
    const stage = ctx.stageOf(name, place, true);
    try {
      // The person's sign-ins land before the seal and after everything the recipe installs, so the copy holds
      // what the builder at the wired place held and no sign-in is run here.
      if (tar !== undefined) {
        stage("uploading-files", `the image's sign-ins, ${fmtBytes(tar.length)}`);
        await importImageVault(entry.builder.machine, tar);
      }
    } catch (e) {
      await killUntilGone(at, entry.builder.machine, opts.killConfirm).catch(() => {});
      await ctx.forgetIfGone(entry, at);
      stage("failed", e instanceof Error ? e.message : String(e));
      throw e;
    }
    const sealed = await ctx.sealEntry(entry, false, record.logins, record);
    const copy = (await copiesOf(name)).find(c => c.place === place);
    if (copy === undefined) throw new Error(`${where} sealed ${name} v${sealed.version.version} and no copy of it was recorded there`);
    return { copy, built: true };
  };

  /** The image whose head, at the place its own seal stands, is this snapshot: the one a fork's copy is looked up by.
   * Nothing for a project golden or a version that is no longer the head. */
  const imageHeadNamed = async (snapshotId: string): Promise<string | undefined> => {
    for (const raw of await store.list(IMAGES)) {
      const image = raw as SealedImage;
      if (goldenHead(await ctx.copyOf(image.place ?? places.wired, image.name))?.snapshotId === snapshotId) return image.name;
    }
    return undefined;
  };

  /** The snapshot a fork names at the place it lands on. A place that is not the image's own forks its own copy: the
   * one a build running there seals, which the create waits for, or the one standing there on the record. A caller
   * that can say so before anything bills has a place holding no current copy build one first, through the same
   * build a press starts; everywhere else the snapshot asked for goes through as it is. */
  const copyForFork = async (golden: string, placeId: string | undefined, announce?: (where: string, rateUsdPerHour: number) => void): Promise<string> => {
    const place = placeId ?? places.wired;
    const name = await imageHeadNamed(golden);
    if (name === undefined || place === (await ctx.imagePlace(name))) return golden;
    if (announce === undefined) {
      const built = await copyBuilds.get(copyKey(place, name))?.catch(() => undefined);
      if (built !== undefined) return built.copy.snapshotId;
    }
    const record = await ctx.recordOf(name);
    if (record === undefined) return golden;
    const held = goldenHead(await ctx.copyOf(place, name));
    if (held !== undefined && copyIsCurrent(record, { hash: held.imageHash })) return held.snapshotId;
    if (announce === undefined) return golden;
    const { at } = await ctx.placeAt(place);
    if (!buildsImages(at.capabilities)) return golden;
    const starting = (): void => announce(ctx.placeName(place), at.pricing.rateUsdPerHour(at.pricing.defaultSize));
    return (await image.build({ place, name, starting })).copy.snapshotId;
  };
  return { conflict, image, copyForFork };
}
