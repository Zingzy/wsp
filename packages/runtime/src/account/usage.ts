// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { CATALOG_AGENTS, type ThreadAgent, loginHomeIn, sharedOn } from "@wsp/catalog";
import { type DaemonFrame, THIS_COMPUTER, underProject, absentComputer, HERE_PLACE_ID, isJoinedComputer, workspacePlace, RANGE_DAYS, READINGS_STEP_MS, SysHistoryReply, resetNoLoginsLine, USAGE_WORDS, outsideWspLine, type ReadingsAnswer, type PlaceView, type AccountsAnswer, type AgentSignInState, type ResetAnswer, type UsageSplit } from "@wsp/protocol";
import { envInput, withEnvFromInput } from "@wsp/engine";
import { NO_PLACE_DOOR } from "../places.js";
import { harnessCatalog, modelLabel } from "../harness-catalog.js";
import { PLAN_RESETS } from "../adapters.js";
import { accountOf, accountOnComputer, accountRows, createBurn, createPriceTable, createUsageLedger, usageComputerName } from "../usage.js";
import { planAlerts } from "../plan-alerts.js";
import { usageResets, type ResetPlace } from "../usage-reset.js";
import { type WorkspaceRecord, type LiveWorkspace, LOG_READ_EVERY_MS, RESET_EXEC_MS, type UsageDoor } from "../types/wiring.js";
import type { RuntimeContext, UsageArea } from "../context.js";

/** How long this computer's sign-ins, read off every agent's own commands, answer a usage read before they are read again. */
const SIGN_INS_HELD_MS = 60_000;

