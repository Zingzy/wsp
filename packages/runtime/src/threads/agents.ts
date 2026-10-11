// SPDX-License-Identifier: AGPL-3.0-only
import { homedir } from "node:os";
import { dirname, join, posix, resolve as resolvePathOn } from "node:path";
import { CATALOG_AGENTS, DEFAULT_AGENT, LAUNCH_SERVER_ROADS, MCP_AGENTS, checkoutArgs, checkoutOf, installsOnFirstRun, serverValuesOf, turnServerFiles } from "@wsp/catalog";
import { INLINE_EXEC_MS, harnessExec, landBytes, agentHomes, parseConfigs, readConfigsCmd, readReason, readWhole } from "@wsp/engine";
import {
  type AttachmentRoad, type HarnessCatalog, type HarnessCatalogProbe, type Preferences, type SessionView, type TitleSource, type Attachment,
  type TurnImage, threadKeyOf, isLocalWorkspace, catalogRefused, imagePathIn, noAdapterLine, shellQuote,
  signInRefusalLine, storedTitleSource, workspaceState, HERE_PLACE_ID, filePathIn, landFilesLine, filesNotLandedLine,
  dropFilesLine, accessMode, accessRefusal, configDirLaunchRefusal, configDirRefusal, markedFor, openDefaults,
  resolveThreadDefaults, withCustomModels, type AccessChoice, type ProjectOverrides, type ResolvedFolder,
} from "@wsp/protocol";
import type { TurnWaiting } from "../machine-exec.js";
import { keyOf, realFolderHere, realFolderScript } from "../agent-setup.js";
import { providerSaid } from "../status.js";
import { catalogFromProbe, harnessCatalog, smallestModel } from "../harness-catalog.js";
import type { HarnessAdapter, HarnessStartOptions } from "../types/harness.js";
import {
  AGENT_VERSION_READ_MS, CATALOG_TTL_MS, CATALOG_PROBE_TIMEOUT_MS, FIRST_RUN_READ_MS, SESSION_TITLE_TTL_MS, SESSION_TITLE_TIMEOUT_MS, SESSION_TITLE_REFRESH_MAX,
  TITLE_MAKE_TIMEOUT_MS,
} from "../types/events.js";
import type { LiveWorkspace } from "../types/wiring.js";
import { AGENT_LISTS, noTitleLogLine, noMadeTitleLogLine, noNameWriteLogLine, serverValuesCutLine, serverValuesUnreadLine } from "../types/internal.js";
import type { RuntimeContext, AgentsArea } from "../context.js";

