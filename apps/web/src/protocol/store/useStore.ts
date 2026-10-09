// SPDX-License-Identifier: AGPL-3.0-only
import { create } from "zustand";
import { applyPreferencesPatch, threadsFollowed, goldenHead, copyBuildOf, type AccountRow, type Preferences, type ReviewDraft, type SessionView, type WorkspacePhase, type WorkspaceSize, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { renameNotTakenLine } from "../../actions/format.js";
import { readAddress, readProjectHome, writeAddress, writeProjectHome } from "../address.js";
import { sidebarWorkspaceOrder } from "../../adapt/workspaces.js";
import { DisconnectedError, RequestError, type Api, type ProtocolEvent } from "../client.js";
import { failureOf, type Failure } from "../failure.js";
import { addNotice, noticeFailure, notRead } from "../../notices/store.js";
import { refetchSlates, slateEvent } from "../../slate/store.js";
import { rememberOpen } from "../lastWorkspace.js";
import { claimKept, claiming, claimsAnswered, keepCreations, letGo, own } from "../keptCreations.js";
import { clearLegacyPreferences, legacyPreferences } from "../legacyPreferences.js";
import { bootPreferences, rememberFirstPaint } from "../firstPaint.js";
import { applyAddStage, takeAdds } from "../../settings/adds.js";
import { foldSetup, frameEndsStep } from "../../settings/add/setup.js";
import { WHERE_WORDS } from "../../settings/format.js";
import { placeName, placeNamed } from "../../settings/places.js";
import { sameAt, useSettingsStore, type SettingsAt } from "../../settings/settingsStore.js";
import { CREATE_UNHEARD, imageBuildFrame } from "../../shell/creationLog.js";
import { requestNewThread } from "../../shell/shellRequests.js";
import { useSignInStore } from "../../shell/signInStore.js";
import { newId, useComposerDraftStore } from "../../components/chat/composerDraftStore.js";
import { useComposerFilesStore } from "../../components/chat/composerFiles.js";
import { useComposerOptionsStore } from "../../components/chat/composerOptionsStore.js";
import { transcripts } from "../../components/chat/transcripts.js";
import { couldNotStart, explainCreateRefusal, keptAtLoad, madeAs, NO_LINES, restored, toKeep } from "./creations.js";
import { addressed, firstRow, groupSessions, keptRows, keptThread, openThreadOf, remembered } from "./selection.js";
import { CREATION_PREFIX, NO_SESSIONS } from "./selectors.js";
import type { CostTick, Creation, CreationLine, Opens, State } from "./types.js";

/** Where a refused places list is drawn: while that page is on screen, the refusal says itself there. */
const COMPUTERS_PAGE: SettingsAt = { kind: "group", group: "computers" };

/** The agent, the model and the access picked on one page, handed to the page the send goes on under. */
function movePicks(from: string, to: string): void {
  useComposerOptionsStore.getState().move(from, to);
  const access = useStore.getState().preferences.access[from];
  if (access !== undefined) void useStore.getState().setPreferences({ access: { [to]: access, [from]: null } });
}

/** Opens the thread a row's message starts on its workspace; a refusal is a notice naming the workspace. */
function openOn(workspaceId: string, creation: Creation & { readonly asked: string; readonly opens: Opens }): void {
  const { api, launching, launched } = useStore.getState();
  if (api === null) return;
  const requestId = newId();
  const attachments = creation.attachments ?? [];
  launching(workspaceId, { requestId, title: creation.asked, harness: creation.opens.harness });
  void api.startSession({ workspaceId, prompt: creation.asked, requestId, ...creation.opens, ...(attachments.length > 0 ? { attachments: [...attachments] } : {}) }).catch((e: unknown) => {
    launched(workspaceId, requestId);
    noticeFailure(e, said => `${creation.name}: ${said}`);
  });
}

/** A creation's page keys its draft, its waiting messages and its picks by the creation's key; the workspace takes
 * them all, so what waited goes with the agent and the model picked over it. A queued asked message goes first, and
 * only while the row stands, since every caller takes the row away straight after. It is the person's own send, so it
 * lifts a hold on the workspace's queue as a send typed there does: a folder project's creation lands on the folder's
 * workspace, whose queue a reload or an earlier send that ended with no start may have left held. */
function handOver(key: string, workspaceId: string): void {
  const drafts = useComposerDraftStore.getState();
  drafts.rekeyQueue(key, workspaceId);
  const creation = useStore.getState().creations.find(c => c.key === key);
  if (creation?.queued === true && creation.asked !== undefined) {
    if (creation.opens === undefined) {
      const files = useComposerFilesStore.getState().unqueue(key);
      const row = drafts.enqueue(workspaceId, creation.asked, "head");
      if (files.length > 0) useComposerFilesStore.setState(s => ({ queued: { ...s.queued, [row]: files } }));
      drafts.release(workspaceId);
    } else openOn(workspaceId, { ...creation, asked: creation.asked, opens: creation.opens });
  }
  const draft = drafts.drafts[key];
  if (draft !== undefined) {
    useComposerDraftStore.setState(s => {
      const { [key]: _moved, ...rest } = s.drafts;
      return { drafts: { ...rest, [workspaceId]: draft } };
    });
  }
  movePicks(key, workspaceId);
  // The lists the creation's composer drew stand for the workspace until its machine answers with its own, so the
  // footer it lands with is the one that was on screen.
  const s = useStore.getState();
  if (s.creations.some(c => c.key === key) && s.harnessesByWorkspace[workspaceId] === undefined) {
    useStore.setState(now => ({ harnessesByWorkspace: { ...now.harnessesByWorkspace, [workspaceId]: now.harnesses } }));
  }
}

/** What waited for a machine that will never come goes with its creation, and so does everything handOver would have
 * moved, since nothing reads a dead creation's key again. */
function dropWaiting(key: string): void {
  useComposerFilesStore.getState().drop(key);
  const drafts = useComposerDraftStore.getState();
  for (const row of drafts.queues[key] ?? []) drafts.removeQueued(key, row.id);
  useComposerDraftStore.setState(s => {
    if (!(key in s.drafts)) return s;
    const { [key]: _gone, ...rest } = s.drafts;
    return { drafts: rest };
  });
  useComposerOptionsStore.setState(s => {
    if (!(key in s.byWorkspaceId)) return s;
    const { [key]: _gone, ...rest } = s.byWorkspaceId;
    return { byWorkspaceId: rest };
  });
  if (useStore.getState().preferences.access[key] !== undefined) void useStore.getState().setPreferences({ access: { [key]: null } });
}

/** Sets on their way to the host. While one is, a reply or a preferences.changed for an earlier set would paint an
 * older record over the one the person sees; the last reply, or the record read after a refusal, settles it. */
let preferenceSetsInFlight = 0;

/** Whether a record moved what the host's agent lists are marked and shaped by: the default agent, an agent's own
 * defaults and picker, or a project's own picks, which a workspace's lists are marked by. */
const agentListsMoved = (a: Preferences, b: Preferences): boolean =>
  a.defaultAgent !== b.defaultAgent || JSON.stringify(a.agentDefaults) !== JSON.stringify(b.agentDefaults) || JSON.stringify(a.projectDefaults) !== JSON.stringify(b.projectDefaults);
/** Every init.job view taken so far. The setup snapshot read on a connect is a view of the moment it was asked
 * for, so a job started or ended between the ask and the reply would be painted over by the older one; a snapshot
 * that raced a view is dropped and the view stands. Dropping it loses nothing because the reply and the events
 * travel one ordered socket and the host emits on every change, so the last event before a reply carries the state
 * that reply was computed from or newer. The day they travel separate channels this needs a stamp instead. */
let initJobViews = 0;

/** How many of one place's build frames are kept: every stage of a build and the tail of its install steps. */
export const GOLDEN_FRAMES_KEPT = 64;

/** Whether usage.accounts was asked since the last gap, so every slate binding usage asks once between them. */
let usageAccountsAsked = false;
/** The rows pushed since usage.accounts was last asked: newer than its answer, so they stand over it. */
let usageAccountsPushed: Record<string, AccountRow> = {};
/** One frame at 60 Hz: how long a status row or a cost tick waits for the rest of its burst. */
export const FRAME_MS = 16;

export const useStore = create<State>((set, get) => {
  /** Status rows and cost ticks held for the next frame: a poll's 125 rows are one render, not 125. Each frame is the
   * whole of its workspace's entry, so the newest in a frame supersedes the older; any other event, and every write to
   * a status outside the event stream, lands the held ones first, so nothing is applied out of the order it arrived in. */
  let held: { statuses: Record<string, WorkspaceStatus>; costs: Record<string, CostTick> } | null = null;
  let frame: ReturnType<typeof setTimeout> | null = null;
  const flushFrame = (): void => {
    if (frame !== null) clearTimeout(frame);
    frame = null;
    const landing = held;
    held = null;
    if (landing !== null) set(s => ({ statuses: { ...s.statuses, ...landing.statuses }, costs: { ...s.costs, ...landing.costs } }));
  };
  const holdForFrame = (e: Extract<ProtocolEvent, { type: "workspace.status" | "workspace.cost" }>): void => {
    held ??= { statuses: {}, costs: {} };
    if (e.type === "workspace.status") held.statuses[e.status.id] = e.status;
    else held.costs[e.workspaceId] = { rateUsdPerHour: e.rateUsdPerHour, accruedUsd: e.accruedUsd, at: e.at };
    frame ??= setTimeout(flushFrame, FRAME_MS);
  };
  /** A record the host answered, and its agent lists read again where it moved what they are marked by: the host's
   * and every workspace's, since a mark the host moved is lost to the composer once the default under it goes. */
  const preferencesLanded = (preferences: Preferences, before: Preferences): void => {
    set({ preferences });
    const api = get().api;
    if (!agentListsMoved(before, preferences) || api?.listHarnesses === undefined) return;
    void api
      .listHarnesses()
      .then(harnesses => set({ harnesses }))
      .catch(() => {});
    for (const workspaceId of Object.keys(get().harnessesByWorkspace)) void get().loadHarnesses(workspaceId);
  };
  const patchCreation = (key: string, patch: (c: Creation) => Creation): void => {
    set(s => ({ creations: s.creations.map(c => (c.key === key ? patch(c) : c)) }));
  };
  /** The row leaves with its workspace in place of it; the selection follows, onto the workspace's next thread,
   * and what was typed on the creation's page goes with it, the waiting messages to be sent from there. */
  /** The landed setup a create leaves on the page it was open on: one asked with a message opens on that message
   * instead, and one that lands while the person is elsewhere leaves none. */
  const landedOn = (opened: boolean, creation: Creation | undefined, workspaceId: string): { landed?: State["landed"] } =>
    opened && creation !== undefined && creation.asked === undefined ? { landed: { workspaceId, creation, at: Date.now() } } : {};
  const finishCreation = (key: string, workspaceId: string): void => {
    handOver(key, workspaceId);
    const opened = get().selectedId === key;
    const creation = get().creations.find(c => c.key === key);
    set(s => ({
      creations: s.creations.filter(c => c.key !== key),
      selectedId: opened ? workspaceId : s.selectedId,
      freshThread: opened || s.freshThread,
      ...landedOn(opened, creation, workspaceId),
    }));
    if (opened) writeAddress({ workspaceId });
  };
  /** Rows the host has spoken of since this window last subscribed. The subscribe asks for the last word of every
   * create the host holds, which lands ahead of the list's reply, so a kept row unheard by then is one no create
   * there is making. */
  const heard = new Set<string>();
  const runCreation = async (key: string, project: string, name: string, picked?: { golden?: string; size?: WorkspaceSize }): Promise<string | null> => {
    const api = get().api;
    if (!api) return null;
    try {
      const { notice, ...workspace } = await api.createWorkspace(project, name, picked);
      if (notice !== undefined) addNotice({ kind: "note", text: notice, where: name });
      // The created event normally lands first; when the reply beats it, the row still has a workspace to become.
      set(s => (s.workspaces.some(w => w.id === workspace.id) ? {} : { workspaces: [...s.workspaces, workspace].sort((a, b) => a.id.localeCompare(b.id)) }));
      finishCreation(key, workspace.id);
      return workspace.id;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      patchCreation(key, c => ({
        ...c,
        failed: explainCreateRefusal(e, name),
        lines: c.lines.at(-1)?.stage === "failed" ? c.lines : [...c.lines, { stage: "failed", message, at: new Date().toISOString(), elapsedMs: c.lines.at(-1)?.elapsedMs ?? 0 }],
      }));
      return null;
    }
  };

  // a rebuild replaces the machine, so its event carries a new machineId; gone carries the words, and any other
  // phase drops the ones the view was holding, since a record that left gone has none to show
  const setPhase = (id: string, phase: WorkspacePhase, machineId?: string, gone?: string): void => {
    const words = phase !== "gone" ? { gone: undefined } : gone !== undefined ? { gone } : {};
    const patch = { phase, ...(machineId !== undefined ? { machineId } : {}), ...words };
    flushFrame();
    set(s => ({
      workspaces: s.workspaces.map(w => (w.id === id ? { ...w, ...patch } : w)),
      statuses: s.statuses[id] ? { ...s.statuses, [id]: { ...s.statuses[id]!, ...patch } } : s.statuses,
    }));
  };

  // The optimistic phase paints at once; the runtime's own pushes (pausing, napping, waking, running) reconcile it.
  const move = async (id: string, to: "pausing" | "waking"): Promise<void> => {
    const api = get().api;
    const w = get().workspaces.find(x => x.id === id);
    if (!api || !w) return;
    setPhase(id, to);
    try {
      await (to === "pausing" ? api.nap(id) : api.wake(id));
    } catch (e) {
      setPhase(id, w.phase);
      noticeFailure(e, said => `${w.name} was not ${to === "pausing" ? "paused" : "woken"}: ${said}`);
    }
  };

  /** What a refused list reads as: undefined for a lost socket, which the banner says and the next pull asks again;
   * null for a socket that may not see it, an empty list that says nothing; else the fault, said once as a notice.
   * Either answer clears the rows, as a refused forwards read does: rows read before it are not today's list. */
  /** A refused list, said as a notice unless the page it is drawn on is the one on screen. */
  const listRefusal = (e: unknown, what: string, home?: SettingsAt): Failure | null | undefined => {
    const failure = failureOf(e);
    if (failure.disconnected) return undefined;
    if (failure.kind === "ticket") return null;
    if (home === undefined || !get().settingsOpen || !sameAt(useSettingsStore.getState().at, home)) notRead(what)(e);
    return failure;
  };

  /** Said once per bind: a host that refuses them refuses every time they are asked. */
  let capabilitiesSaid = false;
  /** The workspaces whose refused thread list has been said since the bind. */
  const sessionsSaid = new Set<string>();
  /** Every read of the thread rows is numbered as it is asked, and each workspace keeps the number its rows came from.
   * A read answered after a newer one landed is older than what is drawn: a reconnect's read of every row, held up
   * while the workspaces list waits on a computer that does not answer, would otherwise put back a workspace without
   * the thread another client started meanwhile, and nothing reads that workspace again until the turn ends. */
  let rowReads = 0;
  const rowsFrom = new Map<string, number>();
  /** Each workspace whose rows a subagent's start or end read in the last quarter second, and whether another came
   * since: the first is read at once and the rest once the quarter second is out, so eight children starting inside
   * a second cost a handful of reads, not one each. */
  const subagentReads = new Map<string, { again: boolean }>();
  const SUBAGENT_READ_MS = 250;
  const readForSubagents = (workspaceId: string): void => {
    const window = { again: false };
    subagentReads.set(workspaceId, window);
    void get().reloadSessions(workspaceId);
    setTimeout(() => {
      if (window.again) readForSubagents(workspaceId);
      else subagentReads.delete(workspaceId);
    }, SUBAGENT_READ_MS);
  };
  /** The rows a read of every workspace answered, less the workspaces a newer read has already drawn. A read that
   * answered covers every workspace, those it found no rows for too, so each is stamped with it: an older read landing
   * later may not put back rows this one found gone. */
  const newerKept = (read: Record<string, SessionView[]> | null, asked: number, covered: readonly string[], drawn: Record<string, SessionView[]>): Record<string, SessionView[]> => {
    const kept = { ...(read ?? {}) };
    for (const [id, from] of rowsFrom) {
      if (from <= asked) continue;
      if (drawn[id] === undefined) delete kept[id];
      else kept[id] = drawn[id];
    }
    if (read !== null) for (const id of new Set([...covered, ...Object.keys(read), ...rowsFrom.keys()])) if ((rowsFrom.get(id) ?? 0) < asked) rowsFrom.set(id, asked);
    return kept;
  };
  const readCapabilities = (api: Api): void => {
    void api
      .capabilities()
      .then(capabilities => set({ capabilities }))
      .catch((e: unknown) => {
        if (capabilitiesSaid || failureOf(e).disconnected) return;
        capabilitiesSaid = true;
        noticeFailure(e, said => `What the host can do was not read: ${said}`);
      });
  };

  const readPlaceRows = (api: Api): void => {
    // An answer either way settles it, and a host whose wire carries no place list settles it at once: nothing
    // waits on a reply that is never coming.
    const placesAsked = api.placesList?.();
    if (placesAsked === undefined) set({ placesRead: true });
    else {
      takeAdds(api, placesAsked.then(read => read.adds));
      void placesAsked.then(
        ({ places, pending }) => set({ places, pending: pending ?? [], placesRead: true, placesRefused: null }),
        (e: unknown) => {
          const refused = listRefusal(e, "Computers", COMPUTERS_PAGE);
          if (refused !== undefined) set({ places: [], placesRead: true, placesRefused: refused });
        },
      );
    }
  };
  const readPlaces = (api: Api): void => {
    readPlaceRows(api);
    // The landings go with it: a host that has gained a computer or an image since answers differently now.
    set({ landings: {} });
  };
  // What bind fetches and a reconnect fetches again: the list plus the status snapshot that also arms status.subscribe.
  const pull = (api: Api): void => {
    heard.clear();
    // A restored row is neither handed over nor judged before this page knows it owns it.
    void claimsAnswered()
      .then(() => get().refresh())
      .catch((e: unknown) => noticeFailure(e, said => `Workspaces not read: ${said}`));
    void api
      .watchStatuses()
      .then(statuses => {
        flushFrame();
        set({ statuses: Object.fromEntries(statuses.map(s => [s.id, s])) });
      })
      .catch((e: unknown) => noticeFailure(e, said => `Live status is not coming from the host: ${said}`));
    // A refused list clears the rows: a forward that closed while the socket was down must not stay listed.
    void api
      .listForwards?.()
      .then(forwards => set({ forwards }))
      .catch((e: unknown) => {
        set({ forwards: [] });
        noticeFailure(e, said => `Forwards not read: ${said}`);
      });
    set({ goldenFrames: {} });
    const initJobsAtAsk = initJobViews;
    void api
      .initGet?.()
      .then(setup => {
        if (initJobViews !== initJobsAtAsk) return;
        set({ initJob: setup.job });
      })
      .catch(notRead("Setup"));
    readPlaces(api);
    // An answer either way settles it, and a host whose wire carries no projects list settles it at once.
    const projectsAsked = api.projectsList?.();
    if (projectsAsked === undefined) set({ projectsRead: true });
    else
      void projectsAsked.then(
        projects => set({ projects, projectsRead: true, projectsRefused: null }),
        (e: unknown) => {
          const refused = listRefusal(e, "Projects");
          if (refused !== undefined) set({ projects: [], projectsRead: true, projectsRefused: refused });
        },
      );
    void api
      .preferences?.()
      .then(preferences => {
        if (preferenceSetsInFlight === 0) set({ preferences });
        // What this browser kept before the record existed goes onto the record once, then the old keys go.
        const legacy = legacyPreferences(window.localStorage);
        if (legacy !== null) void get().setPreferences(legacy).then(() => clearLegacyPreferences(window.localStorage));
      })
      .catch((e: unknown) => noticeFailure(e, said => `Preferences not read: ${said}`));
    // release.changed is never replayed, so a reconnect reads the whole view again.
    void api
      .releaseGet?.()
      .then(release => set({ release }))
      .catch(() => {});
  };

  return {
    api: null,
    conn: "connecting",
    capabilities: null,
    hasGolden: null,
    initJob: null,
    goldenFrames: {},
    harnesses: [],
    harnessesByWorkspace: {},
    workspaces: [],
    statuses: {},
    costs: {},
    spending: {},
    forwards: [],
    places: [],
    pending: [],
    projects: [],
    broughtBack: {},
    viewed: {},
    reviews: {},
    async loadReview(workspaceId) {
      const read = get().api?.reviewDraft;
      if (read === undefined) return;
      const { review } = await read(workspaceId).catch(() => ({}) as { review?: ReviewDraft });
      set(s => {
        if (review === undefined) {
          const { [workspaceId]: _gone, ...rest } = s.reviews;
          return { reviews: rest };
        }
        return { reviews: { ...s.reviews, [workspaceId]: review } };
      });
    },
    landings: {},
    projectsRead: false,
    placesRead: false,
    placesRefused: null,
    projectsRefused: null,
    addComputerOpen: false,
    selectedId: null,
    projectHome: readProjectHome(),
    selectedThreadId: null,
    freshThread: false,
    creations: keptAtLoad,
    landed: null,
    sessions: {},
    launches: {},
    ready: false,
    gaps: 0,
    preferences: bootPreferences(),
    release: null,
    usageAccounts: null,
    loadUsageAccounts() {
      if (usageAccountsAsked) return;
      usageAccountsAsked = true;
      usageAccountsPushed = {};
      // The answer is the whole list as it is now: it replaces what was kept, so an account gone since the last answer
      // goes too, and only a push that came after the ask stands over it.
      void get().api?.usageAccounts?.().then(
        answer => set({ usageAccounts: { ...Object.fromEntries(answer.accounts.map(row => [row.key, row])), ...usageAccountsPushed } }),
        () => {
          usageAccountsAsked = false;
        },
      );
    },
    settingsOpen: false,
    noteGap() {
      transcripts.gap();
      set(s => ({ gaps: s.gaps + 1 }));
      refetchSlates();
      usageAccountsAsked = false;
      if (get().usageAccounts !== null) get().loadUsageAccounts();
    },
    bind(api) {
      transcripts.bind(api);
      set({ api });
      useComposerFilesStore.setState({ kept: api.sessionAttachment });
      capabilitiesSaid = false;
      sessionsSaid.clear();
      api.subscribe(e => {
        if (e.type === "workspace.status" || e.type === "workspace.cost") return holdForFrame(e);
        // Before any view hears it: a view folding the bus itself asks the transcripts what they already held.
        transcripts.apply(e);
        flushFrame();
        get().applyEvent(e);
      });
      readCapabilities(api);
      // A failed lookup reads as sealed: the row is a door, not a gate, and the create's own error says the rest.
      void api
        .getGolden()
        .then(m => set({ hasGolden: goldenHead(m) !== undefined }))
        .catch(() => set({ hasGolden: true }));
      void api
        .listHarnesses?.()
        .then(harnesses => set({ harnesses }))
        .catch((e: unknown) => noticeFailure(e, said => `Agents not read: ${said}`));
      pull(api);
    },
    setConn(conn) {
      set({ conn });
      const api = get().api;
      if (conn === "live" && api) pull(api);
    },
    select(id, threadId = null) {
      set(s => ({ selectedId: id, selectedThreadId: threadId, freshThread: false, settingsOpen: false, projectHome: null, landed: s.landed?.workspaceId === id ? s.landed : null }));
      writeAddress(id === null || get().creations.some(c => c.key === id) ? null : { workspaceId: id, ...(threadId === null ? {} : { threadId }) });
    },
    dropLanded(workspaceId) {
      set(s => (s.landed?.workspaceId === workspaceId ? { landed: null } : {}));
    },
    openProjectHome(projectId) {
      set({ selectedId: null, selectedThreadId: null, freshThread: false, settingsOpen: false, projectHome: projectId, landed: null });
      writeProjectHome(projectId);
    },
    newThread(workspaceId) {
      set({ selectedId: workspaceId, selectedThreadId: null, freshThread: true, settingsOpen: false, projectHome: null, landed: null });
      writeAddress({ workspaceId, fresh: true });
      requestNewThread({ workspaceId });
    },
    readingThread(workspaceId, threadId) {
      const s = get();
      if (s.selectedId !== workspaceId || s.selectedThreadId !== null) return;
      set({ selectedThreadId: threadId, freshThread: false });
      writeAddress({ workspaceId, threadId });
    },
    openSettings() { set({ settingsOpen: true }); },
    closeSettings() { set({ settingsOpen: false, addComputerOpen: false }); },
    toggleSettings() { set(s => ({ settingsOpen: !s.settingsOpen, addComputerOpen: s.settingsOpen ? false : s.addComputerOpen })); },
    async setPreferences(patch) {
      const api = get().api;
      const before = get().preferences;
      set(s => ({ preferences: applyPreferencesPatch(s.preferences, patch) }));
      if (!api?.setPreferences) return;
      preferenceSetsInFlight++;
      try {
        const { notice, ...preferences } = await api.setPreferences(patch);
        if (--preferenceSetsInFlight === 0) preferencesLanded(preferences, before);
        if (notice !== undefined) addNotice({ kind: "error", text: notice });
      } catch (e) {
        preferenceSetsInFlight--;
        if (e instanceof DisconnectedError) return;
        noticeFailure(e, said => `That setting was not saved: ${said.replace(/\.$/, "")}. It shows the host's value again.`);
        if (preferenceSetsInFlight === 0) void api.preferences?.().then(preferences => set({ preferences })).catch(() => {});
      }
    },
    async createWorkspace(project, name, picked, asked) {
      // The computer is the project's own, so the row that waits on an image build is keyed by it and nothing asks
      // the person where the work goes. Nothing is refused here: a project on this computer forks nothing, and a
      // project on a computer with no image is refused by the runtime in its own sentence on the creation view.
      const computer = get().projects.find(p => p.id === project)?.computer;
      if (!get().api) return null;
      // Unique across reloads: a draft or a waiting message persisted under a key must never meet another creation.
      const key = `${CREATION_PREFIX}${newId()}`;
      if (asked?.queuedFrom !== undefined) {
        movePicks(asked.queuedFrom, key);
        // The page's files wait with the message, under the creation's key, until handOver queues it on the workspace.
        useComposerFilesStore.getState().queue(asked.queuedFrom, key);
      }
      const said =
        asked === undefined
          ? {}
          : {
              asked: asked.prompt,
              ...(asked.queuedFrom !== undefined || asked.opens !== undefined ? { queued: true as const } : {}),
              ...(asked.opens !== undefined ? { opens: asked.opens } : {}),
              ...(asked.attachments !== undefined ? { attachments: asked.attachments } : {}),
            };
      own(key);
      set(s => ({
        creations: [
          ...s.creations,
          { key, name, project, askedAt: Date.now(), ...(picked?.golden !== undefined ? { golden: picked.golden } : {}), ...(picked?.size !== undefined ? { size: picked.size } : {}), ...said, ...(computer !== undefined ? { where: computer } : {}), workspaceId: null, lines: NO_LINES, failed: null },
        ],
        selectedId: key,
        selectedThreadId: null,
      }));
      return runCreation(key, project, name, picked);
    },
    async addProject(source, on, into) {
      const api = get().api;
      if (api?.projectsAdd === undefined) return null;
      const project = await api.projectsAdd(source, on, into);
      // The event carries the same record; taking it here too means the caller's next read holds it whichever
      // arrived first, and the create that follows a first run has a project to be made of.
      set(s => ({ projects: [...s.projects.filter(p => p.id !== project.id), project] }));
      get().openProjectHome(project.id);
      return project;
    },
    async bringBack(workspaceId) {
      const api = get().api;
      if (api?.bringBack === undefined) return;
      const back = await api.bringBack(workspaceId);
      set(s => ({ broughtBack: { ...s.broughtBack, [workspaceId]: back } }));
    },
    async removeProject(projectId) {
      const api = get().api;
      if (api?.projectsRemove === undefined) return;
      try {
        await api.projectsRemove(projectId);
      } catch (e) {
        noticeFailure(e);
      }
    },
    async loadLanding(project) {
      const api = get().api;
      if (api?.workspacesLanding === undefined || project in get().landings) return;
      // The mark goes down before the ask, so a project drawn in three rows is asked about once.
      set(s => ({ landings: { ...s.landings, [project]: null } }));
      try {
        const landing = await api.workspacesLanding(project);
        set(s => ({ landings: { ...s.landings, [project]: landing } }));
      } catch {
        // A computer that forks nothing has no landing to give; the rows say what their records carry.
      }
    },
    async retryCreation(key) {
      const creation = get().creations.find(c => c.key === key);
      // A row another client started carries no project, so there is nothing here to ask again.
      if (!creation || creation.project === undefined || claiming(key)) return;
      // From here the create's own reply answers for the row, as for a row this page asked for.
      restored.delete(key);
      patchCreation(key, c => ({ ...c, workspaceId: null, lines: NO_LINES, failed: null }));
      await runCreation(key, creation.project, creation.name, { ...(creation.golden !== undefined ? { golden: creation.golden } : {}), ...(creation.size !== undefined ? { size: creation.size } : {}) });
    },
    dismissCreation(key) {
      // The runtime holds a create that failed with the id its stages carried, so every client's row goes with it. A
      // host that restarted since holds nothing under the id, and its not-found leaves nothing to say.
      const creation = get().creations.find(c => c.key === key);
      const workspaceId = creation !== undefined && creation.failed !== null ? creation.workspaceId : null;
      dropWaiting(key);
      const deleting = get().api?.deleteWorkspace;
      if (workspaceId !== null && deleting !== undefined) void deleting(workspaceId).catch((e: unknown) => (failureOf(e).kind === "not-found" ? undefined : noticeFailure(e)));
      set(s => {
        const project = s.creations.find(c => c.key === key)?.project;
        // The next row is one of the same project's, never the sidebar's first, which may be another project's.
        const sibling = project === undefined ? undefined : sidebarWorkspaceOrder(s).find(id => s.workspaces.find(w => w.id === id)?.project.id === project);
        return { creations: s.creations.filter(c => c.key !== key), selectedId: s.selectedId === key ? (sibling ?? null) : s.selectedId };
      });
    },
    async refresh() {
      const api = get().api;
      if (!api) return;
      const asked = ++rowReads;
      const [workspaces, answered] = await Promise.all([api.listWorkspaces(), api.listSessions().then(rows => rows, () => null)]);
      const s = get();
      const rows = answered ?? NO_SESSIONS;
      const sessions = newerKept(answered === null ? null : groupSessions(rows, workspaces.map(w => w.id)), asked, workspaces.map(w => w.id), s.sessions);
      // The address is read on every refresh, not only the first: a reconnect after the host restarted rebuilds this
      // store from nothing, and what the person is reading is recorded there rather than here.
      const address = readAddress();
      // A project's home stands in the centre with nothing picked on purpose; a refresh fills the gap only when no home does.
      const last = remembered(workspaces);
      const selectedId = s.selectedId ?? (s.projectHome !== null ? null : (addressed(address, workspaces) ?? last?.workspaceId ?? firstRow({ workspaces, statuses: s.statuses, sessions })));
      const open = openThreadOf(address ?? keptThread(last, rows), selectedId, s.selectedThreadId, rows);
      set({
        workspaces,
        sessions,
        ready: true,
        selectedId,
        selectedThreadId: open.threadId,
        freshThread: open.fresh,
        // A list the runtime answered is the whole of what threads there are: a send it has since written a row for
        // is that row now, and one it has not is a turn that died while this client was away, so neither may keep a
        // row of its own. A list it refused says nothing, and the sends in flight stand until a start or an end.
        ...(answered === null ? {} : { launches: {} }),
      });
      // A kept row whose workspace was made while no page here was open to hear it becomes that workspace now, and
      // one the host neither listed nor spoke of is a create it is no longer making.
      for (const c of get().creations) {
        const made = workspaces.find(w => madeAs(c, w));
        if (made !== undefined) finishCreation(c.key, made.id);
        else if (restored.has(c.key) && c.failed === null && !heard.has(c.key)) patchCreation(c.key, r => ({ ...r, failed: { title: couldNotStart(r.name), detail: CREATE_UNHEARD } }));
      }
      if (open.toast !== undefined) addNotice({ kind: "error", text: open.toast });
      if (selectedId === null || !workspaces.some(w => w.id === selectedId)) return;
      // The chat for the workspace clears itself when it takes this, whether it is mounted yet or not.
      if (open.fresh && !s.freshThread) requestNewThread({ workspaceId: selectedId });
      writeAddress({ workspaceId: selectedId, ...(open.threadId === null ? {} : { threadId: open.threadId }), ...(open.fresh ? { fresh: true } : {}) });
    },
    async reloadSessions(workspaceId) {
      const api = get().api;
      if (!api) return;
      try {
        const asked = ++rowReads;
        const rows = await api.listSessions(workspaceId);
        if ((rowsFrom.get(workspaceId) ?? 0) > asked) return;
        rowsFrom.set(workspaceId, asked);
        // A list the host answered unchanged writes nothing, so a reread of every workspace changes only what moved.
        set(s => {
          const kept = keptRows(s.sessions[workspaceId], rows);
          return kept === s.sessions[workspaceId] ? s : { sessions: { ...s.sessions, [workspaceId]: kept } };
        });
      } catch (e) {
        // Said once per workspace for a refusal; anything else, the next session event asks again.
        if (e instanceof RequestError && !sessionsSaid.has(workspaceId)) {
          sessionsSaid.add(workspaceId);
          noticeFailure(e, said => `Threads not read: ${said}`, { where: get().workspaces.find(w => w.id === workspaceId)?.name ?? workspaceId });
        }
      }
    },
    launching(workspaceId, launch) {
      set(s => ({ launches: { ...s.launches, [workspaceId]: launch } }));
    },
    launched(workspaceId, requestId) {
      set(s => {
        const held = s.launches[workspaceId];
        if (held === undefined || (requestId !== undefined && held.requestId !== requestId)) return {};
        const { [workspaceId]: _gone, ...rest } = s.launches;
        return { launches: rest };
      });
    },
    async renameThread({ sessionId, workspaceId, harness, title }) {
      const api = get().api;
      if (!api?.renameSession) return false;
      try {
        // The store the name goes into is on the machine, so a napping one is woken first and its reply repaints the
        // row; every client that can rename can wake, since wake is not an optional verb.
        const workspace = get().workspaces.find(w => w.id === workspaceId);
        if (workspace !== undefined && workspace.phase !== "running") get().applyWorkspace(await api.wake(workspaceId));
        const { outcome, error } = await api.renameSession(sessionId, title);
        if (outcome !== "renamed") {
          addNotice({ kind: "error", text: renameNotTakenLine(harness, outcome, error) });
          return false;
        }
        await get().reloadSessions(workspaceId);
        return true;
      } catch (e: unknown) {
        noticeFailure(e, said => `${title}: ${said}`);
        return false;
      }
    },
    async forgetThread({ threadId, workspaceId }) {
      const api = get().api;
      if (!api?.forgetThread) return false;
      try {
        await api.forgetThread(threadId);
        if (get().selectedThreadId === threadId) set({ selectedThreadId: null });
        await get().reloadSessions(workspaceId);
        return true;
      } catch (e: unknown) {
        noticeFailure(e);
        return false;
      }
    },
    async readThread(threadId) {
      await get().api?.readThread?.(threadId).catch((e: unknown) => noticeFailure(e, said => `Thread not marked read: ${said}`));
    },
    async settleThreads(threadIds) {
      const api = get().api;
      if (!api?.settleThreads || threadIds.length === 0) return undefined;
      try {
        return await api.settleThreads(threadIds);
      } catch (e: unknown) {
        noticeFailure(e);
        return undefined;
      }
    },
    async markThreads(threadIds, marks) {
      const api = get().api;
      if (!api?.markThreads || threadIds.length === 0) return;
      try {
        await api.markThreads(threadIds, marks);
      } catch (e: unknown) {
        noticeFailure(e);
      }
    },
    async restoreThreads(threadIds) {
      const api = get().api;
      if (!api?.restoreThreads || threadIds.length === 0) return;
      try {
        await api.restoreThreads(threadIds);
      } catch (e: unknown) {
        noticeFailure(e);
      }
    },
    async renameWorkspace({ workspaceId, name }) {
      const api = get().api;
      if (!api?.renameWorkspace) return false;
      try {
        get().applyWorkspace(await api.renameWorkspace(workspaceId, name));
        return true;
      } catch (e: unknown) {
        noticeFailure(e);
        return false;
      }
    },
    async setWorkspaceLook({ workspaceId, look }) {
      const api = get().api;
      if (!api?.setWorkspaceLook) return false;
      try {
        const workspace = await api.setWorkspaceLook(workspaceId, look);
        // The record answers with the whole look, and a cleared fact is absent from it, so the row takes it the way
        // the event does rather than through a merge, which cannot unset a key.
        get().applyEvent({ type: "workspace.look", workspaceId, theme: workspace.theme ?? null, glyph: workspace.glyph ?? null });
        return true;
      } catch (e: unknown) {
        noticeFailure(e);
        return false;
      }
    },
    async loadHarnesses(workspaceId) {
      const api = get().api;
      if (!api?.listHarnesses) return;
      try {
        const harnesses = await api.listHarnesses(workspaceId);
        // The composer asks at every thread it opens; an answer that reads the same keeps the record, which the
        // sidebar reads, so its tiles do not all draw again.
        if (JSON.stringify(get().harnessesByWorkspace[workspaceId]) === JSON.stringify(harnesses)) return;
        set(s => ({ harnessesByWorkspace: { ...s.harnessesByWorkspace, [workspaceId]: harnesses } }));
      } catch {
        // the table's catalogs stand
      }
    },
    async toggle(id) {
      const w = get().workspaces.find(x => x.id === id);
      if (!w) return;
      // A workspace already waking is one the host may be asking the provider again for; the one slot stops that.
      if (w.phase === "waking") await get().stopWake(id);
      else if (w.phase === "running") await move(id, "pausing");
      else await get().wake(id);
    },
    async wake(id) {
      const w = get().workspaces.find(x => x.id === id);
      if (!w || w.phase === "running") return;
      await move(id, "waking");
    },
    async stopWake(id) {
      const api = get().api;
      if (!api?.stopWake) return;
      try {
        get().applyWorkspace(await api.stopWake(id));
      } catch (e) {
        noticeFailure(e);
      }
    },
    async stopForward(workspaceId, port) {
      const api = get().api;
      if (!api?.stopForward) return;
      try {
        await api.stopForward(workspaceId, port);
      } catch (e) {
        noticeFailure(e, said => `localhost:${port}: ${said}`);
      }
    },
    openAddComputer() { set({ settingsOpen: true, addComputerOpen: true }); },
    closeAddComputer() { set({ addComputerOpen: false }); },
    async saveKeys(keys) {
      const api = get().api;
      if (api?.initKeys === undefined) throw new Error(WHERE_WORDS.cannotSaveKey);
      const setup = await api.initKeys(keys);
      useSettingsStore.getState().setReads({ setup });
      readPlaces(api);
      return setup;
    },
    async dialPlace(placeId) {
      const api = get().api;
      if (api?.dialPlace === undefined) throw new Error(WHERE_WORDS.cannotDial);
      const answer = await api.dialPlace(placeId);
      set(s => ({ places: s.places.map(p => (p.id === answer.place.id ? answer.place : p)) }));
      return answer;
    },
    async updatePlace(placeId) {
      const api = get().api;
      if (api?.placesUpdate === undefined) return;
      try {
        await api.placesUpdate(placeId);
        // The row then carries the daemon that computer now runs, so the word that it was behind goes.
        readPlaces(api);
      } catch (e) {
        noticeFailure(e);
      }
    },
    async setPlace(placeId, ask, reset) {
      const api = get().api;
      if (api?.placesSet === undefined) return;
      const place = await api.placesSet(placeId, ask, reset);
      set(s => ({ places: s.places.map(p => (p.id === placeId ? place : p)) }));
    },
    applyWorkspace(workspace) {
      flushFrame();
      set(s => ({
        workspaces: s.workspaces.map(w => (w.id === workspace.id ? { ...w, ...workspace } : w)),
        statuses: s.statuses[workspace.id] ? { ...s.statuses, [workspace.id]: { ...s.statuses[workspace.id]!, ...workspace } } : s.statuses,
      }));
    },
    applyEvent(e) {
      switch (e.type) {
        case "thread.marked":
        case "thread.rewound":
          void get().reloadSessions(e.workspaceId);
          return;
        case "workspace.renamed":
          // The record alone changed: the row and its status take the name, and nothing about the machine moves.
          set(s => ({
            workspaces: s.workspaces.map(w => (w.id === e.workspaceId ? { ...w, name: e.name } : w)),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: { ...s.statuses[e.workspaceId]!, name: e.name } } : s.statuses,
          }));
          return;
        case "workspace.look": {
          // Both facts travel whole, so a cleared one leaves the record rather than lingering under a merge.
          const put = <T extends WorkspaceView>(w: T): T => {
            const { theme: _theme, glyph: _glyph, ...rest } = w;
            return { ...rest, ...(e.theme !== null ? { theme: e.theme } : {}), ...(e.glyph !== null ? { glyph: e.glyph } : {}) } as T;
          };
          set(s => ({
            workspaces: s.workspaces.map(w => (w.id === e.workspaceId ? put(w) : w)),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: put(s.statuses[e.workspaceId]!) } : s.statuses,
          }));
          return;
        }
        case "workspace.deleted":
          set(s => {
            const { [e.workspaceId]: _s, ...statuses } = s.statuses;
            const { [e.workspaceId]: _c, ...costs } = s.costs;
            const { [e.workspaceId]: _p, ...spending } = s.spending;
            const { [e.workspaceId]: _r, ...sessions } = s.sessions;
            const { [e.workspaceId]: _b, ...broughtBack } = s.broughtBack;
            const { [e.workspaceId]: _h, ...harnessesByWorkspace } = s.harnessesByWorkspace;
            const creation = s.creations.find(c => c.workspaceId === e.workspaceId);
            const workspaces = s.workspaces.filter(x => x.id !== e.workspaceId);
            // A page open on the workspace goes with it, or the centre keeps drawing a thread the host no longer has.
            const left = s.selectedId === e.workspaceId ? { selectedId: firstRow({ workspaces, statuses, sessions }), selectedThreadId: null } : {};
            return {
              workspaces,
              creations: s.creations.filter(c => c !== creation),
              ...(creation !== undefined && s.selectedId === creation.key ? { selectedId: null } : {}),
              ...left,
              statuses,
              costs,
              spending,
              sessions,
              broughtBack,
              harnessesByWorkspace,
              forwards: s.forwards.filter(f => f.workspaceId !== e.workspaceId),
            };
          });
          return;
        case "place.joined":
          set(s => ({ places: [...s.places.filter(p => p.id !== e.place.id), e.place] }));
          return;
        case "place.changed":
          set(s => ({ places: s.places.map(p => (p.id === e.place.id ? e.place : p)) }));
          return;
        case "place.stage":
          applyAddStage(get().api, e);
          return;
        case "place.setup": {
          set(s => {
            const at = s.places.find(p => p.id === e.placeId);
            const setup = at === undefined ? undefined : foldSetup(at.setup, e);
            // A frame of a run the record does not hold yet changes nothing: the list's next read brings that run.
            return at === undefined || setup === at.setup ? {} : { places: s.places.map(p => (p === at ? { ...p, setup } : p)) };
          });
          // A step's rows and the end's outcome ride the record, not the frame: read once per step, never per frame.
          const api = get().api;
          if (api !== null && frameEndsStep(e)) readPlaceRows(api);
          return;
        }
        case "place.pending":
          set(s => ({ pending: e.pending === undefined ? s.pending.filter(p => p.id !== e.id) : [...s.pending.filter(p => p.id !== e.id), e.pending] }));
          return;
        case "place.present":
        case "place.absent":
          set(s => ({
            places: s.places.map(p => (p.id === e.placeId ? { ...p, present: e.type === "place.present", lastSeenAt: new Date().toISOString() } : p)),
          }));
          return;
        case "place.removed":
          set(s => {
            const { [e.placeId]: _gone, ...goldenFrames } = s.goldenFrames;
            return { places: s.places.filter(p => p.id !== e.placeId), goldenFrames };
          });
          return;
        case "project.added":
          // In the host's own order, so a project a recipe moved under its id and age lands back where it stood.
          set(s => ({ projects: [...s.projects.filter(p => p.id !== e.project.id), e.project].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }));
          return;
        case "project.removed":
          set(s => {
            const { [e.projectId]: _gone, ...landings } = s.landings;
            return { projects: s.projects.filter(p => p.id !== e.projectId), landings };
          });
          return;
        case "forward.open":
          set(s => ({ forwards: [...s.forwards.filter(f => !(f.workspaceId === e.forward.workspaceId && f.port === e.forward.port)), e.forward] }));
          return;
        case "forward.close":
          set(s => ({ forwards: s.forwards.filter(f => !(f.workspaceId === e.workspaceId && f.port === e.port)) }));
          useSignInStore.getState().portClosed(e.workspaceId, e.port);
          return;
        case "golden.stage": {
          // Kept per place for that computer's image card, and folded into the log of a create waiting on the build
          // there, so the build's own stages read as its first lines. A frame naming no place is the image's own
          // build, which the init job owns; one naming a place nobody here is waiting on is only the card's.
          const word = e.place;
          if (word === undefined) return;
          set(s => {
            const kept = s.goldenFrames[word] ?? [];
            const last = kept.at(-1);
            const ended = last !== undefined && copyBuildOf(last)?.stopped !== false;
            const goldenFrames = { ...s.goldenFrames, [word]: [...(ended ? [] : kept), e].slice(-GOLDEN_FRAMES_KEPT) };
            // The create may have been asked by the row's name while the frames carry its id, so the row matches the two.
            const at = s.places.find(p => placeNamed(p, word));
            const own = s.creations.find(c => c.failed === null && c.where !== undefined && (c.where === word || (at !== undefined && placeNamed(at, c.where))));
            const line = own === undefined ? undefined : imageBuildFrame(e, at === undefined ? word : placeName(at));
            if (own === undefined || line === undefined) return { goldenFrames };
            const logged: CreationLine = { stage: "image", at: new Date().toISOString(), elapsedMs: Date.now() - own.askedAt, ...line };
            heard.add(own.key);
            return { goldenFrames, creations: s.creations.map(c => (c === own ? { ...c, lines: [...c.lines, logged] } : c)) };
          });
          return;
        }
        case "workspace.creating": {
          const line: CreationLine = {
            stage: e.stage,
            message: e.message,
            at: new Date().toISOString(),
            elapsedMs: e.elapsedMs,
            ...(e.notice !== undefined ? { notice: e.notice } : {}),
            ...(e.detail !== undefined ? { detail: e.detail } : {}),
            ...(e.waiting === true ? { waiting: e.message } : {}),
          };
          set(s => {
            // Ours is matched by the id once known, before that by the name it was asked for; another client's create shows up
            // too. Two clients creating the same name at once can swap logs until the reply lands, and workspace.created
            // settles which row is whose; the runtime's id is not known here any earlier than its first stage.
            const own = s.creations.find(c => c.workspaceId === e.workspaceId) ?? s.creations.find(c => c.workspaceId === null && c.name === e.name && c.failed === null);
            const failed = e.stage === "failed" ? { title: couldNotStart(e.name), detail: e.message } : null;
            if (own === undefined) {
              // A refusal of a create this window holds no row of, as the subscribe's last word of a command line's
              // failure is, has nobody here to tell.
              if (failed !== null) return {};
              return { creations: [...s.creations, { key: `${CREATION_PREFIX}${e.workspaceId}`, name: e.name, askedAt: Date.now() - e.elapsedMs, workspaceId: e.workspaceId, lines: [line], failed }] };
            }
            heard.add(own.key);
            const last = own.lines.at(-1);
            // A wait is said once per ask: it is the step it waits in, told again, and never a step of its own.
            if (e.waiting === true && last !== undefined && last.stage === e.stage) {
              return { creations: s.creations.map(c => (c === own ? { ...c, workspaceId: e.workspaceId, lines: [...c.lines.slice(0, -1), { ...last, waiting: e.message }] } : c)) };
            }
            // The last word the subscribe asks for repeats the frame a replay may have carried just before it.
            const repeated = last !== undefined && last.stage === line.stage && last.message === line.message && last.elapsedMs === line.elapsedMs;
            return { creations: s.creations.map(c => (c === own ? { ...c, workspaceId: e.workspaceId, lines: repeated ? c.lines : [...c.lines, line], failed: c.failed ?? failed } : c)) };
          });
          return;
        }
        case "workspace.created": {
          const creation = get().creations.find(c => madeAs(c, e.workspace));
          if (creation !== undefined) handOver(creation.key, e.workspace.id);
          set(s => {
            const rest = s.workspaces.filter(x => x.id !== e.workspace.id);
            const opened = creation !== undefined && s.selectedId === creation.key;
            return {
              workspaces: [...rest, e.workspace].sort((a, b) => a.id.localeCompare(b.id)),
              creations: s.creations.filter(c => c !== creation),
              selectedId: opened ? e.workspace.id : s.selectedId,
              freshThread: opened || s.freshThread,
              ...landedOn(opened, creation, e.workspace.id),
            };
          });
          return;
        }
        // napped/woken carry only ids; they are also the optimistic toggle's reconcile.
        case "workspace.napped":
          setPhase(e.workspaceId, "napping");
          return;
        case "workspace.gone":
          setPhase(e.workspaceId, "gone", undefined, e.reason);
          return;
        case "workspace.woken":
        case "workspace.upgraded":
          setPhase(e.workspaceId, "running", e.machineId);
          return;
        case "workspace.status":
          set(s => ({ statuses: { ...s.statuses, [e.status.id]: e.status } }));
          return;
        case "workspace.viewed":
          set(s => ({ viewed: { ...s.viewed, [e.workspaceId]: e.viewed } }));
          return;
        case "workspace.review":
          void get().loadReview(e.workspaceId);
          return;
        case "workspace.cost":
          set(s => ({
            costs: { ...s.costs, [e.workspaceId]: { rateUsdPerHour: e.rateUsdPerHour, accruedUsd: e.accruedUsd, at: e.at } },
          }));
          return;
        case "session.capped":
          // The row says what holds its turn back, and the event that says so is the moment that changed.
          void get().reloadSessions(e.workspaceId);
          return;
        case "session.held":
          // A thread is spoken for before its harness is up, from this window or any other client: its row is read
          // now, and the send it answers, by its request id, has its own tile go once the row is in.
          void get().reloadSessions(e.workspaceId).then(() => (e.requestId === undefined ? undefined : get().launched(e.workspaceId, e.requestId)));
          return;
        case "session.start": {
          // The next send resumes this id; the runtime persists it, the view learns it here.
          const remember = <T extends WorkspaceView>(w: T): T => (w.id === e.workspaceId ? { ...w, claudeSessionId: e.sessionId } : w);
          set(s => ({
            spending: { ...s.spending, [e.workspaceId]: (s.spending[e.workspaceId] ?? 0) + 1 },
            workspaces: s.workspaces.map(remember),
            statuses: s.statuses[e.workspaceId] ? { ...s.statuses, [e.workspaceId]: remember(s.statuses[e.workspaceId]!) } : s.statuses,
          }));
          void get().reloadSessions(e.workspaceId).then(() => (e.requestId === undefined ? undefined : get().launched(e.workspaceId, e.requestId)));
          // The runtime re-asks the binary at a start, so a Claude Code upgrade on the machine shows within its TTL.
          void get().loadHarnesses(e.workspaceId);
          return;
        }
        case "session.done":
          slateEvent(e);
          // The reply is in, but the row stays running until the process exits (session.end): a turn is not over while
          // its agent keeps working, and a send that met a done-but-running row would be one the runtime refuses.
          return;
        case "session.end":
          set(s => ({ spending: { ...s.spending, [e.workspaceId]: Math.max(0, (s.spending[e.workspaceId] ?? 0) - 1) } }));
          // An end without a start of its own is a harness that died before it announced itself: the send it stood
          // for has no row coming, so the row it was drawn as goes with it.
          void get().reloadSessions(e.workspaceId).then(() => get().launched(e.workspaceId));
          return;
        case "session.subagent":
          // A thread's subagents ride its row, so a child starting or ending is a row that changed.
          {
            const window = subagentReads.get(e.workspaceId);
            if (window === undefined) readForSubagents(e.workspaceId);
            else window.again = true;
          }
          return;
        case "session.permission":
        case "session.permission.closed":
          // The row the sidebar reads carries what the thread is waiting on, so a prompt opening or closing is a row
          // that changed: every workspace's rows are read here, not only the open thread's. Every workspace and not
          // only this one, since a thread waiting behind this one carries the same question and may run anywhere.
          for (const id of Object.keys(get().sessions)) void get().reloadSessions(id);
          return;
        case "session.delta": {
          // A call that follows another thread to the end of its turn is what puts a thread behind a question it
          // never asked, so the row moves when such a call opens, with no prompt of its own in sight. A call
          // answering moves it back, but only where a row here is already behind something: every other turn writes
          // hundreds of results that change no row at all.
          const opens = e.kind === "tool_use" && e.toolName !== undefined && threadsFollowed({ toolName: e.toolName, input: e.text }) !== undefined;
          const closes = e.kind === "tool_result" && (get().sessions[e.workspaceId] ?? []).some(row => row.waitingOn !== undefined);
          if (opens || closes) void get().reloadSessions(e.workspaceId);
          return;
        }
        case "preferences.changed":
          if (preferenceSetsInFlight === 0) preferencesLanded(e.preferences, get().preferences);
          return;
        case "session.slate":
        case "slate.values":
        case "slate.run":
          slateEvent(e);
          return;
        case "usage.account":
          usageAccountsPushed = { ...usageAccountsPushed, [e.key]: e.row };
          set(s => ({ usageAccounts: { ...s.usageAccounts, [e.key]: e.row } }));
          return;
        case "release.changed":
          set({ release: e.release });
          return;
        case "init.job": {
          initJobViews++;
          set({ initJob: e.job });
          // A seal is what the cloud row waits on, and the provider the host wired in is what the sizes come from.
          if (e.job.phase === "done") {
            set({ hasGolden: true });
            const api = get().api;
            if (api !== null) readCapabilities(api);
          }
          return;
        }
        default:
          return;
      }
    },
  };
});

// Every road to a workspace or a thread (a click, a chord, a finished creation, the boot fallback) lands here; a creation row is not a workspace yet.
useStore.subscribe((s, prev) => {
  if (s.selectedId === prev.selectedId && s.selectedThreadId === prev.selectedThreadId) return;
  if (s.selectedId !== null && s.workspaces.some(w => w.id === s.selectedId)) rememberOpen(s.selectedId, s.selectedThreadId);
});
// Every change to the record, the host's or a pick painted ahead of it, is what the next load paints first.
useStore.subscribe((s, prev) => {
  if (s.preferences !== prev.preferences) rememberFirstPaint(s.preferences);
});
useStore.subscribe((s, prev) => {
  if (s.creations === prev.creations && s.workspaces === prev.workspaces) return;
  keepCreations(toKeep(s));
  for (const c of prev.creations) if (!s.creations.some(now => now.key === c.key)) letGo(c.key);
});
claimKept(keptAtLoad, key => useStore.setState(s => ({ creations: s.creations.filter(c => c.key !== key) })));
