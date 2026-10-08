// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { remoteHost } from "@wsp/catalog";
import { type DaemonFrame, type DaemonResponse, type DaemonReachView, type ProjectRef, type ProjectView, type WorkspaceAgents, type PlaceSettings, branchUnreadRefusal, GitPushReply, GitStatusReply, GitStartOnReply, DETACHED_HEAD, childStartedLine, forkNeedsPushLine, pushedForChildLine, uncommittedStayed, agentsFrom, placeAtLimitLine, placeSpendLimit, spendCapRefusal, THIS_COMPUTER, isLocalWorkspace, kindWords, machineWord, noSuchProjectLine, absentComputer, HERE_PLACE_ID, placeBlocked, placeWatchesItselfLine, forkProcsUnreadLine, forkOpRefusedLine, placeServesDaemonLine, ownerRepoOf, copiesFolder, kindForComputer, type Caller } from "@wsp/protocol";
import { groupExists } from "../local-exec.js";
import type { DaemonChannel } from "../daemon-channel.js";
import type { MachineExecOptions } from "../machine-exec.js";
import type { WorkspaceRecord, LiveWorkspace } from "../types/wiring.js";
import { DaemonRefusal, type ChildStart, type SESSION_FACTS } from "../types/internal.js";
import type { RuntimeContext, ChannelsArea } from "../context.js";

/** How long the rule's origin read may hold the host's one thread: a local git read answers in milliseconds. */
const ORIGIN_READ_MS = 2_000;

