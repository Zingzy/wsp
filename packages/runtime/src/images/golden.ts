// SPDX-License-Identifier: AGPL-3.0-only
import {
  DAEMON_PORT,
  BUILDER_LABEL,
  CREATED_AT_LABEL,
  OWNER_LABEL,
  SMOKE_LABEL,
  WSP_LABEL,
  buildGolden,
  goldenHead,
  isMissing,
  killUntilGone,
  snapshotUntilGone,
  answerOf,
  prepareBuilder,
  refreshPreviewToken,
  promoteVersion,
  goldenName,
  splitByOwner,
  snapshotMonthlyUsd,
  templatesOf,
  applyDelta,
  applyGoldenImport,
  upgradeBuilder,
  nextSetupSha,
  type Builder,
  type GoldenImport,
  type GoldenManifest,
  type GoldenVersion,
  type Machine,
  type MachineBackend,
  type SnapshotRow,
  type TemplateRow,
  retentionPlan,
  rollback as rollbackGolden,
  snapshotStorage,
} from "@wsp/engine";
import type { GoldenBuilderView } from "@wsp/protocol";
import {
  forksNoMachines,
  ALREADY_APPLIED,
  notFoundRefusal,
  buildPlaceAskLine,
  NO_BUILD_PLACE_LINE,
  noProjectImageLine,
  projectImageInUseRefusal,
  projectImageRefusedLine,
  projectImageStillListedLine,
} from "@wsp/protocol";
import { PlaceForksNowhereError } from "../places.js";
import type { Runtime, OrphansDeleted } from "../types/api.js";
import {
  PROJECT_GOLDENS,
  copyKey,
  BUILDERS,
  HELD_TTL_MS,
  type LiveBuilder,
  PrepareStoppedError,
} from "../types/internal.js";
import type { RuntimeContext, GoldenArea } from "../context.js";
import type { GoldenPromotion } from "../types/wiring.js";

