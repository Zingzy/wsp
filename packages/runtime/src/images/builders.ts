// SPDX-License-Identifier: AGPL-3.0-only
import { catalogIdOfRow } from "@wsp/catalog";
import {
  NotFirstLifeError,
  SnapshotFailedError,
  BUILDER_LABEL,
  CREATED_AT_LABEL,
  OWNER_LABEL,
  SMOKE_LABEL,
  WSP_LABEL,
  imageHash,
  isMissing,
  killUntilGone,
  readGone,
  sealGolden,
  templatesOf,
  type Builder,
  type GoldenImport,
  type SealResult,
  type GoldenVersion,
  type Machine,
  type MachineBackend,
  type ReapFailure,
  type ReapedMachine,
} from "@wsp/engine";
import type { GoldenBuilderView, GoldenLogin, GoldenStage, GoldenStep, SealedImage, SealedVault } from "@wsp/protocol";
import {
  recipePins,
  forksNoMachines,
  NO_PROVIDER_LINE,
  isJoinedComputer,
  noSuchPlaceRefusal,
  placeBuildsNoImageLine,
  placeForksNothingPickLine,
} from "@wsp/protocol";
import { type GoldenRecipe, GRACE_MS } from "../types/wiring.js";
import {
  IMAGES,
  NO_COPY_RECIPE,
  IMAGE_VAULTS,
  copyKey,
  vaultKey,
  BUILDERS,
  HEARTBEAT_MS,
  type BuilderRecord,
  type LiveBuilder,
  PrepareStoppedError,
  type StageFrame,
} from "../types/internal.js";
import type { RuntimeContext, BuildersArea } from "../context.js";

