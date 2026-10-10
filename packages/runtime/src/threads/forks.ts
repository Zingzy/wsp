// SPDX-License-Identifier: AGPL-3.0-only
// A fork read off the thread it forks: the turn it carries through, what that
// turn left to start from, the source's picks and folder, and the events its
// transcript opens on, every refusal said before anything is written. The
// copies of those events and of the images they carry go in under the fork's
// own thread once its start is sure to run.
import { join, relative } from "node:path";
import {
  type Attachment, type Caller, type CountedTurn, type ForkSource, type ForkTurn, type ForkedFrom, type ForkedSession, type SessionEvent,
  type TurnResult, attachmentKey, copiedFromOf, copiesFolder, foldThreads, isImage, notFoundRefusal, refusal, scopeOf, threadWord,
  usageRefusal, FORK_NO_ANCHOR_FIX, FORK_NO_CHECKPOINT_FIX, FORK_NO_CHECKPOINT_LINE, FORK_NO_TURN_FIX, FORK_RUNNING_FIX,
  FORK_RUNNING_LINE, forkAgentFix, forkAgentLine, forkNoAnchorLine, forkNoTurnLine, forkTurnsFix, forkTurnsLine, noBranchesLine,
  placeBranchLine,
} from "@wsp/protocol";
import { harnessCatalog } from "../harness-catalog.js";
import { ATTACHMENT_KEYS, ATTACHMENTS, type KeptImages } from "../types/internal.js";
import type { LiveWorkspace } from "../types/wiring.js";
import type { RuntimeContext } from "../context.js";
import type { HarnessAdapter } from "../types/harness.js";
import type { Runtime } from "../types/api.js";
import type { SessionHandle } from "../types/wiring.js";

/** What a fork reads off its source. */
export interface ForkPlan {
  source: { threadId: string; workspaceId: string; entry: LiveWorkspace; harness: string; title: string; session?: string; cwd?: string };
  /** The turn the fork carries through, absent on a fork that carries none: its anchor and its checkpoint where it
   * left them, and the turns after it in the source, which a harness that counts finds it by. */
  turn?: { turnId: string; anchor?: string; ref?: string; after: CountedTurn[] };
  /** The source's events through that turn, in their order. */
  events: SessionEvent[];
  /** The model, effort, window, speed and access the source's latest turn ran at. */
  picks: { model?: string; effort?: string; contextWindow?: string; fast?: boolean; permissionMode?: string };
  forkedFrom: ForkedFrom;
}

const conflict = (happened: string, fix: string): Error => refusal(happened, fix, "conflict");

/** The fork's source as it stands, read against the caller: the thread has to be one it reaches, the turn one of its
 * finished turns, and a harness that cuts at an anchor needs that turn to have named one. */
