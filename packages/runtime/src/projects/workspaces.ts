// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { GUEST_HOME, remoteHost } from "@wsp/catalog";
import { NotFirstLifeError, RestoreUnfinishedError, ResumeUnansweredError, goldenHead, isMissing, readGone, MachineAliveError, answerOf, diskUse, projectSnapshotName, syncDisk, CHECK_MS, INLINE_EXEC_MS, checkScripts, projectInstalls } from "@wsp/engine";
import type { ProjectGolden, ProjectView, WorkspaceProject } from "@wsp/protocol";
import { noParentWorkspaceLine, parentProjectRefusal, BringBackResult, GitPrReply, GitPushReply, GitCommitReply, GitDiscardReply, GitDiffReply, GitRunLogReply, GitPrMergeReply, GitMergeInReply, DETACHED_HEAD, leadBusyRefusal, FIX_CHECK_OR_CHILD, childOnNoBranchRefusal, mergeChildPrompt, mergeIntoOwnRefusal, noRemoteForTreeLine, type TreeRecord, GitPrReplyReply, GitPrResolveReply, GitPrReactReply, REPLY_EMPTY_LINE, type PullRequestItem, GIT_DIFF_CAP_BYTES, pullRequestSendPrompt, checkFailedPrompt, conflictsPrompt, checkNotFailedRefusal, childPushedLine, isPullRequestFact, mergeMethodRefusal, noPullRequestRefusal, noSuchCheckRefusal, notOpenRefusal, AUTO_MERGE_OFF_LINE, DRAFT_NOTES, cleanCheckoutLine, commitMessage, cutDiff, draftPrompt, agentsFrom, agentsKindRefusal, agentsMayDrive, askerOf, scopeOf, spawnActRefusal, spawnGoldenRefusal, workspaceIdOf } from "@wsp/protocol";
import { isLocalWorkspace, kindWords, noCommandsYetLine, readingRoad, forgetUndrivenRefusal, goneRefusal, goneWords, imageMoveRefusal, inFolder, machineWord, deleteRefusedLine, snapshotRefusedLine, snapshotManagerLine, noWorkspaceRefusal, ID_PREFIX_MIN, idPrefixRefusal, notFoundRefusal, refusalLine, notOnThisComputerLine, noBranchesLine, notMadeWorktreeLine, WORKTREE_FORCE_LINE, copiesFolder, copyTakesNone, kindForComputer, shellQuote, WAKE_STOPPED, wakeAsksIn, wakeGaveUpLine, workspaceState, HERE_PLACE_ID, placeServesDaemonLine, placeNotAWorkspaceLine, placeNotAWorkspaceFix, refusal, execOutsideFix, execOutsideRefusal, spawnFolderRefusal, spawnReachFix, spawnReachRefusal, spawnRepositoryWorkspaceRefusal, SPAWN_FOLDER_FIX, SPAWN_REPOSITORY_WORKSPACE_FIX } from "@wsp/protocol";
import { harnessExec, putFiles } from "@wsp/engine";
import { ownerRepoOf } from "@wsp/protocol";
import { providerSaid } from "../status.js";
import { harnessCatalog, smallestModel } from "../harness-catalog.js";
import { GitPrDiffReply, GitPrReviewReply, START_WORDS, fromTaskPrompt, githubLinkOf, isReviewRead, reviewTaskPrompt, withCloses } from "@wsp/protocol";
import { TITLE_MAKE_TIMEOUT_MS } from "../types/events.js";
import { type LiveWorkspace, settled, lastLineOf, PORT_PROBE_TIMEOUT_MS, PORT_PROBE_BODY_CAP, VAULTS } from "../types/wiring.js";
import { loginEnvOn } from "../types/harness.js";
import type { Runtime } from "../types/api.js";
import { PROJECT_GOLDENS, WORKSPACE_NAMES, DELETED_REASON, type NamedWorkspace, CREATES, readBodyUpTo, isNoHostCli, isNoGitCredential } from "../types/internal.js";
import type { RuntimeContext, WorkspacesArea } from "../context.js";

