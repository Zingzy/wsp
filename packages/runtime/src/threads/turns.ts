// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AdapterEvent, type PermissionAsk, type PermissionOption, type PermissionOutcome, type SessionEvent,
  type SessionAnswerResult, type SessionStartOutcome, type SessionView, type AttachmentRecord, type TurnResult,
  type TurnStatus, ThreadScope, WorkspaceOrigin, threadWord, leadAsk, askingLine, permissionModeOptionLabel,
  pickedOptions, deniedLine, toolCallFacts, notifyBody, turnLines,
} from "@wsp/protocol";
import { harnessCatalog } from "../harness-catalog.js";
import type { HarnessSession, HarnessAdapter } from "../types/harness.js";
import type { LiveWorkspace, SessionHandle } from "../types/wiring.js";
import {
  sweptRunsLogLine, noMadeTitleLogLine, type TurnWritten, turnWritten, type TurnLive, type TurnAsked, type KeptLaunch,
  type Reopened, writeLines,
} from "../types/internal.js";
import type { RuntimeContext, TurnsArea } from "../context.js";

export function turnsArea(ctx: RuntimeContext): TurnsArea {
  const { bus, clock, deviceDoor, live, threadRecords, sessions } = ctx;
  const runTurn = (t: {
    entry: LiveWorkspace;
    view: SessionView;
    /** How much of itself a turn re-opened after a restart has written. A new turn has written nothing. */
    written?: TurnWritten;
    /** The thread this turn runs on, which every row the runtime writes carries. */
    threadId: string;
    turnId: string;
    notify?: readonly string[];
    /** The thread that named those targets, where a thread named them: the line their end delivers starts the
     * target's turn under it, so the rules that let it name them are read again when the line goes. */
    notifyBy?: ThreadScope;
    /** And the road they were named from, read at delivery beside the thread, so a caller that may start no
     * process on the target's workspace gets none started for it a turn later. */
    notifyRoad?: WorkspaceOrigin;
    /** The token this turn was launched with, kept on its row while the turn runs so a request out of it can name
     * this thread. */
    turnToken?: string;
    /** The device this turn's launch environment carries into the machine, taken away at the exit beside the turn
     * token: the two are one turn's identity and they end together. */
    scopeDeviceId?: string;
    outcome: Exclude<SessionStartOutcome, "held">;
    /** What this turn's own session.start row carries, for the road that still has to write it. */
    opening: { prompt: string; requestId?: string; via?: "slate"; afterCut?: boolean; afterLimit?: number; opensThread?: boolean; title?: string; attachments?: readonly AttachmentRecord[] };
    /** The message the agent is handed and the effort it runs at, kept beside the run while the turn runs. */
    asked?: TurnAsked;
    /** The harness session this turn resumes, so the row it takes over keeps who opened the thread and with what. */
    resume?: string;
    /** The rewind's anchor this turn was launched to cut at; the thread lets it go once the turn announces itself. */
    cutAt?: string;
    /** What the row already knows of this turn's reply: a re-opened turn whose result landed before the restart is
     * still working, and reads as such until the run's own result line comes round again. */
    turnLive?: TurnLive;
    /** The folder this turn's images landed in on the machine, removed when the turn ends however it ends; absent on
     * a turn that landed none, whose harness read them inline or which carried none at all. */
    imagesDir?: string;
    /** The snapshot of the turn's folder taken as it launched, which the range of what it changed starts from: the
     * commit itself where it is known as the turn is handed over, a launch's already in or a re-opened turn's off
     * its row. */
    snapshot?: { from: Promise<string | undefined> | string; cwd: string };
    /** Whether the harness names every file its tool calls write (HarnessAdapter.reportsEdits). */
    reportsEdits?: boolean;
    /** The box the turn's own exec stream reads to know it is waiting on something outside its own process: flipped
     * while a permission prompt of this turn stands open, and while its harness reports a command or a subagent it
     * started still running, so the turn's idle clock does not run out under a question nobody has answered yet nor
     * under a quiet watch on work the turn started. Absent on a road that hands the adapter no stream of its own. */
    waiting?: { on: boolean };
    /** What the turn's process was launched with, where it may be kept for the thread's next turn once this one is over. */
    keep?: { launch: KeptLaunch };
    open: (onEvent: (event: AdapterEvent) => void) => HarnessSession;
  }): SessionHandle => {
    const { entry, view, threadId, turnId, opening, outcome, notify, notifyBy, notifyRoad, turnToken, scopeDeviceId } = t;
    const workspaceId = entry.record.id;
    const { lines: deltasWritten, subagents: subagentsWritten, compactions: compactionsWritten, reply: recordedReply, started: startWritten, changes: changesWritten } = t.written ?? { lines: 0, subagents: 0, compactions: 0, started: false, changes: false };
    /** What the turn changed, read once at the first of its reply and its exit. */
    let changesRead = changesWritten;
    /** The paths the agent's own tool calls wrote, read off every call including the ones a re-opened run reads past. */
    const wrote = t.reportsEdits === true ? new Set<string>() : undefined;
    /** While the read is out the turn's ending keeps the launch's commit on its row, so a host that goes before the
     * card is in leaves the read to the next host. Once that ending is on disk (endWritten), a read that lands after
     * it writes the row again to take the commit off. */
    let changesOut = false;
    let endWritten = false;
    const readChanges = (sessionId: string): void => {
      if (changesRead || t.snapshot === undefined) return;
      changesRead = true;
      changesOut = true;
      const { from: taken, cwd } = t.snapshot;
      const startedAt = view.startedAt ?? Date.now();
      void (async () => {
        const from = await taken;
        return from !== undefined && (await ctx.readTurnChanges(entry, { sessionId, turnId, threadId, cwd, from, startedAt, ...(wrote !== undefined ? { wrote } : {}) }));
      })().then(read => {
        changesOut = false;
        const row = sessions.get(rowId);
        if (!endWritten || row?.turnId !== turnId || row.snapshot === undefined) return;
        delete row.snapshot;
        // A closing host's read fails as its daemon channel shuts, and leaves the commit on disk for the next host.
        if (read || !ctx.state.closing) void ctx.persistSessions(workspaceId);
      });
    };
    // The reply and its line to the parent go together, so one gate stands for both.
    let replyRecorded = recordedReply !== undefined;
    /** The account the harness named for this turn's sign-in, off its limit reading, which the ledger files it under. */
    let turnAccount: { id: string; label?: string } | undefined;
    let startRecorded = startWritten;
    let deltas = deltasWritten;
    let replaying = deltasWritten;
    let subagentRows = subagentsWritten;
    let replayingSubagents = subagentsWritten;
    let compactionRows = compactionsWritten;
    let replayingCompactions = compactionsWritten;
    /** What the agent held after its latest call, which passes by on the bus as each call reports it. */
    let held: { context: number; window?: number } | undefined;
    /** Set once the turn's result named what the agent held, which the meter then reads off the result. */
    let resultHeld = false;
    /** The one row of what the agent held a turn writes, where its result names none: a turn stopped, cut or failed
     * after a call, and one a closing host still holds running, so the next window reads the meter off the
     * transcript rather than waiting on the agent's next call. */
    const writeHeld = (): void => {
      if (held === undefined || resultHeld) return;
      ctx.record({ type: "session.context", workspaceId, sessionId: view.claudeSessionId ?? view.id, turnId, threadId, ...held });
    };
    ctx.heldAtClose.add(writeHeld);
    let ended = false;
    /** The harness's own name for where this turn ended, kept with the turn's checkpoint once it is over. */
    let anchor: string | undefined;
    /** The harness's word that it cannot cut this thread's conversation, kept with the checkpoint as the anchor is. */
    let keptWhy: string | undefined;
    let over = false;
    /** The turn is over however it ended: no rewind in this copy can be undone any more, since an undo would take
     * this turn's files with it, and what a rewind to this turn needs is kept, off the turn's road so nothing waits
     * on the machine. */
    const turnOver = (): void => {
      if (over) return;
      over = true;
      ctx.heldAtClose.delete(writeHeld);
      writeHeld();
      const undone: string[] = [];
      for (const [id, held] of threadRecords) {
        if (held.workspaceId !== workspaceId || held.rewound === undefined) continue;
        delete held.rewound;
        undone.push(id);
      }
      if (undone.length > 0) {
        void ctx.persistSessions(workspaceId);
        bus.emit({ type: "thread.marked", workspaceId, threadIds: undone });
      }
      // The slate's snapshot is keyed by the turn and never waits on the machine, so every turn that ends has one.
      void ctx.slates.turnEnded({ threadId, turnId }).catch((e: unknown) => console.warn(`the slate of thread ${threadWord(threadId)} was not kept at the end of turn ${turnId}: ${e instanceof Error ? e.message : String(e)}`));
      const kept = ctx.keepCheckpoint(entry, { sessionId: view.claudeSessionId ?? view.id, threadId, turnId, ...(anchor !== undefined ? { anchor } : {}), ...(keptWhy !== undefined ? { kept: keptWhy } : {}) });
      ctx.checkpointsLanding.set(threadId, kept);
      void kept.finally(() => {
        if (ctx.checkpointsLanding.get(threadId) === kept) ctx.checkpointsLanding.delete(threadId);
      });
    };
    // The reply's status, held while the process still runs. Shared with this turn's session-map entry so runningOn
    // and the persisted row read it whether the harness emits its result synchronously in start() (before the entry
    // exists) or later from its stream.
    const turnLive: TurnLive = t.turnLive ?? {};
    let replayingTold = turnLive.told ?? 0;
    /** The permission prompts of this turn nobody has answered. The harness is blocked on every one of them, so this
     * map is what the thread is waiting on, and it holds for as long as the turn lives. */
    const open = new Map<string, PermissionAsk>();
    /** Whether the harness reports work this turn started still running in the background. Beside the open prompts
     * because the two say the same thing about the turn: it is waiting on something its own process is not doing. */
    let tasksRunning = false;
    /** The tool calls of this turn the harness has not answered yet: what the agent is inside right now. A wsp call
     * among them that follows another thread is what can leave this turn stopped on a question it never asked. */
    const calls = new Map<string, { toolName: string; input: string }>();
    /** The harness's own answer road, once the turn is open; a prompt raised inside start() is answered through it
     * too, since it may stand for hours past the synchronous run that raised it. */
    let answerAsk: HarnessSession["answer"];

    /** The spans of this turn that went on a person rather than on work: closed ones added up, and the moment the
     * span still running began. The harness counts wall time from launch to result, so these are what its figure has
     * to give back before a reader is told how long the turn worked. */
    let waited = 0;
    let waitingSince: number | undefined;
    /** What the turn has spent on the person by now, the open span included, so a result that lands under a prompt
     * still standing counts the same as one that lands after it closed. */
    const waitedSoFar = (): number => waited + (waitingSince === undefined ? 0 : clock.now() - waitingSince);
    /** A reply as its finished line and its row carry it: the harness counts wall time from launch to result, prompts
     * included, so the spans the turn stood on a person ride out with it and every reader takes them off one figure
     * rather than guessing at them. */
    const withWaited = (reply: TurnResult): TurnResult => {
      const onThePerson = waitedSoFar();
      return onThePerson > 0 ? { ...reply, waitedMs: onThePerson } : reply;
    };
    /** What a turn's end tells whoever its start named once a held reply's line went: the end whole where the agent
     * said something new, its outcome alone where only that changed, as a stop does, and nothing where both are what
     * the line said. A held end carries the told words by the adapter's word, whatever task lines it adds under them. */
    const afterTold = (result: TurnResult, held: boolean): TurnResult | undefined => {
      const told = turnLive.toldAs;
      if (told === undefined) return held ? undefined : result;
      if (!held && notifyBody(result, "whole") !== told.body) return result;
      if (result.status === told.status) return undefined;
      const { text: _text, error: _error, ...outcome } = result;
      return outcome;
    };

    /** The one expression that says the turn is waiting on something outside its own process, which its stream's
     * idle clock touches on every poll: a prompt of its own nobody has answered, or work it started that the harness
     * says is still running. */
    const readsWaiting = (): void => {
      if (t.waiting !== undefined) t.waiting.on = open.size > 0 || tasksRunning;
    };

    /** Everything that moves when a prompt of this turn opens or closes, by the protocol's one rule for which open
     * prompt leads: what the row says the thread is waiting on, the question itself for a thread waiting behind
     * this one, whether the turn is blocked on a person, and the clock on how long it has been. Written on every
     * open and close, so the sidebar, the command line, the turn's idle clock and its settled figure read one fact. */
    const readsOpen = (): void => {
      const lead = leadAsk(open.values());
      if (lead === undefined) {
        delete view.asking;
        ctx.leadAsks.delete(threadId);
      } else {
        view.asking = askingLine(lead);
        ctx.leadAsks.set(threadId, lead);
      }
      readsWaiting();
      if (open.size > 0) waitingSince ??= clock.now();
      else if (waitingSince !== undefined) {
        waited += clock.now() - waitingSince;
        waitingSince = undefined;
      }
      void ctx.persistSessions(workspaceId);
    };

    /** The ask as clients read it: the harness's slug for a mode option carries no words of its own, and the words
     * for one live in the harness table beside the picker's, so they are lent here rather than in the adapter. */
    const named = (ask: PermissionAsk): PermissionOption[] => {
      const modes = harnessCatalog(view.harness)?.permissionModes ?? [];
      return ask.options.map(o =>
        o.effect === "mode" && o.mode !== undefined ? { ...o, label: permissionModeOptionLabel(modes.find(m => m.value === o.mode)?.label ?? o.mode) } : { ...o },
      );
    };

    /** The row that says a prompt is closed. Both the harness's own close and the runtime ending the turn under it
     * come through here: a turn cut from this side never reaches the adapter's close, and a row left open would keep
     * offering options that answer nothing. */
    const closeAsk = (askId: string, outcome: PermissionOutcome, optionId?: string): void => {
      if (!open.has(askId)) return;
      open.delete(askId);
      readsOpen();
      ctx.record({
        type: "session.permission.closed",
        workspaceId,
        sessionId: view.claudeSessionId ?? view.id,
        turnId,
        threadId,
        askId,
        outcome,
        ...(optionId !== undefined ? { optionId } : {}),
      });
    };

    /** Every prompt still waiting, closed as going with its turn; the caller is ending the turn. */
    const closeOpenAsks = (): void => {
      for (const askId of [...open.keys()]) closeAsk(askId, "cancelled");
    };

    /** The one place a pick becomes an outcome and the line the agent reads as the call's result. Only a person picks,
     * so a deny is always the person's and says so. */
    const answer = async (askId: string, o: { optionId: string; reason?: string }): Promise<SessionAnswerResult["outcome"]> => {
      const held = open.get(askId);
      if (held === undefined) return "gone";
      // One pick may name several options: a question that takes more than one answer sends them as one id.
      const option = pickedOptions(held.options, o.optionId)?.[0];
      if (option === undefined) return "no-option";
      // A turn that raised a prompt has the road that raised it; with none there is nothing left to answer it.
      if (answerAsk === undefined) return "gone";
      const outcome: PermissionOutcome = option.effect === "deny" ? "denied" : "allowed";
      // A reason rides a deny alone: it is what the person wants done instead of the call they refused.
      const reason = option.effect === "deny" && o.reason !== undefined && o.reason.trim() !== "" ? o.reason.trim() : undefined;
      return (await answerAsk(askId, { optionId: o.optionId, outcome, denyMessage: deniedLine(reason), ...(reason === undefined ? {} : { reason }) })) === "answered" ? "answered" : "gone";
    };

    /** The messages steered into this turn that its agent never read, as the harness tells them at the turn's end, and
     * whether the turn ends because someone stopped it: what decides where those messages go. Read past a cut too,
     * since a nap's cut is a process that goes with its messages unread. */
    let unread: readonly string[] = [];
    let stopped = false;
    const forward = (event: AdapterEvent): void => {
      if (event.type === "turn.unread") {
        unread = event.ids;
        return;
      }
      if (ended) return;
      const sessionId = event.sessionId;
      switch (event.type) {
        case "session.start": {
          // Under a held reply this is the CLI waking its agent, whose end is a new word.
          delete turnLive.toldLast;
          view.claudeSessionId = sessionId;
          if (event.cwd !== undefined) view.cwd = event.cwd;
          if (event.model !== undefined) view.model = event.model;
          entry.record.claudeSessionId = sessionId;
          // The harness loaded the session up to the rewind's anchor, so the thread no longer holds it for a later start.
          if (t.cutAt !== undefined && threadRecords.get(threadId)?.resumeAt === t.cutAt) delete threadRecords.get(threadId)!.resumeAt;
          void ctx.persist(entry.record);
          void ctx.persistSessions(workspaceId);
          // The harness keys its store by the id it just announced, so a name given at the start is written now;
          // a CLI that already took it at launch is told the same name twice, which is what keeps this one road.
          if (opening.title !== undefined && !startRecorded) void ctx.nameInHarness(view, opening.title);
          // One turn is one start row however often the harness announces itself.
          if (startRecorded) return;
          startRecorded = true;
          ctx.record({
            type: "session.start",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            prompt: opening.prompt,
            ...(opening.requestId !== undefined ? { requestId: opening.requestId } : {}),
            ...(opening.via !== undefined ? { via: opening.via } : {}),
            ...(opening.afterCut === true ? { afterCut: true } : {}),
            ...(opening.afterLimit !== undefined ? { afterLimit: opening.afterLimit } : {}),
            ...(opening.opensThread === true ? { opensThread: true } : {}),
            startedBy: view.startedBy,
            ...(opening.attachments !== undefined ? { attachments: [...opening.attachments] } : {}),
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
            ...(view.permissionMode !== undefined ? { permissionMode: view.permissionMode } : {}),
            ...(view.effort !== undefined ? { effort: view.effort } : {}),
            agent: view.harness,
            ...(event.tools !== undefined ? { tools: event.tools } : {}),
            ...(event.harness !== undefined ? { harness: event.harness } : {}),
          });
          // The thread is named now, from its opening words, so a builder's row reads what it is about seconds
          // after it starts rather than after an hour-long turn. Asked here and not before the harness announced
          // its session: the store is read first, since what the harness already calls the session is a person's
          // and a thread that has one is never asked, and the answer is written back under that same id. This sits
          // under the one start row a turn writes, so a re-opened run, whose row the host that launched it wrote,
          // returns above and asks nothing.
          if (ctx.sourceOf(view) === "seed") {
            void ctx.holdAsk(
              ctx.refreshTitle(view, false)
                .then(() => ctx.makeTitle(view))
                .catch((e: unknown) => console.warn(noMadeTitleLogLine(threadId, workspaceId, e instanceof Error ? e.message : String(e)))),
            );
          }
          return;
        }
        case "turn.delta":
          if (event.kind === "tool_use" && event.toolUseId !== undefined && event.toolName !== undefined) {
            calls.set(event.toolUseId, { toolName: event.toolName, input: event.text });
            if (wrote !== undefined) for (const path of toolCallFacts(event.toolName, event.text).changedFiles ?? []) wrote.add(path);
          } else if (event.kind === "tool_result" && event.toolUseId !== undefined) calls.delete(event.toolUseId);
          if (replaying > 0) {
            replaying--;
            return;
          }
          ctx.record({
            type: "session.delta",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            line: ++deltas,
            kind: event.kind,
            text: event.text,
            ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
            ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
            ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
            ...(event.isError !== undefined ? { isError: event.isError } : {}),
            ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
            ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
          });
          return;
        case "turn.done": {
          if (event.result.tokens?.context !== undefined) resultHeld = true;
          // A reply already written stands, and the gate comes before the status is taken: what the run says on the
          // way round again is the reply this turn already gave, and nothing later may overwrite it.
          if (replyRecorded) {
            replyRecorded = false;
            turnLive.reply ??= recordedReply;
            return;
          }
          // The reply is in, but the row stays running until session.end (the process exited): the harness can
          // keep working past its result, and a row read as completed here lets a send start a second agent in the
          // same worktree. The result is held and applied at the exit below.
          turnLive.reply = event.result.status;
          const result = withWaited(event.result);
          // What the turn said last and why it failed ride the row too, so a lead's tree says what a child did.
          writeLines(view, turnLines(result));
          // The cause rides the row too, since a refused turn did none of the work: what a thread is read as having
          // run is decided off the rows, and the result itself lives only in the transcript.
          if (result.refusal !== undefined) view.refusal = result.refusal;
          // So does the usage limit that stopped it, which the thread offers to go on from at the reset.
          if (result.limit !== undefined) view.limit = result.limit;
          // So does what the turn cost, added to what the row's earlier turns cost: a resumed turn takes over the
          // row it resumes, and a listing has to answer what a thread spent without reading anyone's transcript.
          if (result.costUsd !== undefined) view.costUsd = (view.costUsd ?? 0) + result.costUsd;
          // What the turn used, filed in the ledger under the sign-in it ran on; a turn that counted nothing files nothing.
          if (result.tokens !== undefined || result.costUsd !== undefined) {
            const account = ctx.usageAccountOf(entry, view.harness, turnAccount);
            const model = result.model ?? view.model;
            // An agent that names each model a turn used files a row for each; the turn counts once, on the first entry
            // of its own model, since a model whose tokens came part with a cost and part without has two.
            const uses = result.models !== undefined && result.models.length > 0 ? result.models : [{ model, tokens: result.tokens, costUsd: result.costUsd }];
            const counted = Math.max(0, uses.findIndex(u => u.model === model));
            for (const [at, use] of uses.entries())
              void ctx.ledger
                .add({
                  at: clock.now(),
                  agent: view.harness,
                  account: account.key,
                  accountLabel: account.label,
                  computer: ctx.usageComputerOf(entry.record),
                  project: entry.record.project,
                  turns: at === counted ? 1 : 0,
                  ...(use.model !== undefined ? { model: use.model } : {}),
                  ...(use.tokens !== undefined ? { tokens: use.tokens } : {}),
                  ...(use.costUsd !== undefined ? { costUsd: use.costUsd } : {}),
                  ...((view.claudeSessionId ?? sessionId) !== undefined ? { session: view.claudeSessionId ?? sessionId } : {}),
                  source: "wsp",
                })
                .catch((e: unknown) => console.warn(`the use of turn ${turnId} was not filed: ${e instanceof Error ? e.message : String(e)}`));
          }
          void ctx.persistSessions(workspaceId);
          // A reply held over background work had its line when it was given, and a lead is never told one reply twice.
          const told = afterTold(result, event.held === true);
          if (notify !== undefined && told !== undefined) ctx.notifyEnd({ view, turnId, turnLive }, notify, ctx.tellAs(t), told);
          ctx.record({ type: "session.done", workspaceId, sessionId, turnId, threadId, result });
          readChanges(sessionId);
          return;
        }
        case "turn.anchor":
          anchor = event.anchor;
          keptWhy = event.kept;
          return;
        case "subagent":
          // Counted apart from the deltas, so a run re-read from its first line writes none of these a second time and
          // a run a host from before them left has all of them written.
          if (replayingSubagents > 0) {
            replayingSubagents--;
            return;
          }
          ctx.record({
            type: "session.subagent",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            line: ++subagentRows,
            task: event.task,
            state: event.state,
            ...(event.parentToolUseId !== undefined ? { parentToolUseId: event.parentToolUseId } : {}),
            ...(event.title !== undefined ? { title: event.title } : {}),
            ...(event.summary !== undefined ? { summary: event.summary } : {}),
            ...(event.depth !== undefined ? { depth: event.depth } : {}),
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.asked !== undefined ? { asked: event.asked } : {}),
          });
          return;
        case "limit": {
          turnAccount = event.limit.account ?? turnAccount;
          const account = ctx.usageAccountOf(entry, view.harness, turnAccount);
          void ctx.ledger
            .limit({ key: account.key, agent: view.harness, label: account.label, road: account.road, computer: ctx.usageComputerOf(entry.record), limit: event.limit })
            .then(async ({ before, after }) => {
              await ctx.alerts.read(before, after);
              // The row as the Usage page reads it now, so a slate's bound meter moves the moment a turn reports.
              const row = (await ctx.usageAccounts()).accounts.find(a => a.key === account.key);
              if (row !== undefined) bus.emit({ type: "usage.account", key: account.key, row });
            })
            .catch((e: unknown) => console.warn(`the limits of ${account.key} were not kept: ${e instanceof Error ? e.message : String(e)}`));
          return;
        }
        case "turn.usage":
          // Only a run re-read after a restart reads the agent's stamp, and only against its own other stamps.
          ctx.burn.add({ account: ctx.usageAccountOf(entry, view.harness, turnAccount).key, threadId, tokens: event.tokens, ...(t.written !== undefined && event.at !== undefined ? { replayed: { run: turnId, at: event.at } } : {}) });
          if (event.context !== undefined) {
            held = { context: event.context, ...(event.window !== undefined ? { window: event.window } : {}) };
            bus.pass({ type: "session.context", workspaceId, sessionId, turnId, threadId, at: clock.now(), ...held });
          }
          return;
        case "turn.compacted":
          if (replayingCompactions > 0) {
            replayingCompactions--;
            return;
          }
          ctx.record({ type: "session.compacted", workspaceId, sessionId, turnId, threadId, line: ++compactionRows, ...(event.before !== undefined ? { before: event.before } : {}), ...(event.after !== undefined ? { after: event.after } : {}) });
          return;
        case "turn.plan":
          ctx.record({ type: "session.plan", workspaceId, sessionId, turnId, threadId, ...(event.steps !== undefined ? { steps: event.steps } : {}), ...(event.text !== undefined ? { text: event.text } : {}) });
          return;
        case "turn.tasks":
          // The harness's own word on the work this turn started: while any of it runs the turn is working, whatever
          // its agent has already said, so the idle clock is held the way an open prompt holds it.
          tasksRunning = event.running > 0;
          readsWaiting();
          // The agent's final reply, given while that work runs: the turn goes on, and nothing reads the reply again
          // until the work wakes it, so its line goes now. A run re-read after a restart already sent the ones it told.
          if (event.replied !== undefined) {
            const replied = withWaited(event.replied);
            turnLive.toldLast = true;
            turnLive.toldAs = { status: replied.status, body: notifyBody(replied, "whole") };
            if (replayingTold > 0) replayingTold--;
            else if (notify !== undefined) {
              ctx.notifyEnd({ view, turnId, turnLive }, notify, ctx.tellAs(t), replied);
              turnLive.told = (turnLive.told ?? 0) + 1;
            }
            void ctx.persistSessions(workspaceId);
          }
          return;
        case "permission.ask": {
          const ask = { ...event.ask, options: named(event.ask) };
          // The turn stops here until an option comes back. Nothing else closes it: a person who was away for an
          // hour comes back to the question they were asked, rather than to an agent that was denied and told to
          // ask for a mode that does not ask.
          open.set(ask.askId, ask);
          readsOpen();
          ctx.record({ type: "session.permission", workspaceId, sessionId, turnId, threadId, ...ask, options: [...ask.options] });
          ctx.endSnoozeFor(view);
          return;
        }
        case "permission.close":
          closeAsk(event.askId, event.outcome, event.optionId);
          return;
        case "session.end":
          // A prompt the harness left open goes with its process: nothing can answer it now, and a row left open
          // would leave the thread reading as waiting on a person forever.
          closeOpenAsks();
          // The process exited: the turn is over now, so the row takes the reply's status here (synchronously,
          // before the event is recorded, so a waiter woken by it reads the settled row, not the running one).
          if (turnLive.reply !== undefined) view.status = turnLive.reply;
          view.endedAt = Date.now();
          ctx.record({
            type: "session.end",
            workspaceId,
            sessionId,
            turnId,
            threadId,
            exitCode: event.exitCode,
            sawResult: event.sawResult,
          });
          turnOver();
          readChanges(sessionId);
          return;
      }
    };

    // A process kept from an earlier turn reads the box that turn left, which may still say it was waiting.
    readsWaiting();
    ctx.idle.hold(workspaceId);
    let started: HarnessSession;
    try {
      started = t.open(forward);
    } catch (e) {
      ctx.idle.release(workspaceId);
      throw e;
    }
    started.finished.then(
      () => {
        ctx.idle.release(workspaceId);
        void ctx.readDisk(entry).catch((e: unknown) => console.warn(`disk of ${workspaceId} not read after its turn: ${e instanceof Error ? e.message : String(e)}`));
      },
      () => ctx.idle.release(workspaceId),
    );
    answerAsk = started.answer?.bind(started);
    const handleId = started.localId;
    // A row that already has an id keeps it: a re-opened turn is named by the harness's own session, which is not
    // always the id the row was keyed by, and a client holding the row must not see it change under a restart. The
    // turn's own id is the exception, the one the start road keyed this row by while the turn was still reaching the
    // machine, and it gives way to the harness's here: an id does move under a client inside that window, which is
    // safe only because every client keys a thread by its threadId, through foldThreads and through the wait alike.
    if (view.id === "" || view.id === turnId) view.id = handleId;
    const rowId = view.id;
    // A resumed turn takes over the row of the turn it resumes; the row keeps saying who opened the thread and
    // with what, since every client titles the thread by the row's prompt. Later turns live in the transcript.
    const resumed = t.resume !== undefined ? sessions.get(handleId)?.view : undefined;
    if (resumed !== undefined) {
      view.startedBy = resumed.startedBy ?? view.startedBy;
      if (resumed.prompt !== undefined) view.prompt = resumed.prompt;
      // What the row cost is every turn that ran on it, so the earlier turns' figure carries into the row this one
      // takes over; a listing reads the row, not the transcript.
      if (resumed.costUsd !== undefined) view.costUsd = resumed.costUsd;
    }

    /** A pick made while this turn runs, taken by the harness: the row carries the mode the turn is now at. */
    const setAccess = async (mode: string): Promise<"set" | "refused" | "gone"> => {
      const outcome = await started.setAccess!(mode);
      if (outcome === "set") view.permissionMode = mode;
      return outcome;
    };

    const handle: SessionHandle = {
      id: rowId,
      workspaceId,
      finished: started.finished,
      turnId,
      outcome,
      view: () => ({ ...view }),
      interrupt: () => {
        stopped = true;
        return started.interrupt();
      },
      ...(started.steer !== undefined ? { steer: (prompt: string, id?: string) => started.steer!(prompt, id) } : {}),
      ...(started.answer !== undefined ? { answer } : {}),
      ...(started.setAccess !== undefined ? { setAccess } : {}),
      ...(started.stopTask !== undefined ? { stopTask: (task: string) => started.stopTask!(task) } : {}),
    };
    const end = (reason: string, byStop = false): void => {
      if (ended || view.status !== "running") return;
      if (byStop) stopped = true;
      // Before `ended` shuts the forward road: the interrupt below reaches the harness, whose own close would then
      // be dropped, so the rows and the waits are ended here.
      closeOpenAsks();
      ended = true;
      const row = sessions.get(rowId);
      if (row?.turnId === turnId) delete row.snapshot;
      ctx.settleCut({ view, turnId, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}), turnLive }, reason, () => reason, byStop);
      void ctx.persistSessions(workspaceId);
      void started.interrupt().catch(() => {});
      turnOver();
    };
    // One row per turn, never two: the key the start road held this turn under goes as the harness's own takes over.
    if (turnId !== rowId) sessions.delete(turnId);
    sessions.set(rowId, { view, turnId, calls, ...(notify !== undefined ? { notify } : {}), ...(notifyBy !== undefined ? { notifyBy } : {}), ...(notifyRoad !== undefined ? { notifyRoad } : {}), ...(turnToken !== undefined ? { turnToken } : {}), ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}), handle, end, turnLive, ...(started.run !== undefined ? { run: started.run } : {}), ...(started.from !== undefined ? { from: started.from } : {}), ...(t.asked !== undefined ? { asked: t.asked } : {}), ...(typeof t.snapshot?.from === "string" ? { snapshot: t.snapshot.from } : {}), ...(started.pid !== undefined ? { pid: started.pid } : {}) });
    if (started.pid !== undefined && ctx.moduleOf(entry.record.kind).sharedDaemon) {
      const groups = ctx.turnGroups.get(workspaceId) ?? new Set<number>();
      ctx.turnGroups.set(workspaceId, groups);
      groups.add(started.pid);
      ctx.armRootsRecheck();
    }
    ctx.portRootsMoved(workspaceId);
    void ctx.persistSessions(workspaceId);
    // A launch that hands its prompt over late resolves its snapshot after the row exists; the row takes it then.
    const taking = t.snapshot?.from;
    if (taking instanceof Promise) {
      void taking.then(commit => {
        const row = sessions.get(rowId);
        if (commit === undefined || row === undefined || row.turnId !== turnId || row.view.status !== "running") return;
        row.snapshot = commit;
        void ctx.persistSessions(workspaceId);
      });
    }
    /** The turn's process is over: its status settles, its token stops naming anything, and the harness's own title
     * for the session is read again, since it writes one as the turn settles. */
    const settled = (status: TurnStatus): void => {
      const row = sessions.get(rowId);
      if (row !== undefined && row.turnToken === turnToken) delete row.turnToken;
      if (row?.turnId === turnId && !changesOut) delete row.snapshot;
      // A process kept for the thread's next turn keeps the token and the device in its environment, which name the
      // thread until the keep ends it.
      const agent = t.keep !== undefined ? started.kept?.() : undefined;
      const keeps =
        agent !== undefined &&
        !ended &&
        turnToken !== undefined &&
        view.claudeSessionId !== undefined &&
        ctx.holdKept(threadId, { workspaceId, agent, launch: t.keep!.launch, session: view.claudeSessionId, turnToken, ...(scopeDeviceId !== undefined ? { scopeDeviceId } : {}), waiting: t.waiting ?? { on: false } });
      if (agent !== undefined && !keeps) void agent.close().catch(() => {});
      // The process is gone, so the token in its environment names nothing that can be asked for anything: it is
      // taken away here, the one exit both the reply road and the failure road reach.
      if (scopeDeviceId !== undefined && !keeps) {
        void deviceDoor.revoke(scopeDeviceId).catch((e: unknown) => console.warn(`the token of thread ${threadWord(threadId)} was not taken away: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (!ended) view.status = status;
      // A process that exited with no result leaves the words a read of the turn ends on.
      if (!ended && turnLive.reply === undefined) writeLines(view, turnLines({ status }));
      ctx.portRootsMoved(workspaceId);
      view.endedAt ??= Date.now();
      if (view.status === "failed") ctx.endSnoozeFor(view);
      // A pick this turn did not take landed on the thread's record alone; the row says it from here on, since
      // every client folds the thread's access off the row and the next turn runs at the record's.
      const kept = threadRecords.get(threadId)?.permissionMode;
      if (kept !== undefined) view.permissionMode = kept;
      // The turn is over: its own calls follow nobody now, and nobody waiting behind it is waiting any more.
      calls.clear();
      ctx.leadAsks.delete(threadId);
      void ctx.persistSessions(workspaceId);
      endWritten = true;
      // Only a turn that ended on its own: a turn this host ended is one whose workspace is going away under it,
      // and the harness's own store for it goes with the machine, so the read would reach a machine that is being
      // taken down and say so in the log for every thread on it.
      if (!ended) void ctx.refreshTitle(view, true);
      // The turn may have moved the branch or the files, so the tile's line is read again now rather than on a timer,
      // and the pull request with it, since the agent may have pushed.
      if (!ended) void ctx.readCheckout(entry, true).then(() => ctx.readPullRequest(entry, true)).then(() => ctx.readLeadOf(entry));
      // A tree whose root's pull request has settled settles again as its last turn ends: merged stays merged, and a
      // send into the tree is what took it off the fold.
      if (!ended) {
        const rootOn = view.rootThreadId === undefined ? entry : live.get(ctx.latestOn(view.rootThreadId)?.workspaceId ?? "");
        if (rootOn !== undefined && rootOn.record.pr !== undefined && rootOn.record.pr.state !== "open") void ctx.settleTree(rootOn);
      }
      if (t.imagesDir !== undefined) ctx.dropImages(entry, t.imagesDir);
    };
    // The reload a client runs on session.end shares that read rather than starting a second.
    started.finished.then(
      result => {
        settled(result.status);
        ctx.sendBack({ view, turnId, turnLive }, unread, stopped);
        if (!ended && result.status === "completed") void ctx.takeReview(entry, threadId, result.text ?? "").catch((e: unknown) => console.warn(`the review in ${entry.record.name} was not read: ${e instanceof Error ? e.message : String(e)}`));
      },
      () => {
        settled("failed");
        ctx.sendBack({ view, turnId, turnLive }, unread, stopped);
      },
    );
    return handle;
  };

  /** Every harness run on one workspace's machine that this host does not hold, ended. Read after the rows are in
   * and every one that could be re-opened has been, so what is left is a run no thread here will ever read: the host
   * that launched it went down under it, or its own row could not be re-opened and was settled. The runs this host
   * holds are named to the machine rather than found there, so a turn this host is reading is never ended by its own
   * sweep. Best effort: a machine that will not answer keeps its runs, and the next connect asks again. */
  const sweepRuns = async (entry: LiveWorkspace): Promise<void> => {
    if (entry.record.phase !== "running") return;
    // Nothing can be asked about a machine held by a stand-in, so nothing is: a computer that is away and a host
    // started without its provider key both leave the runs where they are rather than saying so at every start.
    if (ctx.isHeldAway(entry.record.id)) return;
    const sweep = ctx.execFactoryFor(entry).sweep;
    if (sweep === undefined) return;
    // Every running row's run and not this workspace's alone: the workspaces on one computer share its run folder,
    // so a sweep that kept only its own would end the turns of the others.
    const held: string[] = [];
    for (const s of sessions.values()) {
      if (s.view.status === "running" && s.run !== undefined) held.push(s.run);
    }
    const swept = await sweep(held).catch((e: unknown) => {
      console.warn(`the runs on ${entry.record.id} were left as they are: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    });
    if (swept.length > 0) console.warn(sweptRunsLogLine(entry.record.id, swept));
  };


  /** A turn the store left running, re-opened where it runs. The machine still holds the run and its whole output,
   * so the events this host missed reach it as the run's own lines and the thread goes on running to its reply.
   * `cannot` covers a row with no run recorded (a host from before this road, or a harness whose runs die with it),
   * no workspace or no machine running under it, no adapter for its harness in this process, and a handle that is
   * not one this host could have launched. */
  const reattach = async (s: { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnLive?: TurnLive; run?: string; from?: number; asked?: TurnAsked; turnToken?: string; scopeDeviceId?: string; snapshot?: string }): Promise<Reopened> => {
    const { view, run } = s;
    const threadId = view.threadId;
    const entry = live.get(view.workspaceId);
    if (run === undefined || threadId === undefined || entry === undefined || entry.record.phase !== "running") return "cannot";
    const cannot = (words: string): "cannot" => {
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} cannot be re-opened: ${words}`);
      return "cannot";
    };
    let adapter: HarnessAdapter;
    // As on the start road: the re-opened stream reads this while the turn it attached to is stopped on a question.
    const waiting = { on: false };
    try {
      adapter = ctx.adapterFor(entry, view.harness, undefined, () => waiting.on).adapter;
    } catch (e: unknown) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
    const open = adapter.attach?.bind(adapter);
    if (open === undefined) return "cannot";
    // The harness may start reading the run the moment it is opened, which is before the row that records those
    // lines exists, so what arrives first is held and handed to the row's own forward in order once it does.
    const held: AdapterEvent[] = [];
    let sink: ((event: AdapterEvent) => void) | undefined;
    let opened: HarnessSession | "gone";
    try {
      opened = await open({
        run,
        sessionId: view.claudeSessionId ?? view.id,
        startedAt: view.startedAt ?? Date.now(),
        ...(view.model !== undefined ? { model: view.model } : {}),
        ...(view.cwd !== undefined ? { cwd: view.cwd } : {}),
        ...(s.asked !== undefined ? { prompt: s.asked.prompt, ...(s.asked.effort !== undefined ? { effort: s.asked.effort } : {}) } : {}),
        ...(s.from !== undefined ? { from: s.from } : {}),
        onEvent: event => (sink === undefined ? void held.push(event) : sink(event)),
      });
    } catch (e: unknown) {
      // Nothing answered about the run, so nothing is known about it: the turn is left exactly as it was.
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} was left running: ${e instanceof Error ? e.message : String(e)}`);
      return "unreached";
    }
    if (opened === "gone") return "gone";
    // The run was read off the machine, so the machine takes commands and needs no proof.
    delete entry.unchecked;
    // The turn reads how much of itself is written off the transcript it is handed, the copy this open answers. A file
    // that did not read says nothing about the run, so the row is left running as it was.
    let written: SessionEvent[];
    try {
      written = await ctx.openTranscript(view.workspaceId);
    } catch (e: unknown) {
      console.warn(`thread ${threadId.slice(0, 8)} on ${view.workspaceId} was left running: ${e instanceof Error ? e.message : String(e)}`);
      return "unreached";
    }
    try {
      runTurn({
        entry,
        view,
        written: turnWritten(written, s.turnId),
        ...(adapter.reportsEdits === true ? { reportsEdits: true } : {}),
        threadId,
        turnId: s.turnId,
        ...(s.notify !== undefined ? { notify: s.notify } : {}),
        ...(s.notifyBy !== undefined ? { notifyBy: s.notifyBy } : {}),
        ...(s.notifyRoad !== undefined ? { notifyRoad: s.notifyRoad } : {}),
        // The token this turn was launched with is still in the process this attach reached, so the row that answers
        // for it takes it back; a token this host had never minted would be one nobody can answer for.
        ...(s.turnToken !== undefined ? { turnToken: s.turnToken } : {}),
        // The device that turn was launched with is still in the process this attach reached, so the row that
        // answers for it takes it back and its exit is what hands it over.
        ...(s.scopeDeviceId !== undefined ? { scopeDeviceId: s.scopeDeviceId } : {}),
        ...(s.turnLive !== undefined ? { turnLive: s.turnLive } : {}),
        ...(s.asked !== undefined ? { asked: s.asked } : {}),
        ...(s.snapshot !== undefined && view.cwd !== undefined ? { snapshot: { from: s.snapshot, cwd: view.cwd } } : {}),
        outcome: "started",
        waiting,
        // The row's own prompt is the thread's opening once a later turn takes the row over, so the start row a
        // re-opened turn still owes is written from what was typed for this turn.
        opening: { prompt: s.asked?.typed ?? s.asked?.prompt ?? view.prompt ?? "" },
        open: forward => {
          sink = forward;
          for (const event of held.splice(0)) forward(event);
          return opened as HarnessSession;
        },
      });
    } catch (e: unknown) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
    return "attached";
  };
  return { runTurn, sweepRuns, reattach };
}
