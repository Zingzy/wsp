// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { CATALOG_AGENTS, serverValuesOf } from "@wsp/catalog";
import { harnessExec } from "@wsp/engine";
import {
  type SessionEvent, type SessionInterruptOutcome, type SessionInterruptResult, type SessionStartOutcome,
  type SessionSearchResult, type SessionView, type StartPicks, type TurnImage, type TurnResult, foldThreads,
  MCP_SERVER_NAME, threadForgetRefusal, threadKeyOf, threadRan, threadWord, SCOPED_MCP_ARG, roadOf, scopeOf,
  RUN_PERSONS_LINE, runOutputTail, type SessionRunEvent, NO_SLATE_MCP_ARG, ASIDE_NO_SESSION_LINE, BLANK_ASIDE_LINE,
  asideUnsupportedLine, isLocalWorkspace, mcpServersBlocked, actionRefusal, homeShortened, EMPTY_TITLE_LINE,
  threadRunsOnLine, keptPicks, listedPick, notFoundRefusal, NOTIFY_ME, noCwdLine,
  THREAD_WORKING_LINE, threadOnMachineLine, WORKTREE_BUSY_LINE, copiesFolder, runsInFolder, sendRefusal, startPicks, titleLine,
  TURN_TOKEN_ENV, turnImagesDir, workspaceState, REWIND_LATEST_LINE, REWIND_NO_CHECKPOINT_LINE, REWIND_NO_UNDO_LINE,
  REWIND_SHARED_LINE, REWIND_WORKING_LINE, rewindBesideLine, rewindChildrenLine, rewindKeptLine, rewindNoAnchorLine,
  attachmentRecord, attachmentKey, filesBlocked, isImage, sendFilesDir, attachedFilesPrompt, threadMessages,
  threadSeed, taskStopRefusedLine, taskStopUnsupportedLine, agentOffLine, HEAD_BYTES, HISTORY_PAGE_BYTES,
  HISTORY_PAGE_EVENTS, AGENT_STARTING_MS, ASIDE_EMPTY_LINE, capStoppedLine, deletedBeforeStartLine, type AsideQuestion,
  type McpServerSpec, type SessionAsker,
} from "@wsp/protocol";
import { harnessCatalog } from "../harness-catalog.js";
import { headShape } from "../transcript-reader.js";
import type { HarnessAdapter, HarnessStartOptions } from "../types/harness.js";
import { SESSION_TITLE_TIMEOUT_MS } from "../types/events.js";
import type { Runtime } from "../types/api.js";
import {
  ATTACHMENTS, ATTACHMENT_KEYS, snippetAround, type KeptProcess, type KeptLaunch, type ThreadRecord, type KeptImages,
  type LiveSession, type SessionEntry,
} from "../types/internal.js";
import type { RuntimeContext, SessionsArea } from "../context.js";

/** The wsp server a thread's launch is handed. A thread another thread started has no slate: its launch says nothing of
 * one, and on this computer, where the server is the host's own wsp and knows the word, its server is told too. A box's
 * server is served by this host as a guest, which reads the same off the thread's token; the box's own wsp may be
 * older and never sees a word. */
function servedTo(wsp: McpServerSpec | undefined, rootThreadId: string, threadId: string): McpServerSpec | undefined {
  if (wsp === undefined || rootThreadId === threadId) return wsp;
  return { ...wsp, noSlate: true as const, ...(wsp.args.includes(SCOPED_MCP_ARG) ? { args: [...wsp.args, NO_SLATE_MCP_ARG] } : {}) };
}

