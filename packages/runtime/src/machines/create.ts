// SPDX-License-Identifier: AGPL-3.0-only
import { killUntilGone, type Machine, type WspError } from "@wsp/engine";
import { type ProjectView, type WorkspaceKind, type WorkspaceView, type WorkspaceCreatingEvent, ThreadScope, agentsFrom, copyFirstLine, namesSize, BLANK_NAME_REFUSAL, CREATE_READY, machineCapRefusal, nameDeletingRefusal, nameTakenRefusal, offeredSize, refusalLine, runsInFolder, SIZE_PICK_FIX, sizeGotLine, sizeRefusal, sizeWord, startingLine } from "@wsp/protocol";
import { projectLanding } from "../project-landing.js";
import { type CreatedWorkspace, type CreateWorkspaceOptions, type WorkspaceRecord, type LiveWorkspace, type StageReport, until } from "../types/wiring.js";
import { isCapRefusal } from "../types/internal.js";
import type { RuntimeContext, CreateArea } from "../context.js";

export function createArea(ctx: RuntimeContext): CreateArea {
  const { opts, backend, placeDoor, bus, clock, live, builders, places } = ctx;
  const createStaged = async (
    o: CreateWorkspaceOptions,
    project: ProjectView,
    id: string,
    report: StageReport,
    spawned?: ThreadScope,
    landed?: () => void,
    childBase?: string,
  ): Promise<CreatedWorkspace> => {
    // Where this fork lands is the project's computer and nothing else: one workspace is one project's copy, so
    // no flag and no default place has a say in it.
    const { placeId } = await ctx.landingPlace(project.computer);
    await ctx.placeRefuses(placeId);
    const at = await ctx.landingBackend(placeId);
    // What this project's computer mounts into every workspace of it, off the road that landed the project there.
    // Where this project's computer keeps its memory, off that computer's own road, read again here because the
    // road can answer it now: a record filled at boot while that computer had said nothing about itself carries
    // whatever could be worked out then, and the folder a workspace mounts has to be the one the computer holds.
    // The record is put right the first time a workspace of it is made, so the two can never disagree again.
    const road = projectLanding(ctx.landingKind(project.computer, at));
    const landingOn = (await ctx.landingDeps(project.computer)).deps;
    // Why no workspace of this project can be made on that computer at all, before a machine is asked for or a
    // record written: a create that read the refusal later left a workspace record behind for a fork that never
    // happened.
    const refused = road.refusal(project, landingOn);
    if (refused !== undefined) throw Object.assign(new Error(refused), { kind: "invalid" });
    const said = road.places({ project, memoryKey: project.memoryKey, deps: landingOn });
    if (said.memoryDir !== project.memoryDir) await ctx.rememberProject({ ...project, memoryDir: said.memoryDir });
    const binds = road.workspaceBinds(ctx.projectHeld(project.id));
    // A project whose checkout the add left on that computer: this workspace takes its own copy of it, mounted at
    // the path the project has inside, so the seed and the install the add paid for are there and nothing is
    // cloned again. A project the computer keeps in an image carries it in the image instead. On a computer that
    // clones at the add, a project with no checkout was refused above by that road's own refusal; a project at a
    // provider has neither, and cloneProject clones it inside the fork.
    const copy = project.checkout === undefined ? undefined : { from: project.checkout, at: project.path };
    // A computer that keeps no image is forked from none: the workspace is a copy of that computer itself, so no
    // image is read, no copy of one is built there ahead of the fork, and the record names none the way a copy of
    // a folder here does.
    const fromImage = ctx.keepsImages(at);
    // What this workspace forks: the image the add built for this project where it built one, since that image
    // already holds the clone and its dependencies; else, at a place that is not the image's own, that place's
    // current copy of the image, built there first when it holds none, and everywhere else the snapshot asked for.
    const golden = fromImage ? await ctx.copyForFork(o.golden ?? project.image?.snapshotId ?? (await ctx.imageHead()), placeId, (where, rate) => report("fork-requested", copyFirstLine(where, o.name, rate))) : "";
    const inherited = fromImage ? (await ctx.imageOf(golden)).version?.size : undefined;
    const record: WorkspaceRecord = {
      id,
      name: o.name,
      kind: "cloud",
      machineId: "",
      phase: "running",
      golden,
      createdAt: new Date().toISOString(),
      project: project.id,
      spec: {
        ...(o.envs !== undefined ? { envs: o.envs } : {}),
        ...(o.labels !== undefined ? { labels: o.labels } : {}),
        ...(o.engine === true ? { engine: true } : {}),
        // What this project's own computer mounts into every workspace of it: its memory folder on a computer that
        // holds one, nothing where the project's memory rides the image. Kept on the record, so a wake mounts what
        // the create mounted.
        ...(binds.length > 0 ? { binds } : {}),
        ...(copy !== undefined ? { copy } : {}),
      },
      ...(o.idleWindowMs !== undefined ? { idleWindowMs: o.idleWindowMs } : {}),
      ...(placeId !== undefined ? { place: placeId } : {}),
      size: {
        cpu: o.cpu ?? inherited?.cpu ?? at.pricing.defaultSize.cpu,
        memMb: o.memMb ?? inherited?.memMb ?? at.pricing.defaultSize.memMb,
      },
      firstLife: true,
      // Written before the machine is asked for: the cap counts machines under a root off these two fields, so a
      // fork that is still landing already holds its place and two forks at once cannot both pass the count.
      ...ctx.treeOf(spawned),
      ...(o.parent !== undefined ? { parentWorkspaceId: o.parent } : {}),
      // The branch this copy starts from, kept because a bring back measures against it long after the parent may
      // have moved on or gone to sleep; nothing reads the parent's machine for it again.
      ...((childBase ?? project.base) !== undefined ? { base: childBase ?? project.base } : {}),
      // A fork a thread asked for stores no switch of its own: it carries the tree it belongs to, and the switch is
      // read off that tree's root wherever it is asked for, so one workspace holds the answer for the whole tree.
      ...(spawned === undefined && o.agents !== undefined ? { agents: agentsFrom(ctx.spawnAt(placeId ?? places.wired), o.agents) } : {}),
    };
    // Only an asked size is checked: the golden's own is what it was built at, whatever the provider offers today.
    if (namesSize(o) && !offeredSize(at.capabilities.sizes, record.size)) {
      throw Object.assign(new Error(refusalLine(sizeRefusal(sizeWord(record.size), at.capabilities.sizes), SIZE_PICK_FIX)), { kind: "invalid" });
    }
    const bind = (m: Machine): void => {
      record.machineId = m.id;
      ctx.attach(record, m).creating = true;
      // The record is in the live map from here, so the place the guard took for it is handed back in the same
      // step: one fork counts as one from the reservation through to the machine being ready, never as two while
      // it boots. A create that never binds hands its place back in the caller's finally instead.
      landed?.();
    };
    const notices: string[] = [];
    const asked = record.size;
    // The computer the fork lands on, by the name its own row carries: the place a person picked, else the
    // provider word this host's machines wear, which is what every other surface names a fork's home by.
    const where = placeId === undefined ? places.wired : ctx.placeDoorOf().nameOf(placeId);
    report("fork-requested", startingLine(record.name, where));
    try {
      await ctx.fork(record, bind, undefined, report, false);
    } catch (e) {
      // A slot for work beats a builder kept for one more change: at the cap one kept builder of this setup is
      // stopped and the fork tried again, the next one only on the next refusal. A held or foreign builder is
      // never touched, and a refusal with none left to stop is turned into words that name the slots' holders.
      if (!isCapRefusal(e)) throw e;
      let refusal: unknown = e;
      let made = false;
      await ctx.refreshBuilders();
      for (const x of [...builders.values()].filter(x => (x.life === "own" || x.life === "reusable") && x.record.sealed !== undefined)) {
        const stopped = `Stopped the builder kept from image v${x.record.sealed!.version} to make room at the machine cap.`;
        ctx.graceTimers.get(x.record.id)?.();
        ctx.graceTimers.delete(x.record.id);
        await killUntilGone(backend, x.builder.machine, opts.killConfirm);
        await ctx.forgetBuilder(x.record.id);
        notices.push(stopped);
        console.warn(`workspace ${record.id}: ${stopped.charAt(0).toLowerCase()}${stopped.slice(1, -1)} (${x.record.id})`);
        report("fork-requested", `${startingLine(record.name, where)} again`, { notice: stopped });
        try {
          await ctx.fork(record, bind, undefined, report, false);
          made = true;
          break;
        } catch (again) {
          if (!isCapRefusal(again)) throw again;
          refusal = again;
        }
      }
      if (!made) {
        // A create still in flight holds its slot; the one being refused never bound a machine, so it cannot name itself.
        const holding = [...live.values()].filter(w => ctx.holdsSlot(w.record)).map(w => w.record.name);
        const line = machineCapRefusal(holding, [...builders.values()].map(x => x.record.name));
        throw Object.assign(new Error(line, { cause: refusal }), { kind: "concurrency", ...(typeof (refusal as WspError).status === "number" ? { status: (refusal as WspError).status } : {}) });
      }
    }
    const entry = live.get(id)!;
    // A computer that would not fork at the size asked for says so on the handle, and the create's own answer is
    // where a person reads it: the record already holds the size that computer actually gave.
    if (entry.machine.notice !== undefined) notices.push(entry.machine.notice);
    // A workspace whose computer serves its daemon is asked nothing here: there is no route to mint and no daemon
    // inside to answer, so the create says nothing about either rather than printing a note about a port nothing
    // listens on.
    let fault: string | undefined;
    if (ctx.servedByItsComputer(entry) === undefined && (entry.machine.previewUrl !== undefined || entry.machine.daemonAnswers !== undefined)) {
      // The route and the daemon are two questions, and the create asks them apart: minting is what the app and
      // the first client will dial, and a mint that fails is its own line rather than a verdict on the guest.
      if (entry.machine.previewUrl !== undefined) {
        try {
          await until(entry.ws.daemonReach(), Date.now() + ctx.lifecycleOf(entry).budgets.daemonAnswersMs, "preview route");
          report("preview-route", "Preview route to the daemon minted.");
        } catch (e) {
          report("preview-route", "No preview route to the daemon.", { notice: `preview route for ${entry.machine.id} not minted (${e instanceof Error ? e.message : String(e)})` });
        }
      }
      // A daemon that does not answer is reported, not fatal: the workspace exists either way, and the status check
      // keeps asking and names a zombie. Asked the way the wake and the poll ask, so a machine reached without a
      // route is asked here too rather than left with no word at all.
      fault = await ctx.pingDaemon(entry);
      report("daemon-answering", fault === undefined ? "Daemon answered." : "Daemon did not answer.", { notice: fault });
      void ctx.syncDaemon(entry);
    }
    if (placeId === undefined) {
      // A guest whose daemon is silent may not serve exec yet either, and would spend the exec budget on top of the daemon's.
      if (fault !== undefined) console.warn(`workspace ${record.id}: memory not read: the daemon did not answer`);
      else if ((await ctx.readMemory(record, entry.machine, at.capabilities.sizes)) && (record.size.cpu !== asked.cpu || record.size.memMb !== asked.memMb)) {
        const line = sizeGotLine(asked, record.size, namesSize(o));
        notices.push(line);
        console.warn(`workspace ${record.id}: ${line}`);
      }
    }
    // The project goes in before the workspace is ready: a copy without the work in it is not a workspace of that
    // project, so a clone that fails ends the create and the machine goes with it.
    await ctx.moduleOf(record.kind).landProject(entry, project, report);
    await ctx.writeDaemonRoots(entry);
    await ctx.persist(record);
    // The place a fork landed on is where the next one lands when nobody says.
    await placeDoor?.markUsed(placeId);
    delete entry.creating;
    report("ready", CREATE_READY);
    const v = ctx.view(record);
    bus.emit({ type: "workspace.created", workspace: v });
    return notices.length > 0 ? { ...v, notice: notices.join(" ") } : v;
  };

  /** The name a workspace takes from what was typed: the space around it is no part of a name. The fork and the
   * rename both read it here, so a name is never stored with spaces a person would have to type back for `--in`. */
  const nameGiven = (name: string): string => name.trim();
  /** Names whose fork is between its check and its first machine: held here so two forks asked for together cannot both land. */
  const forking = new Set<string>();
  /** Creates that failed before any machine was recorded, by the id their stages carried: every client keeps a row
   * for one until it is deleted, so resolve and delete reach it here. */
  const failedCreates = new Map<string, WorkspaceView>();
  const createStages = new Map<string, WorkspaceCreatingEvent>();
  bus.on("*", e => {
    if (e.type === "workspace.creating") {
      // Held without the seq the bus stamped: sent again on a subscribe, it is no position in the stream.
      const { seq: _seq, ...stage } = e;
      createStages.set(e.workspaceId, stage);
    } else if (e.type === "workspace.created") createStages.delete(e.workspace.id);
    else if (e.type === "workspace.deleted") createStages.delete(e.workspaceId);
  });
  const failedView = (id: string, name: string, kind: WorkspaceKind, golden: string, began: number, project: ProjectView, said: string): WorkspaceView => ({
    id,
    name,
    machineId: "",
    phase: "gone",
    kind,
    golden,
    createdAt: new Date(began).toISOString(),
    project: ctx.refOf(project),
    gone: said,
  });
  /** A create asked again under a name supersedes the one that failed under it, and every client's row of it. */
  const supersedeFailed = (name: string): void => {
    for (const [failedId, failed] of failedCreates) {
      if (failed.name !== name) continue;
      failedCreates.delete(failedId);
      bus.emit({ type: "workspace.deleted", workspaceId: failedId });
    }
  };
  /** One create's stages as every client hears them. Who asked rides every stage from the first, which is emitted
   * before the create has a record: the stream's tree rule has nothing to read until then, so a thread watching its
   * own fork boot would see it start midway. */
  const stageReporter = (id: string, name: string, began: number, spawned: ThreadScope | undefined): StageReport => {
    const askedBy = spawned !== undefined ? { threadId: spawned.threadId, rootThreadId: spawned.rootThreadId } : undefined;
    return (stage, message, said) => {
      bus.emit({
        type: "workspace.creating",
        workspaceId: id,
        name,
        stage,
        message,
        elapsedMs: clock.now() - began,
        ...(said?.notice !== undefined ? { notice: said.notice } : {}),
        ...(said?.detail !== undefined ? { detail: said.detail } : {}),
        ...(said?.waiting === true ? { waiting: true as const } : {}),
        ...(askedBy !== undefined ? { askedBy } : {}),
      });
    };
  };
  /** Why a fork of this name is refused, or nothing when the name is free: one entry holds it, whatever it is doing
   * (a delete in flight says so), or a fork of it is under way. A name never names two workspaces, and a fork and a
   * delete of one name never interleave. */
  const nameRefusal = (name: string): string | undefined => {
    if (nameGiven(name) === "") return BLANK_NAME_REFUSAL;
    const entry = [...live.values()].find(e => e.record.name === name);
    if (entry !== undefined) return entry.deleting ? nameDeletingRefusal(name) : nameTakenRefusal(name);
    return forking.has(name) ? nameTakenRefusal(name) : undefined;
  };

  /** The records of one project's folders on this computer: the project folder's own and one per worktree. */
  const foldersOf = (projectId: string): LiveWorkspace[] => [...live.values()].filter(e => runsInFolder(e.record.kind) && e.record.project === projectId);
  /** The folder records being made, by project and branch, so two starts asking for the same folder at once get the
   * one record rather than two. */
  const folderMaking = new Map<string, Promise<LiveWorkspace>>();
  const oneFolder = (key: string, make: () => Promise<LiveWorkspace>): Promise<LiveWorkspace> => {
    const held = folderMaking.get(key);
    if (held !== undefined) return held;
    const making = make().finally(() => folderMaking.delete(key));
    folderMaking.set(key, making);
    return making;
  };
  return {
    createStaged, nameGiven, forking, failedCreates, createStages, failedView, supersedeFailed, stageReporter,
    nameRefusal, foldersOf, oneFolder,
  };
}