export function agentsArea(ctx: RuntimeContext): AgentsArea {
  const { opts, adapters, local, clock, live, setups, threadRecords, sessions } = ctx;
  /** One probe per harness per machine per TTL, a failed one included and one in flight shared: a binary that does
   * not answer costs one exec, not one per composer mount. Past the TTL the lists held answer while the binary is
   * asked again, and the lists a host before this one heard answer its first ask the same way, each only while the
   * binary answers the version they were read off. A send waits on the probe where nothing says what the binary takes:
   * a machine never asked, a binary since changed, a version it does not print. */
  const catalogs = new Map<string, { at: number; catalog: Promise<HarnessCatalog> }>();
  /** Every ask of an agent's own CLI the host set going on its own, a probe or a title question, which a close waits
   * for: one let go on past the close runs that CLI after the host let the machine go. */
  const agentAsks = new Set<Promise<unknown>>();
  const holdAsk = <T>(ask: Promise<T>): Promise<T> => {
    agentAsks.add(ask);
    const drop = (): void => void agentAsks.delete(ask);
    void ask.then(drop, drop);
    return ask;
  };
  /** Whether the agent's command on the workspace's machine is a wrapper whose first run, still to come, installs it;
   * read without running anything of the agent's. */
  const firstRunHere = (entry: LiveWorkspace, harness: string): Promise<boolean> => {
    const bin = CATALOG_AGENTS.find(a => a.id === harness)?.bin;
    if (bin === undefined) return Promise.resolve(false);
    const run = (script: string): Promise<string | undefined> => entry.machine.exec(script, { timeoutMs: FIRST_RUN_READ_MS }).then(r => (r.exitCode === 0 ? r.stdout : undefined), () => undefined);
    return installsOnFirstRun(run, [bin]).then(([installs]) => installs === true);
  };
  const catalogOn = (table: HarnessCatalog, entry: LiveWorkspace, adapter: HarnessAdapter): Promise<HarnessCatalog> => {
    const machine = entry.machine;
    const known: HarnessCatalog = {
      ...table,
      steers: adapter.steers,
      renames: adapter.renameSession !== undefined,
      images: adapter.attachments !== undefined,
      ...(adapter.mcpServers === true ? { mcpServers: true } : {}),
      ...(adapter.movesAccess === true ? { movesAccess: true } : {}),
      ...(adapter.steersImages === true ? { steersImages: true } : {}),
      asides: adapter.aside !== undefined,
      ...(adapter.compacts !== undefined ? { compacts: adapter.compacts } : {}),
      ...(adapter.terminalResume !== undefined ? { terminalResume: adapter.terminalResume } : {}),
      ...(adapter.resumesAt === true || adapter.revert !== undefined ? { rewindsConversation: true } : {}),
      ...(adapter.revert !== undefined ? { rewindsByCount: true } : {}),
      ...(adapter.screenCommands !== undefined ? { screenCommands: [...adapter.screenCommands] } : {}),
    };
    if (adapter.probeCatalog === undefined) return Promise.resolve(known);
    const key = `${machine.id}:${table.harness}`;
    const hit = catalogs.get(key);
    const now = clock.now();
    if (hit !== undefined && now - hit.at < CATALOG_TTL_MS) return hit.catalog;
    if (ctx.state.closing) return hit?.catalog ?? Promise.resolve(known);
    // A command whose first run installs its agent is not asked: the probe would start the download and its cut at
    // the deadline would leave it running. The table answers, and the next ask looks again.
    let skipped = false;
    const probe = adapter.probeCatalog;
    // Read once for the probe and the version check below, neither of which runs a command that would install.
    const installing = firstRunHere(entry, table.harness);
    const catalog = holdAsk(installing
      .then(installs => {
        skipped = installs;
        return installs ? null : probe(harnessExec(machine, CATALOG_PROBE_TIMEOUT_MS));
      })
      // A binary that named why it described nothing keeps the table's lists and lends the footer its words.
      .then(
        answer => {
          if (answer === null) return known;
          if (catalogRefused(answer)) return { ...known, refusal: answer.refused };
          // The answer is kept, not the catalog: what wsp itself says of the agent is this build's.
          void ctx.store.put(AGENT_LISTS, key, answer).catch((e: unknown) => console.warn(`${table.harness} on ${machine.id}: its lists were not kept for the next host (${e instanceof Error ? e.message : String(e)}); its first send there waits on the probe`));
          return catalogFromProbe(known, answer);
        },
        (e: unknown) => {
          // The lists a start is checked against are then wsp's own, which refuse a model the binary there takes.
          console.warn(`${table.harness} on ${machine.id}: the probe of the agent failed (${e instanceof Error ? e.message : String(e)}); wsp's built-in list answers until the next probe`);
          return known;
        },
      ));
    void catalog.then(() => {
      if (skipped) catalogs.delete(key);
    });
    // Lists another build kept in a shape this one cannot read are no answer: the probe is.
    const kept = (answer: unknown): HarnessCatalog | undefined => {
      try {
        return answer === undefined ? undefined : catalogFromProbe(known, answer as HarnessCatalogProbe);
      } catch {
        return undefined;
      }
    };
    // Lists the binary answered are its lists while it answers the same version: an update or another binary first on
    // the PATH takes other flags and opens on another model. wsp's own table answers as it did, since no binary's word
    // is in it.
    const sameBinary = async (lists: HarnessCatalog): Promise<HarnessCatalog> => {
      const read = adapter.probeVersion;
      if (lists.source !== "harness") return lists;
      if (read === undefined || lists.version === null) return catalog;
      const answered = await holdAsk(installing.then(installs => (installs ? null : read(harnessExec(machine, AGENT_VERSION_READ_MS))))).catch(() => null);
      return answered !== null && answered === lists.version ? lists : catalog;
    };
    const before = hit?.catalog ?? ctx.store.get(AGENT_LISTS, key).then(kept, () => undefined);
    const held = before.then(lists => (lists === undefined ? catalog : sameBinary(lists)));
    const asking = { at: now, catalog: held };
    catalogs.set(key, asking);
    void catalog.then(() => {
      if (catalogs.get(key) === asking) asking.catalog = catalog;
    });
    return held;
  };

  /** One title read per harness session per machine per TTL, a failed one included and one in flight shared: a row
   * pushed to the windows asks again for its workspace's rows, and each ask must not cost an exec. `failed` holds from
   * a read that failed until one answers, so a store that fails every window is said once. */
  const titleReads = new Map<string, { at: number; done: Promise<void>; live: boolean; failed: boolean }>();
  /** Asks the harness what it calls a row's session and keeps the answer on every row that shares it, so the title
   * a client folds a thread by follows a rename made inside the harness. `force` reads past the TTL: a turn has just
   * ended, which is when the harness writes its own title. Nothing happens while the machine cannot be asked, or
   * when the harness has no title for the session: the rows keep the last one read rather than losing it to a nap.
   */
  const refreshTitle = (view: SessionView, force: boolean): Promise<void> => {
    const sessionId = view.claudeSessionId;
    const entry = live.get(view.workspaceId);
    if (sessionId === undefined || entry === undefined) return Promise.resolve();
    if (workspaceState({ phase: entry.record.phase }) !== "running" || ctx.unreachedOf(entry) !== undefined || adapters[view.harness] === undefined) return Promise.resolve();
    const key = `${entry.machine.id}:${sessionId}`;
    const hit = titleReads.get(key);
    const now = clock.now();
    if (hit !== undefined && (hit.live || (!force && now - hit.at < SESSION_TITLE_TTL_MS))) return hit.done;
    // The adapter is built after the window is checked, so a refresh inside it costs nothing at all.
    const read = adapterFor(entry, view.harness).adapter.sessionTitle;
    if (read === undefined) return Promise.resolve();
    const pending: { at: number; done: Promise<void>; live: boolean; failed: boolean } = { at: now, live: true, done: Promise.resolve(), failed: hit?.failed ?? false };
    // The read is started inside a promise and never on this stack: an adapter that refuses the id throws where it
    // builds its command (the codex guard does), and one row's store read may never cost the listing or the turn
    // that asked for it. Nothing here rejects, so both callers may leave it unawaited.
    pending.done = confineSetup(entry, view.harness)
      .then(() => read(sessionId, harnessExec(entry.machine, SESSION_TITLE_TIMEOUT_MS)))
      // The window opens when the store answered, before the answer is kept: a row that shows the title is a read
      // that is over, so a listing that sees one waits on nothing.
      .finally(() => {
        pending.at = clock.now();
        pending.live = false;
      })
      .then(
        async title => {
          pending.failed = false;
          if (title === null) return;
          const moved = new Set<string>();
          // A title in the harness's own store is the person's rename inside it or the one the harness itself made
          // for them, and both outrank anything we would generate; only the opening words, which codex writes there
          // at a thread's start, are the seed again, and a seed is no news to a row that already carries a name.
          let unnamed: SessionView | undefined;
          for (const s of sessions.values()) {
            if (s.view.workspaceId !== entry.record.id || s.view.claudeSessionId !== sessionId) continue;
            const source = storedTitleSource(title, s.view.prompt);
            if (source === "seed" && sourceOf(s.view) !== "seed") {
              if (s.view.harnessTitle !== undefined && s.view.harnessTitle !== title) unnamed = s.view;
              continue;
            }
            if (s.view.harnessTitle !== title) moved.add(threadKeyOf(s.view));
            s.view.harnessTitle = title;
            s.view.titleSource = source;
          }
          await ctx.persistSessions(entry.record.id);
          // A name given before codex wrote the thread's index row had nowhere to land; by a turn's end the row is
          // there, so the name the row carries is written again.
          if (force && unnamed?.harnessTitle !== undefined) void nameInHarness(unnamed, unnamed.harnessTitle);
          for (const threadId of moved) ctx.pushHead(threadId);
        },
        (e: unknown) => {
          if (!pending.failed) console.warn(noTitleLogLine(sessionId, entry.record.id, providerSaid(e)));
          pending.failed = true;
        },
      );
    titleReads.set(key, pending);
    return pending.done;
  };

  /** Where a row's title came from; a row written before provenance was recorded, and one with no title at all,
   * read as the words its opening turn seeded the thread with. */
  const sourceOf = (view: SessionView): TitleSource => view.titleSource ?? "seed";
  /** Every turn of one thread, whatever harness session each of them ran under. */
  const rowsOn = (threadId: string): SessionView[] => [...sessions.values()].filter(s => s.view.threadId === threadId).map(s => s.view);
  /** Where the thread's title came from, over all its turns: a person's name on any of them is the thread's, since
   * the fold reads the latest turn's title and a resume writes a row of its own. */
  const threadSource = (threadId: string): TitleSource => {
    let source: TitleSource = "seed";
    for (const view of rowsOn(threadId)) {
      if (sourceOf(view) === "person") return "person";
      if (sourceOf(view) === "auto") source = "auto";
    }
    return source;
  };
  /** The title a new turn of an existing thread carries in: the newest turn that has one. A resume writes a fresh
   * row, and the fold titles the thread by the latest, so a thread that is not seeded again here loses its name. */
  const carriedTitle = (threadId: string): Pick<SessionView, "harnessTitle" | "titleSource"> => {
    const titled = rowsOn(threadId)
      .filter(v => v.harnessTitle !== undefined)
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
    if (titled?.harnessTitle === undefined) return {};
    return { harnessTitle: titled.harnessTitle, titleSource: sourceOf(titled) };
  };

  /** Writes a thread's name into the harness's own store, so `claude --resume` and codex's own list say what the app
   * says. The name stands here whatever the store answers: a harness that keeps no name of a person's does nothing,
   * and a store that refused says so in the log once. */
  const nameInHarness = (view: SessionView, title: string): Promise<void> => {
    const sessionId = view.claudeSessionId;
    const entry = live.get(view.workspaceId);
    if (sessionId === undefined || entry === undefined) return Promise.resolve();
    if (workspaceState({ phase: entry.record.phase }) !== "running" || adapters[view.harness] === undefined) return Promise.resolve();
    const write = adapterFor(entry, view.harness).adapter.renameSession;
    if (write === undefined) return Promise.resolve();
    // Started inside a promise and never on this stack, as the store read is: an adapter that refuses the id throws
    // where it builds its command, and naming a thread may never cost the turn that asked for it.
    return confineSetup(entry, view.harness)
      .then(() => ctx.writeSession(sessionId, () => write(sessionId, title, harnessExec(entry.machine, SESSION_TITLE_TIMEOUT_MS))))
      .then(
        wrote => {
          if (wrote.kind === "failed") console.warn(noNameWriteLogLine(sessionId, entry.record.id, wrote.error));
        },
        (e: unknown) => console.warn(noNameWriteLogLine(sessionId, entry.record.id, e instanceof Error ? e.message : String(e))),
      );
  };

  /** The threads whose one title question has been asked, so a harness that answered nothing is not asked again at
   * the next turn's start. In memory only: a host that started again asks once more, which is not a loop. */
  const titlesAsked = new Set<string>();
  /** Asks the harness for a name for the thread whose first turn just started, from the opening turn alone, once per
   * thread and only while the thread still carries the words its opening turn seeded it with. A person's name, given
   * here or found in the harness's own store, is never replaced: it is read before the question goes out and again
   * when the answer lands, since a rename can happen while the harness is thinking. The answer is written back into
   * the harness's store, so its own UI shows the same name.
   */
  const makeTitle = async (view: SessionView): Promise<void> => {
    const threadId = view.threadId;
    const entry = live.get(view.workspaceId);
    if (threadId === undefined || entry === undefined || titlesAsked.has(threadId)) return;
    if (view.prompt === undefined || threadSource(threadId) !== "seed") return;
    if (workspaceState({ phase: entry.record.phase }) !== "running" || adapters[view.harness] === undefined) return;
    const { harness, adapter } = await launchAdapterFor(entry, view.harness);
    if (adapter.titleFor === undefined) return;
    titlesAsked.add(threadId);
    const table = harnessCatalog(harness);
    const model = smallestModel(table === undefined ? undefined : await catalogOn(table, entry, adapter));
    if (ctx.state.closing) return;
    const title = await adapter.titleFor(
      { opening: view.prompt, ...(model !== undefined ? { model } : {}) },
      harnessExec(entry.machine, TITLE_MAKE_TIMEOUT_MS),
    );
    if (title === null) {
      console.warn(noMadeTitleLogLine(threadId, entry.record.id, "the harness answered with no title"));
      return;
    }
    if (threadSource(threadId) === "person") return;
    for (const row of sessions.values()) {
      if (row.view.threadId === threadId) {
        row.view.harnessTitle = title;
        row.view.titleSource = "auto";
      }
    }
    await ctx.persistSessions(entry.record.id);
    ctx.pushHead(threadId);
    await nameInHarness(view, title);
  };

  /** Which rows a refresh asks about: the newest turn of each harness session, newest first and no more than the cap. */
  const titleRows = (rows: readonly SessionView[]): SessionView[] => {
    const newest = new Map<string, SessionView>();
    for (const view of [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
      if (view.claudeSessionId !== undefined && !newest.has(view.claudeSessionId)) newest.set(view.claudeSessionId, view);
    }
    return [...newest.values()].slice(0, SESSION_TITLE_REFRESH_MAX);
  };

  /** The computer a workspace's agents run on, as the person's setup is keyed: this computer for a copy here, the
   * computer a fork stands on, and none for a fork at a provider, whose image is the whole of its setup. */
  const setupPlace = (entry: LiveWorkspace): string | undefined => (isLocalWorkspace(entry.record) ? HERE_PLACE_ID : entry.record.place);
  /** Whether the person turned this agent off on the computer the workspace stands on. */
  const agentOff = (entry: LiveWorkspace, agent: string): boolean => {
    const place = setupPlace(entry);
    return place !== undefined && setups.off(place, agent);
  };
  const agentLabel = (agent: string): string => harnessCatalog(agent)?.label ?? agent;

  /** A config folder as the computer it names resolves it, links followed: this one off its own disk, a joined one
   * over its link, each with its home and the folders wsp keeps its own state in there. */
  const configFolderOn = async (placeId: string, path: string): Promise<ResolvedFolder> => {
    if (placeId === HERE_PLACE_ID) {
      const home = await realFolderHere(local?.homeDir ?? homedir());
      const kept = [await realFolderHere(join(home, ".wsp")), ...(opts.statePath !== undefined ? [await realFolderHere(dirname(resolvePathOn(opts.statePath)))] : [])];
      return { folder: await realFolderHere(path), home, kept };
    }
    const door = ctx.placeDoorOf();
    const read = await door.exec(placeId, realFolderScript(path), { timeoutMs: INLINE_EXEC_MS });
    if (read.exitCode === 3) throw Object.assign(new Error(read.stderr.trim()), { kind: "usage" });
    const [folder, home] = read.stdout.trim().split("\n");
    if (read.exitCode !== 0 || folder === undefined || home === undefined || !home.startsWith("/")) throw Object.assign(new Error(`${door.nameOf(placeId)} did not say where ${path} is: ${read.stderr.trim() || `exit ${read.exitCode}`}`), { kind: "invalid" });
    return { folder: posix.normalize(folder), home, kept: [join(home, ".wsp")] };
  };

  /** The latest word on each agent's kept config folder by computer and agent, where it was refused: what a thread
   * row of that agent there says, read off the last check rather than a new one. */
  const setupRefusals = new Map<string, string>();
  const keptFolder = (entry: LiveWorkspace, harness: string): { place: string; folder: string } | undefined => {
    const place = setupPlace(entry);
    const folder = place === undefined ? undefined : setups.get(place, harness)?.configDir;
    return place === undefined || folder === undefined ? undefined : { place, folder };
  };
  /** The one check on an agent's kept config folder, read again on the computer the workspace stands on before wsp
   * starts the agent or reads or writes under that folder: why it now leads out of that computer's home, onto it, or
   * into wsp's own, or null where it stands. Nothing falls back to the agent's own default folder. */
  const setupRefusal = async (entry: LiveWorkspace, named?: string): Promise<string | null> => {
    const harness = named ?? DEFAULT_AGENT.id;
    const kept = keptFolder(entry, harness);
    return kept === undefined ? null : keptRefusal(kept.place, harness, kept.folder);
  };
  const keptRefusal = async (place: string, harness: string, folder: string): Promise<string | null> => {
    const why = configDirRefusal(agentLabel(harness), folder, await configFolderOn(place, folder));
    const refused = why === null ? null : configDirLaunchRefusal(agentLabel(harness), harness, folder, why);
    const was = setupRefusals.get(keyOf(place, harness));
    if (refused === null) setupRefusals.delete(keyOf(place, harness));
    else setupRefusals.set(keyOf(place, harness), refused);
    if ((refused ?? undefined) !== was) ctx.setupRefusalMoved(place, harness);
    return refused;
  };
  const homesHere = async (): Promise<Record<string, string>> => {
    await ctx.ready();
    const homes: Record<string, string> = {};
    for (const { id } of CATALOG_AGENTS) {
      const kept = setups.get(HERE_PLACE_ID, id)?.configDir;
      const refused = kept === undefined ? null : await keptRefusal(HERE_PLACE_ID, id, kept);
      if (refused !== null) throw Object.assign(new Error(refused), { kind: "usage" });
      homes[id] = kept ?? local?.home(id) ?? agentHomes(homedir())[id]!;
    }
    return homes;
  };
  /** Each agent's folder a launch here reads where it is not the agent's own under that launch's home: the store a read
   * and a write on this computer point the agent at, since naming its own folder as a store would move files it keeps
   * beside it (Claude Code's .claude.json sits in the home). */
  const storesHere = async (): Promise<Record<string, string>> => {
    const homes = await homesHere();
    const home = local?.homeDir ?? homedir();
    return Object.fromEntries(CATALOG_AGENTS.flatMap(a => (homes[a.id] === undefined || homes[a.id] === join(home, a.stateHome) ? [] : [[a.id, homes[a.id]!]])));
  };
  /** Settles at once where no config folder is kept, so a road with nothing to check waits on nothing more than before. */
  const confineSetup = (entry: LiveWorkspace, named?: string): Promise<void> =>
    keptFolder(entry, named ?? DEFAULT_AGENT.id) === undefined
      ? Promise.resolve()
      : setupRefusal(entry, named).then(refused => {
          if (refused !== null) throw Object.assign(new Error(refused), { kind: "usage" });
        });
  /** adapterFor for a road that starts the agent's process or runs under its setup, its config folder checked first. */
  const launchAdapterFor = async (...a: Parameters<typeof adapterFor>): Promise<ReturnType<typeof adapterFor>> => {
    await confineSetup(a[0], a[1]);
    return adapterFor(...a);
  };

  /** The agent a new thread runs when its start names none: the project's, then the person's default, then the
   * catalog's first, each only where it runs on that workspace's computer. The marks, the start and the drafter all
   * read this one answer. */
  const defaultAgentOf = (prefs: Preferences, entry: LiveWorkspace | undefined): string => {
    const runs = (id: string): boolean => adapters[id] !== undefined && (entry === undefined || !agentOff(entry, id));
    const project = entry === undefined ? undefined : prefs.projectDefaults[entry.record.project];
    return resolveThreadDefaults({ firstAgent: CATALOG_AGENTS.find(a => runs(a.id))?.id ?? DEFAULT_AGENT.id, catalogOf: harnessCatalog, runs, prefs, ...(project !== undefined ? { project } : {}) }).agent.value;
  };

  /** One agent's lists with the person's own models in and the marks moved onto what a new thread on that project
   * starts on, so the composer shows it and startPicks fills it in, with what an open list cannot mark beside them.
   * Never cached: a start and a list share one probe. */
  const defaultsOn = (catalog: HarnessCatalog, prefs: Preferences, project: ProjectOverrides | undefined): { catalog: HarnessCatalog; open: { model?: string; effort?: string } } => {
    const lists = withCustomModels(catalog, prefs.agentDefaults[catalog.harness]?.models);
    const defaults = resolveThreadDefaults({ firstAgent: catalog.harness, named: catalog.harness, catalogOf: () => lists, prefs, ...(project !== undefined ? { project } : {}) });
    return { catalog: markedFor(lists, defaults), open: openDefaults(lists, defaults) };
  };

  /** The harness's own mode for wsp's word a start named, or the refusal naming the words it takes. */
  const namedMode = (catalog: HarnessCatalog | undefined, harness: string, word: AccessChoice): string => {
    const mode = catalog === undefined ? undefined : accessMode(catalog, word);
    if (mode !== undefined) return mode;
    throw Object.assign(new Error(accessRefusal(catalog ?? { label: agentLabel(harness), permissionModes: [] }, word)!), { kind: "usage" });
  };

  /**
   * The turn's images on the road its adapter declared, filesBlocked having already turned away what cannot go. An
   * inline adapter is handed the bytes and nothing lands anywhere, so there is no folder to answer with. A file
   * adapter is handed paths inside this send's own folder (turnImagesDir), readied and written as the thread's files
   * are: two sends on one thread would otherwise write the same paths and the first turn would be handed the
   * second's picture, since the landing happens before either turn is registered. The caller removes the folder when
   * the turn it was sent for ends.
   */
  const landImages = async (
    entry: LiveWorkspace,
    road: AttachmentRoad | undefined,
    folder: string,
    dir: string,
    images: readonly Attachment[],
  ): Promise<{ images: TurnImage[]; dir?: string }> => {
    if (images.length === 0 || road === undefined) return { images: [] };
    if (road === "inline") return { images: images.map(({ mediaType, bytes }) => ({ mediaType, bytes })) };
    const ready = await entry.machine.exec(landFilesLine(folder, dir), { timeoutMs: INLINE_EXEC_MS });
    if (ready.exitCode !== 0) throw new Error(filesNotLandedLine(folder));
    const landed = images.map((image, index) => ({ ...image, path: imagePathIn(dir, index, image.mediaType) }));
    for (const image of landed) await landBytes(entry.machine, image.path, Buffer.from(image.bytes, "base64"));
    return { images: landed.map(({ mediaType, bytes, path }) => ({ mediaType, bytes, path })), dir };
  };

  /**
   * The turn's files that are not images, landed in the folder the thread works in, where its agent reads them at
   * any access and the person's copy holds them: one command readies this send's own folder, then each file goes by
   * the machine's byte road. Answers the paths, which the agent's prompt names. They stay once the turn ends, since
   * a later turn of the thread may read them again, and go when the thread is forgotten or its workspace deleted.
   */
  const landFiles = async (entry: LiveWorkspace, folder: string, dir: string, files: readonly Attachment[]): Promise<string[]> => {
    if (files.length === 0) return [];
    const ready = await entry.machine.exec(landFilesLine(folder, dir), { timeoutMs: INLINE_EXEC_MS });
    if (ready.exitCode !== 0) throw new Error(filesNotLandedLine(folder));
    const taken = new Set<string>();
    const paths: string[] = [];
    for (const file of files) {
      const path = filePathIn(dir, file.name, taken);
      await landBytes(entry.machine, path, Buffer.from(file.bytes, "base64"));
      paths.push(path);
    }
    return paths;
  };

  /** Takes these threads' attached files off the folders their turns ran in, which are the person's own copy: nothing
   * reads them once the thread is gone. One command per folder, and a machine that is not running, or does not
   * answer, keeps them. */
  const dropThreadFiles = async (entry: LiveWorkspace, threadIds: Iterable<string>): Promise<void> => {
    if (entry.record.phase !== "running") return;
    const byFolder = new Map<string, string[]>();
    for (const threadId of threadIds) {
      for (const folder of threadRecords.get(threadId)?.filesIn ?? []) byFolder.set(folder, [...(byFolder.get(folder) ?? []), threadId]);
    }
    for (const [folder, threads] of byFolder) {
      await entry.machine.exec(dropFilesLine(folder, threads), { timeoutMs: INLINE_EXEC_MS }).catch((e: unknown) => {
        console.warn(`attached files of ${threads.join(", ")} not removed from ${folder}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  };

  /** Takes one send's images off the machine once the turn they were sent for is over, whatever it came to: the
   * harness read them at its start and nothing reads them again, so a thread that sends a screenshot and then runs
   * twenty text turns is not still holding it. A machine that is gone or asleep keeps the folder, and the thread's
   * own dir goes with the thread. */
  const dropImages = (entry: LiveWorkspace, dir: string): void => {
    void entry.machine.exec(`rm -rf ${shellQuote(dir)}`, { timeoutMs: INLINE_EXEC_MS }).catch((e: unknown) => {
      console.warn(`images for a finished turn not removed from ${entry.record.id}: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  /** Where one agent keeps its store on this workspace: the config folder the person set for it on that computer,
   * else the kind's own. */
  const agentHome = (entry: LiveWorkspace, id: string): string => {
    const place = setupPlace(entry);
    return (place === undefined ? undefined : setups.get(place, id)?.configDir) ?? ctx.moduleOf(entry.record.kind).home(entry, id);
  };
  /** The environment a thread's processes start under where it runs, before what one turn adds: a turn of `harness`,
   * or with none a process that is no agent's, the terminal opened in a thread on a computer the person joined. One
   * reading for both, so a login one of them reads is the login the other reads. The variables the person set for an
   * agent on that computer go on top: a turn's own agent's, and every agent's for a terminal, where any may be run. */
  const threadEnv = (entry: LiveWorkspace, harness?: string): Readonly<Record<string, string>> => {
    const place = setupPlace(entry);
    const set = place === undefined ? [] : (harness === undefined ? CATALOG_AGENTS.map(a => a.id) : [harness]).map(id => setups.launchOf(place, id).env);
    return Object.assign({ ...ctx.moduleOf(entry.record.kind).env(entry, harness, id => agentHome(entry, id)) }, ...set) as Record<string, string>;
  };

  /** The folder each agent's store variable names for a thread on a computer you joined, by agent id, read as
   * threadEnv reads it for a thread there: what the person set for that variable, else the config folder they kept,
   * else the kind's own. What an act on that computer's page and its recipe's servers write where its threads' agents
   * read. */
  const placeStores = (place: string, home: string): Readonly<Record<string, string>> =>
    Object.fromEntries(
      CATALOG_AGENTS.flatMap(a => {
        const variable = a.stateHomeEnv;
        return variable === undefined ? [] : [[a.id, setups.launchOf(place, a.id).env[variable] ?? setups.get(place, a.id)?.configDir ?? ctx.placeAgentHome(place, home, a.id)]];
      }),
    );

  /** The vault's values for the agent's own MCP servers, for one launch in `folder` on a kind that hands them in the
   * launch: its config there read as the turn's login, and each server that reads a value the vault holds filled for
   * that agent's CLI. Nothing on any other kind, for an agent whose CLI takes no servers at launch, or where the
   * vault holds no server's value. */
  const serverValuesFor = async (entry: LiveWorkspace, harness: string, folder: string): Promise<HarnessStartOptions["serverValues"]> => {
    const road = LAUNCH_SERVER_ROADS[harness];
    const mcp = MCP_AGENTS.find(a => a.id === harness);
    const values = serverValuesOf(opts.vault?.() ?? {});
    if (road === undefined || mcp === undefined || ctx.moduleOf(entry.record.kind).serverValues !== "launch" || Object.keys(values).length === 0) return undefined;
    const env = threadEnv(entry, harness);
    const home = env["HOME"] ?? "~";
    const store = CATALOG_AGENTS.find(a => a.id === harness)?.stateHomeEnv;
    const said = await entry.machine.exec(`git ${checkoutArgs(folder).map(shellQuote).join(" ")} 2>/dev/null`, { timeoutMs: INLINE_EXEC_MS }).catch(() => undefined);
    const checkout = checkoutOf(said?.exitCode === 0 ? said.stdout : undefined, folder);
    const files = turnServerFiles(mcp, folder, home, store === undefined ? undefined : env[store], checkout.top);
    const scopes = [{ files: files.user }, ...files.projects.map(f => ({ files: [f] }))];
    const res = await entry.machine.exec(readConfigsCmd(scopes), { timeoutMs: INLINE_EXEC_MS });
    const agent = CATALOG_AGENTS.find(a => a.id === harness)?.name ?? harness;
    if (res.exitCode === 0 && !readWhole(res.stdout)) throw new Error(serverValuesCutLine(agent, scopes.flatMap(scope => scope.files)));
    const read = res.exitCode === 0 ? parseConfigs(res.stdout, scopes) : undefined;
    if (read === undefined) throw new Error(serverValuesUnreadLine(agent, readReason(res, INLINE_EXEC_MS / 1000)));
    const [user, ...projects] = read;
    const filled = await road.fill({ ...(user !== undefined ? { user } : {}), projects: projects.filter(f => f !== undefined), folder, key: checkout.key }, values);
    return Object.values(filled).every(v => Object.keys(v ?? {}).length === 0) ? undefined : filled;
  };

  /** The adapter for a harness on this workspace's current machine; unnamed means the runtime's default. `turnEnv` is
   * what only a turn's own launch carries, laid over the machine's login environment: every kind answers with that
   * environment through its one module, so a variable put on here reaches a launch on every kind of machine and is
   * written nowhere else. `waiting` is the turn's own reading of whether it is waiting on something outside its own
   * process, a person's answer to a prompt or a command it started in the background, which its stream's idle clock
   * reads; absent on every road that is not a turn. It is handed beside the limits and never as one; the wall the
   * factory gets is the turn limit of the place the workspace stands on, read at each launch, where the door has one. `servers` is the values the MCP servers'
   * definitions read by name, which only a turn's agent starts servers with: they ride its environment only on a kind
   * whose machines name each by a variable and get it no other way. `thread` is the thread a turn's launch is for,
   * which a kind that groups a thread's processes groups it under. `asksUntilStopped` is set on a line's try, whose
   * launch asks after a run it may have started until the line's hour stops it. */
  const adapterFor = (entry: LiveWorkspace, named?: string, turnEnv?: Readonly<Record<string, string>>, waiting?: TurnWaiting, servers: Readonly<Record<string, string>> = {}, thread?: string, asksUntilStopped?: true): { harness: string; adapter: HarnessAdapter } => {
    const harness = named ?? DEFAULT_AGENT.id;
    const factory = adapters[harness];
    if (!factory) throw new Error(noAdapterLine(harness, Object.keys(adapters)));
    const kind = ctx.moduleOf(entry.record.kind);
    const vault = ctx.vaultOn(entry);
    const place = setupPlace(entry);
    const setup = place === undefined ? undefined : setups.launchOf(place, harness);
    const carried = kind.serverValues === "environment" ? servers : {};
    const ofTurn = thread !== undefined && kind.endThread !== undefined ? { thread, ...(asksUntilStopped !== undefined ? { asksUntilStopped } : {}) } : asksUntilStopped !== undefined ? { asksUntilStopped } : undefined;
    return {
      harness,
      adapter: factory({
        machine: entry.machine,
        workspaceId: entry.record.id,
        execStream: ctx.execFactoryFor(entry, ofTurn === undefined ? ctx.turnLimitOf(entry.record) : { ...ctx.turnLimitOf(entry.record), ...ofTurn }, waiting),
        home: id => agentHome(entry, id),
        // The person's variables over the computer's own and under the turn's, which only wsp sets.
        env: { ...carried, ...threadEnv(entry, harness), ...turnEnv },
        ...(setup?.launch !== undefined ? { launch: setup.launch } : {}),
        ...((): { projectKey?: string } => {
          const key = kind.memoryKey(entry, harness);
          return key !== undefined ? { projectKey: key } : {};
        })(),
        signInRefusal: signInRefusalLine({ kind: entry.record.kind }),
        vault,
        loginStands: id => kind.loginStands(entry, id),
      }),
    };
  };
  return {
    catalogOn, firstRunHere, refreshTitle, sourceOf, rowsOn, carriedTitle, nameInHarness, makeTitle, agentAsks, holdAsk, titleRows, setupPlace, agentOff,
    agentLabel, configFolderOn, setupRefusals, setupRefusal, homesHere, storesHere, confineSetup, launchAdapterFor, defaultAgentOf,
    defaultsOn, namedMode, landImages, landFiles, dropThreadFiles, dropImages, threadEnv, placeStores, serverValuesFor, adapterFor,
  };
}
