// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { collect, expand, fileUsageCache, nodeHost, readLogUsage, seedMenu, type Manifest, type Rung } from "@wsp/collect";
import { HARNESS_ADAPTERS, createRuntime, hostIdentity, localExecStream, type GoldenRecipe, type GoldenVersion, type HarnessAdapterFactory, type LocalWiring, type Machine, type PlaceWiring, type Runtime, type SeedWiring, type Store } from "@wsp/runtime";
import { CATALOG_AGENTS, GOLDEN_SETUP, GOLDEN_SMOKE } from "@wsp/catalog";
import { PRICES_URL, PERSON_HOME_ENV, type SealedImage } from "@wsp/protocol";
import { agentHome, type Copier, LocalBackend, providerSlot, type ProviderSlot, verbCopier } from "@wsp/engine";
import { noMachinesLine, PROVIDER_MODULES, providerBackendFor, providerPlaces, wiredPlaceRow, wiredProviderId, type ProviderEnv, type ProviderModule } from "../providers.js";
import { daemonBinaryHere } from "../assets.js";
import { DAEMON_DEPLOYED_LINE, cappedLine, claudeEnvs, deployDaemon } from "../doctor.js";
import { daemonFixLine } from "../daemon-fix.js";
import { envFileFor, serverVault, type Keys } from "../env-keys.js";
import { loginEnv } from "../login-path.js";
import { CACHE_RULE } from "../project-bundle.js";
import { packSeed } from "../project-seed.js";
import { readBrewTable } from "../init-brew.js";
import { copyGoldenRecipe } from "../image-recipe.js";
import { hostInboxDir, hostReadingsDir, hostRootsPath, hostRunDir } from "../host-lock.js";
import type { LocalDaemon, LocalDaemonOptions } from "../local-daemon.js";
import { startOnce } from "../start-once.js";
import { homeNamed } from "../serving-home.js";
import type { HereAt } from "../pairing.js";
import { placeWiring } from "../places.js";
import { agentsReader } from "../agents-reader.js";
import { skillsActs } from "../skills-acts.js";
import { serverIcons } from "../server-icons.js";
import { agentLatest } from "../agent-latest.js";
import { keptTools, recipeShelf } from "../recipes.js";
import { recipeWatch, type WatchFn } from "../recipe-watch.js";
import { serversActs } from "../servers-acts.js";
import { hostActs } from "../agents-signin.js";
import { writeThreadWsp } from "../shim.js";
import { mcpServerSpec, runningWsp, wspCommand, type RunningWsp } from "../mcp-install.js";
import { hostPlatform } from "../verbs.js";
import { VERSION } from "../version.js";
import { vaultNow } from "./keys.js";
import { stateStore } from "./state.js";

/** What every golden wsp init seals is made of: the harness install and its smoke from the doctor, the daemon
 * bundle deploy, and the guest's own variables. No sign-in is among them. */
export function goldenRecipe(hooks: { deployDaemon?: (machine: Machine) => Promise<void | string> } = {}): GoldenRecipe {
  return {
    setup: GOLDEN_SETUP,
    smoke: GOLDEN_SMOKE,
    envs: claudeEnvs(),
    deployDaemon: hooks.deployDaemon ?? (async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE)),
  };
}

/** The folder every turn and every exec on this computer starts in, made when it is first used. Not the person's
 * home: a turn that starts there is one `cd` from the checkouts they work in themselves, and the first build thread
 * run on a local workspace committed inside the person's own repo from there (measured 2026-09-08). Their own
 * folders stay reachable, as they are to any shell they open, but nothing starts a turn in one. */
export const localWorkFolder = (home: string): string => join(home, "wsp-work");

/** How this host starts the daemon for its local workspace. Behind a parameter so a test can hand one that refuses
 * to start; the default loads the daemon module on the first dial, so a host nobody opens a pane on loads none of it. */
export type LocalDaemonStart = (opts: LocalDaemonOptions) => Promise<LocalDaemon>;