export function sessionsArea(ctx: RuntimeContext): SessionsArea {
  const {
    opts, store, bus, clock, deviceDoor, threadLaunch, live, setups, threadRecords, sessions, transcriptIndex,
  } = ctx;
  /** The end a stop is running on a thread's group, by thread: the thread's next turn launches after it, never into
   * the group it is emptying. */
  const ending = new Map<string, Promise<void>>();
  /** A stop on one turn; `marked` lets a held turn's next look go on once the stop has marked it, or will not. */
  const stopTurn = async (marked: () => void, ...[sessionId, origin, task]: Parameters<Runtime["sessions"]["interrupt"]>): ReturnType<Runtime["sessions"]["interrupt"]> => {
    await ctx.ready();
    // A turn held back is named by its turn id, and its row goes under its launch's id once it starts, so a stop sent
    // off the waiting line finds the turn it became.
    const rowOf = (): SessionEntry | undefined => sessions.get(sessionId) ?? [...sessions.values()].find(r => r.turnId === sessionId);
    let s = rowOf();
    if (!s) return { outcome: "not-found" };
    // One absence for every row a thread cannot reach, wherever it stands: a sentence about the workspace would
    // tell a thread which of the two rules hid the row.
    if ((await ctx.entryOfRow(s.view, origin)) === undefined) return { outcome: "not-found" };
    // One subagent of the turn, and nothing else: the threads under this one and the turn itself run on.
    if (task !== undefined) {
      if (s.view.status !== "running" || s.handle === undefined) return { outcome: "not-running" };
      const agent = ctx.agentLabel(s.view.harness);
      if (s.handle.stopTask === undefined) return { outcome: "unsupported", error: taskStopUnsupportedLine(agent) };
      const stopped = await s.handle.stopTask(task);
      if (stopped.outcome === "refused") return { outcome: "refused", error: taskStopRefusedLine(agent, stopped.error) };
      return stopped.outcome === "unsupported" ? { outcome: "unsupported", error: taskStopUnsupportedLine(agent) } : { outcome: stopped.outcome };
    }
    // A turn its computer's threads at once has not let through has no process to stop and holds no slot: it is marked
    // before anything here waits, whether or not it has looked yet, so it gives up at its next look and never launches.
    const held = ctx.capHeld.get(sessionId);
    if (held !== undefined) ctx.capStop(sessionId, capStoppedLine(held.waiting?.wait));
    marked();
    // A thread's agents spawned a tree under it, and a stop on the thread is a stop on the tree: the children go
    // first, so nothing under a stopped lead is left working for a thread that is no longer reading. The lead
    // itself may already be over, which is an answer and not a reason to leave its builders running. A child
    // that stops its lead stops its siblings and itself with it, and may never read the answer.
    const under = s.view.threadId === undefined ? [] : await ctx.stopUnder(s.view.threadId, origin);
    const answered = (outcome: SessionInterruptOutcome, left?: string): SessionInterruptResult => ({ outcome, ...(under.length > 0 ? { under } : {}), ...(left !== undefined ? { left } : {}) });
    if (held !== undefined) {
      await s.launch;
      return answered("accepted");
    }
    // A turn let through and still reaching its machine is stopped once it is there.
    if (s.view.status === "running" && s.handle === undefined && s.launch !== undefined) {
      await s.launch;
      s = rowOf() ?? s;
    }
    // A stop ends what the thread left running on a computer that groups a thread's processes, a server it
    // detached included, once its turn has had its own grace; a thread whose turn is over still has those. Set
    // before the turn is stopped, so a send queued behind it sees the end before it sees the turn gone.
    const thread = s.view.threadId;
    const entry = thread === undefined ? undefined : await ctx.entryOfRow(s.view, origin);
    const ends = entry === undefined ? undefined : ctx.moduleOf(entry.record.kind).endThread;
    let ended = (): void => {};
    const endingNow = ends === undefined ? undefined : new Promise<void>(resolve => (ended = resolve));
    if (endingNow !== undefined) ending.set(thread!, endingNow);
    try {
      if (s.view.status !== "running" || s.handle === undefined) {
        // Another turn of the thread running or on its way stands in the same group, and is not what was stopped.
        if (ends === undefined || ctx.runningOn(thread!) !== undefined || ctx.launchingOn(thread!) !== undefined) return answered("not-running");
        return answered("not-running", await ends(entry!, thread!, {}));
      }
      await s.handle.interrupt();
      // The harness resolves finished only after session.end, so accepted means the turn is over on the transcript too.
      await s.handle.finished.catch(() => {});
      return answered("accepted", await ends?.(entry!, thread!, {}));
    } finally {
      if (endingNow !== undefined && ending.get(thread!) === endingNow) ending.delete(thread!);
      ended();
    }
  };

  const sessionsApi: Runtime["sessions"] = {
    async start(workspaceId, opened, origin) {
      await ctx.ready();
      const prefs = ctx.state.preferencesHeld ?? (await ctx.preferences.get());
      // A start is known by its request id, so one sent again after the host stopped under it is the same message:
      // the host that took it answers with the turn it opened or joined, on a thread the caller reaches, and starts
      // nothing. The one rule every client's road back reads, so a restart neither drops a message nor runs it twice.
      const taken = opened.requestId === undefined ? undefined : transcriptIndex.get(workspaceId)?.taken.get(opened.requestId);
      if (taken !== undefined && (await ctx.entryOfRow({ threadId: taken.threadId, workspaceId }, origin)) !== undefined) {
        const answered = await ctx.takenTurn(workspaceId, taken);
        if (answered !== undefined) return answered;
      }
      // The thread this start lands in is read before the workspace is: a send into a thread of the caller's tree
      // reaches it on whatever workspace it runs, and only a start that opens a thread is a workspace act.
      // A thread whose rows fell off the index cap, or whose index is gone, is still the thread its record or its
      // transcript says it is.
      const named = opened.thread === undefined ? undefined : ctx.latestOn(opened.thread);
      const fromTranscript = opened.thread === undefined ? undefined : ctx.startedAs(workspaceId, opened.thread);
      const heldOn = opened.thread === undefined ? undefined : (named?.workspaceId ?? threadRecords.get(opened.thread)?.workspaceId ?? (fromTranscript !== undefined ? workspaceId : undefined));
      if (opened.thread !== undefined && heldOn !== workspaceId) throw new Error(`no thread ${opened.thread} on this workspace`);
      // Read again where the thread becomes this send's to run: the id it must resume may not exist yet.
      let resume = named?.claudeSessionId ?? fromTranscript;
      const threadId = opened.thread ?? randomUUID();
      // A message into a thread that already has turns is a send; anything else opens one, and only one of those
      // two is what a thread's own token is capped on. Read before the machine is asked for anything. The thread's
      // record answers before its rows, since the rows are capped and the record is not.
      const opens = !threadRecords.has(threadId) && ctx.rowsOn(threadId).length === 0;
      // A send goes into a thread the caller drives, read on the thread it lands in.
      const opening = live.get(workspaceId)?.record;
      const reached = opens ? await ctx.entryOf(workspaceId, opening !== undefined && ctx.opensIn(opening, scopeOf(origin)) ? undefined : origin) : await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (reached === undefined) throw new Error(`no thread ${opened.thread} on this workspace`);
      const entry = reached;
      // A worktree somebody removed by hand reads as gone the moment a thread asks for it, so the turn runs in the
      // project folder rather than in a folder that is not there.
      const worktree = entry.record.worktree;
      const goneNow = worktree !== undefined && worktree.gone !== true && !existsSync(worktree.path) ? worktree.path : undefined;
      if (goneNow !== undefined) await ctx.worktreeGone(entry, "removed", { starting: true });
      // What a thread already carries decides two of this send's picks, and it is read after the reading above, so
      // a caller that cannot drive the thread learns nothing about it. A thread keeps its agent: the turn runs on
      // the harness its record names, and a request naming another is refused rather than resuming that thread's
      // harness session under an agent that never wrote it. Its access is its own the same way, so a mode named on
      // a send is dropped and sessions.access is the one road that changes what a thread may touch; the access the
      // thread runs at is then read off its record below, as a send that named none has always read it.
      const carried: Pick<ThreadRecord, "harness"> | undefined = opens ? undefined : (threadRecords.get(threadId) ?? ctx.latestOn(threadId));
      if (carried !== undefined && opened.harness !== undefined && opened.harness !== carried.harness) throw new Error(threadRunsOnLine(carried.harness, opened.harness));
      // A start that names no agent runs the project's, else the person's default, else the catalog's first, so the
      // command line, the composer and a tool all open the next thread on the same agent.
      const overrides = prefs.projectDefaults[entry.record.project];
      const o = { ...opened, harness: carried?.harness ?? opened.harness ?? ctx.defaultAgentOf(prefs, entry) };
      if (carried !== undefined) {
        delete o.permissionMode;
        delete o.access;
      }
      if (ctx.agentOff(entry, o.harness)) throw Object.assign(new Error(agentOffLine(ctx.agentLabel(o.harness), ctx.computerOf(entry))), { kind: "usage" });
      await ctx.confineSetup(entry, o.harness);
      const refuse = (): void => {
        if (!live.has(workspaceId)) throw new Error(deletedBeforeStartLine(entry.record.name));
        const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
        if (refusal !== null) throw new Error(refusal);
      };
      // A launch from any road, the app's included, meets a machine that takes commands.
      if (entry.unchecked === true && entry.record.phase === "running") await ctx.proven(entry);
      refuse();
      // A blocked computer refuses a new turn but never a message joining one still running there, so a busy thread asks once it frees.
      let cleared = !ctx.threadRuns(threadId);
      if (cleared) await ctx.copyBlocked(entry);
      const title = o.title === undefined ? undefined : titleLine(o.title);
      if (title === "") throw new Error(EMPTY_TITLE_LINE);
      ctx.spawnGuard(opens ? "thread_new" : "send", origin);
      // The tree this thread sits in, written on its first row and read off it by every later turn: a thread a
      // person opened is its own root, and one a thread opened hangs under that thread's root.
      const spawnedBy = opens ? scopeOf(origin) : undefined;
      const tree = opens
        ? ctx.treeOf(spawnedBy)
        : { ...(ctx.parentOf(threadId) !== undefined ? { parentThreadId: ctx.parentOf(threadId)! } : {}), ...(ctx.rootOf(threadId) !== threadId ? { rootThreadId: ctx.rootOf(threadId) } : {}) };
      // me is the caller: the thread this request came out of when its token says it came out of one, and the person
      // when there is no token, which is every road that is not a turn. A target named twice is one target, since a
      // list says who is told and not how often.
      const asked =
        o.notify === undefined
          ? undefined
          : [...new Set(o.notify.map(target => (target === NOTIFY_ME && o.turnToken !== undefined ? ctx.threadOfToken(o.turnToken) : target)))];
      // The threads a start may name as targets: the ones the caller drives, every thread of its own tree, so a
      // notify reaches no thread a send could not and the line it delivers is one the caller could have sent by
      // hand. A thread of another tree reads as no thread at all, so a guest cannot tell a foreign thread from
      // none. The one crossing this keeps is the shim's own `--notify me`, which is the caller itself.
      for (const target of asked ?? []) {
        if (target === NOTIFY_ME) continue;
        const on = ctx.latestOn(target);
        if (on === undefined || !ctx.reachesRow(on, origin)) throw new Error(`no thread ${target} to notify`);
        if (target === threadId) throw new Error("a thread cannot notify itself");
        // Each end would start the next turn on the other thread with no one sending anything, so the chain is
        // walked whole; it is a lead and its builders, so it is short.
        if (ctx.notifyReach(ctx.notifyOn(target)?.notify ?? []).has(threadId)) {
          throw new Error(`thread ${target.slice(0, 8)} already notifies this thread; a cycle would run forever`);
        }
      }
      const registered = ctx.notifyOn(threadId);
      const notify = asked ?? registered?.notify;
      // Who named these targets, kept beside them: a start out of a thread carries that thread's scope, so the line
      // its end delivers starts the target's turn under it; one the person made carries none and goes as theirs. A
      // send into a thread takes what the thread's opener registered, this beside the targets themselves.
      const notifyBy = asked === undefined ? registered?.by : scopeOf(origin);
      // And the road they were named from, beside the thread: the line's own start reads the same rules the
      // registration did, so a road that may not start a process on the target's workspace does not get one
      // started for it a turn later.
      const notifyRoad = asked === undefined ? registered?.road : roadOf(origin);
      const turnToken = randomBytes(16).toString("hex");
      const { scoped, env: launchEnv, wsp } = await threadLaunch(entry, threadId, tree.rootThreadId ?? threadId);
      const dropScope = (): void => {
        if (scoped !== undefined) void deviceDoor.revoke(scoped.deviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      };
      // The one refusal left that comes after the mint, since the launch environment is what it is given: a harness
      // this host has no adapter for hands the token back rather than leaving it standing until a restart.
      let built: { harness: string; adapter: HarnessAdapter };
      // Flipped while a permission prompt of this turn stands open: the stream the adapter is about to launch reads
      // it, and the row the turn opens writes it, so a turn stopped on a question is not read as a quiet one.
      const waiting = { on: false };
      try {
        built = ctx.adapterFor(
          entry,
          o.harness,
          { [TURN_TOKEN_ENV]: turnToken, ...launchEnv },
          () => waiting.on,
          // A name no catalog row declares is one an MCP server's definition reads; the kind decides whether the
          // environment is what carries it.
          serverValuesOf(opts.vault?.() ?? {}),
          threadId,
        );
      } catch (e) {
        dropScope();
        throw e;
      }
      const { harness, adapter } = built;
      // Only on this computer: a box keeps the prompt in its launch seed, since a write there is one more exec trip.
      const promptsLate = adapter.waitsForPrompt === true && copiesFolder(entry.record.kind);
      // The wsp tools ride every launch, for a harness that takes servers with one: under the same name as the
      // person's own wsp server, which Claude Code's --mcp-config and Codex's -c overrides both replace while the
      // person's other servers stay (measured on 2.1.284 and 0.155.1 against the user-scope config; a project's own
      // .mcp.json naming wsp was not measured). A harness that takes none is refused where a caller named servers and
      // left alone here, since the person asked for a thread, not for tools.
      const served = servedTo(wsp, tree.rootThreadId ?? threadId, threadId);
      const mcpServers = served !== undefined && adapter.mcpServers === true ? { [MCP_SERVER_NAME]: served, ...o.mcpServers } : o.mcpServers;
      const records = (o.attachments ?? []).map(attachmentRecord);
      const blocked = filesBlocked(records, adapter.attachments, harness) ?? mcpServersBlocked(o.mcpServers, adapter.mcpServers, harness);
      if (blocked !== null) {
        dropScope();
        throw new Error(blocked);
      }
      const turnId = randomUUID();
      // The thread's row is written here, before anything is asked of the machine: the harness's own lists, the
      // folder and the images all sit between this line and the launch, and they are seconds. A thread no row holds
      // is a thread nothing can be waited on, so a wait fired the moment after a detached start would find nothing
      // to wait for. Only where the thread has none of its own: a thread whose turn is running already has the row
      // a wait waits on, and a second would be the one every client folds the thread's state, folder and times off
      // while it holds none of them. So a send that finds the thread taken holds nothing until the thread is free,
      // and holds its row from then to the launch. The row carries what is known now; the picks and the folder land
      // on it below, and the harness's own facts as the turn answers.
      const view: SessionView = {
        id: turnId,
        workspaceId,
        harness,
        status: "running",
        startedBy: o.startedBy ?? "person",
        threadId,
        ...tree,
        ...(o.attempt !== undefined ? { attempt: o.attempt } : {}),
        prompt: o.prompt,
        startedAt: Date.now(),
        ...(title !== undefined ? { harnessTitle: title, titleSource: "person" as const } : ctx.carriedTitle(threadId)),
        ...(resume !== undefined ? { claudeSessionId: resume } : {}),
        ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
      };
      // The running turn this request came out of, when it waits on this one: its follow, or a start answered only at
      // its launch. This turn runs in that turn's slot, so a thread following another never holds the slot it waits for.
      const asker = scopeOf(origin)?.threadId;
      const waitedOn = o.followed === true || o.onHeld === undefined;
      const lender = asker === undefined || asker === threadId || !waitedOn ? undefined : ctx.runningOn(asker)?.turnId;
      let launched!: () => void;
      const launch = new Promise<void>(r => (launched = r));
      let held = false;
      const hold = (): void => {
        if (held || ctx.threadRuns(threadId)) return;
        // The thread is this send's to run, and the session it resumes is the one the thread's latest turn ran as:
        // a send that arrived while that turn was still launching read none, since the harness names its session
        // only after it is up.
        resume = ctx.latestOn(threadId)?.claudeSessionId ?? resume;
        held = true;
        // The row that says the thread is spoken for also says who its turns tell: a send into the thread reads the
        // opener's notify off its rows, and inside the launch window this is the only one.
        ctx.capHold(entry.record, turnId, lender);
        sessions.set(turnId, { view, turnId, launch, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}) });
        bus.emit({ type: "session.held", workspaceId, threadId, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
      };
      hold();
      let outcome: Exclude<SessionStartOutcome, "held"> = "started";
      // A start still waiting on its agent past AGENT_STARTING_MS says so once, with whether the agent's command is a
      // wrapper whose first run installs it; nothing goes out once the turn's session started or the start left.
      let quiet = false;
      const sayStarting = async (): Promise<void> => {
        if (quiet || outcome === "queued") return hush();
        const installs = await ctx.firstRunHere(entry, harness);
        if (quiet) return;
        hush();
        bus.emit({ type: "session.starting", workspaceId, threadId, harness, ...(installs ? { installs: true as const } : {}), ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
      };
      const slow = setTimeout(() => void sayStarting(), AGENT_STARTING_MS);
      const offStarted = bus.on("*", e => {
        if ((e.type === "session.start" || e.type === "session.end") && e.turnId === turnId) hush();
      });
      function hush(): void {
        quiet = true;
        clearTimeout(slow);
        offStarted();
      }
      let images: TurnImage[] = [];
      let imagesDir: string | undefined;
      let filePaths: string[] = [];
      let serverValues: HarnessStartOptions["serverValues"];
      let filesFolder: string | undefined;
      // Every send takes one trip before its launch: its files land and its folder's snapshot is taken, or only started
      // where the agent takes its prompt late.
      let landed = false;
      // Let through by its computer's threads at once, which it is asked once, and whether the caller heard it held.
      let through = false;
      let toldHeld = false;
      let snapshot: { from: Promise<string | undefined> | string; cwd: string } | undefined;
      // What this send's own folders on the machine are named by where its request id cannot be: the landing runs
      // before any turn is registered, so two sends arriving together both pass the wait, and a folder they shared
      // would leave the first turn holding the second's picture.
      const minted = randomUUID();
      // Every road out of the window between the row above and runTurn is in here, since the row that says this
      // thread is working and the images this send put on the machine both belong to a turn that does not exist on
      // any of them: a refusal after a trip, a start that never opened. A steer leaves by returning and holds
      // neither: a send steers only a turn that was running when it looked, before it held the thread or landed a
      // thing.
      let handedOver = false;
      let failure: string | undefined;
      let keptTaken: KeptProcess | undefined;
      try {
        const table = harnessCatalog(harness);
        // Checked against the binary's own lists, the ones the composer shows for this workspace, with the marks on
        // what the person's defaults resolve to here, which startPicks fills in for anything this start leaves out.
        const resolved = table === undefined ? undefined : ctx.defaultsOn(await ctx.catalogOn(table, entry, adapter), prefs, overrides);
        const catalog = resolved?.catalog;
        const named = o.permissionMode ?? (o.access === undefined ? undefined : ctx.namedMode(catalog, harness, o.access));
        // The thread's own access, read against the list in front of us: a mode this harness does not take is a pick
        // that does not apply here, not a send to refuse. An access this send NAMED is still refused, by startPicks. The
        // model, effort and window it leaves out are the thread's own the same way; only a thread with none opens on
        // the defaults.
        const picksFor = (session: string | undefined): StartPicks & { contextWindow?: string } => {
          const access = named ?? (catalog === undefined ? undefined : listedPick(catalog.permissionModes, ctx.accessOf(workspaceId, threadId, session)));
          const ran = ctx.ranOn(workspaceId, threadId, session);
          const kept = keptPicks(catalog, ran, { ...(o.model !== undefined ? { model: o.model } : {}), ...(o.effort !== undefined ? { effort: o.effort } : {}), ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}) });
          const open = session === undefined && ran.model === undefined && ran.effort === undefined ? (resolved?.open ?? {}) : {};
          const model = kept.model ?? open.model;
          const effort = kept.effort ?? open.effort;
          const picks = startPicks(catalog, { ...o, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), permissionMode: access }, session === undefined, session === undefined ? undefined : ctx.resumedFact(workspaceId, session, "model"));
          return { ...picks, ...(kept.contextWindow !== undefined ? { contextWindow: kept.contextWindow } : {}) };
        };
        // A pick the lists do not carry is refused here, before this send waits on anything; the picks themselves
        // are decided below the loop, against the session this send turns out to resume.
        picksFor(resume);
        const folder = await ctx.threadFolder(entry, o);
        if (o.cwd !== undefined && isLocalWorkspace(entry.record) && !existsSync(folder)) throw Object.assign(new Error(noCwdLine(homeShortened(folder, homedir()))), { kind: "usage" });
        const limitDetails = await ctx.limitDetailsDue(entry, harness);
        // Two processes on one harness session corrupt its transcript, so a thread runs one turn at a time. Nothing
        // below this loop may await: the wait ends the moment no turn is running, and every line from there to
        // runTurn, which registers this one, is one synchronous run. The images land inside it for that reason, once
        // the thread is this send's, and the workspace is checked again after them, since landing them is a trip to
        // the machine and the row this send holds keeps every other send behind it meanwhile. Sends are taken as they
        // reach this loop, which is the order their trips finish and not always the order they arrived.
        for (;;) {
          const running = ctx.runningOn(threadId);
          if (running === undefined) {
            const stopping = ending.get(threadId);
            if (stopping !== undefined) {
              if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, harness, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
              outcome = "queued";
              await stopping;
              refuse();
              cleared = false;
              continue;
            }
            // A turn of this thread another send is still carrying to the machine has no harness to steer or to wait
            // out yet, so this one waits for the moment it has one or is given up, and looks again.
            const launching = ctx.launchingOn(threadId);
            if (launching !== undefined && launching.turnId !== turnId) {
              // A held turn ahead of this one would otherwise wait on the slot this send's follower holds.
              if (lender !== undefined) ctx.capLend(launching.turnId, lender);
              if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, harness, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
              outcome = "queued";
              await launching.launch;
              refuse();
              cleared = false;
              continue;
            }
            if (!cleared) {
              cleared = true;
              await ctx.copyBlocked(entry);
              continue;
            }
            const writing = resume === undefined ? undefined : ctx.hostWrites.get(resume);
            if (writing !== undefined) {
              await writing;
              refuse();
              continue;
            }
            hold();
            // A computer running as many threads as it takes at once holds this turn back before anything lands, so
            // the checkpoint the turn starts from is taken when it starts; the look is part of the run to the launch.
            if (!through) {
              const stops = ctx.capHeld.get(turnId)?.stops;
              if (stops !== undefined && stops.size > 0) {
                await Promise.all(stops);
                refuse();
                cleared = false;
                continue;
              }
              const stopped = ctx.capHeld.get(turnId)?.stopped;
              if (stopped !== undefined) throw new Error(stopped);
              const full = o.wakesLead === true ? undefined : ctx.capFull(entry.record, turnId);
              if (full !== undefined) {
                hush();
                const waits = ctx.capWait({ workspaceId, threadId, turnId, sessionId: resume ?? turnId, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) }, full);
                if (!toldHeld) {
                  toldHeld = true;
                  o.onHeld?.({ view: { ...view, capped: full }, turnId, wait: full });
                }
                await waits;
                refuse();
                cleared = false;
                continue;
              }
              through = true;
              ctx.capLeft(turnId);
            }
            if (landed) break;
            landed = true;
            const landing = ctx.runsIn(entry, resume === undefined ? undefined : ctx.folderOf(workspaceId, resume), folder);
            ({ images, dir: imagesDir } = await ctx.landImages(entry, adapter.attachments, landing, turnImagesDir(landing, threadId, o.requestId, minted), (o.attachments ?? []).filter(a => isImage(a.mediaType))));
            filePaths = await ctx.landFiles(entry, landing, sendFilesDir(landing, threadId, o.requestId, minted), (o.attachments ?? []).filter(a => !isImage(a.mediaType)));
            if (filePaths.length > 0) filesFolder = landing;
            if (adapter.mcpServers === true) serverValues = await ctx.serverValuesFor(entry, harness, landing);
            const taken = promptsLate ? ctx.snapshotOf(entry, landing) : await ctx.snapshotOf(entry, landing);
            snapshot = taken === undefined ? undefined : { from: taken, cwd: landing };
            refuse();
            continue;
          }
          // A turn that has already answered takes no message, however well its harness steers: the words would
          // land after the reply the caller read. The send waits for that process to exit and runs as the thread's
          // next turn; nothing here is ever refused for being in the way.
          const steer = running.turnLive?.reply === undefined && adapter.steers ? running.handle.steer : undefined;
          const steerId = randomUUID();
          if (steer !== undefined && (await steer(o.prompt, steerId)) === "accepted") {
            ctx.recordSteer(running, running.handle.id, o, origin, steerId);
            return { ...running.handle, outcome: "steered" };
          }
          if (outcome === "started") bus.emit({ type: "session.queued", workspaceId, threadId, harness, prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) });
          outcome = "queued";
          await running.handle.finished.catch(() => {});
          refuse();
          cleared = false;
        }
        // A thread whose worktree went runs on in the project folder and is told so in its transcript. An agent that
        // keys its sessions to the project carries its session across; any other opens a fresh one there.
        const ranIn = resume === undefined ? undefined : ctx.folderOf(workspaceId, resume);
        const cwd = ctx.runsIn(entry, ranIn, folder);
        if (o.behind !== undefined) ctx.record({ type: "session.behind", workspaceId, sessionId: resume ?? turnId, turnId, threadId, text: o.behind });
        const movedFrom = ranIn ?? goneNow;
        if (movedFrom !== undefined && cwd !== movedFrom && entry.record.worktree?.gone === true) {
          const fresh = ranIn !== undefined && CATALOG_AGENTS.find(a => a.id === harness)?.projectKeyEnv === undefined;
          ctx.record({ type: "session.moved", workspaceId, sessionId: resume ?? turnId, turnId, threadId, from: movedFrom, to: cwd, ...(entry.record.worktree.branch !== undefined ? { branch: entry.record.worktree.branch } : {}), ...(fresh ? { fresh: true as const } : {}) });
          if (fresh) {
            resume = undefined;
            delete view.claudeSessionId;
          }
        }
        const picks = picksFor(resume);
        const afterCut = resume !== undefined && ctx.cutBefore(workspaceId, threadId);
        // What the trips above settled, onto the row the start wrote: the reads that decide them are behind us, so
        // none of them can be answered from the row they are about. Written before adapter.start, so events that
        // fire synchronously inside start() land on the same view.
        Object.assign(view, picks, cwd !== undefined ? { cwd } : {}, resume !== undefined ? { claudeSessionId: resume } : {});
        // A rewind's cut rides the first resume after it, on a harness that takes one there.
        const cutAt = resume !== undefined && adapter.resumesAt === true ? threadRecords.get(threadId)?.resumeAt : undefined;
        const handed = attachedFilesPrompt(o.prompt, filePaths);
        // What a launch fixes for the life of the agent's process: a turn runs on the thread's kept process only where
        // its own launch would be the same, and a rewind's cut is a launch of its own.
        const launchKey: KeptLaunch | undefined =
          ctx.moduleOf(entry.record.kind).keepsAgents && cutAt === undefined
            ? {
                fixed: JSON.stringify({ harness, cwd, mcpServers: o.mcpServers, version: catalog?.version, setup: ctx.setupPlace(entry) === undefined ? undefined : setups.launchOf(ctx.setupPlace(entry)!, harness) }),
                picks: { ...picks },
              }
            : undefined;
        // Matched on what this send named and the thread's access alone: a pick it left out is the thread's own, which
        // is the kept process's, even where the agent announced its model in other words than it was launched with.
        const asked = { ...(o.model !== undefined ? { model: picks.model } : {}), ...(o.effort !== undefined ? { effort: picks.effort } : {}), ...(o.contextWindow !== undefined ? { contextWindow: picks.contextWindow } : {}), ...(picks.permissionMode !== undefined ? { permissionMode: picks.permissionMode } : {}), ...(picks.fast === true ? { fast: true } : {}) };
        const kept = ctx.takeKept(threadId, launchKey === undefined ? undefined : { fixed: launchKey.fixed, picks: asked }, resume);
        // The kept process carries the token and the device its first turn was launched with; this send's go unused.
        if (kept !== undefined) dropScope();
        const promptAfter = promptsLate && snapshot?.from instanceof Promise ? snapshot.from.then(() => {}) : undefined;
        keptTaken = kept;
        const handle = ctx.runTurn({
          entry,
          view,
          threadId,
          turnId,
          ...(adapter.reportsEdits === true ? { reportsEdits: true } : {}),
          ...(notify !== undefined ? { notify } : {}),
          ...(notifyBy !== undefined ? { notifyBy } : {}),
          ...(notifyRoad !== undefined ? { notifyRoad } : {}),
          turnToken: kept?.turnToken ?? turnToken,
          outcome,
          ...((): { scopeDeviceId?: string } => {
            const device = kept !== undefined ? kept.scopeDeviceId : scoped?.deviceId;
            return device !== undefined ? { scopeDeviceId: device } : {};
          })(),
          ...(launchKey !== undefined ? { keep: { launch: kept?.launch ?? launchKey } } : {}),
          opening: { prompt: o.prompt, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}), ...(o.via !== undefined ? { via: o.via } : {}), ...(afterCut ? { afterCut } : {}), ...(o.afterLimit !== undefined ? { afterLimit: o.afterLimit } : {}), ...(opens ? { opensThread: true } : {}), ...(title !== undefined ? { title } : {}), ...(records.length > 0 ? { attachments: records } : {}) },
          asked: { prompt: handed, ...(picks.effort !== undefined ? { effort: picks.effort } : {}), ...(handed !== o.prompt ? { typed: o.prompt } : {}) },
          ...(imagesDir !== undefined ? { imagesDir } : {}),
          ...(snapshot !== undefined ? { snapshot } : {}),
          ...(resume !== undefined ? { resume } : {}),
          ...(cutAt !== undefined ? { cutAt } : {}),
          waiting: kept?.waiting ?? waiting,
          open: onEvent =>
            kept !== undefined
              ? kept.agent.next({ prompt: handed, ...(images.length > 0 ? { images } : {}), ...(promptAfter !== undefined ? { after: promptAfter } : {}), onEvent })
              : adapter.start({
              prompt: handed,
              ...(resume !== undefined ? { resume } : {}),
              ...(cutAt !== undefined ? { resumeAt: cutAt } : {}),
              ...(cwd !== undefined ? { cwd } : {}),
              ...picks,
              ...(title !== undefined ? { title } : {}),
              ...(images.length > 0 ? { images } : {}),
              ...(mcpServers !== undefined ? { mcpServers } : {}),
              ...(serverValues !== undefined ? { serverValues } : {}),
              ...(limitDetails ? { limitDetails: true as const } : {}),
              ...(promptAfter !== undefined ? { promptAfter } : {}),
              ...(launchKey !== undefined ? { keep: true as const } : {}),
              ...(catalog?.source === "harness" && catalog.version !== null ? { version: catalog.version } : {}),
              // The thread's earlier turns as its transcript holds them, this one left out since its message follows.
              ...(resume !== undefined ? { seed: async () => threadSeed(threadMessages((await ctx.openTranscript(workspaceId)).filter(e => e.turnId !== turnId), threadId)) } : {}),
              onEvent,
            }),
        });
        handedOver = true;
        void ctx.keepSentImages(workspaceId, threadId, o.requestId, o.attachments ?? []);
        // The thread's record, written at its first turn from what that turn runs at, once the turn is under way so a
        // launch that never opened leaves none; a thread from before the record existed gets one here too, off what
        // its rows said this turn runs at, so it is read the one way from now on. Persisted with the row as the turn
        // announces itself and at its end.
        if (!threadRecords.has(threadId)) threadRecords.set(threadId, { workspaceId, harness, ...(picks.permissionMode !== undefined ? { permissionMode: picks.permissionMode } : {}), worked: threadRan(ctx.rowsOn(threadId).filter(r => r.status !== "running")) });
        const thread = threadRecords.get(threadId)!;
        // A newer turn leaves Resume at reset nothing to resume.
        if (thread.limitResume !== undefined) {
          delete thread.limitResume;
          ctx.resumeTimers.get(threadId)?.();
        }
        if (filesFolder !== undefined && !(thread.filesIn ?? []).includes(filesFolder)) threadRecords.set(threadId, { ...thread, filesIn: [...(thread.filesIn ?? []), filesFolder] });
        launched();
        // The turn is running; what the record failed to remember must not read as a start that failed.
        if (resume === undefined) await ctx.rememberTarget(entry.record).catch((e: unknown) => console.warn(`last target for ${workspaceId} not remembered: ${e instanceof Error ? e.message : String(e)}`));
        return handle;
      } catch (e: unknown) {
        failure = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        if (!handedOver) {
          hush();
          ctx.capLeft(turnId);
          // The turn never reached a machine, so nothing out there is holding this token: it goes now rather than
          // standing until a host restart.
          dropScope();
          if (held) {
            // A start its caller heard was held went on without it, so the thread it was to report to hears how it
            // ended, as it hears of a turn that ran: a lead that ended its turn to wait on it is woken.
            if (toldHeld && failure !== undefined && notify !== undefined) {
              ctx.notifyEnd({ view, turnId }, notify, ctx.tellAs({ ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}) }), { status: "failed", error: failure });
            }
            sessions.delete(turnId);
            // Whoever the row told this thread was working must not be left waiting for a turn that never opened, so
            // its end goes out. On the bus alone and not through record: no turn ran, and a transcript that held an
            // end with no start behind it would be read as the thread's latest turn by every reader that folds those
            // rows, which is what the reply, the read and the wait itself all come off. Nothing goes out where the
            // road out named no reason, which is the message the thread's running turn took instead, nor where the
            // thread is still working: the turn that is running is the one a wait here is waiting on.
            if (failure !== undefined && !ctx.threadRuns(threadId)) {
              bus.emit({ type: "session.end", workspaceId, sessionId: view.id, turnId, threadId, exitCode: null, sawResult: false, reason: failure, at: Date.now() });
            }
          }
          // After the row is gone and its end is out, so a send that waited on it finds the thread as it now is.
          launched();
        }
        if (!handedOver && imagesDir !== undefined) ctx.dropImages(entry, imagesDir);
        // A kept process taken for a turn that never opened on it holds the thread's token with nobody to answer for it.
        if (!handedOver && keptTaken !== undefined) ctx.endKept(threadId, keptTaken);
      }
    },

    async list(workspaceId, origin) {
      await ctx.ready();
      // A listing that names a workspace refuses like any other verb naming one, unless a thread of the caller's
      // tree stands there; a listing of them all leaves out the rows the caller may not reach, as workspaces.list
      // leaves out the workspaces.
      if (workspaceId !== undefined && !ctx.treeStandsOn(workspaceId, origin)) ctx.refuseNamed(workspaceId, origin);
      const all = [...sessions.values()].filter(s => ctx.reachesRow(s.view, origin));
      const held = workspaceId === undefined ? all : all.filter(s => s.view.workspaceId === workspaceId);
      const rows = held.map(s => s.view);
      // A refresh is where a rename made inside the harness reaches us: nothing on this side changed. A row that
      // already carries a title is answered from the index and its read goes out unawaited, so a wedged guest
      // costs the listing nothing and the rename lands on the next refresh, which is the window the TTL promises.
      // A row with none blocks, so a thread is titled on the first listing that sees it. A machine still being settled
      // after a restart may answer nothing for minutes, so its rows wait for a later listing.
      const asked = ctx.titleRows(rows.filter(view => !ctx.bootWork.has(view.workspaceId))).map(view => ({ first: view.harnessTitle === undefined, done: ctx.refreshTitle(view, false) }));
      await Promise.all(asked.filter(a => a.first).map(a => a.done));
      return ctx.listedRows(held);
    },

    async history(workspaceId, origin) {
      await ctx.ready();
      // A thread reads the transcript of a workspace its tree stands on, its lead's included, and of its own tree's
      // workspaces; any other it names reads as every workspace verb reads it, so it learns nothing by asking.
      if (!ctx.treeStandsOn(workspaceId, origin)) await ctx.entryOf(workspaceId, origin);
      return (await ctx.openTranscript(workspaceId)).filter(e => ctx.drivesThread(e.threadId, origin)).map(e => ({ ...e }));
    },

    async page(workspaceId, window, origin) {
      await ctx.ready();
      if (!ctx.treeStandsOn(workspaceId, origin)) await ctx.entryOf(workspaceId, origin);
      if (!ctx.drivesThread(window.threadId, origin)) return { events: [], pos: transcriptIndex.get(workspaceId)?.pos ?? 0, total: 0 };
      return ctx.transcriptReader.read(workspaceId, window.threadId, {
        ...(window.before !== undefined ? { before: window.before } : {}),
        limit: window.limit ?? HISTORY_PAGE_EVENTS,
        bytes: HISTORY_PAGE_BYTES,
      });
    },

    async head(threadId, origin) {
      await ctx.ready();
      const facts = ctx.threadFacts(threadId);
      if (facts === undefined || (await ctx.entryOfRow({ threadId: facts.threadId ?? threadId, workspaceId: facts.workspaceId }, origin)) === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // The events take what the facts leave of the head's bytes, less the reply's own keys and numbers.
      const room = HEAD_BYTES - Buffer.byteLength(JSON.stringify(facts)) - 100;
      return { facts, ...(await ctx.transcriptReader.read(facts.workspaceId, facts.threadId ?? threadId, { limit: Infinity, bytes: room, strict: true, shape: headShape })) };
    },

    async attachment(workspaceId, threadId, requestId, index, origin) {
      await ctx.ready();
      if (!ctx.treeStandsOn(workspaceId, origin)) await ctx.entryOf(workspaceId, origin);
      await ctx.keptWrites.get(workspaceId);
      const key = attachmentKey(threadId, requestId, index);
      const held = key === undefined || !ctx.drivesThread(threadId, origin) ? undefined : ((await store.get(ATTACHMENT_KEYS, workspaceId)) as KeptImages | undefined)?.threads[threadId]?.find(k => k.key === key);
      const bytes = held === undefined ? undefined : await store.getBlob(ATTACHMENTS, held.key);
      if (held === undefined || bytes === undefined) throw notFoundRefusal(`no image ${index + 1} kept on that message`);
      return { mediaType: held.mediaType, bytes: bytes.toString("base64") };
    },

    async interrupt(sessionId, origin, task) {
      const asking = task === undefined ? ctx.capStopping(sessionId) : () => {};
      try {
        return await stopTurn(asking, sessionId, origin, task);
      } finally {
        asking();
      }
    },

    async steer(sessionId, o, origin) {
      await ctx.ready();
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      if (s.view.status !== "running" || s.handle === undefined) return { outcome: "not-running" };
      if (s.handle.steer === undefined) return { outcome: "unsupported" };
      const steerId = randomUUID();
      const outcome = await s.handle.steer(o.prompt, steerId);
      if (outcome !== "accepted") return { outcome };
      ctx.recordSteer(s, sessionId, o, origin, steerId);
      return { outcome: "accepted" };
    },

    async answer(sessionId, o, origin) {
      await ctx.ready();
      // A prompt's row carries the agent's own session id, as every row of a turn does, while a turn is keyed by the id
      // its launch was given: Codex's app-server and a Claude CLI that re-keys a resume name a session of their own.
      const keyed = sessions.get(sessionId);
      const s = keyed?.view.status === "running" ? keyed : ([...sessions.values()].find(row => row.view.claudeSessionId === sessionId && row.view.status === "running") ?? keyed);
      if (!s) return { outcome: "not-found" };
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      if (s.handle?.answer === undefined) return { outcome: s.handle === undefined ? "gone" : "unsupported" };
      return { outcome: await s.handle.answer(o.askId, { optionId: o.optionId, ...(o.reason === undefined ? {} : { reason: o.reason }) }) };
    },

    async access(id, permissionMode, origin) {
      await ctx.ready();
      // A row's id or a thread's: a thread whose rows all fell off the index cap is still the thread its record
      // says, and its access is moved on that record, which is what its next turn reads.
      const s = sessions.get(id) ?? [...sessions.values()].filter(r => r.view.threadId === id).at(-1);
      const record = s === undefined ? threadRecords.get(id) : undefined;
      if (s === undefined && record === undefined) return { outcome: "not-found" };
      const entry = await ctx.entryOfRow(s?.view ?? { threadId: id, workspaceId: record!.workspaceId }, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      const { harness, adapter } = await ctx.launchAdapterFor(entry, s?.view.harness ?? record!.harness);
      const table = harnessCatalog(harness);
      // Checked against the list the picker showed, so a mode this CLI does not take is refused in the same words a
      // start refuses it with rather than travelling to the machine as a request it will not answer.
      if (table !== undefined) startPicks(await ctx.catalogOn(table, entry, adapter), { permissionMode }, false);
      if (s === undefined) {
        threadRecords.set(id, { ...record!, permissionMode });
        void ctx.persistSessions(record!.workspaceId);
        ctx.pushHead(id);
        return { outcome: "set" };
      }
      // The pick lands on the thread's record whatever the turn running now does with it: this is the one road that
      // changes a thread's access, and the thread's next turn runs at it. The thread's latest row says the same, as
      // every client folds the access off that row; a running turn's row moves where the harness took the pick,
      // and otherwise as the turn ends, so no row says a mode the thread's next turn will not run at.
      const threadId = s.view.threadId;
      const running = threadId === undefined ? (s.view.status === "running" && s.handle !== undefined ? (s as LiveSession) : undefined) : ctx.runningOn(threadId);
      const latest = threadId === undefined ? s.view : (ctx.latestOn(threadId) ?? s.view);
      const landed = (): void => {
        if (threadId !== undefined) threadRecords.set(threadId, { ...(threadRecords.get(threadId) ?? { workspaceId: s.view.workspaceId, harness: s.view.harness }), permissionMode });
        if (latest.status !== "running") latest.permissionMode = permissionMode;
        void ctx.persistSessions(s.view.workspaceId);
        ctx.pushHead(threadKeyOf(s.view));
      };
      if (latest.status !== "running") {
        landed();
        return { outcome: "set" };
      }
      // A CLI that refused a mode its own list carries is one that will not take it on a turn already under way and
      // whose adapter had no way to stand in for it, as is one that takes none at all: the turn keeps its mode and
      // the pick stands for the next turn, which is what unsupported tells the composer to say. A turn whose process
      // this host does not hold, still launching or re-opened without one, is one the pick cannot reach.
      const outcome = running === undefined ? "gone" : running.handle.setAccess === undefined ? "refused" : await running.handle.setAccess(permissionMode);
      landed();
      return { outcome: outcome === "set" ? "set" : outcome === "refused" ? "unsupported" : "not-running" };
    },

    async rename(sessionId, title, origin) {
      await ctx.ready();
      const named = title.trim();
      if (named === "") throw new Error(EMPTY_TITLE_LINE);
      const s = sessions.get(sessionId);
      if (!s) return { outcome: "not-found" };
      const harnessSessionId = s.view.claudeSessionId;
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) return { outcome: "not-found" };
      const refusal = actionRefusal(workspaceState({ phase: entry.record.phase }), "rename", entry.record.gone, entry.record.name);
      if (refusal !== null) throw new Error(refusal);
      await ctx.copyBlocked(entry);
      const write = (await ctx.launchAdapterFor(entry, s.view.harness)).adapter.renameSession;
      if (write === undefined) return { outcome: "unsupported" };
      // The store is keyed by the harness's own id, so a thread whose harness never announced one has nothing to name.
      if (harnessSessionId === undefined) return { outcome: "no-session" };
      const wrote = await ctx.writeSession(harnessSessionId, () => write(harnessSessionId, named, harnessExec(entry.machine, SESSION_TITLE_TIMEOUT_MS)));
      // A store that refused the write says nothing about which sessions it has, so its own line travels as the answer.
      if (wrote.kind === "failed") return { outcome: "failed", error: wrote.error };
      if (wrote.kind === "no-session") return { outcome: "no-session" };
      // Every turn of the thread shares the harness's session, and the fold reads the latest turn's title. The name
      // is the person's, so a title the harness is still thinking about is thrown away when it lands.
      for (const row of sessions.values()) {
        if (row.view.workspaceId === entry.record.id && row.view.claudeSessionId === harnessSessionId) {
          row.view.harnessTitle = named;
          row.view.titleSource = "person";
        }
      }
      await ctx.persistSessions(entry.record.id);
      ctx.pushHead(threadKeyOf(s.view));
      return { outcome: "renamed" };
    },

    async read(threadId, origin) {
      await ctx.mark([threadId], { readAt: clock.now() }, origin);
    },

    async settle(threadIds, origin) {
      const at = clock.now();
      await ctx.mark(threadIds, { readAt: at, settledAt: at }, origin);
    },

    async mark(threadIds, marks, origin) {
      const at = clock.now();
      if (marks.resumeAtReset !== undefined) await ctx.armResume(threadIds, marks.resumeAtReset, origin);
      const stamps = {
        ...(marks.pinned !== undefined ? { pinnedAt: marks.pinned ? at : undefined } : {}),
        ...(marks.snoozedUntil === undefined ? {} : marks.snoozedUntil === null ? { snoozedUntil: undefined } : { snoozedUntil: marks.snoozedUntil, readAt: at }),
        ...(marks.section !== undefined ? { section: marks.section ?? undefined } : {}),
      };
      if (marks.resumeAtReset === undefined || Object.keys(stamps).length > 0) await ctx.mark(threadIds, stamps, origin);
    },

    async restore(threadIds, origin) {
      await ctx.mark(threadIds, { readAt: clock.now(), settledAt: undefined }, origin);
    },

    async search(query, origin) {
      await ctx.ready();
      const words = query.trim().toLowerCase();
      if (words === "") return { hits: [] };
      const found: { hit: SessionSearchResult["hits"][number]; last: number }[] = [];
      for (const [workspaceId, index] of transcriptIndex) {
        // The workspaces a caller reads the transcript of, by the rule history reads them by.
        if (!ctx.treeStandsOn(workspaceId, origin) && !(await ctx.entryOf(workspaceId, origin, { now: true }).then(() => true, () => false))) continue;
        for (const [threadId, { lines, last }] of index.words) {
          if (lines.length === 0 || !ctx.drivesThread(threadId, origin)) continue;
          // The snippet stays inside the one message that holds the words, so it never runs one message into the next.
          const text = lines.find(line => line.toLowerCase().includes(words));
          if (text !== undefined) found.push({ hit: { workspaceId, threadId, snippet: snippetAround(text, text.toLowerCase().indexOf(words), words.length) }, last });
        }
      }
      return { hits: found.sort((a, b) => b.last - a.last).map(f => f.hit) };
    },

    async aside(sessionId, question, origin, askId) {
      await ctx.ready();
      if (question.trim() === "") throw new Error(BLANK_ASIDE_LINE);
      const s = sessions.get(sessionId);
      if (!s) throw notFoundRefusal(`no session ${sessionId}`);
      const entry = await ctx.entryOfRow(s.view, origin);
      if (entry === undefined) throw notFoundRefusal(`no session ${sessionId}`);
      const refusal = sendRefusal(workspaceState({ phase: entry.record.phase }), entry.record.gone);
      if (refusal !== null) throw new Error(refusal);
      const latest = s.view.threadId === undefined ? s.view : (ctx.latestOn(s.view.threadId) ?? s.view);
      const servers = serverValuesOf(opts.vault?.() ?? {});
      const { harness, adapter: bare } = await ctx.launchAdapterFor(entry, latest.harness, undefined, undefined, servers);
      if (bare.aside === undefined) throw new Error(asideUnsupportedLine(harness));
      if (latest.claudeSessionId === undefined) throw new Error(ASIDE_NO_SESSION_LINE);
      const threadId = threadKeyOf(latest);
      const onText = askId === undefined ? undefined : (text: string): void => bus.pass({ type: "aside.text", workspaceId: latest.workspaceId, threadId, askId, text });
      // What the thread's latest turn ran at, so a harness that copies the session sends the request its turns sent.
      const ran = { ...(latest.cwd !== undefined ? { cwd: latest.cwd } : {}), ...(latest.model !== undefined ? { model: latest.model } : {}), ...(latest.effort !== undefined ? { effort: latest.effort } : {}), ...(latest.contextWindow !== undefined ? { contextWindow: latest.contextWindow } : {}), ...(latest.fast === true ? { fast: true } : {}) };
      const ask = { session: latest.claudeSessionId, question, ...ran, ...(onText !== undefined ? { onText } : {}) };
      const answered = async (asker: SessionAsker, q: AsideQuestion): Promise<{ text: string }> => {
        const { text } = await asker(q);
        if (text.trim() === "") throw new Error(ASIDE_EMPTY_LINE);
        return { text };
      };
      if (bare.asideServers !== true || bare.mcpServers !== true) return answered(bare.aside, ask);
      // A copy that loads the thread's servers is launched with the server the thread's turns get and the pair it
      // dials with, since a harness resuming a session that announced a server it no longer has tells the model so,
      // and the answer opens on it. The harness keeps every tool off; the token goes back the moment the answer is in.
      const { scoped, env: launchEnv, wsp } = await threadLaunch(entry, threadId, ctx.rootOf(threadId), { aside: true });
      try {
        const { adapter } = ctx.adapterFor(entry, harness, launchEnv, undefined, servers);
        if (adapter.aside === undefined) throw new Error(asideUnsupportedLine(harness));
        const served = servedTo(wsp, ctx.rootOf(threadId), threadId);
        const asideIn = latest.cwd ?? ctx.folderOf(latest.workspaceId, ask.session);
        const serverValues = asideIn === undefined ? undefined : await ctx.serverValuesFor(entry, harness, asideIn);
        return await answered(adapter.aside, { ...ask, ...(served !== undefined ? { mcpServers: { [MCP_SERVER_NAME]: served } } : {}), ...(serverValues !== undefined ? { serverValues } : {}) });
      } finally {
        if (scoped !== undefined) await deviceDoor.revoke(scoped.deviceId).catch((e: unknown) => console.warn(`the token of a side question on thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      }
    },

    async run(step, origin) {
      await ctx.ready();
      if (scopeOf(origin) !== undefined) throw new Error(RUN_PERSONS_LINE);
      const rows = [...sessions.values()].filter(s => s.view.threadId === step.threadId);
      const workspaceId = rows[0]?.view.workspaceId ?? threadRecords.get(step.threadId)?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(step.threadId)}`);
      const entry = await ctx.entryOfRow({ threadId: step.threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(step.threadId)}`);
      // Read off the transcript rather than kept beside it, so an ending recorded before a restart still holds.
      for (const e of await ctx.openTranscript(workspaceId)) {
        if (e.type === "session.run" && e.runId === step.runId && e.state !== "running") return { ...e };
      }
      const latest = ctx.latestOn(step.threadId);
      const event: SessionRunEvent = {
        type: "session.run",
        workspaceId,
        sessionId: latest?.claudeSessionId ?? latest?.id ?? step.turnId,
        turnId: step.turnId,
        threadId: step.threadId,
        runId: step.runId,
        block: step.block,
        command: step.command,
        state: step.state,
        ...(step.ptyId !== undefined ? { ptyId: step.ptyId } : {}),
        ...(step.exitCode !== undefined ? { exitCode: step.exitCode } : {}),
        ...(step.signal !== undefined ? { signal: step.signal } : {}),
        ...(step.output !== undefined ? { output: runOutputTail(step.output) } : {}),
      };
      ctx.record(event);
      return { ...event, at: Date.now() };
    },

    async rewind(threadId, opts, origin) {
      await ctx.ready();
      const rows = [...sessions.values()].filter(s => s.view.threadId === threadId);
      const held = threadRecords.get(threadId);
      const workspaceId = rows[0]?.view.workspaceId ?? held?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      const entry = await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      const conflict = (line: string): Error => Object.assign(new Error(line), { kind: "conflict" });
      // Every refusal comes before anything is written: nothing below this block moves a file or a row.
      if (rows.some(r => r.view.status === "running")) throw conflict(REWIND_WORKING_LINE);
      // A kept agent holds the conversation as it stood before the cut in its own memory.
      ctx.reapKept(threadId);
      const tree = ctx.treeUnder(threadId);
      const under = foldThreads([...sessions.values()].map(s => s.view).filter(v => v.threadId !== undefined && tree.includes(v.threadId)));
      const running = under.filter(t => t.status === "running");
      if (running.length > 0) throw conflict(rewindChildrenLine(running.map(t => t.title)));
      // The folder is every thread's on the record: files moved under one that runs would go back mid-turn.
      const besideRunning = (): void => {
        const beside = foldThreads([...sessions.values()].map(s => s.view).filter(v => v.workspaceId === workspaceId && v.threadId !== undefined && v.threadId !== threadId)).find(t => t.status === "running");
        if (beside !== undefined) throw conflict(rewindBesideLine(beside.title));
      };
      const cwd = ctx.checkoutOf(entry.record);
      const restore = (checkpoint: string) => ctx.queued(entry.record.id, () => ctx.withDaemon(entry, ask => ask({ op: "git.restore", cwd, checkpoint, scope: entry.record.id })));
      const done = async (): Promise<void> => {
        await ctx.persistSessions(workspaceId);
        await ctx.flushTranscript(workspaceId);
        bus.emit({ type: "thread.rewound", workspaceId, threadId });
      };

      if (opts.undo === true) {
        const rewound = held?.rewound;
        if (rewound === undefined) throw conflict(REWIND_NO_UNDO_LINE);
        besideRunning();
        const back = await restore(rewound.before);
        delete held!.rewound;
        // The slate follows the conversation, which undo never puts back: it stays as the rewind left it.
        await done();
        return { turns: 0, files: Number(back["files"] ?? 0) };
      }

      // A copy, read for the turns and their checkpoints alone: the cut below takes its own copy inside the queue.
      const events = [...(await ctx.openTranscript(workspaceId))];
      const order: string[] = [];
      for (const e of events) if (e.threadId === threadId && e.turnId !== undefined && !order.includes(e.turnId)) order.push(e.turnId);
      const at = opts.turnId === undefined ? -1 : order.indexOf(opts.turnId);
      if (at < 0) throw notFoundRefusal(`no turn ${opts.turnId ?? ""} on thread ${threadWord(threadId)}`);
      if (at === order.length - 1) throw conflict(REWIND_LATEST_LINE);
      const cut = order.slice(at + 1);
      const keptOf = (turnId: string): Extract<SessionEvent, { type: "session.checkpoint" }> | undefined => {
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i]!;
          if (e.type === "session.checkpoint" && e.turnId === turnId) return e;
        }
        return undefined;
      };
      const kept = keptOf(order[at]!);
      const latest = ctx.latestOn(threadId) ?? rows[0]?.view;
      const { harness, adapter } = await ctx.launchAdapterFor(entry, latest?.harness ?? held?.harness);
      const agent = harnessCatalog(harness)?.label ?? harness;
      let files = opts.files === true;
      if (files && kept?.ref === undefined) throw conflict(REWIND_NO_CHECKPOINT_LINE);
      // Files go back only where no other thread ran a turn in the folder after the checkpoint, running ones
      // included: otherwise the files hold that thread's work too, and the conversation alone goes back.
      const keptAt = kept?.at ?? [...sessions.values()].find(r => r.turnId === order[at])?.view.endedAt ?? 0;
      const shared = files && [...sessions.values()].some(({ view: v }) => v.workspaceId === workspaceId && v.threadId !== undefined && v.threadId !== threadId && (v.endedAt ?? Number.POSITIVE_INFINITY) > keptAt);
      if (shared) files = false;
      // A harness that said it cannot cut this thread keeps every turn: the files alone go back and it is not asked.
      const uncut = events.find((e): e is Extract<SessionEvent, { type: "session.checkpoint" }> => e.type === "session.checkpoint" && e.threadId === threadId && e.kept !== undefined)?.kept;
      if (uncut !== undefined && !files) throw conflict(shared ? REWIND_SHARED_LINE : rewindKeptLine(uncut, false));
      const cutsConversation = (adapter.resumesAt === true || adapter.revert !== undefined) && uncut === undefined;
      if (adapter.resumesAt === true && kept?.anchor === undefined) throw conflict(rewindNoAnchorLine(agent));
      if (!cutsConversation && !files) throw conflict(shared ? REWIND_SHARED_LINE : rewindNoAnchorLine(agent));

      // Files first, since they alone can be put back: a harness that then will not cut has them restored again and
      // the whole rewind refused, rather than a conversation cut over files that never moved.
      const moved = files ? await restore(kept!.ref!) : undefined;
      const before = moved === undefined ? undefined : String(moved["before"]);
      let keptWhy: string | undefined;
      if (adapter.revert !== undefined && cutsConversation && latest?.claudeSessionId !== undefined) {
        const firstCut = keptOf(cut[0]!)?.anchor;
        // A turn that named no anchor is found by count among the harness's own, off each cut turn's anchor and end.
        const endOf = (turnId: string): TurnResult | undefined => {
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i]!;
            if (e.type === "session.done" && e.turnId === turnId) return e.result;
          }
          return undefined;
        };
        const turnOf = (turnId: string): { anchor?: string; result?: TurnResult } => {
          const anchor = keptOf(turnId)?.anchor;
          const result = endOf(turnId);
          return { ...(anchor !== undefined ? { anchor } : {}), ...(result !== undefined ? { result } : {}) };
        };
        try {
          const answer = await adapter.revert({ session: latest.claudeSessionId, cwd, ...(firstCut !== undefined ? { beforeTurn: firstCut } : { turns: cut.map(turnOf) }) });
          keptWhy = answer?.kept;
        } catch (e) {
          if (before !== undefined) await restore(before).catch((back: unknown) => console.warn(`the files of thread ${threadWord(threadId)} were not put back after a refused rewind: ${back instanceof Error ? back.message : String(back)}`));
          throw e;
        }
      }
      const record = held ?? { workspaceId, harness };
      threadRecords.set(threadId, record);
      if (adapter.resumesAt === true) record.resumeAt = kept!.anchor!;
      if (before !== undefined) record.rewound = { before, at: clock.now() };
      if (keptWhy !== undefined) {
        await done();
        throw conflict(rewindKeptLine(keptWhy, before !== undefined));
      }
      if (cutsConversation) await ctx.dropFromTranscript(workspaceId, e => e.threadId === threadId && cut.includes(e.turnId ?? ""));
      await ctx.slates.rewound({ threadId, turnId: order[at]!, cut });
      await done();
      return { turns: cutsConversation ? cut.length : 0, ...(moved !== undefined ? { files: Number(moved["files"] ?? 0) } : {}), ...(shared ? { kept: REWIND_SHARED_LINE } : {}) };
    },

    async delete(threadId, origin) {
      await ctx.ready();
      ctx.spawnGuard("delete", origin);
      const workspaceId = [...sessions.values()].find(s => s.view.threadId === threadId)?.view.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      const entry = await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      if (!runsInFolder(entry.record.kind)) throw Object.assign(new Error(threadOnMachineLine(entry.record.name)), { kind: "usage" });
      const tree = entry.record.worktree;
      if (tree?.made === true && tree.gone !== true) {
        // Every thread in it goes with the worktree, so none may be working, and none can land a checkpoint after
        // its refs were dropped.
        if (ctx.turnRuns(workspaceId)) throw Object.assign(new Error(WORKTREE_BUSY_LINE), { kind: "conflict" });
        const threads = new Set([...sessions.values()].flatMap(s => (s.view.workspaceId === workspaceId && s.view.threadId !== undefined ? [s.view.threadId] : [])));
        for (const thread of threads) await ctx.moduleOf(entry.record.kind).endThread?.(entry, thread, { remove: true });
        await ctx.workspaces.delete(workspaceId, origin);
        return { workspaceId, worktree: tree.path, threads: threads.size };
      }
      if (ctx.threadRuns(threadId)) throw Object.assign(new Error(THREAD_WORKING_LINE), { kind: "conflict" });
      ctx.reapKept(threadId);
      await ctx.moduleOf(entry.record.kind).endThread?.(entry, threadId, { remove: true });
      await ctx.openTranscript(workspaceId);
      await ctx.dropCheckpoints(entry, threadId);
      await ctx.dropThreadFiles(entry, [threadId]);
      await ctx.dropSentImages(workspaceId, [threadId]);
      for (const [id, s] of [...sessions]) if (s.view.threadId === threadId) sessions.delete(id);
      threadRecords.delete(threadId);
      await ctx.dropFromTranscript(workspaceId, e => e.threadId === threadId);
      await ctx.persistSessions(workspaceId);
      await ctx.slates.forget(threadId);
      return { workspaceId, threads: 1 };
    },

    async forget(threadId, origin, o = {}) {
      await ctx.ready();
      const held = [...sessions].filter(([, s]) => s.view.threadId === threadId);
      const record = threadRecords.get(threadId);
      const workspaceId = held[0]?.[1].view.workspaceId ?? record?.workspaceId;
      if (workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // The same absence a name nothing holds gets: a sentence of its own would tell a thread of another tree that
      // the thread it named is there, and the refusal past this gate says its turn ran.
      const entry = await ctx.entryOfRow({ threadId, workspaceId }, origin);
      if (entry === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
      // The rows that say a turn did work fall off the index cap, so the record's word stands beside them: a thread
      // whose worked turns fell off is refused however few rows it has left, and one whose turns never worked goes.
      if (threadRan(held.map(([, s]) => s.view)) || (record !== undefined && record.worked !== false)) throw Object.assign(new Error(threadForgetRefusal(threadId)), { kind: "conflict" });
      if (o.check === true) return;
      // A transcript that does not read refuses here, before anything is changed.
      await ctx.openTranscript(workspaceId);
      // A launch that never got going can still have landed the files its send carried.
      await ctx.dropThreadFiles(entry, [threadId]);
      await ctx.dropSentImages(workspaceId, [threadId]);
      for (const [id] of held) sessions.delete(id);
      threadRecords.delete(threadId);
      await ctx.slates.forget(threadId);
      await ctx.dropFromTranscript(workspaceId, e => e.threadId === threadId);
      await ctx.persistSessions(workspaceId);
    },
  };
  return { sessionsApi };
}
