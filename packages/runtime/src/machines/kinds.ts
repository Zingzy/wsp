// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePathOn } from "node:path";
import { CATALOG_AGENTS, GUEST_HOME, guestEnv, sharedOn } from "@wsp/catalog";
import { INLINE_EXEC_MS, installScript, INSTALL_MS, guestAgentHomes, projectInstalls, type Lifecycle, type MachineBackend, GUEST_TMP, LOCAL_MACHINE_ID, projectStateKey } from "@wsp/engine";
import { type DaemonReachView, type ExecStreamFactory, type ProjectSource, type ProjectView, type WorkspaceKind, type WorkspaceProject, SCOPED_MCP_ARG, imageCarriesCheckout, DAEMON_TOKEN_PATH, homeShortened, folderName, noKindLine, registeredLine, REGISTERING_LINE, cloneFailedLine, cloneIntoTakenLine, cloneUrlRefusal, shellLine, shellQuote, placeForksNowhereLine, placeServesDaemonLine } from "@wsp/protocol";
import { cloneLines } from "../project-landing.js";
import { projectRemote, projectSource } from "../project-sources.js";
import { openDaemonChannel } from "../daemon-channel.js";
import { machineExecStream, type MachineExecOptions, type TurnWaiting } from "../machine-exec.js";
import { writeDaemonRootsScript } from "../daemon-roots.js";
import { PlaceForksNowhereError, type PlaceDoor } from "../places.js";
import { loginEnvOn } from "../types/harness.js";
import { type ProjectImportOptions, type WorkspaceRecord, type LiveWorkspace, type StageReport, CLONE_MS, folderNamed, lastLineOf } from "../types/wiring.js";
import type { KindModule, ImportReport, ImportLanded } from "../types/internal.js";
import type { RuntimeContext, KindsArea } from "../context.js";

