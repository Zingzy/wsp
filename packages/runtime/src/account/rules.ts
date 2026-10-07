// SPDX-License-Identifier: AGPL-3.0-only
import { type Capabilities, type PreferencesPatch, type ProjectView, type McpServerSpec, type Caller, type WorkspaceAgents, type WorkspaceKind, ThreadScope, phaseHoldsSlot, SPAWN_ACTS_ALLOWED, agentsOffRefusal, roadOf, scopeOf, spawnActRefusal, spawnCapRefusal, spawnDepthRefusal, spawnRepositoryRefusal, spawnReachRefusal, type SpawnAct, forksNoMachines, kindWords, NO_PROVIDER_LINE, providerCannotRefusal, machineWord, noWorkspaceRefusal, notFoundRefusal, type WorktreeFolder, copiesFolder, kindForComputer, relayedRecordRefusal, relayedRefusal, undrivenRefusal, workspaceState, HERE_PLACE_ID } from "@wsp/protocol";
import type { WorkspaceRecord, LiveWorkspace } from "../types/wiring.js";
import { PROJECTS, type WorkspaceLike } from "../types/internal.js";
import type { RuntimeContext, RulesArea } from "../context.js";

export function rulesArea(ctx: RuntimeContext): RulesArea {
  const { opts, store, placeDoor, landing, live, projectsHeld, sessions } = ctx;
  /** What a start that opened a thread leaves on the preferences record: the project the thread landed in, by
   * workspace, the second branch of threadFolder for the next thread there, and the target, the workspace and project
   * a thread or an import asked for from nowhere goes to. Written only when it moves the record, so a second thread
   * on the same project pushes no record to any socket. */
  /** One project's record as it stands now, kept and pushed to every client: the one writer, so no road updates
   * the map without the store or the other way round. */
  const rememberProject = async (project: ProjectView): Promise<void> => {
    projectsHeld.set(project.id, project);
    await store.put(PROJECTS, project.id, project);
  };

  const rememberTarget = async (record: WorkspaceRecord): Promise<void> => {
    const current = await ctx.preferences.get();
    if (current.target?.workspace === record.id) return;
    const patch: PreferencesPatch = { target: { workspace: record.id } };
    await ctx.preferences.set(patch);
  };
  /** Why a verb this workspace's machine cannot take is refused, in the three sentences the three reasons have: a
   * machine wsp does not run has no meaning for a verb that moves a fork, a host with no provider forks nothing at
   * all and says how to get one, and a machine wsp does run is short of that verb's road at its provider. Written
   * once, so every gate below refuses in the words its own reason has. */
  const cannotLine = (record: WorkspaceRecord, action: string): string => {
    const kind = record.kind;
    if (!kindWords(kind).driven) return undrivenRefusal(record.name, machineWord(kind), action);
    if (forksNoMachines(ctx.backendFor(record).capabilities)) return opts.noMachinesLine ?? NO_PROVIDER_LINE;
    return providerCannotRefusal(record.name, machineWord(kind), action);
  };
  /** The one throw every gate below goes through, so every capability a verb reads refuses in the same sentence. */
  const refuseUnless = (entry: LiveWorkspace, able: boolean, action: string): void => {
    if (!able) throw new Error(cannotLine(entry.record, action));
  };
  /** The capability a verb reads before it runs: a machine whose capability is false refuses the verb. Each verb
   * names the capability its own move needs and never a neighbour's: a provider that copies a machine's disk but
   * whose forks boot cold takes a snapshot all the same. */
  const refuseCannot = (entry: LiveWorkspace, can: keyof Omit<Capabilities, "sizes" | "pauseMode">, action: string): void => {
    refuseUnless(entry, ctx.backendFor(entry.record).capabilities[can] === true, action);
  };
  /** Whether a kind's machines pause at all, which is all the runtime asks of the pause mode: the nap and the wake
   * refuse where no mode is declared, with the same sentence, and never read which mode it is. */
  const pauses = (record: WorkspaceRecord): boolean => ctx.backendFor(record).capabilities.pauseMode !== undefined;
  const refusePauseless = (entry: LiveWorkspace, action: string): void => {
    refuseUnless(entry, pauses(entry.record), action);
  };
  /** Whether a workspace holds one of the account's machine slots: only a kind whose machines the provider can nap
   * does, the same fact the pause and wake refusals read, so this computer is never counted against the cap nor
   * named beside the two moves that free a slot. Phase decides the rest off the record alone, since a refusal has
   * no time to ask the provider about every workspace. */
  const holdsSlot = (record: WorkspaceRecord): boolean => pauses(record) && phaseHoldsSlot(record);
  /** The one rule about where a request came from, read by every verb and every list that serves workspaces: a
   * request relayed from a machine drives and sees only the kinds whose module takes one, so this computer's own
   * workspace answers nothing relayed. Today no machine has a road into the host, so nothing relays yet; the rule
   * holds when one appears. */
  const drives = (record: { kind: WorkspaceKind; machineId?: string }, caller: Caller | undefined): boolean => roadOf(caller) !== "relayed" || ctx.moduleOf(record.kind).relayed(record.machineId);
  /** Which workspaces a thread's own token reaches: the one its turn runs on, and the ones its root thread forked.
   * A thread never sees or drives a workspace outside its own tree, whatever the verb, so this sits beside the
   * kind rule rather than in any one of them. A caller that is no thread reaches everything the kind rule allows. */
  const inTree = (record: { id?: string; rootThreadId?: string; worktree?: WorktreeFolder }, scope: ThreadScope | undefined): boolean =>
    // A record with no id is a workspace that does not exist yet, the shape a create is checked against: what a
    // thread may make is the guard's question, not this one's. A worktree on this computer made for the tree is in
    // it as a fork the tree made is.
    scope === undefined ||
    record.id === undefined ||
    record.id === scope.workspaceId ||
    record.rootThreadId === scope.rootThreadId ||
    (record.worktree?.madeFor !== undefined && record.worktree.madeFor === scope.rootThreadId);
  /** Where a thread may open a thread beyond its tree: the project folder of its own project, which every thread
   * of the project shares. Every other act there stays its tree's. */
  const opensIn = (record: WorkspaceRecord, scope: ThreadScope | undefined): boolean =>
    scope !== undefined && copiesFolder(record.kind) && record.worktree === undefined && record.project === projectOfScope(scope);
  /** Which project a thread works on: the one its own workspace holds. A thread whose workspace this host no longer
   * holds works on none, and the project rule then has nothing to compare and leaves the tree rule to refuse. */
  const projectOfScope = (scope: ThreadScope): string | undefined => live.get(scope.workspaceId)?.record.project;
  /** Whether a project is of the repository a thread works on, which is what a create demands of a child, since a
   * child starts on its lead's branch and lands its work back in it. A thread whose workspace this host no longer
   * holds works on none. */
  const ofThreadsRepository = (scope: ThreadScope, project: string): boolean => {
    const mine = projectOfScope(scope);
    return mine !== undefined && (project === mine || ctx.sameRepository(ctx.projectHeld(mine), ctx.projectHeld(project)));
  };
  /** Whether a thread may name a project to start children on: its own, or one of its repository on a computer that
   * forks machines, where the child gets a machine of its own. Another folder of it on this computer is the
   * person's, and a thread started there would stand outside the tree. */
  const projectReached = (scope: ThreadScope, project: string): boolean =>
    ofThreadsRepository(scope, project) && (project === projectOfScope(scope) || !copiesFolder(kindForComputer(ctx.projectHeld(project).computer)));
  /** The rule as a sentence: what this request is refused with for that record, or nothing when it may drive it.
   * A record this host does not hold, which a port forward's target may be since the host forwards a builder's
   * ports too, is nobody's to refuse for. The project rule is read before the tree rule and answers first: a
   * workspace of another project is outside the tree as well, and the project is why. */
  const refusalFor = (record: WorkspaceLike | undefined, caller: Caller | undefined): string | undefined => {
    if (record === undefined) return undefined;
    if (!drives(record, caller)) return relayedRefusal(record.name);
    const scope = scopeOf(caller);
    if (scope === undefined) return undefined;
    const mine = projectOfScope(scope);
    if (mine !== undefined && record.project !== undefined && !ofThreadsRepository(scope, record.project)) {
      return spawnRepositoryRefusal(scope.threadId, ctx.projectHeld(mine).name, ctx.projectHeld(record.project).name);
    }
    return !inTree(record, scope) ? spawnReachRefusal(scope.threadId, record.name) : undefined;
  };
  /** The rule as the caller reads it. A person is told which rule hid the workspace, since what this host holds is
   * theirs; a thread is told absence and nothing more, since a sentence naming a workspace or a project outside its
   * tree is how a thread learns what else stands here. No word rides the thread's: every verb that reaches this
   * found the workspace itself rather than being handed it. The name door, `workspaces.resolve`, differs: a whole
   * word the thread typed is refused by its rule there, carrying that word and nothing else. */
  const refuseRelayed = (record: WorkspaceLike | undefined, caller: Caller | undefined): void => {
    const line = refusalFor(record, caller);
    if (line === undefined) return;
    throw scopeOf(caller) === undefined ? new Error(line) : notFoundRefusal(noWorkspaceRefusal());
  };
  /** The rule for a workspace a caller named by id rather than one a verb found for itself: a thread reads one
   * sentence for an id this host does not hold and for one outside its tree alike, since telling the two apart is
   * how a thread walks what else stands here. A caller that is no thread reads what it always did, an id nobody
   * holds being nobody's to refuse for. */
  const refuseNamed = (workspaceId: string, caller: Caller | undefined): void => {
    const record = live.get(workspaceId)?.record;
    if (record === undefined && scopeOf(caller) !== undefined) throw notFoundRefusal(noWorkspaceRefusal());
    refuseRelayed(record, caller);
  };
  /** Every workspace this host holds, as any door serves them: one a create has not finished is not there yet. */
  const held = (): LiveWorkspace[] => [...live.values()].filter(e => !e.creating);
  /** The workspaces this caller is served, which is the one reading behind the listings and behind resolving a name.
   * Both lists a person meets are built here, so neither can drop a workspace the other keeps and no verb denies a
   * name the listing just showed. */
  const listedFor = (caller: Caller | undefined): LiveWorkspace[] => held().filter(e => refusalFor(e.record, caller) === undefined);
  /** Recording a machine that already exists is this computer's own act, whatever the kind takes once it is
   * recorded: the address and the key a record stands on are the person's to name, so a request relayed from a
   * machine is refused before anything is dialled and again where the record is written. */
  const refuseRecording = (named: string, caller: Caller | undefined): void => {
    if (roadOf(caller) === "relayed") throw new Error(relayedRecordRefusal(named));
  };
  /** The switch that governs a workspace, which is the one on the workspace the root thread of its tree runs on: a
   * fork carries the tree it belongs to and not a rule of its own, so turning a lead's switch off stops everything
   * its threads spawned rather than leaving a copy of the old answer standing on every machine under it. A root
   * whose workspace this host no longer holds governs nothing, so the tree under it spawns nothing more. A switch
   * nobody set on the workspace reads as its place's, and one set on neither as the default. */
  const agentsRecordOf = (record: WorkspaceRecord): WorkspaceRecord | undefined => {
    if (record.rootThreadId === undefined) return record;
    const at = ctx.rowsOn(record.rootThreadId)[0]?.workspaceId;
    return at === undefined ? undefined : live.get(at)?.record;
  };
  const agentsOf = (record: WorkspaceRecord): WorkspaceAgents | undefined => {
    const held = agentsRecordOf(record);
    return held === undefined ? undefined : ctx.agentsHeld(held);
  };
  /** Where the switch a record runs under is held, as the depth refusal names the setting to raise. */
  const agentsHeldAt = (record: WorkspaceRecord): { computer: string } | { workspace: string } => {
    const held = agentsRecordOf(record) ?? record;
    if (held.agents !== undefined) return { workspace: held.name };
    const placeId = ctx.placeIdOf(held) ?? HERE_PLACE_ID;
    return { computer: placeDoor?.nameOf(placeId) ?? placeId };
  };
  /** The tree a thread sits in, read off the rows: its parent, then its parent's, up to the thread a person opened.
   * The walk is bounded by the rows there are, since a chain that somehow looped would otherwise never end. */
  const parentOf = (threadId: string): string | undefined => ctx.rowsOn(threadId).find(v => v.parentThreadId !== undefined)?.parentThreadId;
  const depthUnderRoot = (threadId: string): number => {
    let depth = 0;
    let at = threadId;
    for (let steps = sessions.size + 1; steps > 0; steps--) {
      const parent = parentOf(at);
      if (parent === undefined) return depth;
      depth++;
      at = parent;
    }
    return depth;
  };
  /** The top of the tree a thread is in: the root its own rows carry, and itself when nothing spawned it. */
  const rootOf = (threadId: string): string => ctx.rowsOn(threadId).find(v => v.rootThreadId !== undefined)?.rootThreadId ?? threadId;
  /** How a turn on this workspace's machine reaches this host, and the wsp command it runs there: the kind's own
   * answer for its machines, and nothing where that kind reaches this host nowhere. */
  const agentsReach = (entry: LiveWorkspace): { url?: string; wsp?: McpServerSpec } | undefined => {
    const reach = ctx.moduleOf(entry.record.kind).turnReach(entry);
    if (reach === undefined) return undefined;
    const wsp = ctx.moduleOf(entry.record.kind).wspMcp(entry);
    return { ...reach, ...(wsp !== undefined ? { wsp } : {}) };
  };
  /** The one door every act a thread's own token asks for goes through: the switch on the workspace that thread
   * runs on, then the acts a thread may ask for at all, then how deep it already is, then how many machines its
   * root already holds. A caller that is not a thread passes straight through; nothing here is a second copy of a
   * rule any verb also keeps. */
  const spawnGuard = (act: SpawnAct, caller: Caller | undefined): (() => void) => {
    const free = (): void => {};
    const scope = scopeOf(caller);
    if (scope === undefined) return free;
    const own = live.get(scope.workspaceId)?.record;
    const policy = own === undefined ? undefined : agentsOf(own);
    // Read at the act and not at the mint: a person who turns the switch off while a turn runs has turned it off.
    if (own === undefined || policy?.spawn !== true) throw new Error(agentsOffRefusal(own?.name ?? scope.workspaceId, act));
    if (!SPAWN_ACTS_ALLOWED.includes(act)) throw new Error(spawnActRefusal(scope.threadId, act));
    // The depth cap counts what a thread starts under itself; a send and a bring back start nothing, so a thread
    // at the cap still talks to its tree and still gets its work out.
    if (act === "send" || act === "bring_back") return free;
    const depth = depthUnderRoot(scope.threadId);
    if (depth >= policy.maxDepth) throw new Error(spawnDepthRefusal(scope.threadId, depth, policy.maxDepth, agentsHeldAt(own)));
    if (act !== "fork") return free;
    // Counted off the records rather than kept as a number, so a machine deleted, forgotten or gone frees its place
    // without anything having to remember to give it back, plus the slots forks still landing hold. A record
    // enters the live map only after the provider has answered, so two forks asked for in one tick would both read
    // the same count and both pass; the place is taken here, in the same step the count is read, and handed back by
    // the caller's own finally, the way the name a fork is landing under already is.
    const standing = [...live.values()].filter(e => e.record.rootThreadId === scope.rootThreadId && workspaceState({ phase: e.record.phase }) !== "gone").length;
    const held = landing.get(scope.rootThreadId) ?? 0;
    if (standing + held >= policy.maxMachines) throw new Error(spawnCapRefusal(scope.rootThreadId, standing + held, policy.maxMachines));
    landing.set(scope.rootThreadId, held + 1);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const now = (landing.get(scope.rootThreadId) ?? 1) - 1;
      if (now <= 0) landing.delete(scope.rootThreadId);
      else landing.set(scope.rootThreadId, now);
    };
  };
  /** Where a thread's act lands in its tree: under the thread that asked and its root, which is what the thread
   * tree nests by and what the machine cap counts; nothing for a caller that is no thread. */
  const treeOf = (scope: ThreadScope | undefined): { parentThreadId?: string; rootThreadId?: string } =>
    scope === undefined ? {} : { parentThreadId: scope.threadId, rootThreadId: scope.rootThreadId };
  return {
    rememberProject, rememberTarget, refuseCannot, pauses, refusePauseless, holdsSlot, drives, opensIn, projectOfScope, ofThreadsRepository, projectReached,
    refusalFor, refuseRelayed, refuseNamed, held, listedFor, refuseRecording, agentsOf, parentOf, rootOf, agentsReach,
    spawnGuard, treeOf,
  };
}