export function buildersArea(ctx: RuntimeContext): BuildersArea {
  const { opts, backend, store, placeDoor, bus, clock, hostId, builders, gone, stageAt, places } = ctx;
  const builderView = (r: BuilderRecord, b: LiveBuilder): GoldenBuilderView => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    createdAt: r.createdAt,
    size: r.size,
    ...(r.streamUrl !== undefined ? { screen: { streamUrl: r.streamUrl } } : {}),
    sealable: b.sealable,
    ...(r.import !== undefined ? { recipeHash: r.import.recipeHash } : {}),
    ...(r.import?.recipe !== undefined ? { recipe: r.import.recipe } : {}),
    ...(b.life === "foreign" ? { foreignOwner: b.builder.machine.labels?.[OWNER_LABEL] ?? "" } : {}),
    ...(b.life === "held" && r.heldBy !== undefined ? { heldBy: r.heldBy } : {}),
    ...(r.building === true ? { building: true } : {}),
    ...(r.sealed !== undefined ? { sealed: r.sealed } : {}),
  });

  /** One timer per kept builder, so the grace ends on time inside a process; the sweep is the road across processes. */
  const graceTimers = new Map<string, () => void>();
  const armGrace = (id: string, sealedAt: string): void => {
    graceTimers.get(id)?.();
    const left = Math.max(0, GRACE_MS - (clock.now() - Date.parse(sealedAt)));
    graceTimers.set(id, clock.schedule(() => {
      graceTimers.delete(id);
      void expireGrace().catch((e: unknown) => console.warn(`grace sweep failed: ${e instanceof Error ? e.message : String(e)}`));
    }, left, { unref: true }));
  };
  /** True while a kept builder's window is still open by our clock. */
  const inWindow = (sealedAt: string): boolean => {
    const ageMs = clock.now() - Date.parse(sealedAt);
    return !Number.isNaN(ageMs) && ageMs < GRACE_MS;
  };
  let expiring: Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> | undefined;
  /** Stops every kept builder whose window is over, each on its own: a kill that fails is reported and the record
   * kept for the next sweep. A builder another process holds is that process's to stop. One pass at a time: two
   * timers falling due together, or a timer beside a sweep, must not both kill and forget the same builder. */
  const expireGrace = (): Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> => (expiring ??= expireGraceNow().finally(() => (expiring = undefined)));
  const expireGraceNow = async (): Promise<{ reaped: ReapedMachine[]; failed: ReapFailure[] }> => {
    await ctx.refreshBuilders();
    const reaped: ReapedMachine[] = [];
    const failed: ReapFailure[] = [];
    for (const b of [...builders.values()]) {
      if (b.record.sealed === undefined || !(b.life === "own" || b.life === "reusable") || inWindow(b.record.sealed.at)) continue;
      try {
        await gone.stop(backend, b.builder.machine);
      } catch (e) {
        failed.push({ id: b.record.id, message: `could not stop: ${e instanceof Error ? e.message : String(e)}; stays recorded, retried next sweep` });
        continue;
      }
      graceTimers.get(b.record.id)?.();
      graceTimers.delete(b.record.id);
      await forgetBuilder(b.record.id);
      reaped.push({ id: b.record.id, builder: true, reason: "grace", ageMs: clock.now() - Date.parse(b.record.sealed.at) });
    }
    return { reaped, failed };
  };
  const arm = (): void => {
    if (ctx.state.closed || ctx.state.beat !== undefined) return;
    ctx.state.beat = clock.schedule(
      () => {
        ctx.state.beat = undefined;
        ctx.state.ticking = tick();
      },
      HEARTBEAT_MS,
      { unref: true },
    );
  };
  // One failed write costs one beat, never the timer: the hold is what keeps other processes off the builder.
  const tick = async (): Promise<void> => {
    const own = [...builders.values()].filter(x => x.life === "own");
    for (const b of own) {
      await hold(b).catch((e: unknown) => console.warn(`heartbeat for builder ${b.record.id} not written: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (own.length > 0) arm();
  };
  // The record is written whatever the runtime's state, so a prepare that finishes after close() leaves a finished
  // record and not a placeholder; the hold stamp and its timer are this process's and stop with it. A caller that
  // closes while a prepare still runs leaves the placeholder unheld until its stages finish; none does today.
  const hold = async (b: LiveBuilder): Promise<void> => {
    // A record forgotten while a heartbeat was in flight must not come back: the write is skipped for a builder no longer live.
    if (builders.get(b.record.id) !== b) return;
    if (!ctx.state.closed) b.record.heldBy = { host: hostId, pid: process.pid, heartbeat: new Date().toISOString() };
    await store.put(BUILDERS, b.record.id, b.record);
    if (!ctx.state.closed) arm();
  };

  /** A record wearing another state file's label, or held by another live process, is listed and nothing else;
   * acting on it by id would touch a machine that is not this process's to touch. */
  const refuseUntouchable = (entry: LiveBuilder): void => {
    if (entry.life === "foreign") throw new Error(`${entry.record.id} wears another setup's owner label (${entry.builder.machine.labels?.[OWNER_LABEL]}); it is never sealed or reached from here`);
    if (entry.life === "held") throw new Error(`${entry.record.id} is in use by another wsp process (pid ${entry.record.heldBy?.pid}); it is never sealed or reached from here`);
    if (entry.record.building) throw new Error(`${entry.record.id} is still being prepared; it is never sealed or reached until its stages finish`);
  };

  const forgetBuilder = async (id: string): Promise<void> => {
    builders.delete(id);
    await store.delete(BUILDERS, id);
  };

  /** What a stopped build does with the record of the machine its rollback tried to take: only a machine the provider
   * answers gone for GONE_READS reads in a row loses its record. One that outlived the kill, or one the provider
   * could not be asked about, keeps it, since a machine still running that nothing points at bills until somebody
   * lists the account by hand; a kept record is what the next build attaches to and what the doctor sweeps. */
  const forgetIfGone = async (entry: LiveBuilder, at: MachineBackend): Promise<void> => {
    const gone = await readGone(at, entry.record.id).then(
      state => state === "gone",
      () => false,
    );
    if (gone) await forgetBuilder(entry.record.id);
  };

  /** The listener one build's stages ride out on. `on` is the computer the build runs on, which is what a gap in a
   * link is matched against; `named` is whether the frames carry it, since only a copy's build is a thing that
   * computer's row reports. */
  const stageOf =
    (name: string, on?: string, named = false) =>
    (stage: GoldenStage, detail?: string, step?: GoldenStep, left?: readonly string[]) => {
      const place = named ? on : undefined;
      const frame: StageFrame = { name, stage, ...(detail !== undefined ? { detail } : {}), ...(step !== undefined ? { step } : {}), ...(left !== undefined && left.length > 0 ? { left: [...left] } : {}) };
      // The three words a build's stages end on; past one of them nothing of this build is asking that computer
      // anything, so a gap in its link is no longer this build's to report.
      if (on !== undefined) {
        if (stage === "ready" || stage === "sealed" || stage === "failed") stageAt.delete(copyKey(on, name));
        else stageAt.set(copyKey(on, name), { place: on, name, named, frame });
      }
      bus.emit({ ...frame, type: "golden.stage", ...(place !== undefined ? { place } : {}) });
    };
  /** The backend a place id resolves to: a provider row, or a joined computer whose backend this host has heard. */
  const backendAt = (place: string): MachineBackend => {
    const at = places.backend(place) ?? placeDoor?.backendOf(place);
    if (at === undefined) throw Object.assign(new Error(noSuchPlaceRefusal(place, places.list())), { kind: "missing" });
    return at;
  };
  /** The place a word names, as the golden roads key it: a provider's id, or the id a joined computer's copies are
   * filed under, with the backend a builder there is made on. A joined computer's backend is asked of the computer
   * the first time and read off its record after. This computer is never built into, so its own name is refused
   * rather than read as the provider this host forks on, which a fork's road reads it as. */
  const placeAt = async (word: string): Promise<{ place: string; at: MachineBackend }> => {
    const own = places.backend(word);
    if (own !== undefined) return { place: word, at: own };
    if (placeDoor === undefined) return { place: word, at: backendAt(word) };
    let placeId: string | undefined;
    try {
      ({ placeId } = await placeDoor.placeFor(word));
    } catch (e) {
      throw Object.assign(e instanceof Error ? e : new Error(String(e)), { kind: "missing" });
    }
    if (placeId === undefined) throw ctx.conflict(placeBuildsNoImageLine(word));
    return { place: placeId, at: await placeDoor.forkingBackend(placeId) };
  };
  /** The backend a fork lands on, gated before any machine is asked for: a joined computer that forks nowhere refuses
   * with its doctor's reason, and a place that forks nothing refuses with NO_PROVIDER_LINE when no place here runs
   * workspaces, else naming the places that do, so nobody is sent to a provider they do not need. */
  const landingBackend = async (placeId: string | undefined): Promise<MachineBackend> => {
    const at = await forkingAt(placeId);
    if (at !== undefined) return at;
    const running = (await buildPlaces()).map(r => r.name);
    throw ctx.conflict(running.length === 0 ? (opts.noMachinesLine ?? NO_PROVIDER_LINE) : placeForksNothingPickLine(placeName(placeId ?? places.wired), running));
  };
  /** The backend a fork on that place would land on, or nothing where it forks nothing, with no refusal worded: the
   * refusal lists the places, and a list read while the records load waits on that load. */
  const forkingAt = async (placeId: string | undefined): Promise<MachineBackend | undefined> => {
    // The first fork on a joined computer is where this host learns what that computer forks with; every road after
    // it reads the answer off the place's record.
    if (placeId !== undefined) await ctx.placeDoorOf().forkingBackend(placeId);
    const at = ctx.backendOfKind("cloud", placeId);
    return forksNoMachines(at.capabilities) ? undefined : at;
  };
  const placeName = (place: string): string => placeDoor?.nameOf(place) ?? place;
  /** Where the image's own seal stands: the place the record names, or the provider this host forks on for a record
   * sealed before places. The manifest there is the one wsp init built and updates. */
  const imagePlace = async (name: string): Promise<string> => (await ctx.recordOf(name))?.place ?? places.wired;
  /** Every place an image can be built at: the provider rows that fork, and the joined computers whose daemon runs
   * workspaces, this computer left out since it is never forked into. */
  const buildPlaces = async (): Promise<{ place: string; name: string; backend: MachineBackend }[]> => {
    const rows: { place: string; name: string; backend: MachineBackend }[] = [];
    for (const id of places.list()) {
      const at = places.backend(id);
      if (at !== undefined && !forksNoMachines(at.capabilities)) rows.push({ place: id, name: id, backend: at });
    }
    if (placeDoor === undefined) return rows;
    for (const view of await placeDoor.list(clock.now())) {
      if (!isJoinedComputer(view)) continue;
      const at = await placeDoor.forkingBackend(view.id).catch(() => undefined);
      if (at !== undefined) rows.push({ place: view.id, name: view.name, backend: at });
    }
    return rows;
  };

  /** How a copy of the image is planned off the record. The runtime writes no recipe of its own, so a host that
   * wired none builds no copy anywhere, and every road that needs one says so in the one sentence. */
  const copyRecipeOrThrow = (): ((image: SealedImage) => Promise<GoldenRecipe> | GoldenRecipe) => {
    const compose = opts.copyRecipe;
    if (compose === undefined) throw new Error(NO_COPY_RECIPE);
    return compose;
  };

  /** The recipe a golden road builds from: the one the call names, else the one the runtime was wired with. A host
   * serving the app names it per call, since the init job's recipe is answered while the runtime already serves. */
  const recipeOrThrow = (named?: GoldenRecipe): GoldenRecipe => {
    const recipe = named ?? opts.goldenRecipe;
    if (!recipe) throw new Error("this runtime has no golden recipe; the host wires one (setup + smoke) before the wizard can run");
    return recipe;
  };

  const builderLabels = (extra: Record<string, string> | undefined): Record<string, string> => ({ ...extra, [WSP_LABEL]: "1", [BUILDER_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString() });

  /** The hold begins the moment the machine exists: a held placeholder is on the store before any stage runs, so
   * another process over it (a second host) never reads this machine as lost. */
  const recordingCreates = (
    b: MachineBackend,
    name: string,
    imp: Pick<GoldenImport, "recipeHash" | "recipe"> | undefined,
    made: (placeholder: LiveBuilder) => void,
    stop: { signal: AbortSignal | undefined; began: (creating: Promise<Machine>) => void } | undefined,
    place: string,
  ): MachineBackend => ({
    ...b,
    create: spec => {
      if (stop?.signal?.aborted) return Promise.reject(new PrepareStoppedError());
      // Handed out before the provider is called, so a stop that lands inside the call waits for the machine it returns.
      const creating = Promise.resolve().then(async () => {
        const machine = ctx.observed(await b.create(spec));
        const asked = { cpu: spec.cpu ?? backend.pricing.defaultSize.cpu, memMb: spec.memMb ?? backend.pricing.defaultSize.memMb };
        const record: BuilderRecord = {
          id: machine.id,
          name,
          kind: spec.kind,
          baseTemplate: spec.template ?? "",
          setupSha: "",
          // The keyed create restamps the label after this spec was built; the machine carries the stamp the provider got.
          createdAt: machine.labels?.[CREATED_AT_LABEL] ?? spec.labels?.[CREATED_AT_LABEL] ?? new Date().toISOString(),
          size: asked,
          firstLife: true,
          building: true,
          ...(machine.streamUrl !== undefined ? { streamUrl: machine.streamUrl } : {}),
          ...(imp !== undefined ? { import: { recipeHash: imp.recipeHash, ...(imp.recipe !== undefined ? { recipe: imp.recipe } : {}), applied: [], smoke: "true" } } : {}),
          place,
        };
        const placeholder: LiveBuilder = { record, builder: { machine, kind: spec.kind, baseTemplate: record.baseTemplate, setupSha: "", createdAt: record.createdAt, firstLife: true, size: asked }, sealable: true, life: "own" };
        builders.set(machine.id, placeholder);
        made(placeholder);
        await hold(placeholder);
        return machine;
      });
      stop?.began(creating);
      return creating;
    },
  });

  /** The finished builder replaces its placeholder on the record and stays this process's own. */
  const settleBuilder = async (name: string, builder: Builder, placeholder: LiveBuilder | undefined, place: string): Promise<LiveBuilder> => {
    const record: BuilderRecord = {
      id: builder.machine.id,
      name,
      kind: builder.kind,
      baseTemplate: builder.baseTemplate,
      setupSha: builder.setupSha,
      createdAt: placeholder?.record.createdAt ?? builder.createdAt,
      size: builder.size,
      firstLife: true,
      ...(builder.machine.streamUrl !== undefined ? { streamUrl: builder.machine.streamUrl } : {}),
      ...(builder.import !== undefined ? { import: builder.import } : {}),
      ...(builder.base !== undefined ? { base: builder.base } : {}),
      place,
    };
    const entry: LiveBuilder = placeholder ?? { record, builder, sealable: true, life: "own" };
    entry.record = record;
    entry.builder = builder;
    builders.set(record.id, entry);
    await hold(entry);
    return entry;
  };

  /** What the host owns after a seal. The image's own seal writes the record afresh, wherever it ran: the recipe hash
   * the builder carried, the small recipe it was planned from, the logins the seal stamped, the vault it took, their
   * one hash, and the place it stands at. A copy's seal moves nothing of the record; only the copy is recorded,
   * under the hash the record already has. Either way the version carries that hash, so a copy says for itself what
   * it was built from. */
  const recordSeal = async (place: string, name: string, entry: LiveBuilder, recipe: GoldenRecipe, result: SealResult, copy: SealedImage | undefined): Promise<SealResult> => {
    // A copy is stamped with the record it was composed from, never with the record as it stands now: a cut that
    // landed while the copy built leaves it stale, which is what makes the next build there happen.
    let hash = copy?.hash;
    if (copy === undefined) {
      const digest = entry.builder.import?.recipeHash ?? "";
      const vault: SealedVault | undefined =
        result.vault === undefined
          ? undefined
          : { sha256: result.vault.sha256, bytes: result.vault.tar.length, paths: result.vault.paths, held: result.vault.held, takenAt: result.version.createdAt };
      const pins = recipePins(entry.builder.import?.recipe ?? { ticks: [] }, id => catalogIdOfRow({ id }) ?? id);
      hash = imageHash(digest, vault?.sha256, pins);
      const image: SealedImage = {
        name,
        version: result.version.version,
        hash,
        recipeHash: digest,
        ...(recipe.source !== undefined ? { recipe: recipe.source } : {}),
        pins,
        logins: result.version.logins ?? [],
        sealedAt: result.version.createdAt,
        sealedFrom: hostId,
        ...(vault !== undefined ? { vault } : {}),
        ...(result.version.usedBytes !== undefined ? { usedBytes: result.version.usedBytes } : {}),
        place,
      };
      const replaced = (await store.get(IMAGES, name)) as SealedImage | undefined;
      if (result.vault !== undefined) await store.putBlob(IMAGE_VAULTS, vaultKey(name, result.version.version), result.vault.tar);
      await store.put(IMAGES, name, image);
      // No version's sign-ins in the clear outlive the record that named that version, whatever the cut did with
      // its snapshot: the record names one version, and the blob of the one it replaced goes with it.
      if (replaced !== undefined && replaced.version !== result.version.version) await store.deleteBlob(IMAGE_VAULTS, vaultKey(name, replaced.version));
    }
    if (hash === undefined) return result;
    const version: GoldenVersion = { ...result.version, imageHash: hash };
    return { ...result, version, manifest: { ...result.manifest, versions: result.manifest.versions.map(v => (v.version === version.version ? version : v)) } };
  };

  /** Snapshot, smoke fork, manifest. A kept builder stays recorded with the version it was saved as and its grace
   * armed; every other road drops the record, so a machine that outlived its kills is exactly what reap sweeps.
   * `copy` is the record a copy's build was composed from: the record stays as it is, the copy is stamped with that
   * record's hash and the frames name the place. */
  const sealEntry = async (entry: LiveBuilder, keep: boolean, logins?: GoldenLogin[], copy?: SealedImage): Promise<SealResult> => {
    const recipe = recipeOrThrow(entry.recipe);
    const name = entry.record.name;
    // The place this builder was made at, where its seal is filed.
    const place = entry.record.place ?? places.wired;
    const prior = await ctx.copyOf(place, name);
    const at = backendAt(place);
    try {
      const result = await ctx.claiming(`smoke/${entry.record.id}`, b =>
        sealGolden(entry.builder, {
          backend: ctx.observing(b),
          smoke: recipe.smoke,
          ...(recipe.cpu !== undefined ? { cpu: recipe.cpu } : {}),
          ...(recipe.memMb !== undefined ? { memMb: recipe.memMb } : {}),
          ...(recipe.envs !== undefined ? { envs: recipe.envs } : {}),
          labels: { ...recipe.labels, [WSP_LABEL]: "1", [SMOKE_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString() },
          ...(prior !== undefined ? { manifest: prior } : {}),
          onStage: stageOf(name, place, copy !== undefined),
          ...(opts.killConfirm !== undefined ? { killConfirm: opts.killConfirm } : {}),
          ...(opts.snapshotRetryMs !== undefined ? { snapshotRetryMs: opts.snapshotRetryMs } : {}),
          ...(logins !== undefined ? { logins } : {}),
          // Only the image's own seal reads the vault off its builder: a copy's builder was given the record's
          // vault and re-exporting it there would record a second one for the same image.
          ...(copy === undefined && recipe.vaultPaths !== undefined ? { vaultPaths: recipe.vaultPaths } : {}),
          keepBuilder: keep,
          name,
          hostId: ctx.imageMark(),
        }),
        at,
      );
      const stamped = await recordSeal(place, name, entry, recipe, result, copy);
      await ctx.putCopy(place, name, stamped.manifest);
      const snapshot = entry.builder.import?.recipe;
      if (snapshot !== undefined) await ctx.putCopyRecipe(place, name, stamped.version.version, snapshot);
      // The seal stands whatever the mark does: a default that could not be written is a later fork's to ask about.
      if (copy === undefined && name === "default") await placeDoor?.markDefaultIfNone(place).catch((e: unknown) => console.warn(`the default place was not marked at the seal: ${e instanceof Error ? e.message : String(e)}`));
      if (result.builderKept) {
        entry.record.sealed = { at: new Date(clock.now()).toISOString(), version: result.version.version };
        entry.life = "own";
        await hold(entry);
        armGrace(entry.record.id, entry.record.sealed.at);
      } else {
        await forgetBuilder(entry.record.id);
      }
      return stamped;
    } catch (e) {
      // A builder the provider refused to snapshot and still has is untouched, so its record stays for the next attach.
      if (e instanceof SnapshotFailedError && e.builderState !== "gone") throw e;
      // sealGolden consumes the builder on every other road but a refusal; a refused
      // builder can never seal and under a two-machine cap must not outlive it.
      if (e instanceof NotFirstLifeError) await killUntilGone(at, entry.builder.machine, opts.killConfirm);
      await forgetIfGone(entry, at);
      throw e;
    }
  };

  /** Deletes what a version's forks boot from. The template goes first: the provider refuses to delete a snapshot
   * while a template stands on it, and a template already gone is no failure. The sealed vault is not this
   * function's: a manifest counts its own place's versions, and the record's blob is keyed by the record's, so
   * only the seal that replaces a version may take that version's blob. */
  const dropImage = async (v: GoldenVersion, at: MachineBackend = backend): Promise<void> => {
    if (v.templateId !== undefined) {
      await templatesOf(at)?.delete(v.templateId).catch((e: unknown) => {
        if (!isMissing(e)) throw e;
      });
    }
    await at.deleteSnapshot(v.snapshotId);
  };
  return {
    builderView, graceTimers, armGrace, inWindow, expireGrace, hold, refuseUntouchable, forgetBuilder, forgetIfGone,
    stageOf, backendAt, placeAt, landingBackend, forkingAt, placeName, imagePlace, buildPlaces, copyRecipeOrThrow,
    recipeOrThrow, builderLabels, recordingCreates, settleBuilder, sealEntry, dropImage,
  };
}
