// SPDX-License-Identifier: AGPL-3.0-only
import { type Capabilities, type PreferencesPatch, type ProjectView, type McpServerSpec, type Caller, type WorkspaceAgents, type WorkspaceKind, ThreadScope, phaseHoldsSlot, SPAWN_ACTS_ALLOWED, agentsOffRefusal, roadOf, scopeOf, spawnActRefusal, spawnCapRefusal, spawnDepthRefusal, spawnRepositoryRefusal, spawnReachRefusal, type SpawnAct, forksNoMachines, kindWords, NO_PROVIDER_LINE, providerCannotRefusal, machineWord, noWorkspaceRefusal, notFoundRefusal, type WorktreeFolder, runsInFolder, copiesFolder, childOnAnotherComputerLine, childToLeadsComputerLine, elsewhereWorkspaceLine, type AcrossAct, agentsOffComputerRefusal, rootGoneRefusal, refusal, spawnFolderRefusal, SPAWN_FOLDER_FIX, SPAWN_REPOSITORY_FIX, relayedRecordRefusal, relayedRefusal, undrivenRefusal, workspaceState, HERE_PLACE_ID } from "@wsp/protocol";
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
  /** Which project a thread works on: the one its own workspace holds. A thread whose workspace this host no longer
   * holds works on none, and the project rule then has nothing to compare and leaves the tree rule to refuse. */
  const projectOfScope = (scope: ThreadScope): string | undefined => live.get(scope.workspaceId)?.record.project;
  /** Whether a project is of the repository a thread works on, which is what a create demands of a child, since a
   * child starts on its lead's branch and lands its work back in it. A thread whose workspace this host no longer
   * holds works on none. */
  const ofThreadsRepository = (caller: Caller | undefined, project: string): boolean => {
    const scope = scopeOf(caller);
    const mine = scope === undefined ? undefined : projectOfScope(scope);
    return mine !== undefined && (project === mine || ctx.sameRepository(ctx.projectHeld(mine), ctx.projectHeld(project), caller));
  };
  /** Whether a thread may name a project to start children on: its own, one of its repository on a cloud, where the
   * child gets a machine of its own, and, for a thread on this computer, one of its repository on a box, where the
   * child runs in the project's folder in the tree of the thread that started it. Another folder of it on this
   * computer is the person's, a thread on a machine reaches no box, and a thread on a box starts threads on that box
   * alone, which `elsewhereRefusal` says: a thread started elsewhere would stand outside the tree, or run as the
   * person on a computer of theirs at a machine's word. */
  const projectReached = (caller: Caller | undefined, project: string): boolean => {
    const scope = scopeOf(caller);
    if (scope === undefined || !ofThreadsRepository(caller, project)) return false;
    if (project === projectOfScope(scope)) return true;
    const there = ctx.kindOf(ctx.projectHeld(project).computer);
    if (copiesFolder(there)) return false;
    const asking = live.get(scope.workspaceId)?.record;
    return asking !== undefined && (copiesFolder(asking.kind) || (!runsInFolder(asking.kind) && !runsInFolder(there)));
  };
  /** Where a thread may open a thread beyond its tree: the project folder of a project it may start children on, which
   * every thread of that project shares. Every other act there stays its tree's. */
  const opensIn = (record: WorkspaceRecord, caller: Caller | undefined): boolean =>
    scopeOf(caller) !== undefined && runsInFolder(record.kind) && record.worktree === undefined && projectReached(caller, record.project);
  /** A thread on a box with the computer that box is, the one computer it acts on; nothing for any other caller, a
   * thread on this computer or on a machine included. */
  const boxOf = (caller: Caller | undefined): { scope: ThreadScope; asking: WorkspaceRecord; computer: string } | undefined => {
    const scope = scopeOf(caller);
    const asking = scope === undefined ? undefined : live.get(scope.workspaceId)?.record;
    if (scope === undefined || asking === undefined || !runsInFolder(asking.kind) || copiesFolder(asking.kind)) return undefined;
    return { scope, asking, computer: ctx.projectHeld(asking.project).computer };
  };
  /** The lead of a thread's tree as a caller, the one thread every thread of the tree reaches by message wherever it
   * runs: nothing for a thread that leads its own tree, or whose lead's workspace this host no longer holds. */
  const leadOf = (scope: ThreadScope): { threadId: string; caller: Caller; computer: string } | undefined => {
    const lead = scope.rootThreadId;
    const record = lead === scope.threadId ? undefined : recordOfThread(lead);
    if (record === undefined) return undefined;
    return { threadId: lead, caller: { origin: "here", by: { kind: "thread", threadId: lead, workspaceId: record.id, rootThreadId: lead } }, computer: ctx.projectHeld(record.project).computer };
  };
  const usage = (line: string): Error => Object.assign(new Error(line), { kind: "usage" });
  /** Why a thread on a computer the person joined may not start a child on a project another computer holds, a
   * cloud's included, `word` being what it typed, in the order the project rule reads: another repository's is
   * refused by the repository rule; where the lead of its tree reaches the project, a message to the lead is the
   * road; where the lead runs on the project's computer and does not reach it, the folder rule answers; otherwise
   * the person is the road. Nothing for a thread on no joined computer, or a project on its own, so every door asks
   * it whatever kind the project's computer is. */
  const elsewhereRefusal = (caller: Caller | undefined, project: ProjectView, word: string): Error | undefined => {
    const box = boxOf(caller);
    if (box === undefined || project.computer === box.computer) return undefined;
    const { scope, asking } = box;
    if (!ofThreadsRepository(caller, project.id)) return refusal(spawnRepositoryRefusal(scope.threadId, ctx.projectHeld(asking.project).name, word), SPAWN_REPOSITORY_FIX, "usage");
    const [from, to] = [ctx.placeName(box.computer), ctx.placeName(project.computer)];
    const lead = leadOf(scope);
    if (lead !== undefined && projectReached(lead.caller, project.id)) return usage(childToLeadsComputerLine(from, to, lead.threadId));
    if (lead !== undefined && lead.computer === project.computer) return refusal(spawnFolderRefusal(scope.threadId, word), SPAWN_FOLDER_FIX, "usage");
    return usage(childOnAnotherComputerLine(from, to));
  };
  /** The computer rule: a thread on a box acts on the workspaces of that box alone, and reaches its tree anywhere else
   * by message and the listing. Answers the box and the computer the workspace is on where the rule keeps it out. */
  const awayOn = (record: WorkspaceLike, caller: Caller | undefined): { box: string; on: string } | undefined => {
    const box = boxOf(caller);
    const project = box === undefined || record.project === undefined ? undefined : projectsHeld.get(record.project);
    return box === undefined || project === undefined || project.computer === box.computer ? undefined : { box: box.computer, on: project.computer };
  };
  /** Whether a caller acts on a workspace's threads beyond a message: stops, steers, renames and reads them, sends them
   * files and waits on them. The kind rule, then the computer rule. */
  const actsOn = (record: WorkspaceLike, caller: Caller | undefined): boolean => drives(record, caller) && awayOn(record, caller) === undefined;
  /** The lead a thread on a box asks to act on a workspace of another computer for it: the lead of its tree, where the
   * lead drives that workspace itself, which is its own tree's machines and its own folder. */
  const leadActsOn = (record: WorkspaceLike, caller: Caller | undefined): string | undefined => {
    const box = boxOf(caller);
    const lead = box === undefined ? undefined : leadOf(box.scope);
    return lead !== undefined && refusalFor(record, lead.caller) === undefined ? lead.threadId : undefined;
  };
  /** The computer rule as a thread reads it, `act` being what it asked to do there and `word` what it named the
   * workspace by: a message to its lead where the lead may do that there itself, the person otherwise. */
  const awayFor = (record: WorkspaceLike, caller: Caller | undefined, act: AcrossAct, word: string): Error | undefined => {
    const away = awayOn(record, caller);
    return away === undefined ? undefined : usage(elsewhereWorkspaceLine(word, ctx.placeName(away.on), ctx.placeName(away.box), act, leadActsOn(record, caller)));
  };
  /** Whether a request comes from a thread on a computer the person joined, which reaches every thread of its own tree
   * for a message and a listing wherever that thread runs: its lead and its siblings on this computer are how it talks
   * back, and a thread of another tree stays out of reach by the tree rule. */
  const talksToItsTree = (caller: Caller | undefined): boolean => boxOf(caller) !== undefined;
  /** The rule as a sentence: what this request is refused with for that record, or nothing when it may drive it.
   * A record this host does not hold, which a port forward's target may be since the host forwards a builder's
   * ports too, is nobody's to refuse for. The project rule is read before the computer rule, and both before the
   * tree rule, and the first answers: a workspace of another project is outside the tree as well, and the project
   * is why. */
  const refusalFor = (record: WorkspaceLike | undefined, caller: Caller | undefined): string | undefined => {
    if (record === undefined) return undefined;
    if (!drives(record, caller)) return relayedRefusal(record.name);
    const scope = scopeOf(caller);
    if (scope === undefined) return undefined;
    const mine = projectOfScope(scope);
    if (mine !== undefined && record.project !== undefined && !ofThreadsRepository(caller, record.project)) {
      return spawnRepositoryRefusal(scope.threadId, ctx.projectHeld(mine).name, ctx.projectHeld(record.project).name);
    }
    const away = awayFor(record, caller, "work", record.name);
    if (away !== undefined) return away.message;
    return !inTree(record, scope) ? spawnReachRefusal(scope.threadId, record.name) : undefined;
  };
  /** The rule as the caller reads it, `act` being what the verb asked. A person is told which rule hid the workspace,
   * since what this host holds is theirs; a thread is told absence and nothing more, since a sentence naming a
   * workspace or a project outside its tree is how a thread learns what else stands here, but for a workspace on
   * another computer its lead acts on, its tree's or the lead's own, which it already knows and reads the computer
   * rule's words for. No word rides the thread's: every verb that reaches this found the workspace itself rather
   * than being handed it. The name door, `workspaces.resolve`, differs: a whole word the thread typed is refused by
   * its rule there, carrying that word and nothing else. */
  const refuseRelayed = (record: WorkspaceLike | undefined, caller: Caller | undefined, act: AcrossAct = "work"): void => {
    const line = refusalFor(record, caller);
    if (line === undefined) return;
    if (scopeOf(caller) === undefined) throw new Error(line);
    throw (record !== undefined && leadActsOn(record, caller) !== undefined ? awayFor(record, caller, act, record.name) : undefined) ?? notFoundRefusal(noWorkspaceRefusal());
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
  const agentsRecordOf = (record: WorkspaceRecord): WorkspaceRecord | undefined => (record.rootThreadId === undefined ? record : recordOfThread(record.rootThreadId));
  /** The workspace a thread runs on, read off its record, which no cap trims, and off its rows for a thread from
   * before the record. */
  const recordOfThread = (threadId: string): WorkspaceRecord | undefined => {
    const at = ctx.threadRecords.get(threadId)?.workspaceId ?? ctx.rowsOn(threadId)[0]?.workspaceId;
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
  /** The refusal for a switch that is off, naming where it is held: the workspace whose switch governs a tree, and for a
   * folder a thread shares with the person's own threads, its own switch where it holds one and its computer's
   * where it does not. */
  const agentsOffLine = (record: WorkspaceRecord, act: SpawnAct, shared: boolean): string => {
    if (!shared) return agentsOffRefusal((agentsRecordOf(record) ?? record).name, act);
    const held = agentsHeldAt(record);
    return "workspace" in held ? agentsOffRefusal(held.workspace, act) : agentsOffComputerRefusal(held.computer, act);
  };
  /** The tree a thread sits in, read off its record, which no cap trims, and off its rows for a thread from before the
   * record: its parent, then its parent's, up to the thread a person opened. The walk is bounded by the threads there
   * are, since a chain that somehow looped would otherwise never end. */
  const parentOf = (threadId: string): string | undefined => ctx.threadRecords.get(threadId)?.parentThreadId ?? ctx.rowsOn(threadId).find(v => v.parentThreadId !== undefined)?.parentThreadId;
  const depthUnderRoot = (threadId: string): number => {
    let depth = 0;
    let at = threadId;
    for (let steps = sessions.size + ctx.threadRecords.size + 1; steps > 0; steps--) {
      const parent = parentOf(at);
      if (parent === undefined) return depth;
      depth++;
      at = parent;
    }
    return depth;
  };
  /** The top of the tree a thread is in: the root its record or its rows carry, and itself when nothing spawned it. */
  const rootOf = (threadId: string): string => ctx.threadRecords.get(threadId)?.rootThreadId ?? ctx.rowsOn(threadId).find(v => v.rootThreadId !== undefined)?.rootThreadId ?? threadId;
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
    if (own === undefined) throw new Error(agentsOffRefusal(scope.workspaceId, act));
    // Every switch over the thread holds, each read at the act and not at the mint, since a person who turns one off
    // while a turn runs has turned it off: the one on the workspace its root runs on, which a fork carries, and where
    // it runs in a folder its root does not, that folder's own, which is its computer's where the folder holds none.
    const rooted = scope.rootThreadId === scope.threadId ? own : recordOfThread(scope.rootThreadId);
    const over = rooted === undefined ? undefined : [{ record: rooted, policy: agentsOf(rooted) }, ...(rooted.id !== own.id && runsInFolder(own.kind) ? [{ record: own, policy: agentsOf(own) }] : [])];
    if (over === undefined) throw new Error(rootGoneRefusal(scope.threadId, act));
    for (const { record, policy } of over) if (policy?.spawn !== true) throw new Error(agentsOffLine(record, act, record === own && record !== rooted));
    if (!SPAWN_ACTS_ALLOWED.includes(act)) throw new Error(spawnActRefusal(scope.threadId, act));
    // The depth cap counts what a thread starts under itself; a send and a bring back start nothing, so a thread
    // at the cap still talks to its tree and still gets its work out.
    if (act === "send" || act === "bring_back") return free;
    const depth = depthUnderRoot(scope.threadId);
    const deepest = over.reduce((a, b) => (b.policy!.maxDepth < a.policy!.maxDepth ? b : a));
    const policy = { maxDepth: deepest.policy!.maxDepth, maxMachines: Math.min(...over.map(o => o.policy!.maxMachines)) };
    if (depth >= policy.maxDepth) throw new Error(spawnDepthRefusal(scope.threadId, depth, policy.maxDepth, agentsHeldAt(deepest.record)));
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
    rememberProject, rememberTarget, refuseCannot, pauses, refusePauseless, holdsSlot, drives, actsOn, opensIn, projectOfScope, ofThreadsRepository, projectReached, elsewhereRefusal, awayFor, leadActsOn, talksToItsTree,
    refusalFor, refuseRelayed, refuseNamed, held, listedFor, refuseRecording, agentsOf, parentOf, rootOf, agentsReach,
    spawnGuard, treeOf,
  };
}