export function kindsArea(ctx: RuntimeContext): KindsArea {
  const { opts, backend, local, placeDoor, clock, places } = ctx;
  const projectOf = (dest: string, size: number): WorkspaceProject => ({ name: folderName(dest), dest, importedAt: new Date(clock.now()).toISOString(), size });
  /** The command that puts a project's repo inside a copy of an image, word for word, so the test that reads the
   * machine's log and the machine that runs it read one line. No --branch where the record names no base: the
   * remote's own default branch is what the clone then takes. */
  const cloneOnMachine = (project: ProjectView, computer: string): string =>
    cloneLines({
      source: projectSource(project.source.kind),
      remote: project.remote,
      checkout: project.path,
      computer,
      ...(project.base !== undefined ? { branch: project.base } : {}),
    }).join("\n");
  /** The clone inside a copy: git's own last line is the failure, so a person reads what git said and not that a
   * stage failed. */
  const cloneProject = async (entry: LiveWorkspace, project: ProjectView, report: StageReport): Promise<void> => {
    // A copy forked from the project's own image already holds the checkout and its dependencies, and so does one
    // the computer copied the checkout into; there is nothing to clone and nothing to install in either.
    if (project.image !== undefined || project.checkout !== undefined) return;
    // And neither has a fork of a project image that carried this checkout: the snapshot is the whole disk, so the
    // project stands at its path with its dependencies installed, and a clone over it is what git refuses. The
    // image the machine was forked from is what says so, read off this workspace's own record.
    if (imageCarriesCheckout((await ctx.imageOf(entry.record.golden)).projects, project.path)) return;
    report("project-cloned", `Cloning ${project.remote} into ${project.path}.`);
    const cloned = await entry.machine.exec(cloneOnMachine(project, ctx.placeName(entry.record.place ?? places.wired)), { timeoutMs: CLONE_MS });
    if (cloned.exitCode !== 0) throw new Error(lastLineOf(cloned.stderr) || lastLineOf(cloned.stdout) || `git clone exited ${cloned.exitCode}`);
    // Fresh dependencies on the machine holding the checkout: the catalog's row for whichever lockfile the repo's
    // own root carries, run once, its output in wsp's own folder and never inside the project. A repo no row names
    // an install for installs nothing.
    const root = await entry.machine.exec(`ls -A ${shellQuote(project.path)}`, { timeoutMs: INLINE_EXEC_MS });
    const install = projectInstalls(root.stdout.split("\n").map(name => name.trim()), project.path)[0];
    if (install === undefined) return;
    report("project-cloned", `${install.command} in ${project.path}.`);
    const log = `${moduleOf(entry.record.kind).scratch(entry)}/install-${project.id}.log`;
    const ran = await entry.machine.exec(installScript(install, { dir: project.path, log }), { timeoutMs: INSTALL_MS });
    if (ran.exitCode !== 0) throw new Error(`${install.command} in ${project.path}: ${lastLineOf(ran.stderr) || lastLineOf(ran.stdout) || `exit ${ran.exitCode}`}; its whole output is ${log} on the machine`);
  };
  /** One folder on this computer's own remote and the branch that remote's HEAD names, in one command: what a
   * project of a folder here keeps on its record. Both empty where the folder has no origin, which a project
   * here is allowed: nothing clones it. */
  const remoteHere = async (path: string): Promise<{ remote: string; defaultBranch: string }> => {
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    // Each command prints exactly one line, its answer or an empty one, so the two are read apart whichever of
    // them the folder can answer: a folder with no origin has no remote and no default branch, not one of each.
    const read = await machine.exec(
      `${shellLine(["git", "-C", path, "remote", "get-url", "origin"])} || echo; ${shellLine(["git", "-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])} || echo`,
      { timeoutMs: INLINE_EXEC_MS },
    );
    const [remote = "", head = ""] = read.stdout.split("\n").map(line => line.trim());
    return { remote, defaultBranch: head.replace(/^origin\//, "") };
  };

  /** One git command on this computer, argv quoted, through the local backend as every read here goes. */
  const gitHere = async (cwd: string, args: readonly string[], timeoutMs = INLINE_EXEC_MS, stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    return machine.exec(shellLine(["git", "-C", cwd, ...args]), { timeoutMs, ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}) });
  };
  /** The top of the repo a folder on this computer sits in, the folder itself or one above it; nothing for a folder
   * git holds no repo in. */
  const gitTopOf = async (path: string): Promise<string | undefined> => {
    const read = await gitHere(path, ["rev-parse", "--show-toplevel"]);
    const top = read.stdout.trim();
    return read.exitCode === 0 && top !== "" ? top : undefined;
  };
  /** The branch a folder has checked out; nothing on a detached HEAD or where git answers nothing. */
  const branchAt = async (path: string): Promise<string | undefined> => {
    const read = await gitHere(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = read.stdout.trim();
    return read.exitCode === 0 && branch !== "" ? branch : undefined;
  };
  /** The folder beside the state this host serves, where its worktrees and its own files about them live, so two
   * hosts never share one. Never a home's default: a host serving another home would write into the person's. */
  const stateFolder = (): string => {
    if (opts.statePath === undefined) throw Object.assign(new Error("this runtime was given no state file, so it keeps no worktrees or copies"), { kind: "invalid" });
    return dirname(resolvePathOn(opts.statePath));
  };
  /** A repo cloned on this computer into the folder the person named, which must hold nothing yet: the source's own
   * clone line, argv quoted so neither the url nor the folder is read by the shell, `--` before the url so git
   * reads no option out of it, and no prompt, since nobody is at a terminal to answer one. Git's own last line is
   * the refusal. Answers the folder as it resolved, which is the project's path from here on. */
  const cloneHere = async (word: string, source: ProjectSource, into: string): Promise<string> => {
    const refused = cloneUrlRefusal(word);
    if (refused !== undefined) throw Object.assign(new Error(refused), { kind: "invalid" });
    const dest = folderNamed(into);
    let held: string[] = [];
    try {
      held = readdirSync(dest);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTDIR") held = [dest];
      else if (code !== "ENOENT") throw e;
    }
    if (held.length > 0) throw Object.assign(new Error(cloneIntoTakenLine(homeShortened(dest, homedir()))), { kind: "invalid" });
    const machine = await moduleOf("local").backend({ kind: "local" } as WorkspaceRecord).get(LOCAL_MACHINE_ID);
    const line = `${shellLine(["env", "GIT_TERMINAL_PROMPT=0"])} ${projectSource(source.kind).cloneCommand({ remote: projectRemote(source), dest })}`;
    const cloned = await machine.exec(line, { timeoutMs: CLONE_MS });
    if (cloned.exitCode !== 0) throw Object.assign(new Error(cloneFailedLine(cloned.stderr || cloned.stdout)), { kind: "invalid" });
    return folderNamed(dest);
  };
  /** The import road on this computer: the folder is here already, so its path is recorded at once and nothing is
   * packed or sent. The plan is still read, since it is the one measure of the folder and the one check that it is
   * there, and its bytes are the size the record shows. */
  const registerImport = async (o: ProjectImportOptions, report: ImportReport): Promise<ImportLanded> => {
    report("landing", REGISTERING_LINE);
    const plan = await o.bundler.plan();
    return {
      result: { dest: o.dest, files: plan.files, bytes: plan.bytes, parts: 0, cut: [], rewritten: [], agents: [], project: projectOf(o.dest, plan.bytes) },
      done: registeredLine(o.dest),
    };
  };
  /** The roots file as the machine's daemon reads it, written through the machine so the guest and this computer
   * take one script; a machine that will not take it fails the import before the record names the folder. */
  const writeRoots = async (entry: LiveWorkspace, dests: readonly string[], rootsPath?: string): Promise<void> => {
    const browsable = await entry.machine.exec(writeDaemonRootsScript(dests, rootsPath), { timeoutMs: INLINE_EXEC_MS });
    if (browsable.exitCode !== 0) throw new Error(`could not make ${dests.at(-1)} browsable on the machine: ${browsable.stderr.slice(-200)}`);
  };
  const cloudHome = (id: string): string => {
    const home = guestAgentHomes()[id];
    if (home === undefined) throw new Error(`the catalog has no home for ${id}`);
    return home;
  };
  /** The guest's login plus the variable pointing one harness at its store there, the store cloudHome names: a guest
   * exec carries no environment of its own, so the adapter exports this on every launch. */
  const cloudEnv = (place: string | undefined, id: string): Readonly<Record<string, string>> => {
    const login = loginEnvOn(place);
    const agent = CATALOG_AGENTS.find(a => a.id === id);
    return agent === undefined ? login : { ...login, ...guestEnv(agent) };
  };
  const cloudRoad = async (entry: LiveWorkspace): Promise<DaemonReachView> => {
    const reach = await entry.ws.daemonReach();
    const token = await ctx.daemonTokenOf(entry.machine, DAEMON_TOKEN_PATH);
    return { url: reach.url, expiresAt: reach.expiresAt, ...(token !== undefined ? { daemonToken: token } : {}) };
  };
  const localRoad = async (): Promise<DaemonReachView> => {
    if (local?.daemonRoad === undefined) throw new Error("this host wired no daemon for its local workspace, so nothing on this computer can be dialled");
    return local.daemonRoad();
  };
  /** Puts this runtime's daemon on a fork and hands it this runtime's token: the deploy writes one of its own,
   * so the guest's file is replaced the moment the deploy is done rather than at the next dial. */
  const cloudDeploy = async (entry: LiveWorkspace): Promise<void> => {
    await opts.goldenRecipe!.deployDaemon!(entry.machine);
    ctx.daemonTokens.delete(entry.machine.id);
    await ctx.daemonTokenOf(entry.machine, DAEMON_TOKEN_PATH);
  };
  /** Whether the file one agent's shared login lives in stands under the home that agent reads on this computer.
   * The catalog names both the home and the file, and an agent with no shared login has no file to stand. Only a
   * login kept as a file is seen: one a tool put in this computer's keyring reads here as none. */
  const sharedLoginUnder = (home: string, agentId: string): boolean => {
    const shared = sharedOn(agentId);
    return shared !== undefined && existsSync(join(home, shared.file));
  };
  const placeDoorOf = (): PlaceDoor => {
    if (placeDoor === undefined) throw new Error(noKindLine("place"));
    return placeDoor;
  };
  /** Every run on a machine this runtime is reading, as the call that lets go of each. A poll on a turn left
   * running holds this process after its last line, and a turn on a machine is not this host's to end: closing
   * lets go and leaves them running, and whoever opens them next reads their logs from the first byte. Each
   * kind's wiring holds its own set; this one is for the kinds whose runs live on a machine. */
  const machineReading = new Set<() => void>();
  const modules: Record<WorkspaceKind, KindModule | undefined> = {
    cloud: {
      // A fork lands either at this host's own provider or on a computer somebody joined; the record says which,
      // and a place that forks nowhere refuses here rather than at the provider.
      backend: record => {
        if (record.place === undefined) return backend;
        const at = placeDoorOf().backendOf(record.place);
        if (at === undefined) throw new PlaceForksNowhereError(placeForksNowhereLine(placeDoorOf().nameOf(record.place)));
        return at;
      },
      execStream: (entry, o, waiting) => machineExecStream(entry.machine, { reading: machineReading, ...o }, waiting),
      folder: () => undefined,
      home: (_entry, id) => cloudHome(id),
      homeDir: () => GUEST_HOME,
      env: (entry, id) => cloudEnv(entry.record.place, id),
      // A fork at a provider is a copy of an image, and no sign-in is ever sealed into one, so the vault's key is
      // what a turn there runs on. A workspace on a computer somebody joined shares that computer's own logins,
      // and the word for each is the one its row carries.
      loginStands: (entry, id) => entry.record.place !== undefined && placeDoor?.signInsAt(entry.record.place)?.[id] === "signed-in",
      relayed: () => true,
      // The word, not a path: the deploy writes the shim onto the machine's PATH and the binary under it carries the
      // chip in its own path, so the one stable name for a fork's wsp is the word a turn's own shell runs. It dials
      // no host of its own, it opens a session on this machine's daemon and the daemon carries it up the socket
      // this host already holds.
      wspMcp: () => ({ command: "wsp", args: ["mcp"] }),
      turnReach: () => ({}),
      turnRoad: "relayed",
      keepsAgents: false,
      // A workspace whose computer answers its daemon frames has no daemon of its own to dial and no route worth
      // minting: nothing listens inside it, and the road to its files and its git is the link this host holds.
      hasDaemon: entry => ctx.servedByItsComputer(entry) === undefined && Boolean(entry.machine.previewUrl),
      sharedDaemon: false,
      daemonRoad: entry =>
        ctx.servedByItsComputer(entry) === undefined
          ? cloudRoad(entry)
          : Promise.reject(new Error(placeServesDaemonLine(entry.record.name, ctx.computerOf(entry)))),
      scratch: () => GUEST_TMP,
      daemonVersion: entry => ctx.helloVersion(entry),
      dropped: async () => {},
      // The bundle is the host's to wire; whether it can reach a given machine is canDeployDaemon's reading, since
      // one kind's machines can differ about it (a container a box's runtime boots mints no signed URL).
      ...(opts.goldenRecipe?.deployDaemon !== undefined ? { deployDaemon: async (entry: LiveWorkspace) => cloudDeploy(entry) } : {}),
      import: (entry, o, report) => ctx.copyImport(entry, o, report),
      roots: (entry, dests) => writeRoots(entry, dests),
      landProject: (entry, project, report) => cloneProject(entry, project, report),
      // The key the project was recorded with, which is the folder's own on the computer it was seeded from: a
      // fork holds the checkout at a path of the machine's, and keying off that path would give one project as
      // many memories as it has computers.
      memoryKey: (entry, agentId) => projectMemoryKey(agentId, ctx.projectHeld(entry.record.project)),
    },
    local:
      local === undefined
        ? undefined
        : {
            backend: () => local.backend,
            execStream: (_entry, o, waiting) => local.execStream(o, waiting),
            // A record here is a folder: the project's own or a worktree of its repo, the word its view carries and
            // where a thread on it starts; the same reading threadFolder takes.
            folder: record => ctx.checkoutOf(record),
            home: (_entry, id) => local.home(id),
            homeDir: () => local.homeDir,
            // The person's own login on the computer they are sitting at, read where that agent keeps it.
            loginStands: (_entry, id) => sharedLoginUnder(local.home(id), id),
            // The person's own login and nothing more: threads here share the person's ports, as panes in one
            // terminal do.
            env: () => local.env(),
            relayed: () => false,
            // This computer's own command, as the command line hands it: a thread here runs the wsp tools on this
            // computer, which dial the pair its launch carries rather than riding a machine's daemon. Marked, since here a
            // server missing that pair could otherwise dial the host on the person's own token; a fork's guest door has no
            // such fallback.
            wspMcp: () => {
              const wsp = opts.agents?.wspMcp;
              return wsp === undefined ? undefined : { ...wsp, args: [...wsp.args, SCOPED_MCP_ARG] };
            },
            // A turn here runs on the computer the host runs on, so it dials the host's loopback, and a host that
            // listens on none tells it nothing and hands it no token. The token is identity here, not confinement:
            // the turn runs as the person, who can read the host's own token file.
            turnReach: () => {
              const url = opts.agents?.here?.url;
              return url === undefined || url === "" ? undefined : { url };
            },
            turnRoad: "here",
            keepsAgents: true,
            hasDaemon: () => local.daemonRoad !== undefined,
            sharedDaemon: true,
            daemonRoad: localRoad,
            ...(local.restartDaemon !== undefined ? { restartDaemon: local.restartDaemon } : {}),
            scratch: () => local.backend.folder,
            // The binary beside this host, read by starting the daemon where nothing has: this process holds the
            // process, and the binary it spawns is staged beside the command and can be older than this wsp.
            daemonVersion: async () => (local.hereDaemon === undefined ? null : local.hereDaemon.version()),
            dropped: async () => {},
            import: (_entry, o, report) => registerImport(o, report),
            // The file this host's own daemon reads, which is the wiring's and not a path taken off the home it
            // browses: a host on another state file has its own, and neither rewrites the other's.
            roots: (entry, dests) => writeRoots(entry, dests, local.rootsPath),
            landProject: async () => {},
            // A worktree wsp made keys off its own top, so a builder there never loads the notes the person and the
            // thread leading it keep. Every other folder of the project, the project folder with no branch, a
            // subfolder project's own and a worktree the person made, takes the key Claude Code gives it in the
            // person's own terminal, which is its repo's main checkout, so the thread shares their memory.
            memoryKey: (entry, agentId) => {
              const project = ctx.projectHeld(entry.record.project);
              const tree = entry.record.worktree;
              if (tree?.made === true && tree.gone !== true) return projectStateKey(agentId, tree.path);
              const top = project.git?.top;
              return top !== undefined && top !== project.path ? projectStateKey(agentId, top) : projectMemoryKey(agentId, project);
            },
          },
  };
  const moduleOf = (kind: WorkspaceKind): KindModule => {
    const found = modules[kind];
    if (found === undefined) throw new Error(noKindLine(kind));
    return found;
  };
  const backendFor = (record: WorkspaceRecord): MachineBackend => moduleOf(record.kind).backend(record);
  const openChannel = opts.daemonChannel ?? openDaemonChannel;
  /** The backend a kind's machines live on where no record is in hand yet: the create that is about to write one,
   * and the roads that ask what this host can do at all. The same reading a record gets, off the two facts a record
   * would carry. */
  const backendOfKind = (kind: WorkspaceKind, place?: string): MachineBackend =>
    moduleOf(kind).backend({ kind, ...(place !== undefined ? { place } : {}) } as WorkspaceRecord);
  /** Whether a fork on this backend stands on an image at all: a provider boots a template or a snapshot it keeps,
   * and a workspace on a computer somebody joined is a copy of that computer's own directories, so it names none
   * and nothing is looked up or built for it. The one reading of that road above the backend, so no road here
   * names a provider or a place to learn it. */
  const keepsImages = (at: MachineBackend): boolean => at.capabilities.images;
  /** Whether this backend's pause keeps the disk: a stop that snapshots it, so a wake resumes the same machine with
   * its home. Such a nap reads nothing of the home; the vault is taken off the running machine at a rebuild instead. */
  const pauseKeepsDisk = (at: MachineBackend): boolean => at.capabilities.pauseMode === "disk";
  /** Whether the machines of this backend come up under the workspace's own name. The one reading of that road
   * above the backend, beside the images one: a fork that is named at its boot is never named again from here. */
  const namesWorkspace = (at: MachineBackend): boolean => at.namesWorkspace === true;
  /** The budgets a kind's backend declares for its naps and wakes. Every reader sits behind the pause refusal or
   * behind a machine's preview route, so a kind without one here is a wiring fault, never a person's road. */
  const lifecycleOf = (entry: LiveWorkspace): Lifecycle => {
    const lifecycle = backendFor(entry.record).lifecycle;
    if (lifecycle === undefined) throw new Error(`${entry.record.kind} machines declare no lifecycle`);
    return lifecycle;
  };
  const execFactoryFor = (entry: LiveWorkspace, o?: MachineExecOptions, waiting?: TurnWaiting): ExecStreamFactory =>
    moduleOf(entry.record.kind).execStream(entry, opts.machineExec === undefined ? o : { ...opts.machineExec, ...o }, waiting);
  /** What one agent on a workspace of this project keys its sessions and its memory to. The project's own key
   * where that agent's catalog row names the variable that pins it, since that key was fixed when the project was
   * recorded and follows it onto whichever computer holds it; every other agent keys off the folder it is worked
   * at, which is the rule the resolver for that agent carries. Read off the catalog row and never off an agent's
   * id, and read here alone, so every kind answers the same way. */
  const projectMemoryKey = (agentId: string, project: ProjectView): string | undefined =>
    CATALOG_AGENTS.find(a => a.id === agentId)?.projectKeyEnv !== undefined ? project.memoryKey : projectStateKey(agentId, project.path);

  /** The folder a turn or a command starts in, the one rule every road reads: the folder the caller named, else
   * the folder this workspace holds its project in, which is the kind's own reading, else the project's own path.
   * The kind is asked rather than the project read directly, because on a computer that makes a workspace by
   * copying the project folder the workspace's folder is that copy and never the person's own checkout. Both
   * roads that launch a process through this runtime read it here, the turn and the exec verb, so the folder a
   * turn opens in and the one a command runs in cannot differ, and the app, the command line and the tool need
   * not restate it. */
  const threadFolder = async (entry: LiveWorkspace, o: { cwd?: string | undefined }): Promise<string> => {
    return o.cwd ?? moduleOf(entry.record.kind).folder(entry.record) ?? ctx.projectHeld(entry.record.project).path;
  };
  return {
    projectOf, remoteHere, gitHere, gitTopOf, branchAt, stateFolder, cloneHere, localRoad, placeDoorOf, machineReading,
    moduleOf, backendFor, openChannel, backendOfKind, keepsImages, pauseKeepsDisk, namesWorkspace, lifecycleOf,
    execFactoryFor, threadFolder,
  };
}