export function goldenArea(ctx: RuntimeContext): GoldenArea {
  const { opts, backend, store, placeDoor, clock, builders, preparing, places } = ctx;
  const golden: Runtime["golden"] = {
    async build(o) {
      await ctx.ready();
      const { name, ...build } = o;
      const key = name ?? "default";
      const prior = await ctx.copyOf(places.wired, key);
      const result = await ctx.claiming(`golden/${key}`, b =>
        buildGolden({
          ...build,
          backend: b,
          name: key,
          hostId: ctx.imageMark(),
          labels: { ...build.labels, [WSP_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
        }),
      );
      await ctx.putCopy(places.wired, key, result.manifest);
      return { manifest: result.manifest, version: result.version };
    },
    async get(name) {
      await ctx.ready();
      const key = name ?? "default";
      return ctx.copyOf(await ctx.imagePlace(key), key);
    },

    async buildPlace(word) {
      await ctx.ready();
      const runs = (place: string, at: MachineBackend): { place: string; name: string; backend: MachineBackend } => {
        const name = ctx.placeName(place);
        if (forksNoMachines(at.capabilities)) throw Object.assign(new PlaceForksNowhereError(`${name} forks no machines, so your image cannot be built there`), { kind: "conflict" });
        return { place, name, backend: at };
      };
      // A rebuild seals over the record, so building it anywhere else would move the image's home.
      const target = (await ctx.recordOf("default")) !== undefined ? await ctx.imagePlace("default") : word;
      if (target !== undefined) {
        const { place, at } = await ctx.placeAt(target);
        return runs(place, at);
      }
      // The default place first, since it is where every fork that names none lands; where it runs no workspaces, the
      // one other place that does. None at all and more than one are each their own refusal: the run does not guess.
      const marked = (await placeDoor?.defaultPlace()) ?? {};
      try {
        return marked.placeId === undefined ? runs(places.wired, ctx.backendAt(places.wired)) : runs(marked.placeId, await placeDoor!.forkingBackend(marked.placeId));
      } catch (e) {
        // Only a place that runs no workspaces is passed over. A link down or a frame unanswered on the place the
        // person marked is theirs to read, with that place's name in it, never a build sent somewhere else.
        if (!(e instanceof PlaceForksNowhereError)) throw e;
      }
      const running = await ctx.buildPlaces();
      if (running.length === 0) throw ctx.conflict(NO_BUILD_PLACE_LINE);
      if (running.length > 1) throw ctx.conflict(buildPlaceAskLine(running.map(r => r.name)));
      return running[0]!;
    },

    async prepare(o) {
      await ctx.ready();
      const recipe = ctx.recipeOrThrow(o?.recipe);
      const name = o?.name ?? "default";
      const signal = o?.signal;
      const { deployDaemon, smoke, import: imp, ...size } = recipe;
      void smoke;
      // A seal over a standing record files it where the builder was made, so the image's own build goes to the
      // record's place whatever was asked, and only a copy is built anywhere else.
      const asked = o?.copy !== true && (await ctx.recordOf(name)) !== undefined ? await ctx.imagePlace(name) : o?.place;
      const { place, at } = asked === undefined ? { place: places.wired, at: ctx.backendAt(places.wired) } : await ctx.placeAt(asked);
      // Per place as well as per name: a copy building at one place and the image building at another are two
      // prepares of one golden, and neither is the other's to join.
      const preparingKey = copyKey(place, name);
      const active = preparing.get(preparingKey);
      if (active !== undefined) {
        if (active.hash === imp?.recipeHash) return active.promise;
        throw new Error(`a builder named ${name} is still being prepared for a different recipe; wait for it to finish, then run again`);
      }
      const stage = ctx.stageOf(name, place, o?.copy === true);
      const run = ctx.claiming(`builder/${preparingKey}`, async b => {
        await ctx.refreshBuilders();
        // A builder with a seal still in it carrying the same ticks is attached to instead of
        // booting a second one, whichever process made it; the stages skip on its
        // ledger. A stale, foreign or held record is never reused, and a recipe with no
        // import never attaches: nothing says which ticks the builder carries. The
        // building check is a second wall: the join above holds it in this process,
        // life does across processes.
        const same = imp === undefined ? undefined : [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.building !== true && x.record.sealed === undefined && x.record.name === name && (x.record.place ?? places.wired) === place && x.record.import?.recipeHash === imp.recipeHash);
        // The machine this prepare has, attached to or made. A stop kills a made one by its recorded id and drops the
        // record; an attached one still has a seal in it and maybe an earlier run's sign-ins, so its hold is released and
        // its record stays reusable.
        let mine: LiveBuilder | undefined;
        let creating: Promise<Machine> | undefined;
        let stopping: Promise<PrepareStoppedError> | undefined;
        const warn = (what: string) => (e: unknown) => console.warn(`${what}: ${e instanceof Error ? e.message : String(e)}`);
        const stop = async (): Promise<PrepareStoppedError> => {
          // A create still in flight lands first: a stop that gave up sooner would leak the machine it returns.
          await creating?.catch(() => {});
          if (mine === undefined) return new PrepareStoppedError();
          const id = mine.record.id;
          if (mine === same) {
            delete mine.record.heldBy;
            mine.life = "reusable";
            await store.put(BUILDERS, id, mine.record).catch(warn(`hold on builder ${id} not released; it ages out in ${HELD_TTL_MS / 60_000} minutes`));
            return new PrepareStoppedError(id, { kept: true });
          }
          try {
            await killUntilGone(at, mine.builder.machine, opts.killConfirm);
          } catch (e) {
            return new PrepareStoppedError(id, { left: e instanceof Error ? e.message : String(e) });
          }
          await ctx.forgetBuilder(id).catch(warn(`record of builder ${id} not dropped; the machine is gone and the next load drops it`));
          return new PrepareStoppedError(id);
        };
        let wake: () => void = () => {};
        const stopped = new Promise<void>(r => {
          wake = r;
        });
        const onAbort = (): void => {
          stopping ??= stop().finally(wake);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        // Once a stop has begun its word is the answer, whatever the work did meanwhile: the work runs on against a
        // machine that is going or released, and neither its result nor its rejection reaches the caller.
        const raced = async <T>(work: Promise<T>): Promise<T> => {
          await Promise.race([work.then(() => {}, () => {}), stopped]);
          if (stopping !== undefined) throw await stopping;
          return work;
        };
        const attach = async (same: LiveBuilder, ledger: GoldenImport): Promise<GoldenBuilderView> => {
          try {
            stage("creating", ALREADY_APPLIED);
            stage("deploying-daemon", ALREADY_APPLIED);
            const applied = await applyGoldenImport(same.builder.machine, { import: ledger, setup: recipe.setup, ...(same.record.import !== undefined ? { ledger: same.record.import } : {}), onStage: stage });
            // A complete ledger only re-imports the volatile files, and that never fails the apply, so this no-op is what
            // proves the machine outlived the earlier process.
            const alive = await same.builder.machine.exec("true");
            if (alive.exitCode !== 0) throw new Error(`the builder answered exit ${alive.exitCode} to a no-op; it is not serving`);
            // A stop that came while the apply ran released the hold; nothing here takes it back.
            if (stopping !== undefined) throw await stopping;
            same.record.import = applied.ledger;
            same.life = "own";
            same.recipe = recipe;
            await ctx.hold(same);
          } catch (e) {
            if (stopping !== undefined) throw e;
            // Same road as a fresh builder that fails its stages: the machine goes, the person starts over.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(at, same.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await ctx.forgetIfGone(same, at);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          return ctx.builderView(same.record, same);
        };
        const fresh = async (): Promise<GoldenBuilderView> => {
          let builder: Builder;
          try {
            builder = await prepareBuilder({
              backend: ctx.recordingCreates(b, name, imp, p => (mine = p), { signal, began: c => (creating = c) }, place),
              ...size,
              ...(o?.kind !== undefined ? { kind: o.kind } : {}),
              ...(deployDaemon !== undefined ? { deployDaemon } : {}),
              ...(imp !== undefined ? { import: imp } : {}),
              labels: ctx.builderLabels(recipe.labels),
              onStage: stage,
            });
          } catch (e) {
            // prepareBuilder tried to kill the machine on its way out; the placeholder goes only where it is gone. After a stop the record is the stop's.
            if (mine !== undefined && stopping === undefined) await ctx.forgetIfGone(mine, at);
            throw e;
          }
          // A last exec that outran the kill must not leave a finished record for a machine the stop is killing.
          if (stopping !== undefined) throw await stopping;
          const entry = await ctx.settleBuilder(name, builder, mine, place);
          entry.recipe = recipe;
          return ctx.builderView(entry.record, entry);
        };
        try {
          if (same && imp) {
            mine = same;
            return await raced(attach(same, imp));
          }
          return await raced(fresh());
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }, at).finally(() => preparing.delete(preparingKey));
      preparing.set(preparingKey, { hash: imp?.recipeHash, promise: run });
      return run;
    },

    async seal(builderId, o) {
      await ctx.ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      ctx.refuseUntouchable(entry);
      // A builder built from a recipe is what an update can land on; a bare one has no recipe to diff.
      return ctx.sealEntry(entry, o?.keepBuilder !== false && entry.record.import?.recipe !== undefined, o?.logins);
    },

    async recipe(name) {
      await ctx.ready();
      const key = name ?? "default";
      const place = await ctx.imagePlace(key);
      const manifest = await ctx.copyOf(place, key);
      if (manifest === undefined) return undefined;
      return ctx.copyRecipeOf(place, key, manifest.head);
    },

    async upgrade(o) {
      await ctx.ready();
      const recipe = ctx.recipeOrThrow(o.recipe);
      const name = o.name ?? "default";
      // The update lands where the image's own seal stands, on that place's backend.
      const place = await ctx.imagePlace(name);
      const prior = await ctx.copyOf(place, name);
      const head = goldenHead(prior);
      if (head === undefined) throw new Error(`no golden named "${name}" to update; wsp init builds one`);
      const at = ctx.backendAt(place);
      const stage = ctx.stageOf(name, place);
      // The head's digest, whose pins the rows the delta leaves alone keep on the next version's record.
      const previousRecipe = await ctx.copyRecipeOf(place, name, head.version);
      // Past its window a kept builder is never used, running or not: it is stopped here and the update forks; one
      // the pass could not stop is named so the person knows it still bills. Inside the window, it is suspended for
      // the update's length: the record loses `sealed` and gains `building` before the first exec, so neither the
      // timer nor a sweep stops the machine mid-stage, and a process that dies here leaves a record the next one
      // stops as unfinished; the seal re-arms the window.
      const swept = await ctx.expireGrace();
      for (const f of swept.failed) stage("creating", `an earlier kept builder ${f.id}: ${f.message}`);
      await ctx.refreshBuilders();
      const kept = [...builders.values()].find(x => (x.life === "own" || x.life === "reusable") && x.record.name === name && (x.record.place ?? places.wired) === place && x.record.sealed?.version === head.version && ctx.inWindow(x.record.sealed.at));
      let entry: LiveBuilder | undefined;
      if (kept !== undefined) {
        ctx.graceTimers.get(kept.record.id)?.();
        ctx.graceTimers.delete(kept.record.id);
        delete kept.record.sealed;
        kept.record.building = true;
        await store.put(BUILDERS, kept.record.id, kept.record);
        const alive = await kept.builder.machine.exec("true").then(r => r.exitCode === 0, () => false);
        if (!alive) {
          // A machine that does not answer may still bill: it is killed until the provider says gone, then forgotten.
          await killUntilGone(at, kept.builder.machine, opts.killConfirm);
          await ctx.forgetBuilder(kept.record.id);
        } else {
          stage("creating", `your builder from v${head.version}, kept since the save`);
          try {
            const applied = await applyDelta(kept.builder.machine, o.delta, { setup: recipe.setup, previousSmoke: head.smoke.cmd, previousBase: head.base, ...(head.missingTools !== undefined ? { previousMissing: head.missingTools } : {}), ...(head.leftBehind !== undefined ? { previousLeftBehind: head.leftBehind } : {}), ...(previousRecipe !== undefined ? { previousRecipe } : {}), onStage: stage });
            const setupSha = nextSetupSha(head.setupSha, recipe.setup, o.delta.import);
            kept.record.import = applied.ledger;
            kept.record.setupSha = setupSha;
            delete kept.record.building;
            // The builder was sealed as the head, so the version it seals next descends from the head's snapshot.
            kept.builder = { ...kept.builder, import: applied.ledger, setupSha, parentSnapshotId: head.snapshotId, retired: o.delta.retiredOnImage };
            kept.life = "own";
            await ctx.hold(kept);
          } catch (e) {
            // Same road as a fresh builder that fails its stages: the machine goes, the golden stays as it was.
            let detail = e instanceof Error ? e.message : String(e);
            await killUntilGone(at, kept.builder.machine, opts.killConfirm).catch((k: unknown) => {
              detail += `; ${k instanceof Error ? k.message : String(k)}`;
            });
            await ctx.forgetIfGone(kept, at);
            stage("failed", detail);
            throw e;
          }
          stage("ready");
          entry = kept;
        }
      }
      const road = entry !== undefined ? "builder" : "fork";
      entry ??= await ctx.claiming(
        `builder/${name}`,
        async b => {
          let placeholder: LiveBuilder | undefined;
          let builder: Builder;
          try {
            builder = await upgradeBuilder({
              backend: ctx.recordingCreates(b, name, o.delta.import, p => (placeholder = p), undefined, place),
            head,
            delta: o.delta,
              setup: recipe.setup,
              ...(previousRecipe !== undefined ? { previousRecipe } : {}),
              ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
              ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
              ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
              labels: ctx.builderLabels(recipe.labels),
              onStage: stage,
            });
          } catch (e) {
            // upgradeBuilder tried the kill on its way out; the placeholder goes only where the machine is gone.
            if (placeholder !== undefined) await ctx.forgetIfGone(placeholder, at);
            throw e;
          }
          return ctx.settleBuilder(name, builder, placeholder, place);
        },
        at,
      );
      entry.recipe = recipe;
      // The update keeps the golden's disk, so what was signed in stays signed in: the caller passes the previous
      // version's outcomes, with the rows it re-imported as copies rewritten.
      const sealed = await ctx.sealEntry(entry, true, o.logins);
      let manifest = sealed.manifest;
      let previousDropped = false;
      let builderKept = sealed.builderKept;
      // A version with workspaces still on it stays for them: a rebuild boots them from its image, which the provider
      // would delete under a template's forks (they hold no dependency on it).
      const standing = ctx.forkedFrom(head.snapshotId);
      if (o.keepPrevious === false) {
        if (standing.length > 0) {
          console.warn(`golden ${name} v${head.version} kept: ${standing.join(", ")} still on it`);
        } else {
          // A snapshot with live forks under it cannot be deleted (409 on Solari): the builder forked from it goes
          // first, window or not.
          if (road === "fork" && builderKept) {
            ctx.graceTimers.get(entry.record.id)?.();
            ctx.graceTimers.delete(entry.record.id);
            await killUntilGone(at, entry.builder.machine, opts.killConfirm);
            await ctx.forgetBuilder(entry.record.id);
            builderKept = false;
          }
          try {
            await ctx.dropImage(head, at);
            manifest = { ...manifest, versions: manifest.versions.filter(v => v.version !== head.version) };
            await ctx.putCopy(place, name, manifest);
            await ctx.dropCopyRecipe(place, name, head.version);
            previousDropped = true;
          } catch (e) {
            console.warn(`golden ${name} v${head.version} kept: its snapshot was not deleted (${e instanceof Error ? e.message : String(e)})`);
          }
        }
      }
      return { manifest, version: sealed.version, road, previousDropped, builderKept };
    },


    async builderReach(builderId) {
      await ctx.ready();
      const entry = builders.get(builderId);
      if (!entry) throw new Error(`no such builder: ${builderId}`);
      ctx.refuseUntouchable(entry);
      const reach = await refreshPreviewToken(entry.builder.machine, DAEMON_PORT, entry.reach);
      entry.reach = reach;
      const daemonToken = await ctx.daemonTokenOf(entry.builder.machine);
      return { url: reach.url, expiresAt: reach.expiresAt, ...(daemonToken !== undefined ? { daemonToken } : {}) };
    },

    async builders() {
      await ctx.ready();
      return [...builders.values()].map(b => ctx.builderView(b.record, b));
    },

    async kill(builderId) {
      await ctx.ready();
      await ctx.refreshBuilders();
      const entry = builders.get(builderId);
      // A machine of this setup no builder record claims: a seal's smoke fork whose rollback could not reach the
      // provider. Only this state file's own builder or smoke fork is taken, by the labels the create stamped, so
      // neither another host's machine nor a workspace of this one is ever killed here; a provider that cannot be
      // read keeps its own reason, which is what a caller retrying reads.
      if (!entry) {
        const machine = await backend.get(builderId).catch((e: unknown) => {
          if (isMissing(e)) return undefined;
          throw e;
        });
        const labels = machine?.labels;
        const mine = labels?.[OWNER_LABEL] === ctx.state.owner && (labels[BUILDER_LABEL] === "1" || labels[SMOKE_LABEL] === "1");
        if (!mine || machine === undefined) throw new Error(`no such builder: ${builderId}`);
        await killUntilGone(backend, machine, opts.killConfirm);
        return;
      }
      // A record its dead holder left mid-setup is stopped here as the sweep would stop it; only seal and reach need finished stages.
      if (entry.life === "foreign" || entry.life === "held") ctx.refuseUntouchable(entry);
      await killUntilGone(backend, entry.builder.machine, opts.killConfirm);
      await ctx.forgetBuilder(builderId);
    },

    async storage() {
      await ctx.ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      return snapshotStorage(await backend.listSnapshots(), backend.pricing.snapshotStorage, { hostId: ctx.imageMark(), recorded: await ctx.recordedImages(), now: clock.now() });
    },

    async orphans() {
      await ctx.ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const read = { hostId: ctx.imageMark(), recorded: await ctx.recordedImages(), now: clock.now() };
      const rows = await backend.listSnapshots();
      const snapshots = splitByOwner(rows, read);
      const templates = templatesOf(backend);
      const listed = templates === undefined ? [] : await templates.list();
      const promoted = splitByOwner(listed, read);
      const bytesOf = (part: readonly SnapshotRow[]): number => part.reduce((n, r) => n + r.sizeBytes, 0);
      const totalBytes = bytesOf(rows);
      const freedBytes = bytesOf(snapshots.orphans);
      const pricing = backend.pricing.snapshotStorage;
      return {
        snapshots: snapshots.orphans,
        templates: promoted.orphans,
        freedBytes,
        savesUsdPerMonth: snapshotMonthlyUsd(totalBytes, pricing) - snapshotMonthlyUsd(totalBytes - freedBytes, pricing),
        others: { snapshots: snapshots.foreign, templates: promoted.foreign },
      };
    },

    async deleteOrphans() {
      const plan = await golden.orphans();
      if (plan === undefined) return undefined;
      const deleted: OrphansDeleted = { snapshots: [], templates: [], failed: [] };
      // The plan names templates only on a backend that has them, so the road exists wherever the loop runs.
      const templates = templatesOf(backend);
      const named = (row: SnapshotRow | TemplateRow): { id: string; name?: string } => ({ id: row.id, ...(row.name !== undefined ? { name: row.name } : {}) });
      if (templates !== undefined) {
        for (const t of plan.templates) {
          try {
            await templates.delete(t.id);
            deleted.templates.push(t);
          } catch (e) {
            deleted.failed.push({ ...named(t), message: e instanceof Error ? e.message : String(e) });
          }
        }
      }
      for (const row of plan.snapshots) {
        try {
          await backend.deleteSnapshot(row.id);
          deleted.snapshots.push(row);
        } catch (e) {
          // A snapshot the provider already lost is gone either way, which is what the caller asked for.
          if (isMissing(e)) {
            deleted.snapshots.push(row);
            continue;
          }
          deleted.failed.push({ ...named(row), message: e instanceof Error ? e.message : String(e) });
        }
      }
      return deleted;
    },

    async retention(name) {
      await ctx.ready();
      if (!backend.capabilities.snapshotListing || backend.listSnapshots === undefined) return undefined;
      const manifest = await ctx.copyOf(places.wired, name ?? "default");
      if (manifest === undefined) return undefined;
      return retentionPlan(manifest, await backend.listSnapshots(), ctx.forkedFrom, backend.pricing.snapshotStorage);
    },

    async prune(name) {
      const key = name ?? "default";
      const plan = await golden.retention(key);
      const dropped: GoldenVersion[] = [];
      const failed: { version: number; message: string }[] = [];
      if (plan === undefined) return { dropped, failed };
      for (const v of plan.drop) {
        try {
          await ctx.dropImage(v);
        } catch (e) {
          // A snapshot the provider already lost is gone either way; its version goes with it.
          if (!isMissing(e)) {
            failed.push({ version: v.version, message: e instanceof Error ? e.message : String(e) });
            continue;
          }
        }
        const manifest = (await ctx.copyOf(places.wired, key))!;
        await ctx.putCopy(places.wired, key, { ...manifest, versions: manifest.versions.filter(x => x.version !== v.version) });
        await ctx.dropCopyRecipe(places.wired, key, v.version);
        dropped.push(v);
      }
      return { dropped, failed };
    },

    async rollback(version, name) {
      const key = name ?? "default";
      const missing = (message: string) => Object.assign(new Error(message), { kind: "missing" });
      const prior = await ctx.copyOf(places.wired, key);
      if (!prior) throw missing(`no golden named "${key}"`);
      let next: GoldenManifest;
      try {
        next = rollbackGolden(prior, version);
      } catch (e) {
        throw missing(e instanceof Error ? e.message : String(e));
      }
      await ctx.putCopy(places.wired, key, next);
      return next;
    },

    async promote(name) {
      await ctx.ready();
      const templates = templatesOf(backend);
      if (templates === undefined) return undefined;
      const key = name ?? "default";
      const manifest = await ctx.copyOf(places.wired, key);
      const rows: GoldenPromotion[] = [];
      for (const v of manifest?.versions ?? []) {
        if (v.templateId !== undefined) continue;
        try {
          const { templateId, sharing } = await promoteVersion(templates, v.snapshotId, goldenName(ctx.imageMark(), key, v.version));
          const current = await ctx.copyOf(places.wired, key);
          if (current === undefined) throw new Error(`golden ${key} was dropped while its versions were being promoted`);
          await ctx.putCopy(places.wired, key, { ...current, versions: current.versions.map(x => (x.version === v.version ? { ...x, templateId } : x)) });
          rows.push({ golden: key, version: v.version, templateId, ...(sharing !== undefined ? { sharing } : {}) });
        } catch (e) {
          rows.push({ golden: key, version: v.version, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return rows;
    },

    async projects() {
      await ctx.ready();
      return (await store.list(PROJECT_GOLDENS)).map(ctx.projectGoldenOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async removeProject(snapshotId) {
      await ctx.ready();
      const stored = await store.get(PROJECT_GOLDENS, snapshotId);
      if (stored === undefined) throw notFoundRefusal(noProjectImageLine(snapshotId));
      const projectGolden = ctx.projectGoldenOf(stored);
      const standing = ctx.forkedFrom(snapshotId);
      if (standing.length > 0) throw ctx.conflict(projectImageInUseRefusal(snapshotId, standing));
      const at = ctx.backendAt(projectGolden.place ?? places.wired);
      const read = await snapshotUntilGone(at, snapshotId, opts.killConfirm).catch((e: unknown) => {
        const { kind, status } = e as { kind?: unknown; status?: unknown };
        throw Object.assign(new Error(projectImageRefusedLine(snapshotId, answerOf(e))), kind !== undefined ? { kind } : {}, status !== undefined ? { status } : {});
      });
      if (read.verdict === "listed") throw new Error(projectImageStillListedLine(snapshotId, read.graceMs));
      await store.delete(PROJECT_GOLDENS, snapshotId);
      return { projectGolden, alreadyGone: read.verdict === "missing" };
    },

  };
  return { golden };
}