export async function readFork(ctx: RuntimeContext, fork: ForkSource, origin: Caller | undefined): Promise<ForkPlan> {
  await ctx.ready();
  const { threadId } = fork;
  const latest = ctx.latestOn(threadId);
  const record = ctx.threadRecords.get(threadId);
  const workspaceId = latest?.workspaceId ?? record?.workspaceId;
  const entry = workspaceId === undefined ? undefined : await ctx.entryOfRow({ threadId, workspaceId }, origin);
  if (entry === undefined || workspaceId === undefined) throw notFoundRefusal(`no thread ${threadWord(threadId)}`);
  const harness = record?.harness ?? latest!.harness;
  // A slate's events are its own thread's, and the fork opens with no slate.
  const events = (await ctx.openTranscript(workspaceId)).filter(e => e.threadId === threadId && e.turnId !== undefined && e.type !== "session.slate");
  const order: string[] = [];
  for (const e of events) if (!order.includes(e.turnId!)) order.push(e.turnId!);
  const running = new Set([ctx.runningOn(threadId)?.turnId, ctx.launchingOn(threadId)?.turnId].filter((t): t is string => t !== undefined));
  const ended = new Set(events.filter(e => e.type === "session.end" || e.type === "session.done").map(e => e.turnId!));
  const finished = order.filter(t => ended.has(t) && !running.has(t));
  const pick = (): string | undefined => {
    if (fork.turnId !== undefined) {
      if (!order.includes(fork.turnId)) throw refusal(forkNoTurnLine(fork.turnId), FORK_NO_TURN_FIX, "not-found");
      if (!finished.includes(fork.turnId)) throw conflict(FORK_RUNNING_LINE, FORK_RUNNING_FIX);
      return fork.turnId;
    }
    if (fork.at === 0) return undefined;
    const at = fork.at ?? finished.length;
    if (at < 1 || at > finished.length) throw refusal(forkTurnsLine(finished.length), forkTurnsFix(finished.length), "usage");
    return finished[at - 1]!;
  };
  const turnId = pick();
  const lastOf = <T extends SessionEvent["type"]>(type: T, turn: string): Extract<SessionEvent, { type: T }> | undefined => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === type && events[i]!.turnId === turn) return events[i] as Extract<SessionEvent, { type: T }>;
    return undefined;
  };
  const counted = (turn: string): CountedTurn => {
    const anchor = lastOf("session.checkpoint", turn)?.anchor;
    const result: TurnResult | undefined = lastOf("session.done", turn)?.result;
    return { ...(anchor !== undefined ? { anchor } : {}), ...(result !== undefined ? { result } : {}) };
  };
  const kept = turnId === undefined ? [] : order.slice(0, order.indexOf(turnId) + 1);
  const checkpoint = turnId === undefined ? undefined : lastOf("session.checkpoint", turnId);
  const title = foldThreads(ctx.rowsOn(threadId))[0]?.title ?? record?.forkedFrom?.title ?? threadWord(threadId);
  const session = latest?.claudeSessionId ?? ctx.startedAs(workspaceId, threadId);
  const cwd = latest?.cwd ?? (session === undefined ? undefined : ctx.folderOf(workspaceId, session));
  const permissionMode = record?.permissionMode ?? latest?.permissionMode;
  return {
    source: { threadId, workspaceId, entry, harness, title, ...(session !== undefined ? { session } : {}), ...(cwd !== undefined ? { cwd } : {}) },
    ...(turnId !== undefined
      ? {
          turn: {
            turnId,
            ...(checkpoint?.anchor !== undefined ? { anchor: checkpoint.anchor } : {}),
            ...(checkpoint?.ref !== undefined ? { ref: checkpoint.ref } : {}),
            after: order.slice(order.indexOf(turnId) + 1).map(counted),
          },
        }
      : {}),
    events: events.filter(e => kept.includes(e.turnId!)),
    picks: {
      ...(latest?.model !== undefined ? { model: latest.model } : {}),
      ...(latest?.effort !== undefined ? { effort: latest.effort } : {}),
      ...(latest?.contextWindow !== undefined ? { contextWindow: latest.contextWindow } : {}),
      ...(latest?.fast === true ? { fast: true } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    },
    forkedFrom: { threadId, ...(turnId !== undefined ? { turnId } : {}), title },
  };
}

/** Refuses a fork at a turn its harness cannot cut at: one that named no anchor, on a harness that finds none by count. */
export function forkTurnOf(plan: ForkPlan, byCount: boolean): { anchor: string } | { after: readonly CountedTurn[] } | undefined {
  const turn = plan.turn;
  if (turn === undefined) return undefined;
  if (turn.anchor !== undefined) return { anchor: turn.anchor };
  if (!byCount) throw conflict(forkNoAnchorLine(harnessCatalog(plan.source.harness)?.label ?? plan.source.harness), FORK_NO_ANCHOR_FIX);
  return { after: turn.after };
}

/** The source's events as the fork's transcript opens on them: under the fork's workspace and thread, each marked with
 * the thread it was copied from. */
export function copiedEvents(plan: ForkPlan, to: { workspaceId: string; threadId: string }): SessionEvent[] {
  return plan.events.map(e => {
    const { pos: _pos, ...rest } = e;
    return { ...rest, workspaceId: to.workspaceId, threadId: to.threadId, copiedFrom: copiedFromOf(e) ?? plan.source.threadId } as SessionEvent;
  });
}

/** The images the copied history carries, kept again under the fork's own thread, so each still opens there once the
 * source is deleted. An image whose bytes the source no longer holds is left out. */