export function channelsArea(ctx: RuntimeContext): ChannelsArea {
  const { local, placeDoor, clock, projectsHeld, threadRecords, sessions, transcriptIndex, places } = ctx;
  /** The harness session a thread's newest start in the transcript announced: what a send resumes once the thread's
   * rows have fallen off the index cap. */
  const startedAs = (workspaceId: string, threadId: string): string | undefined => transcriptIndex.get(workspaceId)?.starts.get(threadId);

  /** Whether the thread's last turn ended with no exit code and no result: the runtime or its transport ended the
   * process (a deadline, a host restart, a nap), so the harness resumes a transcript it never finished writing. */
  const cutBefore = (workspaceId: string, threadId: string): boolean => transcriptIndex.get(workspaceId)?.cut.get(threadId) ?? false;

  /** What a resumed session's turns carry, read the one way for every such fact: its own rows newest first, then,
   * past the session index cap, the newest start event of that session. The index keeps SESSION_INDEX_CAP rows per
   * workspace and drops the oldest finished ones while the transcript keeps the thread, so the events are where a
   * long-lived thread's own facts survive. Nothing from before a fact was recorded, and the start then fills what
   * its catalog marks. */
  const resumedFact = (workspaceId: string, resume: string, fact: (typeof SESSION_FACTS)[number]): string | undefined => {
    const rows = [...sessions.values()];
    for (let i = rows.length - 1; i >= 0; i--) {
      const view = rows[i]!.view;
      if (view.workspaceId === workspaceId && view.claudeSessionId === resume && view[fact] !== undefined) return view[fact];
    }
    return transcriptIndex.get(workspaceId)?.facts.get(resume)?.[fact];
  };

  /** The folder a resumed session's harness ran in. The CLI keys a session to that folder, so a resume anywhere
   * else opens nothing. */
  const folderOf = (workspaceId: string, resume: string): string | undefined => resumedFact(workspaceId, resume, "cwd");

  /** The access a thread's turns run at: its own record, then what its latest turn recorded for a thread from
   * before the record. A send that names none keeps the thread's own rather than falling back to the adapter's
   * unnamed default, which is bypass on every harness here; without this a second turn on a thread the person
   * opened at its harness's prompts would quietly skip them. */
  const accessOf = (workspaceId: string, threadId: string, resume: string | undefined): string | undefined =>
    threadRecords.get(threadId)?.permissionMode ?? (resume === undefined ? undefined : resumedFact(workspaceId, resume, "permissionMode"));

  /** What the runtime is doing to a machine's daemon, by workspace: the line its row shows while an update runs and
   * the sentence left there when one failed. Held here rather than on the record because it says what this process
   * is doing, not what the workspace is. */
  const daemonNotes = new Map<string, string>();

  /** The machine's home for the view, where the kind knows it. */
  const homeOf = (r: WorkspaceRecord): { home?: string } => {
    const home = ctx.moduleOf(r.kind).homeDir(r);
    return home !== undefined ? { home } : {};
  };

  /** Which provider forked this workspace's machine, by the id a registry gives the module that did it. A record
   * that names the computer it was forked on reads that computer's own offer, since the machine was never at this
   * host's provider; every other driven kind reads the module this host wired, one at a time. A kind whose machine
   * the person owns is forked by nobody and carries none, and so does a place this host has not yet heard what it
   * forks with. The one reading of where a machine lives, so this and `place` on one view cannot disagree. */
  const providerOf = (r: WorkspaceRecord): string | undefined =>
    r.place !== undefined ? placeDoor?.offerOf(r.place) : kindWords(r.kind).driven ? places.wired : undefined;
  /** The row of the places list a workspace stands on: this computer for a folder here, else the computer its record
   * names, else the provider it forks at. */
  const placeIdOf = (r: WorkspaceRecord): string | undefined => (isLocalWorkspace(r) ? HERE_PLACE_ID : (r.place ?? providerOf(r)));
  /** What the person set on the place a workspace, or a workspace about to land, stands on. */
  const settingsAt = (placeId: string | undefined): PlaceSettings | undefined => (placeId === undefined ? undefined : placeDoor?.settingsAt(placeId));
  /** The wall a turn on a workspace runs under, off the row of the place it stands on, none being no limit. Nothing
   * where the door lists no row for it, which leaves the reader its own default. */
  const turnLimitOf = (r: WorkspaceRecord): MachineExecOptions | undefined => {
    const placeId = placeIdOf(r);
    const limit = placeId === undefined ? undefined : placeDoor?.turnLimitAt(placeId);
    return limit === undefined ? undefined : { deadlineMs: limit ?? Number.POSITIVE_INFINITY };
  };
  /** The switch a workspace runs under, read off its own record alone and never its tree's root. */
  const agentsHeld = (r: WorkspaceRecord): WorkspaceAgents => r.agents ?? spawnAt(placeIdOf(r));
  /** The switch a place gives its workspaces: the parts the person set there over the default as it reads now. */
  const spawnAt = (placeId: string | undefined): WorkspaceAgents => agentsFrom(undefined, settingsAt(placeId)?.spawn ?? {});

  /** The project a record names. A record whose project this host does not hold is the one shape the boot refuses,
   * so every read after the boot has one. */
  const projectHeld = (id: string): ProjectView => {
    const found = projectsHeld.get(id);
    if (found === undefined) throw new Error(noSuchProjectLine(id, [...projectsHeld.values()].map(p => p.name)));
    return found;
  };

  /** What a workspace's view carries about its project: the four facts a row and a thread need, joined rather than
   * stored a second time. */
  const refOf = (p: ProjectView): ProjectRef => ({ id: p.id, name: p.name, path: p.path, computer: p.computer });

  /** Where a record's threads work: the project's own path (the clone inside a fork, the folder on this computer),
   * or the same folder inside the worktree the record names. A worktree that is gone answers the project's path, so
   * its threads go on there. */
  const checkoutOf = (r: WorkspaceRecord): string => {
    const project = projectHeld(r.project);
    const tree = r.worktree;
    if (tree === undefined || tree.gone === true) return project.path;
    return join(tree.path, relative(project.git?.top ?? project.path, project.path));
  };
  /** What the computer holding a workspace is called, for the sentences about a workspace whose daemon is that
   * computer's own: the name the person gave that computer, or the word for its kind of machine. */
  const computerOf = (entry: LiveWorkspace): string =>
    entry.record.place !== undefined ? (placeDoor?.nameOf(entry.record.place) ?? entry.record.place) : machineWord(entry.record.kind);

  /** The computer a workspace's daemon is that computer's own: a workspace on a computer somebody owns runs no
   * daemon inside it, so its machine answers the daemon's frames itself, over the link the host already holds.
   * Read in one place, since it decides both which road the frames take and whether anything dials at all. */
  const servedByItsComputer = (entry: LiveWorkspace): ((frame: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined =>
    entry.machine.daemonFrame?.bind(entry.machine);

  /** One dial of a workspace's own daemon, for the frames this host sends itself and for a client of this host
   * driving that daemon one frame at a time: the road its kind answers, and the one sentence for a machine with no
   * daemon answering on it yet. The caller closes what it opened. */
  const ownDaemonChannel = async (entry: LiveWorkspace, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel> =>
    channelOver(await ctx.moduleOf(entry.record.kind).daemonRoad(entry), entry.record.name, onEvent);
  const channelOver = (reach: DaemonReachView, name: string, onEvent: (event: Record<string, unknown>) => void): Promise<DaemonChannel> => {
    if (reach.daemonToken === undefined) throw new Error(`${name} is not answering yet`);
    return ctx.openChannel({ url: reach.url, token: reach.daemonToken, onEvent });
  };

  /** The frames this host sends a workspace's daemon itself, on a channel closed however the work ends: the road
   * the app's panes take for git.status, taken here for the two a bring back is made of. A refusal comes back
   * with the code the daemon put on it, so a caller reads the reason rather than the sentence.
   *
   * Where the workspace's daemon is the computer's own, the frames go up that computer's link with the workspace
   * named on each one and nothing is dialled. A daemon too old to read that name cannot seal the link, so one that
   * is merely behind still answers here. */
  const withDaemon = async <T>(entry: LiveWorkspace, work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> => {
    const served = servedByItsComputer(entry);
    if (served !== undefined) return work(async frame => replyOf(frame, await served(frame)));
    return overChannel(await ownDaemonChannel(entry, () => {}), work);
  };
  /** A daemon's reply to one of this host's own frames, or its refusal thrown with the code the daemon put on it. */
  const replyOf = (frame: DaemonFrame, reply: Record<string, unknown>): Record<string, unknown> => {
    if (reply["ok"] === true) return reply;
    throw new DaemonRefusal(typeof reply["code"] === "string" ? reply["code"] : undefined, String(reply["error"] ?? `${frame.op} was refused`));
  };
  const overChannel = async <T>(channel: DaemonChannel, work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> => {
    try {
      return await work(async frame => replyOf(frame, (await channel.send(frame)) as Record<string, unknown>));
    } finally {
      channel.close();
    }
  };

  /** The frames this host sends the daemon of the computer it runs on, which runs the git host's own signed-in command
   * line as the person, in their home, with the repository named off the project's record: every read of a pull
   * request goes this road first, so no copy is woken for one. A host that wired no daemon here reads as a computer
   * with no command line for the host. */
  const onThisComputer = async <T>(work: (ask: (frame: DaemonFrame) => Promise<Record<string, unknown>>, home: string) => Promise<T>): Promise<T> => {
    if (local?.daemonRoad === undefined) throw new DaemonRefusal("no-host-cli", "this host runs no daemon on this computer");
    const home = local.homeDir;
    return overChannel(await channelOver(await ctx.localRoad(), THIS_COMPUTER, () => {}), ask => work(ask, home));
  };

  /** Refuses a new machine on a place whose spend today has reached its spend per day. Only a cloud has one, so a copy
   * on this computer or a fork on a box is never refused here, and the machines already running are not touched. */
  const placeGuard = async (placeId: string): Promise<void> => {
    if (placeDoor === undefined) return;
    const rows = await placeDoor.rows();
    const row = rows.find(r => r.id === placeId);
    const limit = row === undefined ? undefined : placeSpendLimit(row);
    if (row === undefined || limit === undefined) return;
    const todayUsd = (await ctx.status.spend(rows, clock.now())).find(s => s.place === placeId)?.todayUsd;
    if (todayUsd !== undefined && placeAtLimitLine(row, todayUsd) !== undefined) throw new Error(spendCapRefusal(row.name, todayUsd, limit));
  };

  /** Refuses whatever runs inside a copy (a create, a turn, a command, a port, a bring back) on a computer
   * whose doctor says it cannot run workspaces, in the sentence its row carries; a delete, a remove and an update
   * need no copy running and never ask. */
  const placeRefuses = async (placeId: string | undefined): Promise<void> => {
    const blocked = await blockedLine(placeId);
    if (blocked !== undefined) throw new Error(blocked);
  };
  const blockedLine = async (placeId: string | undefined): Promise<string | undefined> => {
    if (placeId === undefined || placeDoor === undefined) return undefined;
    const report = await placeDoor.reportOf(placeId);
    return report === undefined ? undefined : placeBlocked(placeDoor.nameOf(placeId), report);
  };
  const copyBlocked = (entry: LiveWorkspace): Promise<void> => placeRefuses(entry.record.place);

  /** The frames a place daemon stamps with the workspace they are of: a guest session's, by the listener it arrived
   * on and never anything the guest said, and a tunnel's, by the workspace it was opened inside. */
  const GUEST_EVENTS = ["guest.opened", "guest.message", "guest.closed", "tunnel.data", "tunnel.end"];
  /** What a pty pushes, each naming the pty it is of; a computer answering for many workspaces pushes every
   * workspace's up the one link. */
  const PTY_EVENTS = ["pty.data", "pty.exit", "pty.mode"];
  /** The two a pane opens every link with, and the two a workspace on a computer somebody owns has no answer of
   * its own for: the ports and the load that computer's daemon reads are the whole computer's. */
  const COMPUTER_WATCHES = ["ports.watch", "sys.watch"];
  /** That computer's daemon watches, reads and signals any pid on it and names no workspace on its answers, and the
   * one watch it holds is the link's, which the computer's own page shares. */
  const COMPUTER_PROCS = ["proc.watch", "proc.unwatch", "proc.inspect", "proc.kill"];
  /** The whole of what a client's channel into a served workspace carries, for the reason DEVICE_OPS is a list: that
   * computer's daemon runs every other op on the computer itself, so a deny list would let an op added later reach it.
   * Each of these names the workspace it is for, and the daemon answers it inside that workspace. */
  const WORKSPACE_FRAMES = ["pty.create", "pty.attach", "pty.detach", "pty.write", "pty.resize", "pty.kill", "pty.tab", "pty.list", "fs.list", "fs.files", "fs.read", "fs.write", "fs.search", "git.status", "git.diff", "git.snapshot", "git.range", "git.turn", "git.push", "git.pr", "git.prList", "ping"];
  /** And the host's own guest road, which answers the sessions that computer relays by the id it gave them, and
   * carries an editor's ssh to the server it starts inside the workspace. A client's channel carries neither: a
   * tunnel reaches any port inside the workspace, and only this host's relay listens for one. */
  const GUEST_ROAD_FRAMES = [...WORKSPACE_FRAMES, "guest.watch", "guest.reply", "guest.close", "ssh.start", "tunnel.open", "tunnel.write", "tunnel.close"];

  /** The pid each pty a local workspace's own channels opened leads, by workspace and pty: the ports watch roots at
   * them. Dropped at the pty's exit, which `ptyOwners` keeps. */
  const portPids = new Map<string, Map<string, number>>();
  /** The ptys each channel's owner opened on a daemon several owners dial, a local workspace's by its id and this
   * computer's own terminal by the place's. The daemon tells these apart by no name, so without this every owner's
   * panes would list and drive every other's shells. Kept past a pty's exit, which a pane still shows, and emptied
   * when that daemon is replaced, since its ptys go with it. */
  const ptyOwners = new Map<string, Set<string>>();
  /** A channel that answers only for the ptys its owner opened through a channel of its own: its pty.list holds no
   * other, and an op naming another's pty is told there is no such pty, as a box's daemon tells another machine,
   * without reaching the daemon. */
  const heldToOwner = (owner: string, channel: DaemonChannel): DaemonChannel => {
    const mine = ptyOwners.get(owner) ?? new Set<string>();
    ptyOwners.set(owner, mine);
    return {
      async send(frame) {
        const asked = (frame as Record<string, unknown>)["ptyId"];
        if (asked !== undefined && !mine.has(String(asked))) return { id: frame.id, ok: false, error: `no such pty: ${String(asked)}` } as DaemonResponse;
        // A list can land after another channel of this owner opened a shell, so only what was held when it was asked is dropped.
        const listedFrom = frame.op === "pty.list" ? [...mine] : [];
        const reply = await channel.send(frame);
        const said = reply as Record<string, unknown>;
        if (said["ok"] !== true) return reply;
        if (frame.op === "pty.create") mine.add(String(said["ptyId"]));
        if (frame.op === "pty.kill") mine.delete(String(asked));
        if (frame.op === "pty.list" && Array.isArray(said["ptys"])) {
          const rows = said["ptys"] as Record<string, unknown>[];
          const held = new Set(rows.map(row => String(row["id"])));
          for (const id of listedFrom) if (!held.has(id)) mine.delete(id);
          return { ...reply, ptys: rows.filter(row => mine.has(String(row["id"]))) };
        }
        return reply;
      },
      close: () => channel.close(),
      closed: channel.closed,
    };
  };
  /** Forgets whose every pty was, once the daemon the owners share is replaced and its ptys with it. */
  const sharedDaemonReplaced = (): void => {
    for (const mine of ptyOwners.values()) mine.clear();
  };
  /** Each local workspace's channels that watch ports, as the push that names that workspace's roots again. */
  const portWatchers = new Map<string, Set<() => void>>();
  /** The process group each local workspace's turns led, as the turn road launches them, kept past the turn for as
   * long as the group has members: a server the turn left in its group is still the workspace's, and the kernel
   * hands the number to nobody else while one is there. */
  const turnGroups = new Map<string, Set<number>>();
  /** How often the turns' groups are read again while any workspace holds one, so a group that emptied stops being a
   * root before the kernel can hand its number to a stranger's group, whether or not a channel watches. */
  const PORT_ROOTS_RECHECK_MS = 5_000;
  const armRootsRecheck = (): void => {
    if (ctx.state.rootsRecheck !== undefined) return;
    ctx.state.rootsRecheck = setInterval(() => {
      for (const id of [...turnGroups.keys()]) portRootsMoved(id);
      if (turnGroups.size > 0) return;
      clearInterval(ctx.state.rootsRecheck);
      ctx.state.rootsRecheck = undefined;
    }, PORT_ROOTS_RECHECK_MS);
    ctx.state.rootsRecheck.unref();
  };
  /** The processes whose listeners are a local workspace's: each of its turns' groups that still has members, and
   * each terminal its channels opened. Never the host, which every workspace here runs under. */
  const portRootsOf = (workspaceId: string): number[] => {
    const roots = new Set<number>();
    const groups = turnGroups.get(workspaceId);
    for (const pid of groups ?? []) {
      if (groupExists(pid)) roots.add(pid);
      else groups?.delete(pid);
    }
    if (groups?.size === 0) turnGroups.delete(workspaceId);
    for (const pid of portPids.get(workspaceId)?.values() ?? []) roots.add(pid);
    return [...roots].sort((a, b) => a - b);
  };
  /** Reads the workspace's roots now, which drops a turn's group that emptied, and names them again to every channel
   * that watches. */
  const portRootsMoved = (workspaceId: string): void => {
    portRootsOf(workspaceId);
    for (const push of portWatchers.get(workspaceId) ?? []) push();
  };
  /** A local workspace's channel with its ports.watch rooted at that workspace's processes and its folder, named
   * again on the same socket each time they move; the daemon answers a second watch with what the new roots opened
   * and closed. */
  const rootedPorts = (workspaceId: string, folder: string, ptys: Map<string, number>, channel: DaemonChannel): DaemonChannel => {
    /** The roots this channel last named, undefined until it watches. */
    let told: string | undefined;
    const fresh = (): number[] | undefined => {
      const roots = portRootsOf(workspaceId);
      if (roots.join(",") === told) return undefined;
      told = roots.join(",");
      return roots;
    };
    const push = (): void => {
      if (told === undefined) return;
      const roots = fresh();
      if (roots !== undefined) void channel.send({ id: null, op: "ports.watch", roots, folder } as DaemonFrame).catch(() => undefined);
    };
    const watchers = portWatchers.get(workspaceId) ?? new Set<() => void>();
    portWatchers.set(workspaceId, watchers);
    watchers.add(push);
    const stop = (): void => {
      watchers.delete(push);
    };
    void channel.closed.then(stop, stop);
    return {
      async send(frame) {
        if (frame.op === "ports.watch") {
          told = undefined;
          return channel.send({ ...frame, roots: fresh() ?? [], folder } as DaemonFrame);
        }
        const reply = await channel.send(frame);
        const said = reply as Record<string, unknown>;
        if (frame.op === "pty.create" && said["ok"] === true && typeof said["pid"] === "number") {
          ptys.set(String(said["ptyId"]), said["pid"]);
          portRootsMoved(workspaceId);
        }
        // A pty that exited while none of this workspace's channels listened sent it no pty.exit; the list the panes
        // ask for on every connect is what says it is gone, before its pid can be handed to a stranger.
        if (frame.op === "pty.list" && said["ok"] === true && Array.isArray(said["ptys"])) {
          const standing = new Set((said["ptys"] as Record<string, unknown>[]).filter(row => row["exited"] !== true).map(row => String(row["id"])));
          const gone = [...ptys.keys()].filter(id => !standing.has(id));
          for (const id of gone) ptys.delete(id);
          if (gone.length > 0) portRootsMoved(workspaceId);
        }
        return reply;
      },
      close: () => {
        stop();
        channel.close();
      },
      closed: channel.closed,
    };
  };

  /** The channel a client of this host drives a served workspace's daemon over: every frame it carries goes up that
   * computer's link with the workspace named on it, and the events that come back are the ones this workspace's,
   * read off the link every road on that computer shares. Nothing is dialled and no token is spent, since the
   * road is the link that computer opened.
   *
   * Its own hello opens it. The link's hello named the computer's home, and a client builds this workspace's
   * paths off the root it reads here. */
  const servedChannel = async (
    entry: LiveWorkspace,
    served: (frame: Record<string, unknown>) => Promise<Record<string, unknown>>,
    onEvent: (event: Record<string, unknown>) => void,
    carries: readonly string[],
  ): Promise<DaemonChannel> => {
    const placeId = entry.record.place;
    // A machine that answers its own daemon frames is one on a computer this host holds a link to.
    if (placeId === undefined || placeDoor === undefined) throw new Error(placeServesDaemonLine(entry.record.name, computerOf(entry)));
    const door = placeDoor;
    const version = (await door.reportOf(placeId))?.daemonVersion;
    const machineId = entry.machine.id;
    const checkout = checkoutOf(entry.record);
    /** The ptys on that computer this channel named, so an event of a pty another pane opened is not pushed at
     * this one; of those, the ones it is listening to, which it takes its listeners off when it goes. */
    const named = new Set<string>();
    const attached = new Set<string>();
    const link = door.channel(placeId, event => {
      const type = String(event["type"]);
      if (GUEST_EVENTS.includes(type)) {
        if (event["machineId"] === machineId) onEvent(event);
        return;
      }
      if (!PTY_EVENTS.includes(type) || !named.has(String(event["ptyId"]))) return;
      // A pty that exited holds no listener worth taking off, so the close below asks only for the ones that stand.
      if (type === "pty.exit") attached.delete(String(event["ptyId"]));
      onEvent(event);
    });
    if (link === undefined) throw new Error(absentComputer(door.nameOf(placeId), null).sentence);
    /** What this channel now holds on the far end, off a frame it sent and the answer to it. */
    const held = (op: string, frame: Record<string, unknown>, reply: Record<string, unknown>): void => {
      if (op === "pty.create") {
        named.add(String(reply["ptyId"]));
        return;
      }
      if (op === "pty.list") {
        for (const row of Array.isArray(reply["ptys"]) ? (reply["ptys"] as Record<string, unknown>[]) : []) named.add(String(row["id"]));
        return;
      }
      const ptyId = String(frame["ptyId"]);
      if (op === "pty.attach") {
        named.add(ptyId);
        attached.add(ptyId);
      }
      if (op === "pty.detach" || op === "pty.kill") attached.delete(ptyId);
    };
    onEvent({ type: "daemon.hello", root: checkout, ...(version !== undefined ? { version } : {}) });
    return {
      async send(frame) {
        const op = frame.op;
        if (COMPUTER_WATCHES.includes(op)) return { id: null, ok: false, code: "unsupported", error: placeWatchesItselfLine(door.nameOf(placeId)) };
        if (COMPUTER_PROCS.includes(op)) return { id: null, ok: false, code: "unsupported", error: forkProcsUnreadLine(entry.record.name, door.nameOf(placeId)) };
        if (!carries.includes(op)) return { id: null, ok: false, code: "unsupported", error: forkOpRefusedLine(op, entry.record.name, door.nameOf(placeId)) };
        // The pane's first tab names no folder, and the daemon answering for a workspace has no working directory
        // inside it: without one the shell would open in the home of the computer, which is bound in.
        const asked = op === "pty.create" && frame["cwd"] === undefined ? { ...frame, cwd: checkout } : frame;
        const reply = await served(asked);
        if (reply["ok"] === true) held(op, asked, reply);
        return { id: null, ...reply } as DaemonResponse;
      },
      close: () => {
        // Every channel on that computer rides the one socket its link is, so a pane that goes says which ptys it
        // is done with; the socket's own close would be the link's, and that is the whole computer going.
        for (const ptyId of attached) void served({ op: "pty.detach", ptyId }).catch(() => undefined);
        attached.clear();
        link.close();
      },
      closed: link.closed,
    };
  };

  /** All a channel into a copy on a computer that cannot run workspaces carries out: a stopped copy's git.status
   * reads its files, and ping is the beat a pane's link opens on. In comes only their answers and the open's hello,
   * which names the root git.status is asked under; a session or a pty the computer pushes never reaches a door. */
  const BLOCKED_READS: ReadonlySet<string> = new Set(["git.status", "ping"]);
  const copyChannel = async (entry: LiveWorkspace, onEvent: (event: Record<string, unknown>) => void, carries: readonly string[]): Promise<DaemonChannel> => {
    const said = await blockedLine(entry.record.place);
    const heard = (event: Record<string, unknown>): void => {
      if (said === undefined || event["type"] === "daemon.hello") onEvent(event);
    };
    const served = servedByItsComputer(entry);
    const channel = await (served === undefined ? ownDaemonChannel(entry, heard) : servedChannel(entry, served, heard, carries));
    if (said === undefined) return channel;
    return {
      send: frame => (BLOCKED_READS.has(frame.op) ? channel.send(frame) : Promise.resolve({ id: null, ok: false, code: "unsupported", error: said })),
      close: () => channel.close(),
      closed: channel.closed,
    };
  };


  /** Where a child starts: its lead's own work branch, read off the lead's copy now and pushed first where it holds
   * commits the remote lacks, so the child's copy can start on it wherever that copy is made. Never the branch the
   * lead's work started from, which is pushed by nothing here: a lead on it, or on a branch with nothing over it, has
   * its children start where it started. A copy that did not say which branch it is on refuses the fork, since a
   * child that quietly started elsewhere would land its work elsewhere; so does a push refused, in its own words.
   * Answers the child's base and the lines the lead reads: the push, and the changes it could not carry. */
  const leadStart = async (lead: LiveWorkspace, child: string): Promise<ChildStart> => {
    await copyBlocked(lead);
    const project = projectHeld(lead.record.project);
    const started = lead.record.base ?? project.base ?? project.defaultBranch;
    const cwd = checkoutOf(lead.record);
    const said = await withDaemon(lead, ask => ask({ op: "git.status", cwd })).catch((e: unknown) => {
      throw new Error(branchUnreadRefusal(lead.record.name, e instanceof Error ? e.message : String(e)));
    });
    const read = GitStatusReply.parse(said);
    const branch = read.branch.head;
    const changed = read.entries.filter(e => e.xy !== "!!").length;
    const stayed = changed > 0 ? [uncommittedStayed(changed, lead.record.name)] : [];
    if (branch === "" || branch === DETACHED_HEAD || branch === started) return { base: started, onLeads: false, lines: stayed };
    // Ahead counts against the upstream where the branch has one, and against the default branch where it has none. An
    // upstream of another name holds nothing under this branch's own, so the push is what puts it on the remote.
    // A branch cut from the base's own remote branch with nothing ahead of it holds nothing over the base either.
    const upstream = read.branch.upstream;
    const tracksItself = upstream !== undefined && upstream.endsWith(`/${branch}`);
    const tracksBase = upstream !== undefined && started !== undefined && upstream.endsWith(`/${started}`);
    const holdsNew = read.branch.ahead > 0 || read.countsUnknown === true || (upstream !== undefined && !tracksItself && !tracksBase);
    if (!holdsNew) return tracksItself ? { base: branch, onLeads: true, lines: stayed } : { base: started, onLeads: false, lines: stayed };
    const pushed = await withDaemon(lead, ask => ask({ op: "git.push", cwd, ...(started !== undefined ? { base: started } : {}) })).catch((e: unknown) => {
      throw new Error(forkNeedsPushLine(lead.record.name, e instanceof Error ? e.message : String(e)));
    });
    const push = GitPushReply.parse(pushed);
    void ctx.readCheckout(lead, true);
    return { base: push.branch, onLeads: true, lines: [pushedForChildLine(push.branch, child), ...stayed] };
  };

  /** A child's copy put on its lead's branch as pushed, through the child's own daemon: the copy was made where the
   * project starts, since no copier sees a branch only a remote holds. A copy that would not go there is deleted with
   * the create that made it and the fork is refused in its sentence. Answers the line the fork says. */
  const startChildOn = async (child: LiveWorkspace, branch: string, lead: string): Promise<string> => {
    try {
      const put = GitStartOnReply.parse(await withDaemon(child, ask => ask({ op: "git.startOn", cwd: checkoutOf(child.record), branch })));
      if (child.record.worktree !== undefined) child.record.worktree = { ...child.record.worktree, branch: put.branch };
      await ctx.persist(child.record);
      void ctx.readCheckout(child, true);
      return childStartedLine(child.record.name, put.branch);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await ctx.workspaces.delete(child.record.id).catch((d: unknown) => console.warn(`${child.record.name} was not put on ${branch} and was not deleted: ${d instanceof Error ? d.message : String(d)}`));
      throw new Error(forkNeedsPushLine(lead, why));
    }
  };

  /** The host and owner/name a remote names, lowercase; nothing for a remote no host names. */
  const repositoryOf = (remote: string): string | undefined => {
    const host = remoteHost(remote);
    const repo = ownerRepoOf(remote)?.toLowerCase();
    return host === undefined || repo === undefined ? undefined : `${host}/${repo}`;
  };
  /** The origin a request's thread read for its own project, keyed by that request's own caller: a listing or a
   * stream's replay asks git once, and nothing outlives the request. */
  const originsRead = new WeakMap<object, { project: string; remote: string }>();
  /** A folder project here's origin as its git answers now, empty for any other project and a folder with none. Read
   * rather than kept, since the person moves an origin with git and tells no verb, and synchronous, since the rule
   * that asks is read on every event a thread's stream passes. */
  const originNow = (p: ProjectView, caller: Caller | undefined): string => {
    if (p.source.kind !== "folder" || !copiesFolder(kindForComputer(p.computer))) return "";
    const asked = typeof caller === "object" ? originsRead.get(caller) : undefined;
    if (asked?.project === p.id) return asked.remote;
    const read = spawnSync("git", ["-C", p.path, "remote", "get-url", "origin"], { encoding: "utf8", timeout: ORIGIN_READ_MS });
    const remote = read.status === 0 ? read.stdout.trim() : "";
    if (typeof caller === "object") originsRead.set(caller, { project: p.id, remote });
    return remote;
  };
  /** Whether b is of a's repository: b's saved remote names the host and owner/name a's saved remote names, or the
   * one a's origin names, asked only when the saved remotes differ. No saved remote is rewritten, so a folder pointed
   * at a fork moves nothing of the upstream's. A project with no remote a host names is one repository with nothing
   * but itself. */
  const sameRepository = (a: ProjectView, b: ProjectView, caller: Caller | undefined): boolean => {
    const theirs = repositoryOf(b.remote);
    return theirs !== undefined && (theirs === repositoryOf(a.remote) || theirs === repositoryOf(originNow(a, caller)));
  };
  return {
    startedAs, cutBefore, resumedFact, folderOf, accessOf, daemonNotes, homeOf, providerOf, placeIdOf, settingsAt,
    turnLimitOf, agentsHeld, spawnAt, projectHeld, refOf, checkoutOf, computerOf, servedByItsComputer, channelOver,
    withDaemon, overChannel, onThisComputer, placeGuard, placeRefuses, copyBlocked, WORKSPACE_FRAMES, GUEST_ROAD_FRAMES,
    portPids, heldToOwner, sharedDaemonReplaced, turnGroups, armRootsRecheck, portRootsMoved, rootedPorts, copyChannel, leadStart, startChildOn,
    sameRepository,
  };
}