export function workspacesArea(ctx: RuntimeContext): WorkspacesArea {
  const {
    store, adapters, local, placeDoor, bus, clock, githubCache, readsState, tookTheResume, sleeps, imageMovePlan, live,
    threadRecords, sessions, execs, places,
  } = ctx;
  const workspaces: Runtime["workspaces"] = {
    async landing(o, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(o.project, origin);
      const computer = project.computer;
      const kind = kindForComputer(computer);
      if (copiesFolder(kind)) return { name: ctx.placeName(HERE_PLACE_ID), capabilities: ctx.backendOfKind(kind).capabilities };
      const { placeId } = await ctx.landingPlace(computer);
      const at = await ctx.landingBackend(placeId);
      return { ...(placeId !== undefined ? { place: placeId } : {}), name: ctx.placeName(placeId ?? places.wired), capabilities: at.capabilities };
    },

    async create(opts, origin) {
      await ctx.ready();
      const asked = scopeOf(origin);
      // A thread forks the image its own workspace's project runs and names none.
      if (asked !== undefined && opts.golden !== undefined) throw Object.assign(new Error(spawnGoldenRefusal(asked.threadId)), { kind: "invalid" });
      // A create a thread asked for is a child of the workspace that thread runs on and of no other, named or not:
      // a thread's workspaces are its own tree, nothing it makes stands beside it as a sibling of the person's, and
      // a workspace it names is one whose branch it may not read.
      const bornOf = asked === undefined ? opts.parent : asked.workspaceId;
      const o = { ...opts, name: ctx.nameGiven(opts.name), ...(bornOf !== undefined ? { parent: bornOf } : {}) };
      const project = await ctx.projectsDoor.resolve(o.project, origin);
      // The project's computer decides which road this create takes, off the one table that says whether a kind
      // copies a folder on this computer or forks an image; the origin rule is then read on that kind.
      const kind = kindForComputer(project.computer);
      // The same rule and the same sentence the verb that sets the switch on a workspace that exists reads, so a
      // create on a computer whose agents could not drive this host is refused rather than given a dead switch.
      if (o.agents?.spawn === true && !agentsMayDrive(kind)) throw Object.assign(new Error(agentsKindRefusal(kind)), { kind: "invalid" });
      // Read before anything is asked of a machine: the project rule refuses a thread naming another project here,
      // as the same reading refuses it every workspace of one. A computer that copies its folders takes no relayed
      // request at all and says so in its own words below.
      const copies = copiesFolder(kind);
      // A project on this computer is its folder: a create there names the folder's record, the one every thread in
      // that folder shares, and makes nothing.
      if (copies) {
        ctx.refuseRecording(o.name, origin);
        // The folder is not forked, so the words a fork takes have nothing to act on: refused rather than ignored.
        const forkWords = [o.golden !== undefined ? "--from" : "", o.cpu !== undefined || o.memMb !== undefined ? "--size" : "", o.engine === true ? "--engine" : ""].filter(w => w !== "");
        if (forkWords.length > 0) throw Object.assign(new Error(copyTakesNone(project.name, forkWords)), { kind: "invalid" });
        if (asked !== undefined && o.agents !== undefined) throw new Error(spawnActRefusal(asked.threadId, "agents"));
        const folder = await ctx.projectFolder(project);
        if (o.agents !== undefined) {
          folder.record.agents = agentsFrom(ctx.spawnAt(HERE_PLACE_ID), o.agents);
          await ctx.persist(folder.record);
        }
        return ctx.view(folder.record);
      }
      ctx.refuseRelayed({ kind, name: o.name, project: project.id }, origin);
      // A child of another workspace starts where that workspace is now, not where the project starts. A parent
      // this host does not hold, and one whose own create has not finished, are refused rather than dropped, since
      // a create that dropped it would land as somebody's root; the branch itself is read off the parent's machine
      // below, once this create is allowed.
      const parent = o.parent === undefined ? undefined : live.get(o.parent);
      if (o.parent !== undefined && (parent === undefined || parent.creating === true)) throw Object.assign(new Error(noParentWorkspaceLine(o.parent)), { kind: "invalid" });
      // A child is a second checkout of its parent's repository on the branch that parent is on, so a parent holding
      // another repository has no branch this child could start from and land its work back in. The same repository
      // added on another computer is the same code, which is how a lead on this computer starts a child on a box.
      if (parent !== undefined && parent.record.project !== project.id && !ctx.sameRepository(ctx.projectHeld(parent.record.project), project)) {
        throw Object.assign(new Error(parentProjectRefusal(parent.record.name, ctx.projectHeld(parent.record.project).name, project.name)), { kind: "invalid" });
      }
      await ctx.placeGuard((await ctx.landingPlace(project.computer)).placeId ?? places.wired);
      // The place under the root is taken here, with no await between the count and the taking, and handed back in
      // the finally below however this create ends: the record it becomes is what holds it from then on. A copy on
      // this computer is a child in the tree as a fork is, so it takes the same place.
      const freePlace = ctx.spawnGuard("fork", origin);
      const spawned = scopeOf(origin);
      // A thread's fork carries the switch of the workspace it was asked from, and nothing the caller says: the
      // caps are the person's, and a fork naming its own would be the agents act by another road.
      if (spawned !== undefined && o.agents !== undefined) {
        freePlace();
        throw new Error(spawnActRefusal(spawned.threadId, "agents"));
      }
      const refusal = ctx.nameRefusal(o.name);
      if (refusal !== undefined) {
        freePlace();
        throw Object.assign(new Error(refusal), { kind: "conflict" });
      }
      ctx.forking.add(o.name);
      ctx.supersedeFailed(o.name);
      const id = `ws_${randomBytes(4).toString("hex")}`;
      const began = clock.now();
      const report = ctx.stageReporter(id, o.name, began, spawned);
      try {
        // Read inside the try, so a parent that did not answer gives the name and the slot back the way every
        // other end of this create does, and after the guard, so what a thread may do is decided before anything
        // is asked of a machine.
        const start = parent === undefined ? undefined : await ctx.leadStart(parent, o.name);
        const made = await ctx.createStaged(o, project, id, report, spawned, freePlace, start?.base);
        if (start === undefined) return made;
        const lines = [...start.lines, ...(start.onLeads && start.base !== undefined ? [await ctx.startChildOn(live.get(id)!, start.base, parent!.record.name)] : [])];
        return lines.length === 0 ? made : { ...made, notice: [made.notice, ...lines].filter(l => l !== undefined).join("\n") };
      } catch (e) {
        // A machine already forked goes with the failed create, so the retry forks a fresh one; one the provider
        // will not part with keeps its record instead, since a machine nobody records bills unseen.
        const entry = live.get(id);
        let kept: LiveWorkspace | undefined;
        if (entry !== undefined) {
          const gone = await ctx.unfork(entry).then(() => true, (k: unknown) => isMissing(k));
          if (gone) live.delete(id);
          else {
            kept = entry;
            delete entry.creating;
            await ctx.persist(entry.record).catch((p: unknown) => console.warn(`workspace ${id} not stored: ${p instanceof Error ? p.message : String(p)}`));
            console.warn(`workspace ${id} failed to create and its machine ${entry.machine.id} would not stop; the record stays for wsp delete`);
          }
        }
        // The id dies with a failed create, so nothing could ever retry under its key.
        await store.delete(CREATES, `workspace/${id}`);
        const said = e instanceof Error ? e.message : String(e);
        report("failed", said);
        if (kept !== undefined) bus.emit({ type: "workspace.created", workspace: ctx.view(kept.record) });
        else ctx.failedCreates.set(id, ctx.failedView(id, o.name, kind, o.golden ?? "", began, project, said));
        throw e;
      } finally {
        ctx.forking.delete(o.name);
        freePlace();
      }
    },

    async get(id, origin) {
      return ctx.view((await ctx.entryOf(id, origin)).record);
    },

    async agents(id, patch, origin) {
      ctx.spawnGuard("agents", origin);
      const entry = await ctx.entryOf(id, origin);
      // The same rule the create that names the switch reads, off the one table of what each kind's machines are:
      // a kind whose agents could not drive this host is refused the switch rather than given one that does nothing.
      if (patch.spawn === true && !agentsMayDrive(entry.record.kind)) throw new Error(agentsKindRefusal(entry.record.kind));
      const next = agentsFrom(ctx.agentsHeld(entry.record), patch);
      entry.record.agents = next;
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.agents", workspaceId: id, agents: next });
      return ctx.view(entry.record);
    },

    async list(origin) {
      await ctx.ready();
      return ctx.listedFor(origin).map(e => ctx.view(e.record));
    },

    async resolve(ref, origin, verb) {
      await ctx.ready();
      const scope = scopeOf(origin);
      const rows = scope === undefined ? ctx.held() : ctx.listedFor(origin);
      // The whole of an id, then the whole of a name, as a thread's own reference does: a name names one workspace at
      // most, since the create and the rename both refuse a name another already holds, and a word that is one is
      // that workspace whatever else it starts. Only a word that is neither reaches the prefix, where enough of an
      // id is the way round quoting a name with spaces and a word that starts two is refused with both ids.
      const exact = rows.find(e => e.record.id === ref) ?? rows.find(e => e.record.name === ref);
      const started = exact === undefined && ref.length >= ID_PREFIX_MIN ? rows.filter(e => e.record.id.startsWith(ref)) : [];
      if (started.length > 1) throw new Error(idPrefixRefusal(ref, started.map(e => e.record.id)));
      const entry = exact ?? started[0];
      if (entry === undefined) {
        if (scope !== undefined) {
          // A whole id or name the person holds outside the thread's tree, a workspace's or a project's, is refused
          // by the rule that keeps it out, so a lead learns what to do instead, in words that carry the word the
          // thread typed and nothing of the workspace it may not see. A word that names nothing, or only starts an
          // id, reads as absent. A run names a project here when the thread's listing did not carry it, and the
          // project door refuses one the thread may not use in its own words. Exec starts nothing, so its refusal
          // says what the word is and its road is exec on the machine the thread runs on.
          const mine = ctx.projectOfScope(scope);
          const own = verb === "exec" && mine !== undefined ? ctx.live.get(scope.workspaceId)?.record.name : undefined;
          const execFix = own === undefined ? undefined : execOutsideFix(own);
          const outside = (is: "folder" | "project" | "workspace", fix: string): Error => refusal(execOutsideRefusal(scope.threadId, ref, is), fix, "usage");
          const theirs = ctx.held().find(e => e.record.id === ref) ?? ctx.held().find(e => e.record.name === ref);
          if (theirs !== undefined && mine !== undefined && ctx.refusalFor(theirs.record, origin) !== undefined) {
            const project = ctx.projectHeld(theirs.record.project);
            if (!ctx.ofThreadsRepository(scope, project.id)) throw execFix !== undefined ? outside("workspace", execFix) : refusal(spawnRepositoryWorkspaceRefusal(scope.threadId, ctx.projectHeld(mine).name, ref), SPAWN_REPOSITORY_WORKSPACE_FIX, "usage");
            if (!ctx.projectReached(scope, project.id)) throw execFix !== undefined ? outside("folder", execFix) : refusal(spawnFolderRefusal(scope.threadId, ref), SPAWN_FOLDER_FIX, "usage");
            throw refusal(spawnReachRefusal(scope.threadId, ref), execFix ?? spawnReachFix(project.name, !copiesFolder(kindForComputer(project.computer))), "usage");
          }
          if (execFix !== undefined) {
            const held = [...ctx.projectsHeld.values()];
            const project = held.find(p => p.id === ref) ?? held.find(p => p.name === ref);
            if (project !== undefined && !ctx.projectReached(scope, project.id)) throw outside(ctx.ofThreadsRepository(scope, project.id) ? "folder" : "project", execFix);
          }
          await ctx.projectsDoor.resolve(ref, origin).catch((e: unknown) => {
            if ((e as { kind?: unknown }).kind !== "not-found") throw e;
          });
          throw notFoundRefusal(noWorkspaceRefusal(ref));
        }
        const failed = [...ctx.failedCreates.values()].find(v => v.id === ref || v.name === ref);
        if (failed !== undefined) return failed;
        // A computer somebody joined is a place, and a place is no workspace: the word is answered with the road to
        // one there rather than with absence, since the person typed the name of something this host does hold.
        const place = (await placeDoor?.find(ref)) ?? [];
        if (place.length > 0) throw notFoundRefusal(refusalLine(placeNotAWorkspaceLine(place[0]!.name), placeNotAWorkspaceFix(place[0]!.name)));
        throw notFoundRefusal(noWorkspaceRefusal(ref));
      }
      ctx.refuseRelayed(entry.record, origin);
      return ctx.view(entry.record);
    },

    async nap(id, origin) {
      ctx.spawnGuard("pause", origin);
      ctx.refusePauseless(await ctx.entryOf(id, origin), "be paused");
      return ctx.napWith(id);
    },

    async wake(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      if (entry.waking) return entry.waking;
      if (entry.record.phase === "gone") {
        const left = await ctx.recoverGone(entry);
        if (left === undefined) throw new Error(goneRefusal(entry.record.name, "wake", entry.record.gone));
        // A record that left gone for napping is a machine the provider holds paused: the wake goes on and resumes it.
        if (left === "running") return ctx.view(entry.record);
      }
      if (entry.napping) await entry.napping.catch(() => {});
      // A wake nobody should need is the one sign the provider paused the machine on its own, or lost it, and a wake of
      // a machine the provider runs would be refused with its words: one read settles any, and the record follows the fact.
      if (entry.record.phase === "running") {
        let answer: string | undefined;
        const read = await entry.machine.state().catch((e: unknown) => {
          if (!isMissing(e)) return "running";
          answer = providerSaid(e);
          return "gone";
        });
        if (read === "gone" && settled(await ctx.settleGone(entry, goneWords(entry.record.machineId, { by: "wake", at: clock.now(), ...(answer !== undefined ? { answer } : {}) })))) {
          throw new Error(goneRefusal(entry.record.name, "wake", entry.record.gone));
        }
        if (read === "paused") await ctx.adoptPause(entry);
      } else if (await ctx.runsUnderNapping(entry)) await ctx.adoptRunning(entry);
      // A wake that began while this one read the machine is the one this caller waits on.
      if (entry.waking) return entry.waking;
      // A running workspace has nothing to wake, whatever its kind; only a real resume asks the machine for one.
      if (entry.record.phase === "running") return entry.unchecked === true ? ctx.proven(entry) : ctx.view(entry.record);
      ctx.refusePauseless(entry, "be woken");
      entry.waking = (async () => {
        // The stop the person pulls from the row. It aborts the provider call the ask is on rather than walking away
        // from one that keeps running: an abandoned resume would go on to run its cap out, write its line back onto
        // a row that reads Paused, and leave a second lifecycle wake beside the next one.
        const stop = new AbortController();
        entry.wakeStop = stop;
        const stopped = (): boolean => stop.signal.aborted;
        /** Resolves as its promise does, or at once when the stop is pulled; only the wait between two asks needs
         * this, since the abort ends an ask on its own. */
        const orStopped = <T>(p: Promise<T>): Promise<T | "stopped"> =>
          stopped()
            ? Promise.resolve("stopped" as const)
            : Promise.race([p, new Promise<"stopped">(resolve => stop.signal.addEventListener("abort", () => resolve("stopped"), { once: true }))]);
        const began = clock.now();
        // How the backend has the host ask again after a resume its provider did not take; none means once.
        const asks = ctx.lifecycleOf(entry).budgets.resumeAsks;
        const wakeAsks = asks === undefined ? 1 : wakeAsksIn(asks.forMs, asks.everyMs);
        try {
          delete entry.deleteSaid;
          entry.record.phase = "waking";
          await ctx.persist(entry.record);
          await ctx.emitStatus(entry, "napping");
          // Ask 1 is the person's wake; every ask after it is the host's own, once a cadence apart, so a provider
          // that comes back inside its own outage wakes the machine without the person having to try again. The
          // record stays waking between two asks: nothing about the machine changed, only who is asking.
          // Set when the read before an ask found the machine already up: that ask sends no second resume and the
          // engine's wake goes straight to the guest check, first life ending there as on any other road.
          let landed = false;
          for (let ask = 1; ; ask++) {
            try {
              const result = await entry.ws.wake({ landed });
              if (stopped()) throw new Error(WAKE_STOPPED);
              ctx.followMachine(entry);
              delete entry.record.wakeRefused;
              await ctx.persist(entry.record);
              bus.emit({ type: "workspace.woken", workspaceId: id, machineId: entry.record.machineId });
              if (result.reason !== undefined) console.warn(`wake of ${id}: ${result.reason}`);
              await ctx.emitStatus(entry, ctx.reachOf(entry), result.reason);
              return ctx.view(entry.record);
            } catch (e) {
              if (!stopped() && e instanceof ResumeUnansweredError && ask < wakeAsks) {
                entry.wakeAsk = { ask, of: wakeAsks };
                delete entry.wakeSaid;
                await ctx.emitStatus(entry, "napping");
                // The cadence is wall time from the wake's start, so the half hour of asking is half an hour: a
                // resume that sat on its cap for half the minute leaves half a minute to wait, and one that ran
                // longer than the cadence is asked again at once.
                if ((await orStopped(sleeps(Math.max(0, began + ask * asks!.everyMs - clock.now())))) !== "stopped") {
                  // The retry reads the machine before it asks: a call that hung at the provider can land in the
                  // minute since, and a resume is worth sending only while the machine still reads paused.
                  landed = tookTheResume(await readsState(entry.machine));
                  continue;
                }
              }
              // A resume the provider answered 404 for is a sighting like any other: the record settles gone only
              // where the reads agree, and the refusal says what went with the machine.
              if (!stopped() && isMissing(e) && settled(await ctx.settleGone(entry, goneWords(entry.record.machineId, { by: "wake", at: clock.now(), answer: providerSaid(e) })))) {
                throw new Error(goneRefusal(entry.record.name, "wake", entry.record.gone));
              }
              // The provider would not resume it for the whole of the asking: the record carries the road out until
              // something replaces the machine, since nothing about it changes on its own from here.
              const gaveUp = !stopped() && e instanceof ResumeUnansweredError ? wakeGaveUpLine(ask, clock.now() - began) : undefined;
              if (gaveUp !== undefined) entry.record.wakeRefused = gaveUp;
              // A stop leaves the machine where the abort found it: paused, until the late read says otherwise.
              if (stopped()) entry.ws.notePaused();
              entry.record.phase = entry.ws.currentPhase;
              await ctx.persist(entry.record);
              delete entry.wakeAsk;
              const unfinished = !stopped() && e instanceof RestoreUnfinishedError ? noCommandsYetLine(entry.record.name, e.message) : undefined;
              const words = stopped() ? WAKE_STOPPED : (gaveUp ?? unfinished ?? (e instanceof Error ? e.message : String(e)));
              if (!stopped()) console.warn(`wake of ${id} failed: ${words}`);
              await ctx.emitStatus(entry, "napping", words);
              ctx.armLateRead(entry);
              throw stopped() ? new Error(WAKE_STOPPED) : gaveUp !== undefined ? new Error(gaveUp) : unfinished !== undefined ? new Error(unfinished) : e;
            }
          }
        } finally {
          delete entry.wakeStop;
          delete entry.wakeSaid;
          delete entry.wakeAsk;
          delete entry.waking;
        }
      })();
      return entry.waking;
    },

    async stopWake(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const waking = entry.waking;
      entry.wakeStop?.abort();
      await waking?.catch(() => {});
      return ctx.view(entry.record);
    },

    async upgrade(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "replacesMachine", "have its machine replaced");
      await entry.ws.upgrade();
      ctx.followMachine(entry);
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      return ctx.view(entry.record);
    },

    async updateImage(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "replacesMachine", "move to a newer image");
      const manifest = await ctx.goldenManifestOf(entry.record.golden);
      const head = goldenHead(manifest);
      const project = (await store.get(PROJECT_GOLDENS, entry.record.golden)) as ProjectGolden | undefined;
      const refusal = imageMoveRefusal(entry.record.name, workspaceState({ phase: entry.record.phase }), { knownVersion: head !== undefined, projectImage: project !== undefined });
      if (refusal !== null) throw Object.assign(new Error(refusal), { kind: "conflict" });
      // The refusal covers an image no manifest knows, so both are there by the time the move runs.
      const to = head!;
      const was = entry.record.golden;
      const from = manifest!.versions.find(v => v.snapshotId === was);
      if (to.snapshotId === was) return { workspace: ctx.view(entry.record), moved: false, kept: [] };
      // The archive is what lands and --recursive-unlink cannot merge, so which of the image's own files the fork
      // keeps is settled here, off the machine that is still running, before anything is replaced.
      const plan = await imageMovePlan(entry.machine, from, to);
      // The fork reads the record, so the new image is named before the machine is replaced; the vault carries the
      // work across. A move that throws puts the record back, so a retry forks what the
      // workspace is actually running.
      entry.record.golden = to.snapshotId;
      try {
        await entry.ws.upgrade(undefined, { drop: plan.drop.map(path => `${GUEST_HOME}/${path}`) });
      } catch (e) {
        entry.record.golden = was;
        throw e;
      }
      ctx.followMachine(entry);
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      await ctx.emitStatus(entry, ctx.reachOf(entry), `moved from image v${from?.version ?? "?"} to v${to.version}`);
      return { workspace: ctx.view(entry.record), moved: true, kept: plan.kept, ...(plan.fallback ? { fallback: true } : {}) };
    },

    async rebuild(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "replacesMachine", "be rebuilt");
      if (entry.waking) await entry.waking.catch(() => {});
      if ((await ctx.recoverGone(entry)) !== undefined) return ctx.view(entry.record);
      const at = ctx.backendFor(entry.record);
      // Where the pause keeps the disk no nap stored a vault, so a rebuild takes one off the running machine before
      // the replacement, over the cap or unreadable going on with none. A napped one holds its home on its paused
      // disk, so it is woken first and the vault taken live, not the one a nap stored (this rule stores none); a wake
      // that cannot land refuses the rebuild rather than replacing with no backup. Where the pause does not keep the
      // disk, the rebuild reads the vault the nap stored.
      if (ctx.keepsImages(at) && ctx.pauseKeepsDisk(at) && entry.record.phase !== "running") {
        try {
          await workspaces.wake(id, origin);
        } catch (e) {
          throw Object.assign(new Error(`${entry.record.name} could not be woken to back up before the rebuild: ${e instanceof Error ? e.message : String(e)}`), { kind: "conflict" });
        }
      }
      const old = entry.record.machineId;
      const fromRunning = ctx.keepsImages(at) && ctx.pauseKeepsDisk(at) && entry.record.phase === "running";
      const napVault = fromRunning ? undefined : (await store.getBlob(VAULTS, id)) !== undefined;
      if (fromRunning) {
        try {
          await entry.ws.upgrade();
        } catch (e) {
          console.warn(`rebuild of ${id}: the running machine gave no vault (${e instanceof Error ? e.message : String(e)}); replacing with none`);
          await entry.ws.rebuild();
        }
      } else {
        await entry.ws.rebuild();
      }
      ctx.followMachine(entry);
      delete entry.record.wakeRefused;
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.upgraded", workspaceId: id, machineId: entry.record.machineId });
      const reason = fromRunning
        ? `rebuilt: ${old} replaced by ${entry.record.machineId}`
        : `rebuilt: ${old} replaced by ${entry.record.machineId}, ${napVault ? "nap-time vault imported" : "no vault to import"}`;
      console.warn(`rebuild of ${id}: ${reason}`);
      await ctx.emitStatus(entry, ctx.reachOf(entry), reason);
      return ctx.view(entry.record);
    },

    async rename(id, typed, origin) {
      const entry = await ctx.entryOf(id, origin);
      const name = ctx.nameGiven(typed);
      if (entry.record.name === name) return ctx.view(entry.record);
      const refusal = ctx.nameRefusal(name);
      if (refusal !== undefined) throw Object.assign(new Error(refusal), { kind: "conflict" });
      entry.record.name = name;
      await ctx.persist(entry.record);
      await store.put(WORKSPACE_NAMES, id, { workspaceId: id, name, project: entry.record.project } satisfies NamedWorkspace);
      bus.emit({ type: "workspace.renamed", workspaceId: id, name });
      return ctx.view(entry.record);
    },

    async look(id, look, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.putLook(entry.record, "theme", look.theme);
      ctx.putLook(entry.record, "glyph", look.glyph);
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.look", workspaceId: id, theme: entry.record.theme ?? null, glyph: entry.record.glyph ?? null });
      return ctx.view(entry.record);
    },

    async snapshot(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      ctx.refuseCannot(entry, "diskSnapshots", "be snapshotted");
      const { name } = entry.record;
      // The snapshot is the whole disk and carries the project in it, which is the one the workspace was made for.
      const held = ctx.projectHeld(entry.record.project);
      const project: WorkspaceProject = { name: held.name, dest: held.path, importedAt: held.createdAt };
      const projects = [project];
      if (entry.record.phase !== "running") throw new Error(`${name} is ${entry.record.phase}; only a running machine can be snapshotted`);
      // A manager that does not start in the project folder, under a thread's environment or a login shell's, never
      // reaches an image; and a pnpm other than the folder's pin, which switches itself into a copy under PNPM_HOME on
      // its first call there and never fetches that copy again, switches here before the disk is copied.
      const root = await entry.machine.exec(`ls -A ${shellQuote(project.dest)}`, { timeoutMs: INLINE_EXEC_MS });
      for (const { check } of projectInstalls(root.stdout.split("\n").map(line => line.trim()), project.dest)) {
        if (check === undefined) continue;
        for (const script of checkScripts(check, { dir: project.dest, env: loginEnvOn(entry.record.place, entry.record.npmBin) })) {
          const ran = await entry.machine.run(script, { deadlineMs: CHECK_MS });
          if (ran.exitCode === 0) continue;
          const said = ran.stderr.split("\n").find(line => /\berror\b/i.test(line))?.trim() || lastLineOf(ran.stderr) || lastLineOf(ran.stdout) || `exit ${ran.exitCode}`;
          throw new Error(snapshotManagerLine(name, check, project.dest, said, `${ran.stderr}\n${ran.stdout}`));
        }
      }
      await syncDisk(entry.machine);
      const disk = await diskUse(entry.machine);
      const createdAt = new Date(clock.now()).toISOString();
      const snapshotId = await entry.ws.checkpoint(projectSnapshotName(ctx.imageMark(), project.name, createdAt.replace(/[:.]/g, "-"))).catch((e: unknown) => {
        if (e instanceof NotFirstLifeError) throw e;
        const said = snapshotRefusedLine(name, answerOf(e), disk);
        console.warn(said);
        const { kind, status } = e as { kind?: unknown; status?: unknown };
        throw Object.assign(new Error(said), kind !== undefined ? { kind } : {}, status !== undefined ? { status } : {});
      });
      const image = await ctx.imageOf(entry.record.golden);
      const golden: ProjectGolden = {
        snapshotId,
        projects,
        golden: image.golden,
        ...(image.version !== undefined ? { version: image.version.version } : {}),
        workspaceId: id,
        workspaceName: name,
        createdAt,
        ...(entry.record.place !== undefined ? { place: entry.record.place } : {}),
      };
      await store.put(PROJECT_GOLDENS, snapshotId, golden);
      return golden;
    },

    async updateDaemon(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      if (ctx.servedByItsComputer(entry) !== undefined) {
        throw new Error(placeServesDaemonLine(entry.record.name, ctx.computerOf(entry)));
      }
      const deploy = ctx.moduleOf(entry.record.kind).deployDaemon;
      if (deploy === undefined) throw new Error("this runtime cannot deploy a daemon; the host wires the bundle");
      if (entry.record.phase !== "running") throw new Error(`wake ${entry.record.name} before updating its daemon`);
      await ctx.deployDaemonOn(entry, deploy);
    },

    async delete(id, origin) {
      ctx.spawnGuard("delete", origin);
      if (scopeOf(origin) === undefined && !live.has(id) && ctx.failedCreates.delete(id)) {
        bus.emit({ type: "workspace.deleted", workspaceId: id });
        return;
      }
      const entry = await ctx.entryOf(id, origin);
      if (entry.deleting) return entry.deleting;
      // A worktree wsp made goes with its record, never over files no commit holds; the project folder, and a
      // worktree somebody else made, are never touched.
      const tree = entry.record.worktree;
      const takes = tree?.made === true && tree.gone !== true && existsSync(tree.path);
      if (takes) await ctx.refuseChanged(tree.path);
      entry.deleting = (async () => {
        try {
          delete entry.deleteSaid;
          ctx.endSessions(id, DELETED_REASON);
          const threads = new Set([...threadRecords].flatMap(([threadId, held]) => (held.workspaceId === id ? [threadId] : [])));
          for (const s of sessions.values()) if (s.view.workspaceId === id && s.view.threadId !== undefined) threads.add(s.view.threadId);
          if (copiesFolder(entry.record.kind)) for (const threadId of threads) await ctx.dropCheckpoints(entry, threadId);
          if (takes) await ctx.removeWorktree(entry, false, { ending: true });
          // Before the machine goes: on a computer somebody owns the folders the files landed in outlive the workspace.
          await ctx.dropThreadFiles(entry, [...threadRecords].flatMap(([threadId, held]) => (held.workspaceId === id ? [threadId] : [])));
          // A machine wsp never forked reads running whatever is asked of it, so only a forked one is read back.
          if (!kindWords(entry.record.kind).driven) {
            await entry.machine.kill().catch((e: unknown) => {
              if (!isMissing(e)) throw e;
            });
          } else {
            await ctx.unfork(entry).catch((e: unknown) => {
              if (!(e instanceof MachineAliveError)) throw e;
              const line = deleteRefusedLine(entry.record.name, e.machineId, e.state);
              entry.deleteSaid = { phase: entry.record.phase, line };
              console.warn(line);
              throw Object.assign(new Error(line), { kind: e.kind });
            });
          }
          await ctx.drop(id);
        } finally {
          delete entry.deleting;
        }
      })();
      return entry.deleting;
    },

    async forget(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const kind = entry.record.kind;
      if (!kindWords(kind).driven) throw Object.assign(new Error(forgetUndrivenRefusal(entry.record.name, machineWord(kind))), { kind: "conflict" });
      const state = await readGone(ctx.backendFor(entry.record), entry.machine.id);
      if (state !== "gone") {
        throw Object.assign(new Error(`${entry.record.name}'s machine ${entry.machine.id} is still ${state}; pause it or delete it at the provider first`), { kind: "conflict" });
      }
      ctx.endSessions(id, DELETED_REASON);
      await ctx.drop(id);
    },

    async touch(id, origin) {
      await ctx.entryOf(id, origin);
      ctx.idle.touch(id);
    },

    async restartDaemon(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const start = ctx.moduleOf(entry.record.kind).restartDaemon;
      if (start === undefined) throw new Error(`${entry.record.name}'s daemon runs on ${machineWord(entry.record.kind)}, which this host does not hold the process of`);
      try {
        await start(entry);
      } finally {
        if (ctx.moduleOf(entry.record.kind).sharedDaemon) ctx.sharedDaemonReplaced();
      }
      // The poll's last measurement is of the daemon that is gone, and the next one is a poll away: the row would
      // go on saying no daemon for that long over a daemon this host has just watched start. Dropped rather than
      // replaced with a claim, so the row falls back to what this kind's road says and the next poll measures.
      ctx.polledReach.delete(entry.record.id);
      await ctx.pushStatus(entry);
    },

    async exec(id, cmd, o, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      return entry.machine.exec(cmd, o);
    },

    async execStream(id, argv, cwd, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      const { adapter } = await ctx.launchAdapterFor(entry);
      // Only the socket or the machine going away ends a command; a build may outlive the deadline a harness turn gets.
      const ranIn = await ctx.threadFolder(entry, { cwd });
      const inner = ctx.execFactoryFor(entry, { idleMs: Number.POSITIVE_INFINITY, deadlineMs: Number.POSITIVE_INFINITY })(inFolder(ranIn, argv.map(shellQuote).join(" ")), { env: { ...adapter.env } });
      let endWith: (reason: string) => void = () => {};
      const ended = new Promise<{ reason: string }>(resolve => {
        endWith = reason => resolve({ reason });
      });
      const running = {
        workspaceId: id,
        end: (reason: string): void => {
          endWith(reason);
          inner.kill();
        },
      };
      execs.add(running);
      // The inner poll loop notices the kill one poll late; the reason reaches the reader as soon as it is known.
      const lines = async function* (): AsyncGenerator<string> {
        const it = inner.lines[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await Promise.race([it.next(), ended]);
            if ("reason" in next) throw new Error(next.reason);
            if (next.done) return;
            yield next.value;
          }
        } finally {
          execs.delete(running);
        }
      };
      return { ...inner, lines: lines(), exited: Promise.race([inner.exited, ended.then(() => null)]), ...(ranIn !== undefined ? { ranIn } : {}) };
    },

    async bringBack({ workspaceId, title, body: given }, origin) {
      let body = given;
      ctx.spawnGuard("bring_back", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const cwd = ctx.checkoutOf(entry.record);
      // The branch this copy started from, off its own record: for a child that is the branch its parent was on at
      // the fork, which is the code it was cut from and so where its work goes back, and nothing is asked of the
      // parent's machine, so a child whose parent has gone to sleep brings its work back without a wake nobody
      // named. A record written before that fact was kept reads the branch its project starts from, as it did.
      const base = entry.record.base ?? ctx.projectHeld(entry.record.project).base;
      const against = base === undefined ? {} : { base };
      // A pull request off someone's fork takes a push only where its author allowed maintainers to push; refused
      // before anything is pushed.
      const fork = entry.record.from?.head?.fork;
      if (entry.record.from?.kind === "pull_request" && fork !== undefined && !fork.pushable) throw new Error(START_WORDS.forkNotPushable(fork.owner));
      // Work on an issue closes it once its pull request merges: the body says so, once, whoever wrote the rest of it.
      const issue = entry.record.from?.kind === "issue" ? entry.record.from.number : undefined;
      if (issue !== undefined) body = withCloses(body ?? "", issue);
      const brought = await ctx.queued(entry.record.id, () => ctx.withDaemon(entry, async (ask): Promise<BringBackResult> => {
        const push = GitPushReply.parse(
          await ask({ op: "git.push", cwd, ...against }).catch(async (e: unknown) => {
            const said = e instanceof Error ? e.message : String(e);
            if (entry.record.parentWorkspaceId !== undefined && isNoGitCredential(e)) await ctx.keepTree(entry, { ...entry.record.tree, pushRefused: said });
            throw e;
          }),
        );
        if (entry.record.tree?.pushRefused !== undefined) {
          const { pushRefused: _gone, ...rest } = entry.record.tree;
          await ctx.keepTree(entry, rest);
        }
        // A workspace a thread opened under a lead pushes its branch and opens nothing: the lead's own pull request is
        // where its work lands, which the lead merges its branch into.
        if (entry.record.parentThreadId !== undefined) {
          return { branch: push.branch, base: push.base, ahead: push.ahead, uncommitted: push.uncommitted, stat: push.stat, note: childPushedLine(push.branch) };
        }
        const asked = { op: "git.pr", cwd, ...against, ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) };
        // The push has landed by here, so nothing the pull request half says makes this a failed bring back: the
        // branch is on the remote either way and the two halves are answered apart. A machine with no signed-in
        // command line for the host is the note it always was; any other refusal rides beside the push as its own,
        // which the verb above prints under the push lines and then exits on.
        const opened = await ask(asked).catch((e: unknown) => {
          const said = e instanceof Error ? e.message : String(e);
          return isNoHostCli(e) ? { note: said } : { refused: said };
        });
        const half = opened as { note?: string; refused?: string };
        const apart = half.note !== undefined ? { note: half.note } : half.refused !== undefined ? { refused: half.refused } : { pr: GitPrReply.parse(opened).pr };
        return { branch: push.branch, base: push.base, ahead: push.ahead, uncommitted: push.uncommitted, stat: push.stat, ...apart };
      }));
      if (brought.pr !== undefined) await ctx.takePullRequest(entry, { ...brought.pr, readAt: clock.now() });
      ctx.readLeadOf(entry);
      return brought;
    },

    async folderFor(o, origin) {
      await ctx.ready();
      const at = await ctx.folderFor(o, origin);
      return { workspace: ctx.view(at.entry.record), ...(at.cwd !== undefined ? { cwd: at.cwd } : {}) };
    },

    async folder({ project: named }, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(named, origin);
      if (!copiesFolder(kindForComputer(project.computer))) throw Object.assign(new Error(notOnThisComputerLine(project.name)), { kind: "usage" });
      ctx.refuseRecording(project.name, origin);
      return ctx.view((await ctx.projectFolder(project)).record);
    },

    async worktree({ project: named, branch }, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(named, origin);
      const top = project.git?.top;
      if (!copiesFolder(kindForComputer(project.computer))) throw Object.assign(new Error(notOnThisComputerLine(project.name)), { kind: "usage" });
      if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
      const entry = await ctx.worktreeFolder(project, top, branch, undefined, scopeOf(origin)?.rootThreadId);
      const tree = entry.record.worktree;
      return { path: tree?.path ?? top, branch, made: tree?.made === true };
    },

    async worktreeRemove({ project: named, branch, force }, origin) {
      await ctx.ready();
      const project = await ctx.projectsDoor.resolve(named, origin);
      const top = project.git?.top;
      if (top === undefined) throw Object.assign(new Error(noBranchesLine(project.name)), { kind: "usage" });
      const holding = (await ctx.worktreesOf(top)).find(t => t.branch === branch)?.path;
      const entry = ctx.foldersOf(project.id).find(e => {
        const tree = e.record.worktree;
        return tree !== undefined && tree.gone !== true && (holding !== undefined ? tree.path === holding : tree.branch === branch);
      });
      if (entry !== undefined) ctx.refuseRelayed(entry.record, origin);
      if (entry?.record.worktree?.made !== true) throw Object.assign(new Error(notMadeWorktreeLine(branch)), { kind: "invalid" });
      if (force === true && scopeOf(origin) !== undefined) throw Object.assign(new Error(WORKTREE_FORCE_LINE), { kind: "usage" });
      await ctx.removeWorktree(entry, force === true);
    },

    async checkout(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      const checkout = await ctx.readCheckout(entry, false);
      // The tile asks as it mounts, and its word rides the status once the git host answers.
      void ctx.readPullRequest(entry, false);
      // A lead's thread opening reads its children again.
      if ([...live.values()].some(e => e.record.parentWorkspaceId === entry.record.id)) void ctx.readTree(entry);
      return checkout === undefined ? {} : { checkout };
    },

    async discard({ workspaceId, path }, origin) {
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const put = GitDiscardReply.parse(await ctx.queued(entry.record.id, () => ctx.withDaemon(entry, ask => ask({ op: "git.discard", cwd: ctx.checkoutOf(entry.record), path }))));
      await ctx.readCheckout(entry, true);
      return put;
    },

    async commit({ workspaceId, message, paths }, origin) {
      ctx.spawnGuard("commit", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const cwd = ctx.checkoutOf(entry.record);
      const made = GitCommitReply.parse(
        await ctx.queued(entry.record.id, () =>
          ctx.withDaemon(entry, async ask => {
            // Every changed file, each untracked one on its own, as the Changes pane lists them.
            const named = paths ?? GitDiffReply.parse(await ask({ op: "git.diff", cwd, scope: "head" })).files.map(f => f.path);
            if (paths === undefined && named.length === 0) throw new Error(cleanCheckoutLine(entry.record.name));
            return ask({ op: "git.commit", cwd, message, paths: named });
          }),
        ),
      );
      await ctx.readCheckout(entry, true);
      return made;
    },

    async commitDraft({ workspaceId, paths }, origin) {
      ctx.spawnGuard("commit", origin);
      if (paths !== undefined && paths.length === 0) return { message: null, note: DRAFT_NOTES.nothing };
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      // The workspace's newest thread drafts, on its own agent and from the task it was opened with; a workspace
      // with no thread yet drafts on the default agent from the diff alone.
      const rows = [...sessions.values()].map(s => s.view).filter(v => v.workspaceId === workspaceId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
      const newest = rows.at(-1);
      const opening = newest?.threadId === undefined ? undefined : rows.find(v => v.threadId === newest.threadId)?.prompt;
      const named = newest?.harness ?? ctx.defaultAgentOf(await ctx.preferences.get(), entry);
      if (adapters[named] === undefined || ctx.agentOff(entry, named)) return { message: null, note: DRAFT_NOTES.noAgent };
      const { harness, adapter } = await ctx.launchAdapterFor(entry, named);
      if (adapter.draftFor === undefined) return { message: null, note: DRAFT_NOTES.noAgent };
      const diff = GitDiffReply.parse(await ctx.withDaemon(entry, ask => ask({ op: "git.diff", cwd: ctx.checkoutOf(entry.record), scope: "head", ...(paths !== undefined ? { paths } : {}) })));
      const table = harnessCatalog(harness);
      const model = smallestModel(table === undefined ? undefined : await ctx.catalogOn(table, entry, adapter));
      // The question rides a file on the machine, since a diff is longer than one exec may carry, and only the
      // login that wrote it may read it; it goes once the answer is in, whatever the answer was.
      const promptFile = `/tmp/wsp-draft-${randomBytes(6).toString("hex")}.txt`;
      const question = draftPrompt(cutDiff(diff.files.map(f => f.patch).join("\n")), opening);
      const put = await putFiles(entry.machine, [{ path: promptFile, text: question }], { before: ["umask 077"] });
      if (put.exitCode !== 0) return { message: null, note: DRAFT_NOTES.noAnswer };
      try {
        const answer = await adapter.draftFor(
          { promptFile, ...(model !== undefined ? { model } : {}) },
          harnessExec(entry.machine, TITLE_MAKE_TIMEOUT_MS),
        );
        const message = answer === null ? null : commitMessage(answer);
        return message === null ? { message: null, note: DRAFT_NOTES.noAnswer } : { message };
      } finally {
        await entry.machine.exec(`rm -f ${shellQuote(promptFile)}`).catch(() => undefined);
      }
    },

    async viewed({ workspaceId, path, blob }, origin) {
      await ctx.entryOf(workspaceId, origin);
      const marks = { ...(ctx.viewedMarks.get(workspaceId) ?? {}) };
      if (path === undefined) return { viewed: marks };
      if (typeof blob === "string") marks[path] = blob;
      else delete marks[path];
      ctx.viewedMarks.set(workspaceId, marks);
      await ctx.persistSessions(workspaceId);
      bus.emit({ type: "workspace.viewed", workspaceId, viewed: marks });
      return { viewed: marks };
    },

    async pullRequestView({ workspaceId, fresh }, origin) {
      const { entry, remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      const { page, here } = await ctx.readPage(entry, remote, number, fresh === true);
      const merge = await ctx.mergeSettings(remote).catch(() => undefined);
      return { ...page, ...(merge !== undefined ? { merge } : {}), sent: entry.record.prSent ?? [], postsAsYou: here };
    },

    async pullRequestDiff({ workspaceId }, origin) {
      const { entry, remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      return ctx.readHost(entry, cwd => ({ op: "git.prDiff", cwd, remote, number, maxBytes: GIT_DIFF_CAP_BYTES }), r => GitPrDiffReply.parse(r));
    },

    async pullRequestReply({ workspaceId, replyTo, threadId, body }, origin) {
      if (body.trim() === "") throw Object.assign(new Error(REPLY_EMPTY_LINE), { kind: "invalid" });
      const { remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      const where = { ...(replyTo !== undefined ? { replyTo } : {}), ...(threadId !== undefined ? { threadId } : {}) };
      return ctx.postAsPerson(remote, number, cwd => ({ op: "git.prReply", cwd, remote, number, ...where, body }), r => GitPrReplyReply.parse(r));
    },

    async pullRequestResolve({ workspaceId, threadId, resolved }, origin) {
      const { remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      return ctx.postAsPerson(remote, number, cwd => ({ op: "git.prResolve", cwd, remote, number, threadId, resolved }), r => GitPrResolveReply.parse(r));
    },

    async pullRequestReact({ workspaceId, subject, content, on }, origin) {
      const { remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      return ctx.postAsPerson(remote, number, cwd => ({ op: "git.prReact", cwd, remote, number, subject, content, on }), r => GitPrReactReply.parse(r));
    },

    async pullRequestSend({ workspaceId, items }, origin) {
      const { entry, remote, number } = await ctx.pullRequestOn(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const { page } = await ctx.readPage(entry, remote, number, false);
      const same = (a: PullRequestItem, b: PullRequestItem): boolean => a.kind === b.kind && a.id === b.id;
      const asked = items.filter((item, n) => items.findIndex(other => same(item, other)) === n);
      const said = await ctx.toFirstThread(workspaceId, pullRequestSendPrompt(page, asked, number), origin);
      const at = clock.now();
      entry.record.prSent = [...(entry.record.prSent ?? []).filter(s => !asked.some(i => same(i, s))), ...asked.map(i => ({ kind: i.kind, id: i.id, at }))];
      await ctx.persist(entry.record);
      return { outcome: said.outcome, threadId: said.threadId, agent: said.harness, sent: entry.record.prSent };
    },

    async fix({ workspaceId, check, child }, origin) {
      ctx.spawnGuard("fix", origin);
      if (check !== undefined && child !== undefined) throw Object.assign(new Error(FIX_CHECK_OR_CHILD), { kind: "invalid" });
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      const project = ctx.projectHeld(entry.record.project);
      let prompt: string;
      let base: string;
      if (child !== undefined) {
        // A merge that stopped goes to the lead's agent as a message, and nothing is merged here.
        const kid = await ctx.childOf(entry, child, origin);
        const leadBranch = (await ctx.readCheckout(entry, false))?.branch ?? entry.record.base ?? project.base ?? project.defaultBranch;
        const childBranch = (await ctx.readCheckout(kid, false))?.branch ?? kid.record.worktree?.branch ?? "";
        // With no remote the child's branch is in its folder, which is where the merge took it from.
        const remote = remoteHost(project.remote) === undefined ? ctx.checkoutOf(kid.record) : "origin";
        prompt = mergeChildPrompt({ leadBranch, childBranch, remote, conflicts: kid.record.tree?.conflicts ?? [] });
        base = leadBranch;
      } else if (check === undefined) {
        const updated = await ctx.updateCopy(entry);
        base = updated.base;
        if (updated.merged) return { outcome: "updated", base };
        const branch = entry.checkout?.branch ?? (isPullRequestFact(entry.pr) ? entry.pr.branch : base);
        prompt = conflictsPrompt({ base, branch, files: updated.conflicts });
      } else {
        // Read whole: a check that failed since the last read moves nothing a lighter read compares.
        const fact = await ctx.readPullRequest(entry, true, true);
        if (!isPullRequestFact(fact)) throw new Error(noPullRequestRefusal(entry.record.name));
        const failed = fact.checks.find(c => c.name === check);
        if (failed === undefined) throw new Error(noSuchCheckRefusal(check, fact.checks.map(c => c.name)));
        if (failed.state !== "fail") throw new Error(checkNotFailedRefusal(check, failed.state));
        const run = failed.run;
        // A log the host no longer holds, or will not hand over, leaves the message with the check's link alone.
        const log =
          run === undefined
            ? undefined
            : await ctx.readHost(entry, cwd => ({ op: "git.runLog", cwd, remote: project.remote, runId: run.runId, jobId: run.jobId }), r => GitRunLogReply.parse(r)).catch(() => undefined);
        prompt = checkFailedPrompt({ check: failed, commit: { oid: fact.headOid, subject: fact.headSubject }, ...(log !== undefined ? { log } : {}) });
        base = fact.base;
      }
      const said = await ctx.toFirstThread(workspaceId, prompt, origin);
      return { outcome: said.outcome, threadId: said.threadId, ...(check !== undefined ? { check } : {}), ...(child !== undefined ? { child } : {}), base, agent: said.harness };
    },

    async merge({ workspaceId, method, whenChecksPass, head }, origin) {
      ctx.spawnGuard("merge", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      // The fact the host holds is the one every window drew, however old it is: a fresh read here would hand the
      // guard below whatever the agent pushed since the person looked. Read only where nothing was ever read.
      const fact = isPullRequestFact(entry.pr) ? entry.pr : await ctx.readPullRequest(entry, false);
      if (!isPullRequestFact(fact)) {
        const kept = entry.record.pr;
        throw new Error(kept !== undefined && kept.state !== "open" ? notOpenRefusal(kept.number, kept.state) : noPullRequestRefusal(entry.record.name));
      }
      if (fact.state !== "open") throw new Error(notOpenRefusal(fact.number, fact.state));
      const remote = ctx.projectHeld(entry.record.project).remote;
      const settings = await ctx.mergeSettings(remote);
      const by = method ?? settings.defaultMethod;
      if (!settings.methods.includes(by)) throw new Error(mergeMethodRefusal(by, settings.methods));
      if (whenChecksPass === true && !settings.autoMerge) throw new Error(AUTO_MERGE_OFF_LINE);
      // Merged on this computer as the person, and only while the head is the commit the person was shown, which the
      // window that drew it names: a push between the drawing and the press fails the merge in the host's own words
      // rather than landing unseen code.
      const done = GitPrMergeReply.parse(
        await ctx.onThisComputer((ask, home) => ask({ op: "git.prMerge", cwd: home, remote, number: fact.number, method: by, auto: whenChecksPass === true, headOid: head ?? fact.headOid })),
      );
      githubCache.delete(ctx.pageKey(remote, fact.number));
      await ctx.readPullRequest(entry, true);
      return { number: fact.number, method: by, merged: done.merged, autoArmed: done.autoArmed };
    },

    async update({ workspaceId }, origin) {
      ctx.spawnGuard("update", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      await ctx.copyBlocked(entry);
      return ctx.updateCopy(entry);
    },

    async mergeIn({ workspaceId, child }, origin) {
      ctx.spawnGuard("merge_in", origin);
      const lead = await ctx.entryOf(workspaceId, origin);
      // A thread merges only into the workspace it runs on: a child merging into its lead is a merge nobody there asked.
      const asked = scopeOf(origin);
      if (asked !== undefined && asked.workspaceId !== lead.record.id) throw new Error(mergeIntoOwnRefusal(asked.threadId));
      const kid = await ctx.childOf(lead, child, origin);
      // The lead's copy is its agent's working tree, and a merge under a turn is one that agent was never asked about;
      // the asking thread's own turn is the one a tool call runs inside, so it is the one turn left out.
      const busy = [...sessions.values()]
        .map(s => s.view)
        .filter(v => v.workspaceId === lead.record.id && v.status === "running" && v.threadId !== undefined && v.threadId !== asked?.threadId);
      if (busy.length > 0) throw new Error(leadBusyRefusal(lead.record.name, busy.map(v => v.threadId!)));
      await ctx.copyBlocked(lead);
      const branch = (await ctx.readCheckout(kid, true))?.branch ?? kid.record.worktree?.branch ?? "";
      if (branch === "" || branch === DETACHED_HEAD) throw new Error(childOnNoBranchRefusal(kid.record.name));
      const project = ctx.projectHeld(lead.record.project);
      // Through the remote, the one place both copies always reach; with none, from the child's folder only where
      // both copies sit on this computer, since a copy on a box is visible to nothing but its own workspace.
      let from: string | undefined;
      if (remoteHost(project.remote) === undefined) {
        if (!isLocalWorkspace(lead.record) || !isLocalWorkspace(kid.record)) throw new Error(noRemoteForTreeLine(project.name));
        from = ctx.checkoutOf(kid.record);
      }
      const done = GitMergeInReply.parse(
        await ctx.queued(lead.record.id, () => ctx.withDaemon(lead, ask => ask({ op: "git.mergeIn", cwd: ctx.checkoutOf(lead.record), branch, ...(from !== undefined ? { from } : {}) }))),
      );
      const kept: TreeRecord = { ...kid.record.tree };
      if (done.merged) {
        delete kept.conflicts;
        if (done.commits > 0 && done.oid !== undefined) kept.merged = { oid: done.oid, at: clock.now(), ...(done.head !== undefined ? { head: done.head } : {}) };
      } else kept.conflicts = done.conflicts;
      await ctx.readCheckout(lead, true);
      await ctx.keepTree(kid, kept);
      return { lead: lead.record.name, child: kid.record.name, branch, merged: done.merged, commits: done.commits, conflicts: done.conflicts };
    },

    async start({ url, project: named, agent, model, effort, access }, origin) {
      ctx.spawnGuard("start", origin);
      await ctx.ready();
      const link = githubLinkOf(url);
      if (link === undefined) throw Object.assign(new Error(START_WORDS.notALink(url)), { kind: "invalid" });
      const project = ctx.projectByRepo(link.repo, named);
      const read = await ctx.issueOf(project.remote, link.number);
      const fact = link.kind === "pull_request" ? await ctx.pullRequestOf(project.remote, link.number) : undefined;
      const from = ctx.fromOf(link.kind, link.repo, read, fact);
      await ctx.picksHold(project, { ...(agent !== undefined ? { harness: agent } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(access !== undefined ? { access } : {}) });
      const entry = await ctx.workspaceFrom(project, from, fact, "start", origin);
      return ctx.openWith(entry, { prompt: fromTaskPrompt(from, read), ...(agent !== undefined ? { harness: agent } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(access !== undefined ? { access } : {}) }, origin);
    },

    async review({ url, workspaceId, agent, model, effort }, origin) {
      ctx.spawnGuard("review", origin);
      await ctx.ready();
      let repo: string;
      let number: number;
      let project: ProjectView;
      if (url !== undefined) {
        const link = githubLinkOf(url);
        if (link === undefined) throw Object.assign(new Error(START_WORDS.notALink(url)), { kind: "invalid" });
        if (link.kind !== "pull_request") throw Object.assign(new Error(START_WORDS.notAPullRequest), { kind: "invalid" });
        project = ctx.projectByRepo(link.repo, undefined);
        ({ repo, number } = link);
      } else {
        const entry = workspaceId === undefined ? undefined : await ctx.entryOf(workspaceId, origin);
        const kept = entry?.record.pr ?? (entry?.record.from?.kind !== "issue" ? entry?.record.from : undefined);
        if (entry === undefined || kept === undefined) throw Object.assign(new Error(START_WORDS.notAPullRequest), { kind: "invalid" });
        project = ctx.projectHeld(entry.record.project);
        repo = ownerRepoOf(project.remote) ?? project.remote;
        number = kept.number;
      }
      const reviewer = agent ?? "codex";
      const readOnly = ctx.readOnlyOf(reviewer);
      if (readOnly === undefined) throw Object.assign(new Error(START_WORDS.noReadOnly(reviewer, ctx.reviewers())), { kind: "invalid" });
      const fact = await ctx.pullRequestOf(project.remote, number);
      const read = await ctx.issueOf(project.remote, number);
      const diff = GitPrDiffReply.parse(await ctx.onThisComputer((ask, home) => ask({ op: "git.prDiff", cwd: home, remote: project.remote, number })));
      const from = ctx.fromOf("review", repo, read, fact);
      await ctx.picksHold(project, { harness: reviewer, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode: readOnly });
      const entry = await ctx.workspaceFrom(project, from, fact, "review", origin);
      return ctx.openWith(entry, { prompt: reviewTaskPrompt(from, read, diff), harness: reviewer, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode: readOnly }, origin);
    },

    async reviewDraft({ workspaceId, summary, verdict, on }, origin) {
      const entry = await ctx.entryOf(workspaceId, origin);
      const draft = entry.record.review;
      if (isReviewRead(draft) && (summary !== undefined || verdict !== undefined || on !== undefined)) {
        const ticks = new Map((on ?? []).map(t => [t.id, t.on]));
        entry.record.review = {
          ...draft,
          ...(summary !== undefined ? { summary } : {}),
          ...(verdict !== undefined ? { verdict } : {}),
          comments: draft.comments.map(c => (ticks.has(c.id) ? { ...c, on: ticks.get(c.id)! } : c)),
        };
        await ctx.persist(entry.record);
        bus.emit({ type: "workspace.review", workspaceId });
      }
      return entry.record.review === undefined ? {} : { review: entry.record.review };
    },

    async reviewPost({ workspaceId }, origin) {
      ctx.spawnGuard("review_post", origin);
      const entry = await ctx.entryOf(workspaceId, origin);
      const draft = entry.record.review;
      const from = entry.record.from;
      if (!isReviewRead(draft) || from === undefined) throw new Error(START_WORDS.noReviewYet(entry.record.name));
      const ticked = draft.comments.filter(c => c.on).map(({ id, path, line, side, body }) => ({ id, path, line, side, body }));
      const remote = ctx.projectHeld(entry.record.project).remote;
      // One call on this computer as the person, pinned to the head the review was written against, so a push since
      // is GitHub's to say and a half-made review is never seen.
      const done = GitPrReviewReply.parse(
        await ctx.onThisComputer((ask, home) => ask({ op: "git.prReview", cwd: home, remote, number: from.number, headOid: draft.headOid, event: draft.verdict, body: draft.summary, comments: ticked })),
      );
      entry.record.review = { ...draft, posted: { url: done.url, at: clock.now(), folded: done.folded } };
      await ctx.persist(entry.record);
      bus.emit({ type: "workspace.review", workspaceId });
      githubCache.delete(ctx.pageKey(remote, from.number));
      void ctx.readPullRequest(entry, true);
      return { url: done.url, number: from.number, comments: ticked.length - done.folded.length, folded: done.folded.length };
    },

    async daemonReach(id, origin) {
      const entry = await ctx.entryOf(id, origin);
      return ctx.moduleOf(entry.record.kind).daemonRoad(entry);
    },

    async daemonChannel(id, onEvent, origin) {
      const entry = await ctx.entryOf(id, origin);
      if (!ctx.moduleOf(entry.record.kind).sharedDaemon) return ctx.copyChannel(entry, onEvent, ctx.WORKSPACE_FRAMES);
      const ptys = ctx.portPids.get(id) ?? new Map<string, number>();
      ctx.portPids.set(id, ptys);
      const heard = (event: Record<string, unknown>): void => {
        if (event["type"] === "pty.exit" && ptys.delete(String(event["ptyId"]))) ctx.portRootsMoved(id);
        onEvent(event);
      };
      return ctx.rootedPorts(id, ctx.checkoutOf(entry.record), ptys, ctx.heldToOwner(id, await ctx.copyChannel(entry, heard, ctx.WORKSPACE_FRAMES)));
    },

    async guestChannel(id, onEvent) {
      return ctx.copyChannel(await ctx.entryOf(id), onEvent, ctx.GUEST_ROAD_FRAMES);
    },

    async servedByItsComputer(id, origin) {
      return ctx.servedByItsComputer(await ctx.entryOf(id, origin)) !== undefined;
    },

    async watchSys(id, fn, origin) {
      const entry = await ctx.entryOf(id, origin);
      const kind = entry.record.kind;
      if (readingRoad(kind, "metrics") !== "host") throw new Error(`${machineWord(kind)} reads its own load over its daemon link, not from this host`);
      if (local?.sysSamples === undefined) throw new Error("this host reads nothing of the computer it runs on");
      return local.sysSamples(fn);
    },

    async portReach(id, port, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      const reach = await entry.ws.portReach(port);
      return { url: reach.url, expiresAt: reach.expiresAt };
    },

    async portProbe(id, port, origin) {
      const entry = await ctx.entryOf(id, origin);
      await ctx.copyBlocked(entry);
      const reach = await entry.ws.portReach(port);
      // A followed redirect would refetch without the token or the edge's cookies and report the edge's 401 for a page the frame loads fine.
      const res = await fetch(reach.url, { redirect: "manual", signal: AbortSignal.timeout(PORT_PROBE_TIMEOUT_MS) });
      const body = await readBodyUpTo(res, PORT_PROBE_BODY_CAP);
      if (res.status === 401) await entry.ws.remintPortReach(port);
      return { status: res.status, body };
    },

    async originRefusal(id, origin) {
      await ctx.ready();
      return ctx.refusalFor(live.get(id)?.record, origin);
    },

    creating() {
      return [...ctx.createStages.values()];
    },

    seenBy(event, origin) {
      const scope = scopeOf(origin);
      if (scope === undefined) return true;
      const asked = askerOf(event);
      if (asked !== undefined) return asked.threadId === scope.threadId || asked.rootThreadId === scope.rootThreadId;
      const id = workspaceIdOf(event);
      const record = id === undefined ? undefined : live.get(id)?.record;
      if (record === undefined) return false;
      // An event about a thread is that thread's tree's, whatever workspace it names: the stream shows exactly what
      // the listing and the transcript show, a lead's turn to the child on its copy included, and hides the rest,
      // so a row cannot be read going by. An event with no thread is about the workspace and reads its rule.
      const thread = (event as { threadId?: unknown }).threadId;
      if (typeof thread === "string") return ctx.reachesRow({ threadId: thread, workspaceId: record.id }, origin);
      return ctx.refusalFor(record, origin) === undefined;
    },
  };
  return { workspaces };
}