/** This computer as a workspace: the local backend, a real child process per turn under the turn's limits, each
 * harness's own store (the one their store variable names, else the default under the person's home), and the
 * person's own login environment for every turn, the same one wsp exec runs under, so the keys and tools a terminal
 * gives an agent reach it here too. The adapters strip their own agent-session variables from it, as they do on a
 * fork. The person's home and the folder work starts in are two facts: the stores are theirs, so a sign-in they
 * made is the one a turn uses, and the work folder is the workspace's own. */
/** The copy road this command has: the daemon binary staged beside it. A build or an install that left the daemon
 * asset out leaves this host with one workspace per project and the sentence that says so, rather than failing to
 * start. */
function copierHere(): Copier | undefined {
  try {
    return verbCopier(daemonBinaryHere());
  } catch {
    return undefined;
  }
}

export function localWiring(
  home = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
  startDaemon: LocalDaemonStart = opts => import("../local-daemon.js").then(m => m.LocalDaemon.start(opts)),
  /** The state file the host this wiring belongs to serves. Every file it writes for itself sits in that file's
   * own folder, the runs, the roots file and the inbox alike, so a host on a home somebody named writes nothing
   * under the home a bare line picks. */
  statePath: string,
  copier: Copier | undefined = copierHere(),
  /** Where the daemon's own stderr goes as it starts. A serving host's stderr is its log, which is where those
   * lines belong; a line at a terminal asked a question of its own and hands a sink that keeps none. */
  say: (line: string) => void = line => void process.stderr.write(`${line}\n`),
  /** The folder holding this host's own wsp, first on the PATH of everything this wiring starts; absent on a line
   * that serves no turn. */
  threadBin?: string,
): LocalWiring {
  const root = localWorkFolder(home);
  const runDir = hostRunDir(statePath);
  const rootsPath = hostRootsPath(statePath);
  /** Every run this wiring is reading, as the call that lets go of each. A poll on a turn left running holds the
   * process after its last line, and a turn is not this wiring's to end: closing lets go and leaves them running. */
  const reading = new Set<() => void>();
  // The person whose sign-ins a turn here reads. Their login home, except under a harness serving a fixture out of
  // a home of its own: that home holds this host's files, and a turn started under it finds no sign-in at all.
  const person = homeNamed(env[PERSON_HOME_ENV]) ?? home;
  let shutting = false;
  const backend = new LocalBackend({ root, env });
  // Started on the first dial and kept: a host nobody opens a pane on starts no process, binds no port on this
  // computer and writes none of the daemon's own files under the person's home.
  let running: number | undefined;
  const daemon = startOnce(
    async () => {
      running = undefined;
      const started = await startDaemon({ root: home, workFolder: backend.workFolder(), rootsPath, inboxDir: hostInboxDir(statePath), readingsDir: hostReadingsDir(statePath), say });
      running = started.version;
      return started;
    },
    why => {
      const last = why.split("\n").map(l => l.trim()).filter(l => l !== "").at(-1) ?? why;
      return cappedLine(`the daemon for this computer's workspace did not start, so its terminal, files and processes have nothing to dial: ${last}`);
    },
  );
  return {
    backend,
    execStream: (o, waiting) => localExecStream({ root: backend.workFolder(), runDir, reading, ...o }, waiting),
    home: id => agentHome(person, id, env),
    homeDir: home,
    rootsPath,
    ...(copier !== undefined ? { copier } : {}),
    // The binary the copy road runs, read off the daemon this host starts for its own workspace: a host rebuilt
    // without its binary runs beside an older one, which knows none of this wsp's verbs.
    hereDaemon: { version: async () => (await daemon.get()).version, held: () => (daemon.held() === undefined ? undefined : running), fix: daemonFixLine(runningWsp()) },
    platform: hostPlatform(),
    env: () => ({
      ...Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)),
      HOME: person,
      ...(threadBin !== undefined ? { PATH: env["PATH"] === undefined || env["PATH"] === "" ? threadBin : `${threadBin}${delimiter}${env["PATH"]}` } : {}),
    }),
    sysSamples: async fn => (await daemon.get()).sysSamples(fn),
    daemonRoad: async () => {
      // The panes stay on the person's home: the files and terminal tabs are theirs to look around in, where a
      // turn's own folder is the workspace's.
      const started = await daemon.get();
      // A dial that lands while the host is closing must leave no socket behind: a listening one keeps this process up.
      if (shutting) {
        await started.close().catch(() => {});
        throw new Error("this host is closing; its local workspace has no daemon to dial");
      }
      return started.road;
    },
    // The daemon is a child of this process, so nothing but this host can put one back. The one it is holding is
    // let go of and closed first, whether it died or is merely wedged, so the next dial cannot be answered with
    // the port of a daemon that is gone.
    restartDaemon: async () => {
      const held = daemon.held();
      daemon.forget();
      await held?.then(d => d.close(), () => {});
      await daemon.get();
    },
    close: async () => {
      shutting = true;
      // The turns running here are not ended: each leads a process group of its own and reads its own log off this
      // computer, so the host that comes next re-opens them and their replies still land. What this host holds open
      // is the reading of those runs and the daemon, and that is what closing it frees.
      for (const stop of [...reading]) stop();
      reading.clear();
      const started = daemon.held();
      daemon.forget();
      await started?.then(d => d.close(), () => {});
    },
  };
}