export function usageArea(ctx: RuntimeContext): UsageArea {
  const { opts, store, local, placeDoor, bus, clock, projectsHeld, setups, placeAway, sessions } = ctx;
  /** Why a machine cannot be asked anything at all this tick: it stands on a computer that is not connected. Every
   * road to it, the provider read included, rides that computer's link, so the row says so rather than reading a
   * silence as a machine that died. */
  const awayLine = (record: WorkspaceRecord): string | undefined => {
    const at = workspacePlace(record);
    if (at === undefined || placeDoor === undefined || !placeAway(at)) return undefined;
    return absentComputer(placeDoor.nameOf(at), null).sentence;
  };

  /** A nap, a pause the poll adopts or a gone verdict moves the phase, and the sentence was about the phase it left. */
  const deleteLine = (e: LiveWorkspace): string | undefined => (e.deleteSaid?.phase === e.record.phase ? e.deleteSaid.line : undefined);
  /** The one sentence a row carries, the most pressing first: a delete the provider sat on, the wake's own line or the
   * words it left, a pause or a stop the provider refused, then a disk past the line a stop fails at. */
  const rowReason = (e: LiveWorkspace): string | undefined => deleteLine(e) ?? e.wakeSaid ?? e.record.wakeRefused ?? ctx.napRefusedReason(e) ?? ctx.stopRefusedReason(e) ?? ctx.diskReason(e);

  const prices = createPriceTable({ store, clock, fetch: opts.pricesFetch ?? (async () => ({})) });
  const ledger = createUsageLedger({ store, clock, prices: () => prices.get() });
  const alerts = planAlerts({ clock, emit: e => bus.emit(e), limits: () => ledger.limits() });
  void alerts.resume().catch((e: unknown) => console.warn(`the plan alerts were not armed: ${e instanceof Error ? e.message : String(e)}`));
  const burn = createBurn(clock);

  /** A usage split value as a person reads it: the agent's name, the account's label, the computer's, the project's. */
  const usageLabel = (places: readonly PlaceView[], accounts: ReadonlyMap<string, string>) => (split: UsageSplit, value: string): string => {
    switch (split) {
      case "agent":
        return harnessCatalog(value)?.label ?? value;
      case "project":
        return value === "" ? "No project" : (projectsHeld.get(value)?.name ?? value);
      case "computer":
        return usageComputerName(places, value);
      case "account":
        return accounts.get(value) ?? value;
      case "model":
        return modelLabel(value);
      case "source":
        return value === "log" ? outsideWspLine(usageComputerName(places, HERE_PLACE_ID)) : USAGE_WORDS.wspThreads;
      default: {
        const _exhaustive: never = split;
        return value;
      }
    }
  };

  /** The logs of this computer's agents, filed into the ledger as outside wsp: a folder under one of this computer's
   * projects is that project's, the account is this computer's own login of that agent unless a turn here named it. */
  let logsReadAt: number | undefined;
  const readLogs = async (): Promise<void> => {
    if (opts.logUsage === undefined || !(await ctx.preferences.get()).usageLogs) return;
    if (logsReadAt !== undefined && clock.now() - logsReadAt < LOG_READ_EVERY_MS) return;
    logsReadAt = clock.now();
    const here = [...projectsHeld.values()].filter(p => p.computer === HERE_PLACE_ID);
    const limits = await ledger.limits();
    // A thread wsp ran here writes its transcript to the same logs, whether or not its turn filed a row.
    await ctx.ready();
    const threads = new Set([...sessions.values()].flatMap(s => (s.view.claudeSessionId !== undefined ? [s.view.claudeSessionId] : [])));
    const rows = (await opts.logUsage()).filter(r => !threads.has(r.session));
    const thisComputer = { id: HERE_PLACE_ID, name: usageComputerName((await placeDoor?.list(clock.now())) ?? [], HERE_PLACE_ID) };
    // Work in a terminal here runs on the account this computer's turns run on.
    const accountHere = (agent: string): { key: string; label: string } => accountOnComputer({ agent, agentName: harnessCatalog(agent)?.label ?? agent, computer: thisComputer, limits, vaulted: ctx.vaultedFor(agent) });
    await ledger.fileLogs(
      rows.map(r => ({
        at: r.at,
        agent: r.agent,
        account: accountHere(r.agent).key,
        accountLabel: accountHere(r.agent).label,
        computer: HERE_PLACE_ID,
        project: (r.folder !== undefined ? here.find(p => underProject(r.folder!, p.path))?.id : undefined) ?? "",
        model: r.model,
        tokens: r.tokens,
        ...(r.cost !== undefined ? { costUsd: r.cost } : {}),
        session: r.session,
        source: "log" as const,
      })),
    );
  };

  /** This computer's own sign-ins, read off its agents since no report carries them, held a minute and shared while a
   * read is out; a read that fails lists none. Each read runs every agent's own version and status command, and a
   * usage read per live slate ran one each, about forty a minute (2026-10-06). */
  let heldSignIns: { at: number; value: Promise<Record<string, AgentSignInState>> } | undefined;
  const hereSignIns = (): Promise<Record<string, AgentSignInState>> => {
    const now = clock.now();
    if (heldSignIns !== undefined && now - heldSignIns.at < SIGN_INS_HELD_MS) return heldSignIns.value;
    const value = (opts.agentsReader?.read({ kind: "here" }, { latest: false }) ?? Promise.resolve(undefined)).then(
      read => (read === undefined ? {} : Object.fromEntries(read.agents.flatMap(a => (a.signIn === "signed-in" || a.signIn === "vault-key" ? [[a.id, a.signIn]] : [])))),
      () => ({}),
    );
    heldSignIns = { at: now, value };
    return value;
  };
  // A sign-in that landed shows in usage at once rather than after the hold runs out.
  bus.on("agents.changed", () => {
    heldSignIns = undefined;
  });

  const usageAccounts = async (): Promise<AccountsAnswer> => {
    const places = (await placeDoor?.list(clock.now())) ?? [];
    const here = await hereSignIns();
    const listed = places.map(p => ({ id: p.id, name: p.name, ...(p.signIns !== undefined ? { signIns: p.signIns } : {}) }));
    const row = listed.find(p => p.id === HERE_PLACE_ID);
    if (row !== undefined) row.signIns ??= here;
    else listed.push({ id: HERE_PLACE_ID, name: THIS_COMPUTER, signIns: here });
    return {
      accounts: accountRows({
        limits: await ledger.limits(),
        places: listed,
        nameOf: id => usageComputerName(places, id),
        agentName: agent => harnessCatalog(agent)?.label ?? agent,
        planBrand: agent => CATALOG_AGENTS.find(a => a.id === agent)?.planBrand,
        vaulted: agent => ctx.vaultedFor(agent),
        printsLimits: agent => CATALOG_AGENTS.find(a => a.id === agent)?.printsLimits === true,
        burn: burn.of,
      }),
    };
  };

  /** One reset script on one computer: this one as a child of this host, a joined one over its link. The variables
   * the person set for the agent never go in the script: here they ride the spawn, since the script lands in a file,
   * and there the exec's input, since its command line is one every login on that computer can read. */
  const resetRun = async (place: ResetPlace, script: string, agent: string): Promise<string> => {
    if (place.kind === "box") {
      if (placeDoor === undefined) throw new Error(NO_PLACE_DOOR);
      const path = (await placeDoor.reportOf(place.id))?.login["PATH"];
      const env = { ...(path !== undefined ? { PATH: path } : {}), ...setups.launchOf(place.id, agent).env };
      return (await placeDoor.exec(place.id, withEnvFromInput(script), { timeoutMs: RESET_EXEC_MS, stdin: envInput(env) })).stdout;
    }
    if (local === undefined) throw new Error(absentComputer(place.name, null).sentence);
    // The PATH and the home alone of this computer's own, as the road below reads them, and the variables the person
    // set for the agent, which ride the spawn since the script lands in a file; the variables that keep a thread's
    // shells on its own wsp belong to threads.
    const { PATH, HOME } = local.env();
    const stream = local.execStream({ idleMs: RESET_EXEC_MS, deadlineMs: RESET_EXEC_MS })(script, { env: { ...(PATH !== undefined ? { PATH } : {}), ...(HOME !== undefined ? { HOME } : {}), ...setups.launchOf(place.id, agent).env } });
    const lines: string[] = [];
    for await (const line of stream.lines) lines.push(line);
    await stream.exited;
    return lines.join("\n");
  };

  const spendReset = usageResets({
    store,
    limits: () => ledger.limits(),
    agentName: agent => harnessCatalog(agent)?.label ?? agent,
    resets: agent => PLAN_RESETS[agent as ThreadAgent],
    places: async () => {
      const views = (await placeDoor?.list(clock.now())) ?? [];
      const here = await hereSignIns();
      return id => {
        const name = usageComputerName(views, id);
        if (id === HERE_PLACE_ID) return { id, name, kind: "here", connected: local !== undefined, signedIn: agent => here[agent] === "signed-in" };
        const view = views.find(v => v.id === id);
        if (view === undefined || !isJoinedComputer(view)) return { id, name, kind: "provider", connected: false, signedIn: () => false };
        return { id, name, kind: "box", connected: placeDoor?.link(id) !== undefined, signedIn: agent => placeDoor?.signInsAt(id)?.[agent] === "signed-in" };
      };
    },
    road: async (agent, at) => {
      const setup = setups.launchOf(at.id, agent);
      const launch = setup.launch?.program !== undefined ? { launch: { program: setup.launch.program } } : {};
      // The script exports nothing of the setup's: the run carries those variables itself.
      const env = {};
      if (at.kind === "here") {
        if (local === undefined) throw new Error(absentComputer(at.name, null).sentence);
        return { home: setup.configDir ?? local.home(agent), env, ...launch };
      }
      if (setup.configDir !== undefined) return { home: setup.configDir, env, ...launch };
      const logins = (await placeDoor?.list(clock.now()))?.find(v => v.id === at.id)?.logins;
      const shared = sharedOn(agent);
      if (logins === undefined || shared === undefined) throw new Error(resetNoLoginsLine(at.name, harnessCatalog(agent)?.label ?? agent));
      return { home: loginHomeIn(logins, shared), env, ...launch };
    },
    run: resetRun,
    file: async ({ agent, place: at, limit }) => {
      const account = accountOf({ agent, agentName: harnessCatalog(agent)?.label ?? agent, ...(limit.account !== undefined ? { named: limit.account } : {}), vaulted: undefined, computer: { id: at.id, name: at.name } });
      const { before, after } = await ledger.limit({ key: account.key, agent, label: account.label, road: account.road, computer: at.id, limit });
      await alerts.read(before, after);
      return account.key;
    },
    row: async key => (await usageAccounts()).accounts.find(a => a.key === key),
    uuid: () => randomUUID(),
  });

  /** A spend, the computer the person named read as a place first: a word, or this computer. */
  const reset = async (ask: { account: string; creditId?: string; on?: string }): Promise<ResetAnswer> => {
    const on = ask.on === undefined ? undefined : ((await placeDoor?.placeFor(ask.on))?.placeId ?? HERE_PLACE_ID);
    return spendReset({ account: ask.account, ...(ask.creditId !== undefined ? { creditId: ask.creditId } : {}), ...(on !== undefined ? { on } : {}) });
  };

  const usage: UsageDoor = {
    reset,
    used: async q => {
      // The split by source is the one that sets the logs beside wsp's threads, so it reads them whatever the door asked.
      const outside = (q.outside === true || q.split === "source") && (await ctx.preferences.get()).usageLogs;
      if (outside) await readLogs().catch((e: unknown) => console.warn(`this computer's agent logs were not read for usage: ${e instanceof Error ? e.message : String(e)}`));
      const places = (await placeDoor?.list(clock.now())) ?? [];
      return ledger.used({ range: q.range, split: q.split, label: usageLabel(places, await ledger.accountLabels()), outside, logsOn: usageComputerName(places, HERE_PLACE_ID) });
    },
    readings: async (target, range, origin) => {
      const to = clock.now();
      const from = to - RANGE_DAYS[range] * 86_400_000;
      const stepMs = READINGS_STEP_MS[range];
      const frame = { op: "sys.history", from, to, stepMs } as DaemonFrame;
      const read = async (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>): Promise<ReadingsAnswer> => {
        const reply = SysHistoryReply.parse(await ask(frame));
        return { points: reply.points, stepMs: reply.stepMs, from, to };
      };
      if ("workspaceId" in target) return ctx.withDaemon(await ctx.entryOf(target.workspaceId, origin), read);
      if (target.placeId === HERE_PLACE_ID) return ctx.overChannel(await ctx.channelOver(await ctx.localRoad(), THIS_COMPUTER, () => {}), read);
      const onLink = placeDoor?.channel(target.placeId, () => {});
      if (onLink === undefined) throw new Error(absentComputer(placeDoor?.nameOf(target.placeId) ?? target.placeId, null).sentence);
      return ctx.overChannel(onLink, read);
    },
    accounts: usageAccounts,
  };
  return { awayLine, rowReason, ledger, alerts, burn, usageAccounts, usage };
}
