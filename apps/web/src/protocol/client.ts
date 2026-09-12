// SPDX-License-Identifier: AGPL-3.0-only
// Browser-side client for the runtime WS (see packages/runtime/src/serve.ts).
// Auth: open the socket, send one `auth` frame with the token (host injects it
// via window.__WSP__), then ops flow. The token never rides in the URL. A
// dropped socket is redialled with backoff and authed again with the same
// token; the store re-runs its standing fetches when the status comes back
// to live.
import {
  CLOUD_SETUP_WORDS,
  HarnessCatalog,
  PortForward,
  SessionAccessOutcome,
  SessionAnswerOutcome,
  SessionInterruptOutcome,
  SessionRenameResult,
  SessionSteerOutcome,
  type Capabilities,
  type DaemonChannelEvent,
  type DaemonFrame,
  type DaemonOpenReply,
  type DaemonResponse,
  type EventUnion,
  goldenHead,
  type GoldenManifest,
  type GoldenVersion,
  HostFolderListing,
  InitJob,
  InitSetup,
  type InitRoad,
  PlaceDoorView,
  PlaceView,
  type PlaceAddStep,
  type InitScreenId,
  type ImageAttachment,
  TerminalConfig,
  type TerminalScheme,
  type PortProbeView,
  type PortReachView,
  Preferences,
  type PreferencesPatch,
  ProjectExportResult,
  ProjectGolden,
  ProjectImportResult,
  ProjectPlan,
  SealedImageView,
  type SessionEvent,
  type SessionView,
  type SnapshotLineage,
  type SnapshotRollbackResult,
  type SnapshotStorage,
  type UpgradeResult,
  type WorkspaceCreateResult,
  type WorkspaceLook,
  type WorkspaceSize,
  WorkspaceCostEvent,
  type WorkspaceStatus,
  WorkspaceSysEvent,
  type WorkspaceView,
} from "@wsp/protocol";

export type ProtocolEvent = EventUnion;
type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export interface ProtocolClientOptions {
  url: string;
  token: string;
  WebSocketCtor?: typeof WebSocket;
  /** Fires on every transition; "closed" is terminal (client closed, or the token was refused). */
  onStatus?: (s: ConnStatus) => void;
  /** Fires once when the runtime refused this token and no redial can fix it, which "closed" alone does not say:
   * a client the page closed on its own reaches "closed" too. A page holding a paired device's token drops it here. */
  onUnauthorized?: () => void;
  /** Delay before redial number `attempt` (1-based); the default doubles from 250 ms and caps at 5 s. */
  backoffMs?: (attempt: number) => number;
  /** A re-subscribe found the runtime could not replay what this socket missed: anything folded from events is
   * stale and must be refetched. Fires after the redial is live, before any event from the new socket. */
  onGap?: () => void;
}
/** "connecting" until the first auth succeeds, "reconnecting" after a drop; both keep dialling. */
export type ConnStatus = "connecting" | "live" | "reconnecting" | "closed";

export type DisconnectReason = "lost" | "closed" | "unauthorized";
const DISCONNECT_MESSAGE: Record<DisconnectReason, string> = {
  lost: "runtime connection lost",
  closed: "runtime client closed",
  unauthorized: "runtime refused the token",
};

/** What every request settles with when no live socket can carry it. */
export class DisconnectedError extends Error {
  readonly reason: DisconnectReason;
  constructor(reason: DisconnectReason) {
    super(DISCONNECT_MESSAGE[reason]);
    this.name = "DisconnectedError";
    this.reason = reason;
  }
}

/** A runtime refusal. kind is the typed failure when the runtime has one (engine
 * WspError kinds such as "concurrency", the provider's machine cap). */
export class RequestError extends Error {
  readonly kind: string | undefined;
  constructor(message: string, kind?: string) {
    super(message);
    this.name = "RequestError";
    this.kind = kind;
  }
}

export const defaultBackoffMs = (attempt: number): number => Math.min(5_000, 250 * 2 ** (attempt - 1));

export class ProtocolClient {
  #ws: WebSocket | null = null;
  #seq = 0;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(e: ProtocolEvent) => void>();
  /** Per-channel listeners for the frames the host relays from a daemon. Kept off #listeners on purpose: a pty
   * chunk is not history, and the store folds everything that reaches an event listener. */
  #channels = new Map<string, Set<(e: DaemonChannelEvent) => void>>();
  /** Frames that arrived for a channel nobody listens to yet. The host writes the open reply and the daemon's hello
   * back to back, and two frames in one read are dispatched before the microtask that resolves the open can run, so
   * a caller that subscribes the moment it learns its channel id would still miss the hello. Bounded by the socket:
   * a channel dies with the socket that opened it, so a redial starts this empty. */
  #unclaimed = new Map<string, DaemonChannelEvent[]>();
  /** Listeners for this computer's own readings, which the host pushes on this socket. Kept off #listeners for the
   * reason the daemon's frames are: a figure ticking twice a minute is not history for the store to fold. */
  #sys = new Set<(e: WorkspaceSysEvent) => void>();
  #opts: ProtocolClientOptions;
  #Ctor: typeof WebSocket;
  #backoff: (attempt: number) => number;
  #subscribed = false;
  /** seq of the last event seen, or the runtime's head when none was; sent as `after` on every re-subscribe. */
  #cursor: number | undefined;
  /** The runtime process the cursor belongs to; sent with it, and a reply from another one is a gap. */
  #stream: string | undefined;
  #subscribeId: number | null = null;
  #everLive = false;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #dead: DisconnectReason | null = null;
  #firstLive: { resolve: () => void; reject: (e: Error) => void } | null = null;
  status: ConnStatus = "connecting";