export async function copyImages(ctx: RuntimeContext, plan: ForkPlan, to: { workspaceId: string; threadId: string }): Promise<void> {
  await ctx.keptWrites.get(plan.source.workspaceId);
  const held = ((await ctx.store.get(ATTACHMENT_KEYS, plan.source.workspaceId)) as KeptImages | undefined)?.threads[plan.source.threadId] ?? [];
  if (held.length === 0) return;
  for (const e of plan.events) {
    if ((e.type !== "session.start" && e.type !== "session.steer") || e.attachments === undefined || !e.attachments.some(a => isImage(a.mediaType))) continue;
    const images: Attachment[] = [];
    for (const [index, a] of e.attachments.entries()) {
      const key = attachmentKey(plan.source.threadId, e.requestId, index);
      const kept = key === undefined ? undefined : held.find(k => k.key === key);
      const bytes = kept === undefined ? undefined : await ctx.store.getBlob(ATTACHMENTS, kept.key);
      // An entry that is no image, or whose bytes are gone, keeps its place so each image keeps its own index.
      images.push(bytes === undefined || !isImage(a.mediaType) ? { name: a.name ?? "", mediaType: "text/plain", bytes: "" } : { name: a.name ?? "", mediaType: a.mediaType, bytes: bytes.toString("base64") });
    }
    await ctx.keepSentImages(to.workspaceId, to.threadId, e.requestId, images);
  }
}

/** Readies a fork of one of a harness's sessions through a turn, the agent's refusal said in the caller's words. */
export async function readyFork(adapter: HarnessAdapter, session: string, turn: ForkTurn, said: (why: string) => Error): Promise<ForkedSession> {
  try {
    return await adapter.forkSession!({ session, turn });
  } catch (e) {
    throw said(e instanceof Error ? e.message : String(e));
  }
}

/** A thread moved onto a copy of its session: every row of it that named the session names the copy, which is what its
 * next turn resumes and what its facts are read under. */
export function moveSession(ctx: RuntimeContext, threadId: string, from: string, to: string): void {
  for (const s of ctx.sessions.values()) if (s.view.threadId === threadId && s.view.claudeSessionId === from) s.view.claudeSessionId = to;
}

type StartOptions = Parameters<Runtime["sessions"]["start"]>[1];

/** A fork's start: in its source's folder, or with a branch in a new worktree of the source's repo at the turn's
 * checkpoint, made where this computer makes them and taken away again, branch and all, where the start refuses. */
export async function forkStart(ctx: RuntimeContext, start: (workspaceId: string, o: StartOptions) => Promise<SessionHandle>, o: Parameters<Runtime["sessions"]["fork"]>[0], origin: Caller | undefined): Promise<SessionHandle> {
  const plan = await readFork(ctx, o.fork, origin);
  const { entry, harness } = plan.source;
  if (o.harness !== undefined && o.harness !== harness) throw refusal(forkAgentLine(ctx.agentLabel(harness), ctx.agentLabel(o.harness)), forkAgentFix(ctx.agentLabel(o.harness)), "usage");
  if (o.branch === undefined) return start(plan.source.workspaceId, o);
  const project = ctx.projectHeld(entry.record.project);
  if (!copiesFolder(entry.record.kind)) throw usageRefusal(placeBranchLine(ctx.placeName(project.computer)), FORK_NO_CHECKPOINT_FIX);
  const top = project.git?.top;
  if (top === undefined) throw usageRefusal(noBranchesLine(project.name), FORK_NO_CHECKPOINT_FIX);
  const ref = plan.turn?.ref;
  if (ref === undefined || (await ctx.gitHere(top, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])).exitCode !== 0) throw refusal(FORK_NO_CHECKPOINT_LINE, FORK_NO_CHECKPOINT_FIX, "conflict");
  const before = new Set(ctx.live.keys());
  const made = await ctx.worktreeFolder(project, top, o.branch, entry.record.id, scopeOf(origin)?.rootThreadId, ref);
  const tree = made.record.worktree;
  // The fork runs where in its tree its source ran in the source's checkout.
  const from = ctx.checkoutOf(entry.record);
  const cwd = tree === undefined || plan.source.cwd === undefined || !plan.source.cwd.startsWith(`${from}/`) ? tree?.path : join(tree.path, relative(from, plan.source.cwd));
  try {
    return await start(made.record.id, { ...o, ...(cwd !== undefined ? { cwd } : {}) });
  } catch (e) {
    if (!before.has(made.record.id) && tree?.made === true) {
      await ctx.removeWorktree(made, true).catch((gone: unknown) => console.warn(`the worktree a refused fork made at ${tree.path} was not removed: ${gone instanceof Error ? gone.message : String(gone)}`));
      await ctx.gitHere(top, ["branch", "-D", o.branch]).catch(() => undefined);
    }
    throw e;
  }
}
