// SPDX-License-Identifier: AGPL-3.0-only
// What a thread's launch runs at, and the agent's process a new thread's composer starts ahead of its first send.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { serverValuesOf } from "@wsp/catalog";
import { MCP_SERVER_NAME, TURN_TOKEN_ENV, keptPicks, listedPick, scopeOf, startPicks, type AccessChoice, type Preferences, type SessionWarmResult, type StartPicks } from "@wsp/protocol";
import { harnessCatalog } from "../harness-catalog.js";
import type { HarnessAdapter } from "../types/harness.js";
import type { Runtime } from "../types/api.js";
import { launchesAs, type KeptLaunch } from "../types/internal.js";
import type { LiveWorkspace } from "../types/wiring.js";
import type { RuntimeContext } from "../context.js";

/** The picks a launch names, each left to the thread's own or the defaults where absent. */
export type LaunchAsked = { model?: string; effort?: string; permissionMode?: string; access?: AccessChoice; contextWindow?: string; fast?: boolean };

export function launchArea(ctx: RuntimeContext) {
  const { opts, deviceDoor, threadLaunch, setups } = ctx;
  /** What a launch on a thread runs at, against the agent's lists for the workspace with the marks the person's
   * defaults put on them: the access named, else the thread's own; the model, effort and window named, else the
   * thread's own latest, else the defaults where the thread has none. Read against the session the launch resumes. */
  const launchPicks = async (entry: LiveWorkspace, harness: string, adapter: HarnessAdapter, prefs: Preferences, threadId: string, o: LaunchAsked) => {
    const workspaceId = entry.record.id;
    const table = harnessCatalog(harness);
    // Checked against the binary's own lists, the ones the composer shows for this workspace, with the marks on
    // what the person's defaults resolve to here, which startPicks fills in for anything this start leaves out.
    const resolved = table === undefined ? undefined : ctx.defaultsOn(await ctx.catalogOn(table, entry, adapter), prefs, prefs.projectDefaults[entry.record.project]);
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
    return { catalog, picksFor };
  };
  /** What a launch fixes for the life of the agent's process: the agent, the folder, the servers a caller named, the
   * binary's version and the person's setup for it. */
  const launchFixed = (entry: LiveWorkspace, harness: string, cwd: string, mcpServers: unknown, version: string | null | undefined): string => {
    const place = ctx.setupPlace(entry);
    return JSON.stringify({ harness, cwd, mcpServers, version, setup: place === undefined ? undefined : setups.launchOf(place, harness) });
  };
  /** The warm launches in flight, by workspace and agent: a second ask waits for the first, so one stands. */
  const warming = new Map<string, Promise<SessionWarmResult>>();
  const warmNow = async (entry: LiveWorkspace, harness: string, prefs: Preferences, asked: LaunchAsked & { cwd?: string }): Promise<SessionWarmResult> => {
    const workspaceId = entry.record.id;
    const threadId = randomUUID();
    const probe = ctx.adapterFor(entry, harness, {}, () => false, {}, threadId).adapter;
    if (probe.warm === undefined) return { warm: "none" };
    await ctx.confineSetup(entry, harness);
    const { catalog, picksFor } = await launchPicks(entry, harness, probe, prefs, threadId, asked);
    const picks = picksFor(undefined);
    const folder = await ctx.threadFolder(entry, asked);
    if (!existsSync(folder)) return { warm: "none" };
    const cwd = ctx.runsIn(entry, undefined, folder);
    const launch: KeptLaunch = { fixed: launchFixed(entry, harness, cwd, undefined, catalog?.version), picks: { ...picks } };
    const standing = ctx.warmOn(workspaceId, harness);
    if (standing !== undefined && launchesAs(standing[1].launch, launch) && launchesAs(launch, standing[1].launch)) {
      ctx.rewarm(standing[0]);
      return { warm: "standing" };
    }
    if (standing !== undefined) ctx.reapKept(standing[0]);
    const turnToken = randomBytes(16).toString("hex");
    const { scoped, env: launchEnv, wsp } = await threadLaunch(entry, threadId, threadId);
    try {
      const waiting = { on: false };
      const { adapter } = ctx.adapterFor(entry, harness, { [TURN_TOKEN_ENV]: turnToken, ...launchEnv }, () => waiting.on, serverValuesOf(opts.vault?.() ?? {}), threadId);
      const served = adapter.mcpServers === true ? wsp : undefined;
      const serverValues = adapter.mcpServers === true ? await ctx.serverValuesFor(entry, harness, cwd) : undefined;
      const agent = adapter.warm!({
        ...picks,
        cwd,
        ...(served !== undefined ? { mcpServers: { [MCP_SERVER_NAME]: served } } : {}),
        ...(serverValues !== undefined ? { serverValues } : {}),
        ...(catalog?.source === "harness" && catalog.version !== null ? { version: catalog.version } : {}),
      });
      ctx.holdWarm(threadId, { workspaceId, agent, launch, turnToken, ...(scoped !== undefined ? { scopeDeviceId: scoped.deviceId } : {}), waiting, warm: { harness, claimed: false } });
      return { warm: "started" };
    } catch (e) {
      if (scoped !== undefined) void deviceDoor.revoke(scoped.deviceId).catch(() => {});
      throw e;
    }
  };

  const warm: Runtime["sessions"]["warm"] = async (workspaceId, asked, origin) => {
    await ctx.ready();
    // A thread's token starts nothing ahead: the process is the person's next thread's, and its token names a tree
    // of its own.
    if (scopeOf(origin) !== undefined) return { warm: "none" };
    const entry = await ctx.entryOf(workspaceId, origin);
    if (!ctx.moduleOf(entry.record.kind).keepsAgents || ctx.state.closing) return { warm: "none" };
    const prefs = ctx.state.preferencesHeld ?? (await ctx.preferences.get());
    const harness = asked.harness ?? ctx.defaultAgentOf(prefs, entry);
    if (ctx.agentOff(entry, harness)) return { warm: "none" };
    const key = `${workspaceId}\u0000${harness}`;
    const run = (warming.get(key) ?? Promise.resolve()).catch(() => {}).then(() => warmNow(entry, harness, prefs, asked));
    warming.set(key, run);
    void run.catch(() => {}).then(() => {
      if (warming.get(key) === run) warming.delete(key);
    });
    return run;
  };

  return { launchPicks, launchFixed, warm };
}