  constructor(opts: ProtocolClientOptions) {
    this.#opts = opts;
    this.#Ctor = opts.WebSocketCtor ?? globalThis.WebSocket;
    this.#backoff = opts.backoffMs ?? defaultBackoffMs;
  }

  /** Resolves on the first live socket, however many dials that takes; rejects only when the token is refused. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#firstLive = { resolve, reject };
      this.#dial();
    });
  }

  async request<T = Record<string, unknown>>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.status !== "live") throw new DisconnectedError(this.#dead ?? "lost");
    const id = this.#next();
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: v => resolve(v as T), reject });
      this.#raw({ id, op, ...params });
    });
  }

  /** Frames the host pushes for one channel, in order; stops when the unsubscribe runs. */
  onDaemonFrame(channel: string, fn: (e: DaemonChannelEvent) => void): () => void {
    let fns = this.#channels.get(channel);
    if (!fns) {
      fns = new Set();
      this.#channels.set(channel, fns);
    }
    fns.add(fn);
    for (const e of this.#unclaimed.get(channel) ?? []) fn(e);
    this.#unclaimed.delete(channel);
    return () => {
      fns.delete(fn);
      if (fns.size === 0) this.#channels.delete(channel);
    };
  }

  /** Readings of the computer this host runs on, pushed for every workspace this socket asked about. */
  onSysSample(fn: (e: WorkspaceSysEvent) => void): () => void {
    this.#sys.add(fn);
    return () => this.#sys.delete(fn);
  }

  subscribe(fn: (e: ProtocolEvent) => void): () => void {
    this.#listeners.add(fn);
    if (!this.#subscribed) { this.#subscribed = true; if (this.status === "live") this.#sendSubscribe(); }
    return () => this.#listeners.delete(fn);
  }

  #sendSubscribe(): void {
    this.#subscribeId = this.#next();
    this.#raw({
      id: this.#subscribeId,
      op: "events.subscribe",
      ...(this.#cursor !== undefined ? { after: this.#cursor } : {}),
      ...(this.#stream !== undefined ? { stream: this.#stream } : {}),
    });
  }

  #onSubscribed(msg: Record<string, unknown>): void {
    if (typeof msg.seq !== "number") return;
    const stream = typeof msg.stream === "string" ? msg.stream : undefined;
    const gap = msg.gap === true || (this.#stream !== undefined && stream !== undefined && stream !== this.#stream);
    if (gap || this.#cursor === undefined) this.#cursor = msg.seq;
    this.#stream = stream;
    if (gap) this.#opts.onGap?.();
  }

  close(): void { this.#die("closed"); }

  #next(): number { return ++this.#seq; }
  #raw(o: Record<string, unknown>): void { this.#ws?.send(JSON.stringify(o)); }
  #setStatus(s: ConnStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.#opts.onStatus?.(s);
  }

  #dial(): void {
    if (this.#dead) return;
    const ws = new this.#Ctor(this.#opts.url);
    this.#ws = ws;
    ws.onopen = () => this.#raw({ id: 0, op: "auth", token: this.#opts.token });
    ws.onmessage = e => { if (this.#ws === ws) this.#onMessage(String((e as MessageEvent).data)); };
    ws.onerror = () => {}; // a close event always follows
    ws.onclose = ev => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#unclaimed.clear();
      this.#failAll(new DisconnectedError("lost"));
      // 4401 is the runtime refusing the token; redialling cannot fix that.
      if (ev.code === 4401) this.#die("unauthorized");
      else this.#scheduleRedial();
    };
  }

  #scheduleRedial(): void {
    this.#setStatus(this.#everLive ? "reconnecting" : "connecting");
    this.#attempt++;
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; this.#dial(); }, this.#backoff(this.#attempt));
  }

  #onAuth(ok: boolean): void {
    if (!ok) { this.#die("unauthorized"); return; }
    this.#attempt = 0;
    this.#everLive = true;
    // Re-arm before the status flips so the store's refetches never race ahead of the subscription.
    if (this.#subscribed) this.#sendSubscribe();
    this.#setStatus("live");
    const first = this.#firstLive;
    this.#firstLive = null;
    first?.resolve();
  }

  /** Terminal: no socket, no redial. close() before the first live leaves connect() pending, since
   * nothing awaits a client that was thrown away and a rejection there would fault every unmount. */
  #die(reason: DisconnectReason): void {
    if (this.#dead) return;
    this.#dead = reason;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
    this.#unclaimed.clear();
    this.#failAll(new DisconnectedError(reason));
    this.#setStatus("closed");
    const first = this.#firstLive;
    this.#firstLive = null;
    if (reason === "unauthorized") {
      first?.reject(new DisconnectedError(reason));
      this.#opts.onUnauthorized?.();
    }
  }

  #onMessage(data: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }
    if (typeof msg.type === "string" && !("ok" in msg)) { // server-push event
      if (msg.type.startsWith("daemon.")) {
        if (typeof msg.channel !== "string") return;
        const fns = this.#channels.get(msg.channel);
        if (fns === undefined) {
          const held = this.#unclaimed.get(msg.channel) ?? [];
          held.push(msg as unknown as DaemonChannelEvent);
          this.#unclaimed.set(msg.channel, held);
          return;
        }
        for (const fn of fns) fn(msg as unknown as DaemonChannelEvent);
        return;
      }
      if (msg.type === "workspace.sys") {
        // Parsed, not trusted: a row paints only figures the wire type vouches for, as a daemon's own samples are.
        const reading = WorkspaceSysEvent.safeParse(msg);
        if (reading.success) for (const fn of this.#sys) fn(reading.data);
        return;
      }
      if (typeof msg.seq === "number") this.#cursor = msg.seq;
      for (const fn of this.#listeners) fn(msg as unknown as ProtocolEvent);
      return;
    }
    const id = msg.id;
    if (id === 0) { this.#onAuth(msg.ok === true); return; }
    if (typeof id !== "number") return;
    if (id === this.#subscribeId) { this.#onSubscribed(msg); return; }
    const p = this.#pending.get(id);
    if (!p) return;
    this.#pending.delete(id);
    if (msg.ok === false) p.reject(new RequestError(String(msg.error ?? "request failed"), typeof msg.kind === "string" ? msg.kind : undefined));
    else p.resolve(msg);
  }

  #failAll(e: Error): void { for (const p of this.#pending.values()) p.reject(e); this.#pending.clear(); }
}

/** What a remove took: whether a computer of that id was there, what the sweep took off it, what its workspaces
 * said as they went, and the one line for a computer that was not connected to sweep. */
export interface PlaceRemoved {
  removed: boolean;
  swept: string[];
  dropped: string[];
  note?: string;
}

/** The ssh road of Add a computer: the login as a person's terminal would take it. No key rides here; the host
 * logs in through the ssh agent and config as they stand, which is what the note under the fields promises. */
export interface SshLogin {
  address: string;
  port?: number;
}

/** One line of the installer's progress as the sheet draws it: the step it belongs to, the words, whether it is
 * running, and the figure at its right end where the stage carries one. The step is what a line is: a line's words
 * change as it runs, so a list keyed by them would draw the finished step as a second line. */
export interface InstallStage {
  step: PlaceAddStep;
  word: string;
  state: "running" | "done";
  fact?: string;
}

export interface Api {
  listWorkspaces(): Promise<WorkspaceView[]>;
  getWorkspace(id: string): Promise<WorkspaceView>;
  /** `size` is one of capabilities().sizes; absent, the workspace takes the golden's size. `on` is the computer or
   * provider it lands on, by the id its own row carries; absent, wherever a fork last landed. */
  createWorkspace(golden: string, name?: string, size?: WorkspaceSize, on?: string): Promise<CreatedWorkspace>;
  /** Makes this computer the host's one local workspace, named after this computer, which the host is the one to
   * know. It forks nothing, so there is no image, no size and no boot to wait on: the record is written and the
   * reply is the workspace. Rejects with the host's own sentence when this computer already is one. Optional so
   * fixtures without the road need not fake it; a client without it offers no road to this computer. */
  createLocalWorkspace?(): Promise<WorkspaceView>;
  /** Resolves the default golden manifest's head so the UI never handles snapshot ids. */
  createFromGoldenHead(name: string, size?: WorkspaceSize, on?: string): Promise<CreatedWorkspace>;
  /** Snapshot of enriched statuses; keeps the runtime's poller + cost ticker running for this socket. */
  watchStatuses(): Promise<WorkspaceStatus[]>;
  nap(id: string): Promise<WorkspaceView>;
  wake(id: string): Promise<WorkspaceView>;
  /** Stops a wake that is asking the provider again on its own. Optional so a fixture that never wakes need not fake it. */
  stopWake?(id: string): Promise<WorkspaceView>;
  /** A person typed into the workspace; the runtime's idle window starts over. Optional so fixtures that never open a terminal need not fake it. */
  touch?(id: string): Promise<void>;
  /** Replaces the machine with a fresh golden fork at the new size; gate on capabilities().resize. */
  upgrade(id: string, size: WorkspaceSizeSpec): Promise<WorkspaceView>;
  /** Moves the workspace onto the golden's head version, carrying its files across and naming the ones of the
   * image's own it changed. Optional so fixtures that never show the lineage need not fake it. */
  updateImage?(id: string): Promise<UpgradeResult>;
  /** Replaces a zombie's machine with a fresh golden fork carrying the vault; id and name stay. Optional so fixtures without a zombie need not fake it. */
  rebuild?(id: string): Promise<WorkspaceView>;
  /** Drops a workspace whose machine is gone from the host's store; the row leaves on workspace.deleted. The host refuses
   * while the machine exists. Optional so fixtures without a gone machine need not fake it. */
  forget?(id: string): Promise<void>;
  /** Names the workspace on the host. The name is unique there, so a name another workspace holds and a blank one are
   * refused with that reason and nothing is renamed. Optional so fixtures that never rename need not fake it; a client
   * without it offers no rename. */
  renameWorkspace?(id: string, name: string): Promise<WorkspaceView>;
  /** Sets the workspace's hue, its glyph, or both on the host. A key left out keeps that fact as it is and null clears
   * it. Optional so fixtures that never pick a look need not fake it; a client without it offers no picker. */
  setWorkspaceLook?(id: string, look: WorkspaceLook): Promise<WorkspaceView>;
  /** The guest ports the host forwards to this computer's loopback; forward.open and forward.close keep the list current. Optional so fixtures without forwards need not fake it. */
  listForwards?(): Promise<PortForward[]>;
  stopForward?(workspaceId: string, port: number): Promise<void>;
  /** Takes a computer or a provider back out: the host sweeps wsp off it over its link where it is connected, drops
   * the workspaces standing on it and the record. */
  removePlace?(placeId: string): Promise<PlaceRemoved>;
  /** The ssh road of Add a computer: the host logs in as the person's terminal would, installs wsp on the box and
   * waits for the box to dial back, calling `onStage` with each stage as the installer reaches it. Resolves with the
   * computer once it has joined. This is the one seam the sheet's ssh road calls; no op on the wire carries the
   * installer yet, so a host without it holds the road's Add rather than pretending to run one. */
  addComputerOverSsh?(login: SshLogin, onStage: (stage: InstallStage) => void): Promise<PlaceView>;
  capabilities(): Promise<Capabilities>;
  /** The road to every workspace's daemon: the host holds the socket and relays the frames. */
  daemon: DaemonApi;
  /** The public route to one guest port, for an iframe; the runtime remints near the hourly expiry, so ask again before expiresAt. */
  portReach(id: string, port: number): Promise<PortReachView>;
  /** What the host saw fetching that route once; the pane explains a refusal from it, since the frame cannot read its own
   * status. Without it the frame is the only truth. */
  portProbe?(id: string, port: number): Promise<PortProbeView>;
  /** One turn on the workspace; events arrive on the subscription, this resolves with the row. */
  startSession(opts: StartSessionOptions): Promise<SessionView>;
  /** All sessions the runtime knows, or one workspace's. */
  listSessions(id?: string): Promise<SessionView[]>;
  /** The workspace's persisted session events, oldest first: what a chat replays on mount. */
  sessionHistory(id: string): Promise<SessionEvent[]>;
  /** Stops the session's running turn; takes the runtime's session id (SessionView.id), not the harness id the events carry.
   * accepted means the turn's done is already on the wire; not-running and not-found are answers, not errors. Optional so
   * fixtures that never stop a turn need not fake it; the composer offers no stop without it. */
  interruptSession?(sessionId: string): Promise<SessionInterruptOutcome>;
  /** Sends a message into the session's running turn; takes the runtime's session id, as interruptSession does. accepted
   * means a session.steer event is on the wire; not-running means the turn beat it and the caller starts a turn instead.
   * Optional so fixtures without a steering harness need not fake it; the composer keeps the stop road without it. */
  steerSession?(sessionId: string, prompt: string, requestId: string): Promise<SessionSteerOutcome>;
  /** Answers a permission prompt the session's running turn relayed into the chat, by the prompt's id and one of its
   * options; takes the runtime's session id, as interruptSession does. answered means the tool call it blocks ran or
   * was refused and the closing event is on the wire; every other outcome closed nothing here. Optional so fixtures
   * whose harness raises no prompt need not fake it; without it a prompt row's options do nothing. */
  answerPermission?(sessionId: string, askId: string, optionId: string): Promise<SessionAnswerOutcome>;
  /** Moves the session's running turn to another access mode, from its next tool call on; takes the runtime's session
   * id, as interruptSession does. set means the turn in front of the person now runs at the picked mode; every other
   * outcome moved nothing, and the pick reaches the agent with the next message instead. Optional so fixtures without
   * a running turn need not fake it; without it a pick made mid-turn simply waits for the next message. */
  setSessionAccess?(sessionId: string, permissionMode: string): Promise<SessionAccessOutcome>;
  /** Names the session in its harness's own store on the machine; takes the runtime's session id, as interruptSession
   * does. renamed means the store took it and the next listing carries it; every other outcome named nothing, and
   * failed carries the machine's own line for the write it refused. Optional so fixtures that never rename need not
   * fake it; a client without it offers no rename. */
  renameSession?(sessionId: string, title: string): Promise<SessionRenameResult>;
  /** Drops a thread no turn ever ran on from the host's store; takes the runtime's thread id, not a session id. The
   * host refuses one whose turn reached its agent. Optional so fixtures that never forget one need not fake it; a
   * client without it offers no forget. */
  forgetThread?(threadId: string): Promise<void>;
  /** What each harness's CLI takes at launch; the composer's pickers render from it, and every start rides the model,
   * effort, context window and access resolved out of it. With a workspace the runtime asks the binaries on its
   * machine, else its table answers. Optional so fixtures without pickers need not fake it; without it the composer
   * has no agent to send to and is held with that reason. */
  listHarnesses?(workspaceId?: string): Promise<HarnessCatalog[]>;
  /** One level of the folders on the computer running the host, for the picker a browser tab has instead of the
   * desktop shell's dialog. `dir` absent, or a folder inside the roots that is gone, answers with the first root; a
   * path outside them is refused. Optional so fixtures that never browse need not fake it; without it the folder
   * field takes a typed path alone. */
  hostFolders?(dir?: string, hidden?: boolean): Promise<HostFolderListing>;
  /** The person's Ghostty config on the computer running the host, as the terminal pane applies it, read now for the
   * scheme the app shows. Optional so fixtures without a terminal need not fake it; without it the pane keeps its defaults. */
  hostTerminalConfig?(scheme: TerminalScheme): Promise<TerminalConfig>;
  /** Every computer this wsp runs on: this one, the ones joined to it, and the provider it forks on. Optional so a
   * fixture with no Settings page need not fake it. */
  placesList?(): Promise<PlaceView[]>;
  /** Opens the door a computer you own dials and answers where it is. Refused in the host's own words when this
   * host serves none. */
  placesDoor?(): Promise<PlaceDoorView>;
  /** A fresh code for a computer to join with, and when it stops being one. */
  pairIssue?(): Promise<{ code: string; expiresAt: number }>;
  /** The person's view preferences as the host keeps them, one record every client on this host shares. Optional so
   * fixtures without a settings page need not fake it; without it the defaults stand and nothing is kept. */
  preferences?(): Promise<Preferences>;
  /** The patch over the host's record; resolves with the record as it now stands, and every client hears preferences.changed. */
  setPreferences?(patch: PreferencesPatch): Promise<Preferences>;
  /** What importing a folder on this computer would carry; nothing is read into memory or uploaded. Optional so
   * fixtures that never import need not fake it; the sidebar offers no import without it. */
  planProject?(source: string): Promise<ProjectPlan>;
  /** Packs the folder and lands it on the workspace's machine; progress rides project.import events, this resolves
   * with what landed. carry and rewrite name paths from the plan's secrets; an existing dest is refused unless replace. */
  importProject?(opts: ImportProjectOptions): Promise<ProjectImportResult>;
  /** Brings a folder and the agent sessions keyed to it home from the workspace's machine; progress rides project.export
   * events, this resolves with what landed. An existing dest is refused (kind "exists") unless replace. Optional so
   * fixtures that never export need not fake it; the sidebar offers no export without it. */
  exportProject?(opts: ExportProjectOptions): Promise<ProjectExportResult>;
  /** The cloud setup as the host serves it: which keys it holds (never their values), the agents on this computer,
   * what a machine costs, and the init job when one runs or ran. Optional so fixtures without the modal need not fake
   * it; without it the sidebar's cloud row opens nothing that can start a build. */
  initGet?(): Promise<InitSetup>;
  /** Saves keys into the wsp home's .env on the host's computer: the provider key, which wires the provider, and an
   * agent's API key by the sign-in row that took it; the reply says a key is held and never carries it back. */
  initKeys?(keys: { solari?: string; rows?: Record<string, string> }): Promise<InitSetup>;
  /** Starts the init job on a road; every change after rides init.job events. */
  initStart?(o: { road: InitRoad; harness?: string }): Promise<InitJob>;
  /** Answers one of the screens; the reply carries the screens recomputed and the step moved on. */
  initAnswer?(o: { screen: InitScreenId; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob>;
  /** Moves the job to a screen the person went back to, so a setup shut there reopens there. */
  initStep?(o: { at: number }): Promise<InitJob>;
  /** Keeps what a step has ticked, picked or typed and not sent, so a sheet shut mid-step reopens on it. */
  initDraft?(o: { at: string; ticks?: string[]; answers?: Record<string, string> }): Promise<InitJob>;
  /** Runs a sign-in that ran out or failed again on the machine while the build goes on. */
  initRetry?(o: { tool: string }): Promise<InitJob>;
  /** Writes the recipe as answered and starts the build, which rides on after the reply. */
  initBuild?(o: { firstWorkspace?: string; importFolder?: string }): Promise<InitJob>;
  /** The code a sign-in's page handed back, typed into the tool waiting for it on the machine. Nothing of it is kept
   * here or on the host; refused when that sign-in is not waiting for one. */
  initSignInCode?(o: { tool: string; code: string }): Promise<InitJob>;
  /** Stops the job where it stands; refused once the machine is up. */
  initCancel?(): Promise<InitJob>;
  subscribe(fn: (e: ProtocolEvent) => void): () => void;
  /** The named golden manifest, undefined on a fresh install: that absence is what points the page at wsp init. */
  getGolden(name?: string): Promise<GoldenManifest | undefined>;
  /** Every sealed version of a golden and the head new forks use. */
  listSnapshots(name?: string): Promise<SnapshotLineage>;
  /** Every snapshot on the account by count, size and monthly cost; null when the provider cannot list them. */
  snapshotStorage(): Promise<SnapshotStorage | null>;
  /** Asks the host to push this workspace's own readings on this socket, one per poll tick, until the socket goes.
   * The road for the workspace that is this computer, whose figures the host reads in its own process; every other
   * kind's ride its daemon link. Asked again on every live transition, as the daemon link's own watches are: a
   * subscription dies with the socket that made it. Optional so a fixture with no host behind it need not fake it. */
  watchSys?(workspaceId: string): Promise<void>;
  /** The readings those asks push, for every workspace this socket asked about. */
  onSysSample?(fn: (e: WorkspaceSysEvent) => void): () => void;
  /** The workspace's cost ticks since the runtime began metering it, folded to the rate changes and the newest. Optional
   * so fixtures without a usage chart need not fake it; without it the chart starts with the next tick. */
  costHistory?(workspaceId: string): Promise<WorkspaceCostEvent[]>;
  /** Moves head to a version in the manifest; workspaces already forked keep their image. */
  rollbackSnapshot(version: number, name?: string): Promise<SnapshotRollbackResult>;
  /** Snapshots the workspace's disk as a project golden; the runtime refuses a machine that is not first-life. Optional
   * so fixtures without a project need not fake it; the Lineage section offers no snapshot without it. */
  snapshotWorkspace?(id: string): Promise<ProjectGolden>;
  /** Every project golden the runtime took; the Lineage section lists each under the version it stands on. */
  listProjectGoldens?(): Promise<ProjectGolden[]>;
  /** The image this host owns and the copy each place holds of it, as Settings > Image reads them and as the
   * Remove dialog reads a copy's size to say what comes off that computer. Optional so a fixture that shows no
   * image section need not fake it. */
  image?(name?: string): Promise<SealedImageView>;
}

/** The page's one transport to a daemon. The route the machine answers on and the token that opens it never leave
 * the host: a page names a workspace and the host dials the road that workspace's kind answers with. */
export interface DaemonApi {
  open(workspaceId: string): Promise<DaemonOpenReply>;
  /** Resolves with the daemon's own answer, ok or not; rejects only when the host could not carry the frame. */
  send(channel: string, frame: DaemonFrame): Promise<DaemonResponse>;
  close(channel: string): Promise<void>;
  /** Frames the host pushes for one channel, in order; stops when the unsubscribe runs. */
  onFrame(channel: string, fn: (e: DaemonChannelEvent) => void): () => void;
}

export interface WorkspaceSizeSpec {
  cpu?: number;
  memMb?: number;
}

export interface StartSessionOptions {
  workspaceId: string;
  prompt: string;
  /** Minted per send; the runtime stamps it on the turn's session.start, which is how the sender tells its own start
   * from another client's with the same text. */
  requestId?: string;
  harness?: string;
  resume?: string;
  /** The thread the message goes to, by its runtime id, when the view has no session to resume: the runtime resumes
   * the thread's latest session or, after a launch that failed, runs the message as the thread's first turn. */
  thread?: string;
  /** The folder the thread starts in; it wins over project and the runtime's default folder rule. */
  cwd?: string;
  /** One of the workspace's projects by name, where the thread starts when cwd names none. */
  project?: string;
  /** Values from the harness catalog; absent leaves the CLI's own default for that flag. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  contextWindow?: string;
  /** The images the message carries. The host refuses over the caps and refuses naming the agent when that agent
   * reads no image, both before its machine is asked for anything. */
  attachments?: readonly ImageAttachment[];
}

export interface ImportProjectOptions {
  workspaceId: string;
  /** The folder on this computer as the person picked it; events echo this spelling. */
  source: string;
  /** Where it lands on the machine, absolute. */
  dest: string;
  replace?: boolean;
  carry?: string[];
  rewrite?: string[];
  /** The plan's agents whose sessions travel, by catalog id; absent, none do. */
  agents?: string[];
}

export interface ExportProjectOptions {
  workspaceId: string;
  /** The folder on the machine, absolute. */
  source: string;
  /** Where it lands on this computer, absolute; events echo this spelling. */
  dest: string;
  replace?: boolean;
  /** The agents whose sessions come home, by catalog id; absent, every agent with sessions for the folder. */
  agents?: string[];
}

/** The created view plus the runtime's notice when it stopped a builder kept after a save to make room. */
export interface CreatedWorkspace extends WorkspaceView {
  notice?: string;
}

export function makeApi(c: ProtocolClient): Api {
  const create = async (golden: string, name?: string, size?: WorkspaceSize, on?: string): Promise<CreatedWorkspace> => {
    const { workspace, notice } = await c.request<WorkspaceCreateResult>("workspaces.create", { golden, ...(name ? { name } : {}), ...size, ...(on === undefined ? {} : { on }) });
    return notice === undefined ? workspace : { ...workspace, notice };
  };
  return {
    listWorkspaces: async () => (await c.request<{ workspaces: WorkspaceView[] }>("workspaces.list")).workspaces,
    getWorkspace: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.get", { workspaceId: id })).workspace,
    createWorkspace: create,
    createLocalWorkspace: async () => (await c.request<{ workspace: WorkspaceView }>("workspaces.createLocal", {})).workspace,
    createFromGoldenHead: async (name, size, on) => {
      const { manifest } = await c.request<{ manifest?: GoldenManifest }>("golden.get", { name: "default" });
      const head = goldenHead(manifest);
      // A golden gone between the store's read and this ask: the app's own sentence, never a command to run.
      if (!head) throw new Error(CLOUD_SETUP_WORDS.create.none);
      return create(head.snapshotId, name, size, on);
    },
    watchStatuses: async () => (await c.request<{ statuses: WorkspaceStatus[] }>("status.subscribe")).statuses,
    nap: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.nap", { workspaceId: id })).workspace,
    wake: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.wake", { workspaceId: id })).workspace,
    stopWake: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.stopWake", { workspaceId: id })).workspace,
    touch: async id => void (await c.request("workspaces.touch", { workspaceId: id })),
    upgrade: async (id, size) =>
      (await c.request<{ workspace: WorkspaceView }>("workspaces.upgrade", { workspaceId: id, ...size })).workspace,
    updateImage: async id => await c.request<UpgradeResult>("workspaces.updateImage", { workspaceId: id }),
    rebuild: async id => (await c.request<{ workspace: WorkspaceView }>("workspaces.rebuild", { workspaceId: id })).workspace,
    forget: async id => void (await c.request("workspaces.forget", { workspaceId: id })),
    renameWorkspace: async (id, name) => (await c.request<{ workspace: WorkspaceView }>("workspaces.rename", { workspaceId: id, name })).workspace,
    setWorkspaceLook: async (id, look) => (await c.request<{ workspace: WorkspaceView }>("workspaces.look", { workspaceId: id, ...look })).workspace,
    // Parsed, not trusted: a reply without the list must not become the list.
    listForwards: async () => PortForward.array().parse((await c.request<{ forwards?: unknown }>("forwards.list")).forwards),
    stopForward: async (workspaceId, port) => void (await c.request("forwards.stop", { workspaceId, port })),
    capabilities: async () => (await c.request<{ capabilities: Capabilities }>("capabilities.get")).capabilities,
    daemon: {
      open: async workspaceId => ({ channel: (await c.request<{ channel: string }>("daemon.open", { workspaceId })).channel }),
      send: async (channel, frame) => (await c.request<{ reply: DaemonResponse }>("daemon.send", { channel, frame })).reply,
      close: async channel => void (await c.request("daemon.close", { channel })),
      onFrame: (channel, fn) => c.onDaemonFrame(channel, fn),
    },
    watchSys: async workspaceId => void (await c.request("sys.subscribe", { workspaceId })),
    onSysSample: fn => c.onSysSample(fn),
    portReach: async (id, port) => (await c.request<{ reach: PortReachView }>("workspaces.portReach", { workspaceId: id, port })).reach,
    portProbe: async (id, port) => (await c.request<{ probe: PortProbeView }>("workspaces.portProbe", { workspaceId: id, port })).probe,
    startSession: async opts => (await c.request<{ session: SessionView }>("sessions.start", { ...opts })).session,
    sessionHistory: async id => (await c.request<{ events: SessionEvent[] }>("sessions.history", { workspaceId: id })).events,
    listSessions: async id =>
      (await c.request<{ sessions: SessionView[] }>("sessions.list", id !== undefined ? { workspaceId: id } : {})).sessions,
    // Parsed, not trusted: an outcome outside the enum must not read as accepted.
    interruptSession: async sessionId =>
      SessionInterruptOutcome.parse((await c.request<{ outcome?: unknown }>("sessions.interrupt", { sessionId })).outcome),
    steerSession: async (sessionId, prompt, requestId) =>
      SessionSteerOutcome.parse((await c.request<{ outcome?: unknown }>("sessions.steer", { sessionId, prompt, requestId })).outcome),
    answerPermission: async (sessionId, askId, optionId) =>
      SessionAnswerOutcome.parse((await c.request<{ outcome?: unknown }>("sessions.answer", { sessionId, askId, optionId })).outcome),
    setSessionAccess: async (sessionId, permissionMode) =>
      SessionAccessOutcome.parse((await c.request<{ outcome?: unknown }>("sessions.access", { sessionId, permissionMode })).outcome),
    // Parsed, not trusted: an outcome outside the enum must not read as renamed.
    renameSession: async (sessionId, title) => SessionRenameResult.parse(await c.request<Record<string, unknown>>("sessions.rename", { sessionId, title })),
    forgetThread: async threadId => void (await c.request("sessions.forget", { threadId })),
    // Parsed, not trusted: a picker renders only values the wire type vouches for.
    listHarnesses: async workspaceId =>
      HarnessCatalog.array().parse((await c.request<{ harnesses?: unknown }>("harnesses.list", workspaceId !== undefined ? { workspaceId } : {})).harnesses),
    // Parsed, not trusted: the picker walks and names only paths the wire type vouches for.
    hostFolders: async (dir, hidden) =>
      HostFolderListing.parse((await c.request<{ listing?: unknown }>("host.folders", { ...(dir !== undefined ? { dir } : {}), ...(hidden !== undefined ? { hidden } : {}) })).listing),
    // Parsed, not trusted: the pane paints only values the wire type vouches for.
    hostTerminalConfig: async scheme => TerminalConfig.parse((await c.request<{ config?: unknown }>("host.terminalConfig", { scheme })).config),
    placesList: async () => PlaceView.array().parse((await c.request<{ places?: unknown }>("places.list")).places),
    placesDoor: async () => PlaceDoorView.parse((await c.request<{ door?: unknown }>("places.door")).door),
    pairIssue: async () => await c.request<{ code: string; expiresAt: number }>("pair.issue"),
    // Parsed, not trusted: the page paints its theme and sizes only from values the wire type vouches for.
    preferences: async () => Preferences.parse((await c.request<{ preferences?: unknown }>("preferences.get")).preferences),
    setPreferences: async patch => Preferences.parse((await c.request<{ preferences?: unknown }>("preferences.set", { patch })).preferences),
    // Parsed, not trusted: the consent step renders only what the wire type vouches for.
    planProject: async source => ProjectPlan.parse((await c.request<{ plan?: unknown }>("project.plan", { source })).plan),
    importProject: async opts => ProjectImportResult.parse((await c.request<{ imported?: unknown }>("project.import", { ...opts })).imported),
    exportProject: async opts => ProjectExportResult.parse((await c.request<{ exported?: unknown }>("project.export", { ...opts })).exported),
    // Parsed, not trusted: the modal draws screens and rows only as the wire type vouches for them.
    initGet: async () => InitSetup.parse((await c.request<{ setup?: unknown }>("init.get")).setup),
    initKeys: async keys => InitSetup.parse((await c.request<{ setup?: unknown }>("init.keys", { ...keys })).setup),
    initStart: async o => InitJob.parse((await c.request<{ job?: unknown }>("init.start", { ...o })).job),
    initAnswer: async o => InitJob.parse((await c.request<{ job?: unknown }>("init.answer", { ...o })).job),
    initStep: async o => InitJob.parse((await c.request<{ job?: unknown }>("init.step", { ...o })).job),
    initDraft: async o => InitJob.parse((await c.request<{ job?: unknown }>("init.draft", { ...o })).job),
    initRetry: async o => InitJob.parse((await c.request<{ job?: unknown }>("init.retry", { ...o })).job),
    initBuild: async o => InitJob.parse((await c.request<{ job?: unknown }>("init.build", { ...o })).job),
    initSignInCode: async o => InitJob.parse((await c.request<{ job?: unknown }>("init.signInCode", { ...o })).job),
    initCancel: async () => InitJob.parse((await c.request<{ job?: unknown }>("init.cancel")).job),
    removePlace: async placeId => await c.request<PlaceRemoved>("places.remove", { placeId }),
    subscribe: fn => c.subscribe(fn),
    getGolden: async (name = "default") => (await c.request<{ manifest?: GoldenManifest }>("golden.get", { name })).manifest,
    listSnapshots: async name =>
      (await c.request<{ lineage: SnapshotLineage }>("snapshots.list", name !== undefined ? { name } : {})).lineage,
    snapshotStorage: async () => (await c.request<{ storage: SnapshotStorage | null }>("snapshots.storage")).storage,
    // Parsed, not trusted: the chart interpolates whatever numbers it is handed.
    costHistory: async workspaceId => WorkspaceCostEvent.array().parse((await c.request<{ points?: unknown }>("cost.history", { workspaceId })).points),
    // Parsed, not trusted: the lineage renders and forks only snapshots the wire type vouches for.
    snapshotWorkspace: async id => ProjectGolden.parse((await c.request<{ projectGolden?: unknown }>("workspaces.snapshot", { workspaceId: id })).projectGolden),
    listProjectGoldens: async () => ProjectGolden.array().parse((await c.request<{ projectGoldens?: unknown }>("projectGoldens.list")).projectGoldens),
    // Parsed, not trusted: the section draws a record and its copies only as the wire type vouches for them.
    image: async name => SealedImageView.parse((await c.request<{ view?: unknown }>("image.get", name !== undefined ? { name } : {})).view),
    rollbackSnapshot: async (version, name) => {
      const { lineage, existingWorkspaces } = await c.request<SnapshotRollbackResult>("snapshots.rollback", {
        version,
        ...(name !== undefined ? { name } : {}),
      });
      return { lineage, existingWorkspaces };
    },
  };
}
