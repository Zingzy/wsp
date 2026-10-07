// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS, DEFAULT_AGENT } from "@wsp/catalog";
import { INLINE_EXEC_MS, BUILDER_LABEL, CREATED_AT_LABEL, OWNER_LABEL, WSP_LABEL, destExists, exportFolder, exportPathsInto, importInto, landBundle, landBytes, plural, agentsOnMachine, guestAgentHomes, guestTmpPath, parseStateListing, stateListing, type MachineBackend, type MachineSpec, GUEST_TMP, syncDisk } from "@wsp/engine";
import type { HarnessCatalog, ProjectAddStage, ProjectExportStage, ProjectSource, ProjectView, ProjectPlan, SeedChoice, SeedPlan, Caller } from "@wsp/protocol";
import { projectLanding, type Landed, type LandingDeps, type ProjectLanding } from "../project-landing.js";
import { projectSource } from "../project-sources.js";
import { refusal, scopeOf, spawnFolderRefusal, spawnRepositoryRefusal, SPAWN_FOLDER_FIX, SPAWN_REPOSITORY_FIX } from "@wsp/protocol";
import { addedProjectOn, addingProjectLine, actionRefusal, kindWords, fmtBytes, notFoundRefusal, claudeProjectKey, folderOnCopyRefusal, cloneIntoNeeded, intoIsHereLine, INTO_TAKES_A_REPO_LINE, noComputerForSourceLine, bareNoSuchProjectLine, noSuchProjectLine, leftBehindLine, projectInUseRefusal, seedChoiceNeeded, sameSourceRefusal, sourceKind, projectSourceOf, bareFolder, copiesFolder, kindForComputer, runsInFolder, shellQuote, underProject, workspaceState, HERE_PLACE_ID, noSuchPlaceRefusal } from "@wsp/protocol";
import { GITHUB_TOKEN_ENV } from "@wsp/engine";
import { resolveThreadDefaults, withCustomModels } from "@wsp/protocol";
import { harnessCatalog } from "../harness-catalog.js";
import { loginEnvOn } from "../types/harness.js";
import { type PackedState, type LandRequest, type ProjectImportOptions, type LiveWorkspace, type SeedWiring, ADD_IS_A_COMPUTER_LINE, folderNamed, sameSource, outcomeWords, LISTING_DEADLINE_MS, mergeOnMachine, homeOutcome } from "../types/wiring.js";
import type { Runtime } from "../types/api.js";
import { PROJECTS, SEED_CHOICES, NO_SEED_WIRING, type ImportReport, type ImportLanded } from "../types/internal.js";
import type { RuntimeContext, ProjectsArea } from "../context.js";