/** The provider slot each runtime made here was wired with, so a host can swap the module in when a key is saved. */
const PROVIDER_SLOTS = new WeakMap<Runtime, ProviderSlot>();
/** The managers' listing each runtime's recipes resolve against, which the watcher reads again once a day. */
const RECIPE_TOOLS = new WeakMap<Runtime, ReturnType<typeof keptTools>>();

/** How long after an edit here the computers that follow its recipe sync: a save in an editor is often several. */
const WATCH_SYNC_MS = 5_000;

/** The watcher over what followed recipes hold on this computer, on a host that keeps recipes and places: an edit
 * reaches every computer that follows a recipe holding it, and a recipe saved or followed moves what is watched. */
export function hostRecipeWatch(rt: Pick<Runtime, "places" | "recipes" | "events">, watch?: WatchFn): { close(): void } | undefined {
  const places = rt.places;
  const recipes = rt.recipes;
  if (places === undefined || recipes === undefined) return undefined;
  const watcher = recipeWatch({
    home: homedir(),
    followed: async () => {
      const by = await places.followers();
      return (await recipes.list()).filter(r => by.has(r.slug));
    },
    changed: slugs => {
      for (const slug of slugs) void places.recipeChanged(slug, WATCH_SYNC_MS).catch(() => undefined);
    },
    versions: async () => RECIPE_TOOLS.get(rt as Runtime)?.refresh(),
    ...(watch !== undefined ? { watch } : {}),
  });
  const moved = (): void => void watcher.refresh().catch(() => undefined);
  moved();
  // A follow, a recipe saved or taken away moves what is watched; a sync's own frames may too.
  const offs = [rt.events.on("recipes.changed", moved), rt.events.on("place.sync", moved)];
  return {
    close: () => {
      for (const off of offs) off();
      watcher.close();
    },
  };
}
/** The provider pick each runtime made here stands on: the module it forks on now, which names the place its copies
 * are filed under, and the environment that module was picked out of, which is also where the other places this
 * host can build at are read from. A swap moves both, so the backend, the place and the table never say different
 * things. */
const PROVIDER_PICKS = new WeakMap<Runtime, ProviderPick>();
interface ProviderPick {
  id: string;
  env: ProviderEnv;
  /** The provider table the runtime was made on, which a saved key is picked out of too. */
  modules: readonly ProviderModule[];
}
export const providerSlotOf = (rt: Runtime): ProviderSlot | undefined => PROVIDER_SLOTS.get(rt);

/** Wires the provider module the keys now on this computer name into a runtime made here, picking out of the same
 * environment that runtime was built from; a runtime made elsewhere has no slot, and a saved key it would do
 * nothing with is refused rather than taken. The saved record stands in front of that environment on purpose: this
 * is the road the app's keys step takes, where the key just written is the answer and the shell the host started in
 * is the older one. Every other road reads the layers, where the environment wins. */
