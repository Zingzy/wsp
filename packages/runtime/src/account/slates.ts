// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { threadWord, isLocalWorkspace, SETTLE_MS, threadSettled } from "@wsp/protocol";
import { lazySlates } from "../lazy-slates.js";
import type { Slates } from "../slates.js";
import type { RuntimeContext, SlatesArea } from "../context.js";

export function slatesArea(ctx: RuntimeContext): SlatesArea {
  const { opts, store, local, bus, clock, live, threadRecords, sessions, transcripts } = ctx;
  const slates: Slates = lazySlates({
    store,
    now: () => clock.now(),
    record: e => ctx.record(e),
    emit: e => bus.emit(e),
    thread: threadId => {
      const latest = ctx.latestOn(threadId);
      const workspaceId = latest?.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
      if (workspaceId === undefined) return undefined;
      const running = [...sessions.values()].find(s => s.view.threadId === threadId && s.view.status === "running");
      const entry = live.get(workspaceId);
      // A run starts where the thread's next turn would: the folder its session ran in, a --cwd or a worktree, else
      // the folder the workspace's kind holds its project in, on that kind's computer.
      const ranIn = latest?.cwd ?? (latest?.claudeSessionId === undefined ? undefined : ctx.folderOf(workspaceId, latest.claudeSessionId));
      if (entry === undefined) return { workspaceId, rootThreadId: ctx.rootOf(threadId), sessionId: latest?.claudeSessionId ?? latest?.id ?? threadId, ...(running !== undefined ? { turnId: running.turnId } : {}) };
      const folder = ctx.runsIn(entry, ranIn, ctx.moduleOf(entry.record.kind).folder(entry.record) ?? ctx.checkoutOf(entry.record));
      // A run on the host from a thread on a box starts in the project's folder here, where the project is also here.
      const here = isLocalWorkspace(entry.record) ? folder : existsSync(ctx.checkoutOf(entry.record)) ? ctx.checkoutOf(entry.record) : homedir();
      return {
        workspaceId,
        rootThreadId: ctx.rootOf(threadId),
        sessionId: latest?.claudeSessionId ?? latest?.id ?? threadId,
        ...(running !== undefined ? { turnId: running.turnId } : {}),
        folder,
        hostFolder: here,
        computer: ctx.computerOf(entry),
      };
    },
    machineOf: threadId => {
      const entry = ctx.boxOf(threadId);
      return entry?.machine;
    },
    asleep: threadId => {
      const entry = ctx.boxOf(threadId);
      return entry !== undefined && entry.record.phase !== "running";
    },
    wake: async threadId => {
      const entry = ctx.boxOf(threadId);
      if (entry !== undefined) await ctx.workspaces.wake(entry.record.id);
    },
    loaded: () => ctx.ready(),
    settled: async threadId => {
      const latest = ctx.latestOn(threadId);
      if (latest === undefined) return false;
      const own = threadRecords.get(threadId);
      const prefs = await ctx.preferences.get();
      const facts = { working: latest.status === "running", asking: latest.waitingOn !== undefined, failed: latest.status === "failed", startedAt: latest.startedAt ?? null, endedAt: latest.endedAt ?? null, readAt: own?.readAt ?? null, settledAt: own?.settledAt ?? null };
      return threadSettled(facts, clock.now(), SETTLE_MS[prefs.settleAfter]);
    },
    under: lead => ctx.treeUnder(lead),
    threadOfToken: token => ctx.threadOfToken(token),
    mcpServer: async (threadId, name) => {
      const workspaceId = ctx.latestOn(threadId)?.workspaceId ?? threadRecords.get(threadId)?.workspaceId;
      const harness = ctx.latestOn(threadId)?.harness ?? threadRecords.get(threadId)?.harness;
      const entry = workspaceId === undefined ? undefined : live.get(workspaceId);
      if (entry === undefined || harness === undefined) throw new Error(`thread ${threadId} has no workspace this host holds`);
      if (!isLocalWorkspace(entry.record)) throw new Error("a slate's tool runs start their server on this computer, and this thread runs on another");
      const reader = opts.agentsReader;
      if (reader?.server === undefined) throw new Error("this host reads no agent's MCP config");
      return reader.server({ kind: "here", projects: [{ id: workspaceId!, name: "thread", path: ctx.checkoutOf(entry.record) }] }, { agent: harness, name });
    },
    sources: (threadId, workspaceId) => ({
      threadId,
      workspaceId,
      now: clock.now(),
      rows: () => ctx.rowsOn(threadId).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
      results: () => (transcripts.get(workspaceId) ?? []).flatMap(e => (e.type === "session.done" && e.threadId === threadId ? [e.result] : [])),
      account: async () => {
        const entry = live.get(workspaceId);
        const harness = ctx.latestOn(threadId)?.harness ?? threadRecords.get(threadId)?.harness;
        if (entry === undefined || harness === undefined) return undefined;
        const key = ctx.usageAccountOf(entry, harness).key;
        return (await ctx.usageAccounts()).accounts.find(a => a.key === key);
      },
      workspace: () => {
        const entry = live.get(workspaceId);
        if (entry === undefined) return undefined;
        const project = entry.record.project;
        return {
          computer: ctx.computerOf(entry),
          ...(project !== undefined ? { project: ctx.projectHeld(project).name } : {}),
          folder: ctx.checkoutOf(entry.record),
          ...(entry.checkout !== undefined ? { checkout: entry.checkout } : {}),
          ...(entry.pr !== undefined ? { pr: entry.pr } : {}),
          rateUsdPerHour: entry.record.size === undefined ? 0 : ctx.backendFor(entry.record).pricing.rateUsdPerHour(entry.record.size),
          accruedUsd: ctx.accrued.get(workspaceId) ?? 0,
        };
      },
    }),
    deliver: async ({ threadId, workspaceId, prompt, requestId }) => {
      let queuedNow: (() => void) | undefined;
      const queued = new Promise<{ outcome: "queued" }>(resolve => {
        queuedNow = () => resolve({ outcome: "queued" });
      });
      const off = bus.on("session.queued", e => {
        if (e.type === "session.queued" && e.requestId === requestId) queuedNow?.();
      });
      try {
        const started = ctx.sessionsApi.start(workspaceId, { prompt, thread: threadId, requestId, startedBy: "person", via: "slate" });
        const first = await Promise.race([started, queued]);
        if ("outcome" in first && !("turnId" in first)) {
          started.catch((e: unknown) => console.warn(`a press waiting in thread ${threadWord(threadId)} was not sent: ${e instanceof Error ? e.message : String(e)}`));
          return { outcome: "queued" };
        }
        return { outcome: first.outcome, turnId: first.turnId };
      } finally {
        off();
      }
    },
    watchPr: workspaceId => {
      const entry = live.get(workspaceId);
      if (entry !== undefined) ctx.pollPullRequest(entry);
    },
    runEnv: () => local?.env() ?? (process.env as Record<string, string>),
    ...(opts.statePath !== undefined ? { secretsFile: join(ctx.stateFolder(), "slates.secrets.json"), slatesDir: join(ctx.stateFolder(), "slates") } : {}),
  });
  return { slates };
}