export function projectsArea(ctx: RuntimeContext): ProjectsArea {
  const { opts, store, adapters, local, bus, clock, live, projectsHeld, gone, placeDoor } = ctx;
  /** The import road onto a fork: the plan, what was consented, the pack, the upload in parts, the landing at the
   * path and the agents' state keyed to it there. */
  const copyImport = async (entry: LiveWorkspace, o: ProjectImportOptions, report: ImportReport): Promise<ImportLanded> => {
    const plan = await o.bundler.plan();
    report("planned", `${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}${plan.repo ? " and the repository" : ""}; ${plural(plan.secrets.length, "secret-shaped file")}; ${plural(plan.excluded.length, "cache")} left behind.`);
    const carry = new Set(o.carry ?? []);
    const rewrite = new Set(o.rewrite ?? []);
    const rewriting = plan.secrets.flatMap(s => (s.rewrite !== undefined && rewrite.has(s.path) ? [{ path: s.path, ...s.rewrite }] : []));
    const rewritten = new Set(rewriting.map(r => r.path));
    const carried = plan.secrets.filter(s => carry.has(s.path) && !rewritten.has(s.path)).map(s => s.path);
    const cut = plan.secrets.filter(s => !carry.has(s.path) && !rewritten.has(s.path)).map(s => s.path);
    const clauses = [
      ...(carried.length > 0 ? [`carrying ${carried.join(", ")}`] : []),
      ...(rewriting.length > 0 ? [`rewriting ${rewriting.map(r => `${r.path}${r.urls.length > 0 ? ` to ${r.urls.join(", ")}` : ""}${r.drop.length > 0 ? ` without ${r.drop.join(", ")}` : ""}`).join(", ")}`] : []),
      ...(carried.length === 0 && rewriting.length === 0 ? ["no secret-shaped file travels"] : []),
      cut.length === 0 ? "nothing cut" : `cut ${cut.join(", ")}`,
    ].join("; ");
    const named = new Set(o.agents ?? []);
    const readable = plan.agents.filter(a => a.error === undefined);
    const unreadable = plan.agents.filter(a => a.error !== undefined);
    const travelling = readable.filter(a => named.has(a.agent));
    const staying = readable.filter(a => !named.has(a.agent));
    const withCount = (a: ProjectPlan["agents"][number]): string => `${a.name} (${plural(a.sessions, "session")})`;
    const notes = [
      ...(plan.agents.length === 0 ? [] : travelling.length === 0 ? ["No agent sessions travel"] : [`Sessions travel for ${travelling.map(withCount).join(", ")}`]),
      ...(travelling.length > 0 && staying.length > 0 ? [`${staying.map(a => a.name).join(", ")} ${staying.length === 1 ? "stays" : "stay"}`] : []),
      ...unreadable.map(a => `${a.name} could not be read (${a.error})`),
    ];
    const agentsLine = notes.length === 0 ? "" : ` ${notes.join("; ")}.`;
    report("consented", `${plan.secrets.length === 0 ? "No secret-shaped files." : `${clauses.charAt(0).toUpperCase()}${clauses.slice(1)}.`}${agentsLine}`);
    report("packing", `Packing ${plural(plan.files - cut.length, "file")}.`);
    const packed = await o.bundler.pack(carry, rewrite);
    let state: PackedState | undefined;
    if (travelling.length > 0) {
      const present = await agentsOnMachine(entry.machine, travelling.map(a => a.agent));
      const homes = guestAgentHomes();
      state = await o.bundler.packState({
        dest: o.dest,
        agents: travelling.map(a => {
          const home = homes[a.agent];
          if (home === undefined) throw new Error(`${a.agent} is not an agent the catalog knows`);
          return { agent: a.agent, home, present: present.has(a.agent) };
        }),
      });
    }
    report("uploading", `Uploading ${fmtBytes(packed.tar.length)}.`, { bytes: 0, total: packed.tar.length });
    const { parts } = await landBundle(entry.machine, packed.tar, o.dest, {
      ...(o.replace !== undefined ? { replace: o.replace } : {}),
      tmpDir: ctx.moduleOf(entry.record.kind).scratch(entry),
      timeoutMs: 600_000,
      onPart: p => report("uploading", `Part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, { bytes: p.bytes, total: p.total }),
      onLanding: () => report("landing", `Landing at ${o.dest}.`),
    });
    const nameOf = (id: string): string => plan.agents.find(a => a.agent === id)?.name ?? id;
    const agents = [...(state?.agents ?? [])];
    const outcomes = (): string => agents.map(a => `${nameOf(a.agent)} ${outcomeWords(a)}`).join(", ");
    if (state !== undefined && (agents.some(a => a.files > 0) || state.merges.length > 0)) {
      const files = agents.reduce((n, a) => n + a.files, 0);
      const what = [...(files > 0 ? [plural(files, "session file")] : []), ...(state.merges.length > 0 ? ["the rows to merge"] : [])].join(" and ");
      report("uploading", `Uploading ${what}, ${fmtBytes(state.tar.length)}.`, { bytes: 0, total: state.tar.length });
      await importInto(entry.machine, state.tar, "/", {
        overlay: true,
        tmpDir: ctx.moduleOf(entry.record.kind).scratch(entry),
        timeoutMs: 600_000,
        onPart: p => report("uploading", `Part ${p.part} of ${p.parts}, ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, { bytes: p.bytes, total: p.total }),
      });
      if (state.merges.length > 0) {
        report("landing", `Merging rows into ${state.merges.map(m => nameOf(m.agent)).join(", ")}.`);
        for (const m of state.merges) {
          const at = agents.findIndex(a => a.agent === m.agent);
          if (at >= 0) agents[at] = await mergeOnMachine(entry.machine, m.script, agents[at]!);
        }
      }
      report("landing", `Landing sessions: ${outcomes()}.`);
    }
    return {
      result: { dest: o.dest, files: packed.files, bytes: packed.bytes, parts, cut: packed.cut, rewritten: packed.rewritten, agents, project: ctx.projectOf(o.dest, packed.bytes) },
      done: `${plural(packed.files, "file")}, ${fmtBytes(packed.bytes)}, landed at ${o.dest}${parts > 1 ? ` in ${parts} parts` : ""}${agents.length > 0 ? `; sessions: ${outcomes()}` : ""}.`,
    };
  };

  /** The seed half of an add, which the host wires because it reads a folder of the person's: a runtime without it
   * records a folder as a project on this computer and clones a repo anywhere else, and a folder seeding another
   * computer is refused rather than sent unread. */
  const seedWiring = (): SeedWiring => {
    if (opts.seed === undefined) throw new Error(NO_SEED_WIRING);
    return opts.seed;
  };

  /** Which landing road a computer takes, off the kind of workspace it makes rather than off its id: the computer
   * the app runs on works the folder beside itself, a computer the person joined holds the project as a folder in
   * its login's home, and everything else is a provider, where a project lives in an image. */
  const landingKind = (computer: string, _at?: MachineBackend): ProjectLanding["kind"] => {
    const kind = ctx.kindOf(computer);
    return copiesFolder(kind) ? "mac" : runsInFolder(kind) ? "box" : "provider";
  };

  /** What a landing road may ask of this runtime, for one computer: a short-lived machine of that computer's image
   * to clone, seed and install in, the road that puts the seed archive on it, the snapshot a project image is, and
   * where that computer and this Mac keep what a project needs. */
  const landingDeps = async (computer: string): Promise<{ deps: LandingDeps; at: MachineBackend | undefined; placeId: string | undefined }> => {
    const { placeId } = await ctx.landingPlace(computer);
    // A computer this host cannot read a backend for holds nothing of a project: the record still stands, as it
    // did before this road existed, and the road that would have to fork there says so itself when it is asked.
    const at = await ctx.forkingAt(placeId).catch(() => undefined);
    const joined = placeId === undefined ? undefined : placeDoor?.folderComputer(placeId);
    const deps: LandingDeps = {
      async worker(o) {
        const forking = await ctx.landingBackend(placeId);
        // A computer that keeps no image is worked in a copy of its own directories, the same machine a workspace
        // there is; only a provider names an image to fork, and the add read which one once.
        const golden = o.from === "" ? undefined : await ctx.copyForFork(o.from, placeId);
        const spec: MachineSpec = {
          kind: "sandbox",
          ...(golden !== undefined ? { fromSnapshot: golden } : {}),
          // On a computer somebody joined this machine clones and installs with that computer's shared home
          // bound in, as a workspace there does, so it reads the same order and the same knobs; this Mac and the
          // provider this host forks on answer no place and keep the order an image is sealed with.
          envs: { ...loginEnvOn(placeId, golden === undefined ? undefined : (await ctx.imageOf(o.from)).version?.npmBin) },
          // A machine whose disk becomes an image is a builder, which is what keeps the computer's own logins out
          // of it; one that only clones onto the computer is not, since the clone reads those logins.
          labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: ctx.state.owner, [CREATED_AT_LABEL]: new Date().toISOString(), ...(o.image ? { [BUILDER_LABEL]: "1" } : {}) },
          ...(o.binds.length > 0 ? { binds: [...o.binds] } : {}),
          // Nothing waits on a person here: an add that died leaves no machine running for hours.
          onIdle: "kill",
        };
        return forking.create(spec);
      },
      stop: async machine => gone.stop(await ctx.landingBackend(placeId), machine),
      land: async (machine, path, bytes) => void (await landBytes(machine, path, bytes)),
      // A first-life fork of the image: the one snapshot road, the same the project goldens take.
      checkpoint: async (machine, name) => {
        await syncDisk(machine);
        return machine.snapshot(name, { firstLife: true });
      },
      scratch: () => GUEST_TMP,
      ...(joined !== undefined ? { computer: { machine: joined.machine, home: joined.home } } : {}),
      imageHead: () => ctx.imageHeadOrNone(),
      cloneEnv: (): Record<string, string> => {
        const token = opts.vault?.()[GITHUB_TOKEN_ENV];
        return token === undefined ? {} : { [GITHUB_TOKEN_ENV]: token };
      },
      // Where Claude Code keeps its projects on this computer, which is the memory folder of a project worked in
      // place here; read the way every other road on this computer reads that store.
      macStateHome: local?.home("claude") ?? "",
      // The name this wsp holds for that computer, read the way a fork's own line reads it.
      computerName: ctx.placeName(computer),
      now: () => clock.now(),
    };
    return { deps, at, placeId };
  };

  /** A computer somebody joined that this host cannot reach right now holds nothing of a project: the sentence is
   * that computer's own absent one, said before anything is made or removed. Read apart from the deps above
   * because a computer with no backend at all is what this Mac looks like to a host with no provider key, and a
   * folder here is still a project. */
  const readableComputer = async (at: MachineBackend | undefined, placeId: string | undefined): Promise<void> => {
    if (at === undefined && placeId !== undefined) await ctx.landingBackend(placeId);
  };

  /** Recording, reading and dropping a project, the four acts that keep the projects map and the store together.
   * Named apart from the door below so the create and the landing can resolve a project without reaching through
   * the public object. */
  const projectsDoor = {
    /** What a seed of a folder on this computer would carry, with the ticks a choice remembered for that folder
     * leaves on it. Nothing is read whole and nothing leaves this computer: the menu is git's own listing of what
     * it ignores, one size pass and the agent's memory folder. */
    async seedPlan(source: string): Promise<SeedPlan> {
      await ctx.ready();
      const folder = folderNamed(source);
      const plan = await seedWiring().plan(folder, await ctx.homesHere());
      const remembered = (await store.get(SEED_CHOICES, folder)) as SeedChoice | undefined;
      if (remembered === undefined) return plan;
      return { ...plan, remembered: true, files: plan.files.map(f => ({ ...f, ticked: f.kind !== "never" && remembered.files.includes(f.path) })) };
    },

    /** `report` hears each line the add says as it goes, beside the stream every client watches: a caller that
     * keeps its own log of the add, as a computer's setup does. */
    async add(o: { source: string; on?: string; name?: string; base?: string; into?: string; seed?: SeedChoice; id?: string; createdAt?: string; report?: (line: string) => void }, origin?: Caller): Promise<ProjectView & { notice?: string }> {
      await ctx.ready();
      // A project is this computer's to record: the folder and the computer named are read here, and a machine
      // that asked would be naming paths on a computer it cannot see.
      ctx.refuseRecording(o.source, origin);
      const rows = await ctx.computerRows();
      const clones = rows.filter(r => r.id !== HERE_PLACE_ID && kindWords(kindForComputer(r.id)).projectSources.includes("git")).map(r => r.name);
      const kind = sourceKind(o.source);
      if (kind === "computer") throw new Error(ADD_IS_A_COMPUTER_LINE);
      if (kind === "folder" && o.into !== undefined) throw new Error(INTO_TAKES_A_REPO_LINE);
      const source: ProjectSource = projectSourceOf(o.source, kind, kind === "folder" ? folderNamed(o.source) : undefined);
      // No --on: a folder is worked here and so is a repo given a folder to clone into; a repo with neither is the
      // person's to place, here or on a computer that clones, which the kind table says are which.
      const computer = o.on === undefined ? (kind === "folder" || o.into !== undefined ? HERE_PLACE_ID : undefined) : (rows.find(r => r.id === o.on || r.name === o.on)?.id ?? undefined);
      if (computer === undefined) {
        if (o.on === undefined) throw new Error(noComputerForSourceLine(o.source, clones));
        throw new Error(noSuchPlaceRefusal(o.on, rows.map(r => r.name)));
      }
      if (o.into !== undefined && computer !== HERE_PLACE_ID) throw new Error(intoIsHereLine(ctx.nameOfComputer(HERE_PLACE_ID, rows)));
      const computerKind = kindForComputer(computer);
      const takes = kindWords(computerKind).projectSources;
      if (!takes.includes(source.kind)) throw new Error(source.kind === "folder" ? folderOnCopyRefusal(ctx.nameOfComputer(computer, rows)) : noComputerForSourceLine(o.source, clones));
      // A repo here is cloned into the folder the person named, and that folder is then the project: every road
      // after the clone is the one a folder of theirs already takes.
      if (source.kind !== "folder" && copiesFolder(computerKind)) {
        if (o.into === undefined) throw new Error(cloneIntoNeeded(o.source));
        const into = await ctx.cloneHere(o.source, source, o.into);
        const { into: _into, on: _on, ...rest } = o;
        return projectsDoor.add({ ...rest, source: into }, origin);
      }
      const held = [...projectsHeld.values()].find(p => p.computer === computer && sameSource(p.source, source));
      if (held !== undefined) throw Object.assign(new Error(sameSourceRefusal(held.name, ctx.nameOfComputer(computer, rows))), { kind: "conflict" });
      // A folder here is a project whether or not git holds it; the repo it sits in, its own or one above it, is
      // what its branches and worktrees are read off.
      const top = source.kind === "folder" && copiesFolder(computerKind) ? await ctx.gitTopOf(source.path) : undefined;
      const { deps, at, placeId } = await landingDeps(computer);
      await readableComputer(at, placeId);
      const road = projectLanding(landingKind(computer, at));
      // What the source resolves to on this computer: the remote whichever computer holds the project will clone,
      // and, for a folder here, the menu of what a seed of it would carry.
      const module = projectSource(source.kind);
      const resolved = await module.resolve(source, {
        // A folder is seeded only onto a computer that clones it; the computer the app runs on copies it beside
        // itself and reads nothing of it but its own remote.
        seeding: road.kind !== "mac",
        seedPlan: folder => projectsDoor.seedPlan(folder),
        folderRemote: folder => ctx.remoteHere(folder),
      });
      // Nothing of the person's folder leaves this computer unasked: a seed onto a computer that clones needs the
      // choice they made off the menu, and the road that copies the folder here seeds nothing at all.
      const seeding = resolved.seed !== undefined && road.kind !== "mac";
      if (seeding && o.seed === undefined) throw Object.assign(new Error(seedChoiceNeeded(source.kind === "folder" ? source.path : o.source)), { kind: "invalid" });
      const name = o.name ?? resolved.name;
      // An id and an age are named only by a recipe folder moving the project wsp made from it, which went first.
      const id = o.id ?? `pr_${randomBytes(4).toString("hex")}`;
      const path = road.path({ name, source, deps });
      // The key the agent's memory sits under, fixed here and never recomputed: the folder's own key where a folder
      // on this computer seeded the project, so the memory it already has is the memory it keeps, else the key of
      // the path on the computer holding it.
      const memoryKey = resolved.seed?.memory?.key ?? claudeProjectKey(source.kind === "folder" ? source.path : path);
      const places = road.places({ project: { id, name, path, source }, memoryKey, deps });
      const project: ProjectView = {
        id,
        name,
        computer,
        source,
        path,
        remote: resolved.remote,
        defaultBranch: resolved.defaultBranch,
        memoryKey,
        memoryDir: places.memoryDir,
        // The branch a workspace of this project starts on: the one they named, and otherwise none, which the
        // clone reads as the remote's own default. The branch a seed's unpushed commits were on is never this: a
        // branch the remote has never seen is nothing a clone can ask for, so those commits land on a branch of
        // their own after the clone and the record stays on the branch the remote has.
        ...(o.base !== undefined ? { base: o.base } : {}),
        ...(top !== undefined ? { git: { top } } : {}),
        createdAt: o.createdAt ?? new Date(clock.now()).toISOString(),
      };
      const began = clock.now();
      const report = (stage: ProjectAddStage, message: string): void => {
        bus.emit({ type: "project.add", projectId: project.id, computer, stage, message, elapsedMs: clock.now() - began });
        o.report?.(message);
      };
      // Work runs on the computer when the add has something of the person's to put there, which is a seed: the
      // clone, the files they ticked, the install and, on a provider, the image every workspace of the project
      // forks. A repo the computer can clone by itself is recorded here and cloned by the workspace's own create,
      // which is what it did before this road existed.
      const keep = async (landed: Landed): Promise<ProjectView & { notice?: string }> => {
        // The notice is what the person is told about this add, not a field of the project: the record is written
        // once here with the schema's own fields, so it is taken off before anything is stored or emitted.
        const { notice: _said, ...fields } = landed;
        const recorded: ProjectView = { ...project, ...fields };
        await ctx.rememberProject(recorded);
        // Kept under the folder as this host resolved it, which is the word the next menu is looked up by.
        if (o.seed?.remember === true && source.kind === "folder") await store.put(SEED_CHOICES, source.path, o.seed);
        bus.emit({ type: "project.added", project: recorded });
        return recorded;
      };
      const seed = seeding && resolved.seed !== undefined && o.seed !== undefined ? { plan: resolved.seed, choice: o.seed } : undefined;
      if (!road.landsAtAdd({ seeding: seed !== undefined })) return keep({});
      report("planned", addingProjectLine(project.name, source, seed !== undefined));
      try {
        const packed = seed === undefined ? undefined : await seedWiring().pack({ ...seed, homes: await ctx.homesHere() });
        // A login inside a folder they ticked stays on this computer: said as the pack finds it, so the terminal
        // watching the add reads it there and the answer's notice is the tool door's copy of the same fact.
        if (packed !== undefined && packed.left.length > 0) report("seeding", leftBehindLine(packed.left));
        const landed = await road.land(
          {
            project,
            source: module,
            ...(seed !== undefined && packed !== undefined ? { seed: { tar: packed.tar, choice: seed.choice, plan: seed.plan } } : {}),
            report,
          },
          deps,
        );
        const recorded = await keep(landed);
        // The one sentence about where the project is, which every door reads from here: the terminal prints this
        // stage and says nothing of its own after it, so the fact is said once.
        report("done", addedProjectOn(recorded, ctx.nameOfComputer(computer, rows)));
        // What landed and is not what they asked for, each in its own sentence: the commits a computer's git
        // refused, and a login found inside a folder they ticked, which the pack leaves here. Both are theirs to
        // know about on an add that otherwise stands.
        const notices = [...(landed.notice !== undefined ? [landed.notice] : []), ...(packed !== undefined && packed.left.length > 0 ? [leftBehindLine(packed.left)] : [])];
        return notices.length === 0 ? recorded : { ...recorded, notice: notices.join("; ") };
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },

    async list(origin?: Caller): Promise<ProjectView[]> {
      await ctx.ready();
      // A thread is served the projects it may start children on, so the listing and the start read one rule.
      const scope = scopeOf(origin);
      return [...projectsHeld.values()].filter(p => scope === undefined || ctx.projectReached(origin, p.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async computers(): Promise<{ id: string; name: string }[]> {
      await ctx.ready();
      return ctx.computerRows();
    },

    async resolve(ref: string, origin?: Caller): Promise<ProjectView> {
      await ctx.ready();
      const all = [...projectsHeld.values()];
      const found = all.find(p => p.id === ref) ?? all.find(p => p.name === ref);
      // A thread works on its own project and its repository's on computers that fork machines. A project the
      // person holds that it may not use is refused by the rule that says why, another repository's or a folder
      // the person keeps of its own, in words that carry the word it typed; a word naming nothing, and every word
      // for a thread whose workspace this host no longer holds, read as absent.
      const scope = scopeOf(origin);
      if (scope !== undefined) {
        // Its own project by id or by name first, so another computer's project of the same name never stands in.
        const mine = ctx.projectOfScope(scope);
        if (mine === undefined) throw notFoundRefusal(bareNoSuchProjectLine(ref));
        const own = projectsHeld.get(mine);
        if (own !== undefined && (own.id === ref || own.name === ref)) return own;
        if (found === undefined) throw notFoundRefusal(bareNoSuchProjectLine(ref));
        if (ctx.projectReached(origin, found.id)) return found;
        if (ctx.ofThreadsRepository(origin, found.id)) throw refusal(spawnFolderRefusal(scope.threadId, ref), SPAWN_FOLDER_FIX, "usage");
        throw refusal(spawnRepositoryRefusal(scope.threadId, ctx.projectHeld(mine).name, ref), SPAWN_REPOSITORY_FIX, "usage");
      }
      if (found === undefined) throw notFoundRefusal(noSuchProjectLine(ref, all.map(p => p.name)));
      return found;
    },

    /** Whether the folder a project lives in still stands on its computer; a road where wsp keeps the project for
     * itself holds no folder of the person's, so none stands. */
    async folderStands(id: string): Promise<boolean> {
      const project = await projectsDoor.resolve(id);
      const { deps, at } = await landingDeps(project.computer);
      return (await projectLanding(landingKind(project.computer, at)).folderStands?.(project, deps)) ?? false;
    },

    /** Copies files off a folder's seed menu into the folder its project stands in on its computer. */
    async seedInto(id: string, plan: SeedPlan, files: readonly string[]): Promise<void> {
      const project = await projectsDoor.resolve(id);
      const { deps, at } = await landingDeps(project.computer);
      const road = projectLanding(landingKind(project.computer, at));
      if (road.seedInto === undefined) throw new Error(`${project.name} keeps no folder of its own on ${deps.computerName} to copy files into`);
      const packed = await seedWiring().pack({ plan, choice: { files: [...files], memory: false, commits: false }, homes: await ctx.homesHere() });
      await road.seedInto(project, packed.tar, deps);
    },

    async remove(id: string, origin?: Caller): Promise<{ said: string }> {
      await ctx.ready();
      ctx.spawnGuard("delete", origin);
      const project = await projectsDoor.resolve(id);
      const held = [...live.values()].filter(e => e.record.project === project.id);
      const standing = held.filter(e => !bareFolder(e.record, ctx.holdsThread(e.record.id))).map(e => e.record.name);
      if (standing.length > 0) throw Object.assign(new Error(projectInUseRefusal(project.name, standing)), { kind: "conflict" });
      const { deps, at, placeId } = await landingDeps(project.computer);
      await readableComputer(at, placeId);
      for (const entry of held) await ctx.workspaces.delete(entry.record.id, origin);
      // What the add made on that computer goes before the record does, so a computer that cannot be reached
      // keeps both and the person can say it again when it is back. The sentence is the road's: it is true
      // differently on a computer of theirs, at a provider and here.
      const said = await projectLanding(landingKind(project.computer, at)).remove(project, deps);
      projectsHeld.delete(project.id);
      await store.delete(PROJECTS, project.id);
      bus.emit({ type: "project.removed", projectId: project.id });
      return { said };
    },
  };

  const projects: Runtime["projects"] = {
    add: projectsDoor.add,
    seedPlan: projectsDoor.seedPlan,
    list: projectsDoor.list,
    async defaults(origin) {
      const prefs = await ctx.preferences.get();
      const runs = (id: string): boolean => adapters[id] !== undefined;
      const catalogOf = (id: string): HarnessCatalog | undefined => {
        const table = runs(id) ? harnessCatalog(id) : undefined;
        return table === undefined ? undefined : withCustomModels(table, prefs.agentDefaults[id]?.models);
      };
      const firstAgent = CATALOG_AGENTS.find(a => runs(a.id))?.id ?? DEFAULT_AGENT.id;
      const held = await projectsDoor.list(origin);
      return Object.fromEntries(held.map(p => [p.id, resolveThreadDefaults({ firstAgent, catalogOf, runs, prefs, ...(prefs.projectDefaults[p.id] !== undefined ? { project: prefs.projectDefaults[p.id] } : {}) })]));
    },
    computers: projectsDoor.computers,
    resolve: projectsDoor.resolve,
    remove: projectsDoor.remove,
    async import(o, origin) {
      ctx.spawnGuard("import", origin);
      const entry = await ctx.entryOf(o.workspaceId, origin);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "import", entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      await ctx.copyBlocked(entry);
      const began = clock.now();
      const report: ImportReport = (stage, message, progress) => {
        bus.emit({ type: "project.import", workspaceId: o.workspaceId, source: o.source, dest: o.dest, stage, message, elapsedMs: clock.now() - began, ...progress });
      };
      try {
        const kind = ctx.moduleOf(entry.record.kind);
        const landed = await kind.import(entry, o, report);
        // A folder landed beside the workspace's own project is browsable too: the record keeps it beside the one
        // project it names, so every later write of the roots file, a restarted host's included, lists it. Named on
        // the record before the write, so a write queued behind this one lists it too, and taken back if the machine
        // refuses the file: this import's folder alone, since another import may have added its own meanwhile.
        const dest = landed.result.dest;
        const had = entry.record.landed?.includes(dest) === true;
        entry.record.landed = [...new Set([...(entry.record.landed ?? []), dest])];
        try {
          await ctx.writeDaemonRoots(entry, true);
        } catch (e) {
          const kept = had ? entry.record.landed : entry.record.landed.filter(d => d !== dest);
          if (kept.length > 0) entry.record.landed = kept;
          else delete entry.record.landed;
          throw e;
        }
        await ctx.persist(entry.record);
        report("done", landed.done);
        return landed.result;
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      }
    },
    async export(o, origin) {
      ctx.spawnGuard("export", origin);
      const entry = await ctx.entryOf(o.workspaceId, origin);
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "export", entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      await ctx.copyBlocked(entry);
      const began = clock.now();
      const report = (stage: ProjectExportStage, message: string, progress?: { bytes: number; total: number }): void => {
        bus.emit({ type: "project.export", workspaceId: o.workspaceId, source: o.source, dest: o.dest, stage, message, elapsedMs: clock.now() - began, ...progress });
      };
      const downloading = (what: string) => (p: { bytes: number; total: number }): void => report("downloading", `${what}: ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}.`, p);
      const scratch = mkdtempSync(join(tmpdir(), "wsp-exported-"));
      // Where the listing writes the filtered copy of a store an agent keeps for every project, mirroring the homes.
      const onMachine = guestTmpPath("wsp-state");
      let listed = false;
      try {
        const homes = guestAgentHomes();
        const listing = stateListing(homes, o.source, onMachine, o.agents);
        const at = await o.lander.probe(o.dest);
        if (at !== undefined && o.replace !== true) throw destExists(o.dest, at.files);
        report("packing", `Packing ${o.source} on the machine.`);
        const archive = join(scratch, "folder.tgz");
        const folder = await exportFolder(entry.machine, o.source, o.lander.caches, archive, { timeoutMs: 600_000, onProgress: downloading("The folder") });
        let found = { exitCode: 0, stdout: "", stderr: "" };
        if (listing !== "") {
          listed = true;
          found = await entry.machine.run(listing, { deadlineMs: LISTING_DEADLINE_MS });
        }
        if (found.exitCode !== 0) throw new Error(`could not look for agent state on the machine: ${found.stderr.slice(-200)}`);
        const { paths: present, unread } = parseStateListing(found.stdout);
        let state: LandRequest["state"];
        if (present.length > 0) {
          report("packing", `Packing the agents' state for it on the machine.`);
          const stateArchive = join(scratch, "state.tgz");
          // A copy travels at the path it mirrors under the scratch root, so the archive is the homes as the project alone left them.
          const groups = [
            { root: "/", paths: present.filter(p => !underProject(p, onMachine)) },
            { root: onMachine, paths: present.filter(p => underProject(p, onMachine)) },
          ].filter(g => g.paths.length > 0);
          await exportPathsInto(entry.machine, groups, stateArchive, { timeoutMs: 600_000, onProgress: downloading("Agent state") });
          state = { archive: stateArchive, homes, ...(o.agents !== undefined ? { agents: o.agents } : {}) };
        }
        report("landing", `Landing at ${o.dest}.`);
        const landed = await o.lander.land({ source: o.source, dest: o.dest, replace: o.replace === true, archive, ...(state !== undefined ? { state } : {}), ...(unread.length > 0 ? { unread } : {}) });
        const outcomes = landed.agents.map(homeOutcome);
        const caches = folder.excluded.length === 0 ? "" : `; ${plural(folder.excluded.length, "cache")} left behind`;
        report("done", `${plural(landed.files, "file")}, ${fmtBytes(landed.bytes)}, landed at ${o.dest}${caches}; ${outcomes.length === 0 ? "no agent sessions for it on the machine" : `sessions: ${outcomes.join(", ")}`}.`);
        return { dest: o.dest, files: landed.files, bytes: landed.bytes, excluded: folder.excluded, agents: landed.agents.map(({ name: _name, ...a }) => a) };
      } catch (e) {
        report("failed", e instanceof Error ? e.message : String(e));
        throw e;
      } finally {
        if (listed) await entry.machine.exec(`rm -rf ${shellQuote(onMachine)}`, { timeoutMs: INLINE_EXEC_MS }).catch(() => {});
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
  return { copyImport, landingKind, landingDeps, projectsDoor, projects };
}