export function swapProvider(rt: Runtime, keys: Readonly<Record<string, string | undefined>>): void {
  const slot = providerSlotOf(rt);
  if (slot === undefined) throw new Error("this runtime has no provider slot; a key saved now would reach no machine road until the host restarts");
  // One environment for all three: the module this host forks on, the place its copies are filed under and the
  // other places it can build at are the same pick, so they cannot drift apart when a key is saved.
  const pick = PROVIDER_PICKS.get(rt);
  const env = { ...(pick?.env ?? process.env), ...keys };
  const modules = pick?.modules ?? PROVIDER_MODULES;
  slot.swap(providerBackendFor(env, modules));
  if (pick !== undefined) {
    pick.id = wiredProviderId(env, modules);
    pick.env = env;
  }
}

/** This computer's wiring for a runtime that builds its own: a host that turns can reach writes its own wsp beside
 * the state file and puts it first on their PATH, the same command their wsp tools run. */
export function servingWiring(
  statePath: string,
  agents: { run?: RunningWsp; here?: HereAt } | undefined,
  home: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalWiring {
  const threadBin = agents?.here === undefined ? undefined : writeThreadWsp(statePath, wspCommand(agents.run ?? runningWsp()));
  return localWiring(home, env, undefined, statePath, undefined, undefined, threadBin);
}

export function makeRuntime(
  keys: Keys,
  statePath: string,
  recipe: GoldenRecipe = goldenRecipe(),
  env: ProviderEnv = process.env,
  agents?: { advertise?: string; run?: RunningWsp; here?: HereAt },
  /** This computer as a workspace, where the caller built the wiring itself and holds a reader off it: the doctor
   * reads the daemon beside this host through the same wiring the copy road runs it from. */
  local: LocalWiring = servingWiring(statePath, agents),
  /** The links this host holds to the computers a person joined, and the one planner the recipe on this computer
   * is read through. Built here for a caller that needs none of it back; handed in by one that reads the recipe
   * off the same planner, so the doctor and the recipe job cannot read this computer two ways. */
  links: PlaceWiring = placeWiring(statePath, agents?.advertise),
  /** The store over the state file, handed in by a caller that has already read it once: a state this build cannot
   * read is refused at every collection read, and a caller that met that refusal has said so already. */
  store: Store = stateStore(statePath, env),
  /** The agents a turn runs; a test hands in stand-ins so no real agent starts. */
  adapters: Record<string, HarnessAdapterFactory> = HARNESS_ADAPTERS,
  /** The providers this host answers for, its own process's by default; a test hands in the table it means. */
  modules: readonly ProviderModule[] = PROVIDER_MODULES,
): Runtime {
  const slot = providerSlot(providerBackendFor(env, modules));
  // The place this host's copies are filed under is the provider module it forks on, read at each call: a host that
  // starts with no key swaps its module in when one is saved, and its copies belong to the module that made them.
  const pick: ProviderPick = { id: wiredProviderId(env, modules), env, modules };
  const tools = keptTools();
  const rt = createRuntime({
    noMachinesLine: noMachinesLine(modules),
    places: providerPlaces(
      () => pick.id,
      slot.backend,
      () => pick.env,
      modules,
    ),
    backend: slot.backend,
    // What a turn on this computer needs to reach back in: the loopback this host fills once it binds, and the same
    // wsp command an agent's config on this computer is given. A fork's turn needs neither, its wsp rides its daemon.
    agents: {
      ...(agents?.here !== undefined ? { here: agents.here } : {}),
      wspMcp: mcpServerSpec(statePath, agents?.run ?? runningWsp()),
    },
    local,
    // The provider row off the same pick the slot and the table stand on, so a key saved while this host serves
    // makes its provider a place on every screen at once.
    placeLinks: { ...links, provider: () => wiredPlaceRow(pick.env, slot.current(), modules) },
    // The build this host is, written into the state file at every save, so a host that meets a record it cannot
    // read says which wsp on this computer wrote it.
    store,
    statePath,
    adapters,
    // Read at every launch, never copied: a token minted after this host started is in the next turn, and nothing
    // of it is written to a machine.
    vault: () => vaultNow(statePath),
    // The recipes beside the state, resolved against this computer with the managers' listing read once a day.
    recipes: recipeShelf({ statePath, home: homedir(), tools: tools.tools }),
    // LiteLLM's price table off GitHub, once a day, nothing sent: the one read the usage ledger makes of the network.
    pricesFetch: async () => {
      const res = await fetch(PRICES_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      return (await res.json()) as unknown;
    },
    // What this computer's agents used outside wsp, off their own logs here, counts and a model name alone, read at
    // most once a minute; the cache beside the state file keeps each read to the files that changed.
    logUsage: () => readLogUsage(nodeHost(), CATALOG_AGENTS, { cache: fileUsageCache(join(dirname(statePath), "usage-cache.json")) }),
    // The same vault stands behind the sign-in word of an agent whose own login is not on the computer read.
    // Each agent's newest version is asked of its vendor from this host, never from a machine, and kept a day.
    agentsReader: agentsReader({ vault: () => vaultNow(statePath), loginEnv, latest: agentLatest({ statePath, running: VERSION }).read }),
    // A key pasted in the app lands in the same vault, and the wsp tools an agent's config gets are the entry an
    // install writes: this same wsp against this state file.
    agentsActs: hostActs({ vaultFile: envFileFor(statePath), home: homedir, wspServer: () => mcpServerSpec(statePath, agents?.run ?? runningWsp()) }),
    // skills.sh is asked from this host and never from the page; a skill lands as the login of the computer it is for.
    skillsActs: skillsActs(),
    // A server lands in the agent's own config as the login of the computer it is for: its values in that file on
    // this computer, and on any other the file names a variable for each and the value goes to the vault.
    serversActs: serversActs({ vault: serverVault(statePath) }),
    // A remote server's icon is asked of Google from this host, never from the page or a machine, and kept beside the
    // state file.
    serverIcons: serverIcons({ dir: join(dirname(statePath), "icons") }),
    // How a folder on this computer is read and packed to seed a project elsewhere: the collector's own menu over
    // this computer, and the host's pack of whichever rows the person ticked.
    seed: hostSeed(),
    goldenRecipe: recipe,
    copyRecipe: hostCopyRecipe(statePath),
    hostId: hostIdentity(),
    vaultCaches: CACHE_RULE,
  });
  PROVIDER_SLOTS.set(rt, slot);
  PROVIDER_PICKS.set(rt, pick);
  RECIPE_TOOLS.set(rt, tools);
  return rt;
}

/** The seed half of an add on this computer: the menu off git's own listing of what a folder ignores, and the
 * archive of the rows the person ticked. Both read the person's folder and Claude Code's store in the folder the
 * runtime hands them, which is the one a launch here reads. */
export function hostSeed(): SeedWiring {
  return {
    plan: (folder, homes) => seedMenu(nodeHost(), folder, { claudeStateHome: homes["claude"]! }),
    pack: ({ homes, ...o }) => packSeed({ ...o, claudeStateHome: homes["claude"]! }),
  };
}

/** How a copy of the image is planned on this computer for a serving host: the same readers wsp init builds from,
 * the keys as they stand at the ask rather than at the start, and the daemon deploy every build made here gets. */
function hostCopyRecipe(statePath: string): (image: SealedImage) => Promise<GoldenRecipe> {
  return image =>
    copyGoldenRecipe(image, {
      collect: () => collectThisComputer(() => {}),
      brew: () => readBrewTable(nodeHost()),
      home: homedir(),
      platform: hostPlatform(),
      vault: serverVault(statePath),
      deployDaemon: async machine => deployDaemon(machine).then(() => DAEMON_DEPLOYED_LINE),
    });
}

/** The collector's ladder over this laptop; onRung lets the terminal count rows as each rung lands. */
export function collectThisComputer(onRung: (rung: Rung, rows: number) => void): Promise<Manifest> {
  return collect(nodeHost(), { onRung });
}

/** A folder a `~/`-relative answer or a flag named: where it is, and whether there is one there. The one place both
 * the flag and the wizard's own question resolve a folder. */
export function projectFolder(folder: string): { path: string; exists: boolean } {
  const path = resolve(expand({ home: homedir() }, folder.trim()));
  return { path, exists: existsSync(path) };
}

/** The envs a new workspace forks with: Claude Code's config dir and the browser shim of the golden it forks from.
 * No sign-in among them; the vault sets the token and the key on each turn instead. */
export const workspaceEnvsFor = (): { workspaceEnvs: (golden: GoldenVersion) => Record<string, string> } => ({ workspaceEnvs: golden => claudeEnvs(golden) });
