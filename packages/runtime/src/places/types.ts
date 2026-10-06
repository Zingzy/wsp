// SPDX-License-Identifier: AGPL-3.0-only
import {
  PlaceSettings,
  type PlaceSettingsAsk,
  type PlaceSettingWord,
  PendingComputer,
  RecipeFile,
  type AgentsSignInEvent,
  type SignInLine,
  type PlaceApplied,
  type PlacePendingEvent,
  type PlaceSetup,
  type PlaceSetupEvent,
  type PlaceSync,
  type PlaceSyncEvent,
  type RecipesChangedEvent,
  type PlaceSetupStep,
  type PlaceEstimate,
  type RecipeKind,
  BackendFacts,
  type AgentSignInState,
  type MacKind,
  type DaemonEvent,
  type PlaceAddStep,
  PLACE_LOGIN_REFUSED_KIND,
  type PlaceStageEvent,
  type PlaceAddJob,
  type PlaceAuthRefusal,
  type PlaceAuthReply,
  type PlaceAuthRequest,
  type PlaceJoinReply,
  type PlaceJoinRequest,
  type PlaceEvent,
  type PlaceDial,
  type PlaceDialled,
  type PlaceProvisionRow,
  type PlaceReport,
  type PlaceBack,
  type PlaceRoad,
  type PlaceUpdateReply,
  type PlaceView,
  type WorkspaceSize,
  type PlaceProveRequest,
} from "@wsp/protocol";
import type { EngineStep, ExecResult, Machine, MachineBackend, ProvisionPlan, ProvisionStage, SetupRun } from "@wsp/engine";
import type { WebSocket } from "ws";
import type { DeviceDoor } from "../devices.js";
import type { HereDaemon, PlaceBackends } from "../runtime.js";
import type { DaemonChannel } from "../daemon-channel.js";
import type { DaemonReach } from "../reach.js";
import type { PlaceKeyPair, Seal } from "@wsp/keys";
import type { Store } from "../store.js";

/** One document per joined computer, keyed by the id this host knows it by. */
export const PLACES = "places";
/** One document per place a person set anything on, keyed by place id, holding only what they set. */
export const CAPS = "caps";
/** The one document naming which place a verb means when nobody says: the last one added. */
export const DEFAULT_COLLECTION = "place-default";
export const DEFAULT_ID = "default";

/** What the store keeps about a joined computer. The key is the whole of its identity: a computer whose key moved
 * is not this place, whatever address it dials from. */
export interface PlaceRecord {
  id: string;
  name: string;
  publicKey: string;
  joinedAt: string;
  lastSeenAt: string;
  report: PlaceReport;
  /** What the backend this computer offers said about itself the last time it was linked. Kept on the record so a
   * fork standing on this place can be held at host start, before the computer has dialled in: the capabilities,
   * the sizes and the budgets a road reads are facts about that computer, not about this moment's socket. */
  backendFacts?: BackendFacts;
  /** Where this host expects that computer: the ssh login it was installed over, and the address its last link
   * dialled in from. Written at the install and at every attach, so a row can say which machine it means while
   * the computer is saying nothing. */
  road?: PlaceRecordRoad;
  /** What the last dial of it came to. Kept so the answer outlives the window that asked for it. */
  dialled?: PlaceDialled;
  /** The setup job on this computer as it last stood; written after every step. */
  setup?: PlaceSetup;
  /** What the setup came to, row by row, written as each step ends. */
  applied?: PlaceApplied;
  /** What this computer was set up with, saved or not: what a retry, a resume and a recipe saved from it read. */
  picks?: RecipeFile;
  /** The saved recipe it follows, by slug, or none. */
  recipe?: string;
  /** Set while it is out of step with that recipe. */
  sync?: PlaceSync;
  /** When the report on this record was taken. Not lastSeenAt: that moves every minute while the link is held,
   * and the uptime in the report grows with the computer, so a row dating one by the other reads an hours-old
   * figure as a minutes-old one. */
  reportedAt?: string;
}

/** The road as the record keeps it: what a client is told, and the key file the person named at the add, which is
 * a path on this computer and stays here. */
export interface PlaceRecordRoad extends PlaceRoad {
  keyPath?: string;
  /** The key the box's ssh answered the add with: what a later remove or update holds the box against before a sudo
   * password goes there. Absent on a record made before it was kept, or where the add could read none. */
  hostKey?: string;
}

/** The rows of one kind the setup put on that computer itself, by their key in the picks: a row it found already
 * there reads present and is never counted, so a remove takes off only what wsp put there. */
export const madeBySetup = (held: PlaceRecord, kind: "folders" | "plugins"): string[] =>
  Object.keys(held.picks?.[kind] ?? {}).filter(key => held.applied?.rows.some(r => r.id === `${kind}/${key}` && r.outcome === "installed") === true);

export const isPlaceRecord = (v: unknown): v is PlaceRecord => {
  const r = v as PlaceRecord | undefined;
  return typeof r === "object" && r !== null && typeof r.id === "string" && typeof r.publicKey === "string" && typeof r.name === "string";
};

/** What a client watching the places hears. The four shapes are the protocol's own, so the host hands them straight
 * to the runtime's event bus and the app folds them with no second spelling in between. */
export type { PlaceEvent };

/** What this computer is, as a row of the same list: the list is the whole of where work can run, so the computer
 * the host runs on is on it. The host answers, since its own name and shape are its own to read. */
export interface HerePlace {
  name: string;
  label?: string;
  mac?: MacKind;
  os?: string;
  shape?: WorkspaceSize;
  engine?: "none" | "docker" | "podman";
  diskFreeBytes?: number;
}

/** What a host wires for the places it holds: its own key pair, what it is set up to fork on, and this computer's
 * own row. Absent, the runtime serves no place and every place op is refused. */
export interface PlaceWiring {
  /** The host's own ed25519 pair, made once beside the state file by the host and never written by the runtime. */
  hostKey: PlaceKeyPair;
  /** The one word for a provider the host is set up for, as a place; nothing, or no reader at all, when it forks
   * nowhere. */
  provider?(): { id: string; rateUsdPerHour: number } | undefined;
  here(): HerePlace;
  /** What this computer calls itself, which is what a joining computer shows its person from then on. */
  hostName(): string;
  /** How the agent is put on a computer over ssh; absent on a runtime served without the road that installs it,
   * where the printed join line is the only way in. */
  install?: PlaceInstaller;
  /** One login over the road a computer was added on, to tell a computer that is off from an agent that is not
   * calling home. Nothing is installed and nothing is left running: it answers or it throws the road's own line.
   * Absent on a runtime served without the ssh road, where a computer that is not linked can only be waited for. */
  dial?: PlaceDialler;
  /** The end of the agent's own log on a computer that took it and has not dialled back, over the road it was
   * installed on. Absent on a runtime served without the ssh road, where a wait that runs out has only its own
   * sentence to give. */
  log?: PlaceLogReader;
  /** How the daemon this host deploys is put on a computer that is already a place. The host wires it because the
   * binary and the table of chips it is picked from are the host's, as the installer above is. */
  update?: PlaceUpdater;
  /** How the agent is taken off a computer this host is holding no link to, over the login the install used.
   * Absent on a runtime served without the ssh road, where a remove of a computer that is not connected says the
   * agent is still installed and leaves it to the person at that computer. */
  leave?: PlaceLeaver;
  /** How a login reaches root on a computer, read before a remove or an update over that login does anything there:
   * answers the road where root is reachable, the password the person typed tried where sudo asks for one, and
   * throws the add's own refusal where it is not (the sudo kind where a password would do). Absent, the login is
   * taken to be root, as every login was before sudo was a road. */
  sudoOver?(login: PlaceLogin, sudoPassword: string | undefined, act: { verb: "remove" | "update"; name: string }): Promise<string>;
  /** How a computer's picks are put on it. Absent, no computer is set up and the join and the update say nothing
   * about it. */
  provision?: PlaceProvisioner;
  /** Puts the GitHub token this computer's gh holds into the vault, where the picks say GitHub signs in from it and
   * the vault holds none yet: the clone of a private repo and every turn there read it from the environment. */
  githubToken?(): Promise<void>;
  /** Takes back what an add put on a computer before the host stopped mid-install, over the login that add used:
   * the script the installer left on the pending record for it. Throws the road's own sentence. */
  undo?(login: PlaceLogin, script: string): Promise<void>;
  /** Runs one script on a computer over the login the install used, for a remove that finds no link up. Answers
   * what it exited with; throws the road's own sentence where the login would not stand. */
  runOver?(login: PlaceLogin, script: string, timeoutMs: number, sudoPassword?: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** The forwards over ssh this host holds for computers that reach it no other way; the installer holds one before
   * the deploy and the records keep it held. Absent on a runtime served without the ssh road. */
  back?: PlaceBackHolder;
}

/** The forwards a host holds from a computer's own loopback to its door, one per login. */
export interface PlaceBackHolder {
  /** Holds the forward for that login until it is released, making it again each time it ends. Answers where it
   * first stood, or throws the sentence for why the first try did not; a login already held takes the new `moved`
   * and answers where it stands. `moved` hears the port on that computer whenever a remake had to take another,
   * after the place file there names it. */
  hold(login: PlaceLogin, back: PlaceBack, on: { home: string }, moved?: (back: PlaceBack) => void): Promise<PlaceBack>;
  release(login: PlaceLogin): void;
  /** The door every forward lands on, handed over once the host serves: its port on this computer's loopback as it
   * stands when asked, or nothing on a host with no door of its own. Nothing stands before it is handed. */
  door(at: () => Promise<number | undefined>): void;
  close(): void;
}

/** How a computer's picks are put on it. `setup` plans them against this computer and the one they go to; `floor`
 * puts the base tools on a computer that joined before anything was picked; `step` runs one engine step of a plan
 * there. `plan` is the recipe beside the host's state, what the doctor reads on a computer set up before picks were
 * kept. The host wires it because the reading of this computer is the host's, as the installer is. */
export interface PlaceProvisioner {
  /** `on` is the computer the plan is for: its home is what every path of the job hangs off and what the PATH the
   * job's scripts export is read from, since a directory under it is one the workspaces there write. */
  plan(on: { home: string }): Promise<ProvisionPlan | { noRecipe: string }>;
  /** `only` holds a sync to the steps it runs, so a plan for those alone reads no more of this computer than they need. */
  setup(picks: RecipeFile, on: { home: string }, only?: ReadonlySet<PlaceSetupStep>): Promise<ProvisionPlan>;
  floor(machine: Machine, on: { home: string }, stage: ProvisionStage): Promise<PlaceProvisionRow[]>;
  step(machine: Machine, plan: ProvisionPlan, step: EngineStep, run: SetupRun, stage: ProvisionStage, on: { home: string }): Promise<PlaceProvisionRow[]>;
  /** What taking rows out of a computer's picks runs there, planned off the picks as they were. Absent, a row taken
   * out of a recipe stays where it is. */
  undo?(before: RecipeFile, removed: readonly { kind: RecipeKind; name: string }[], on: { home: string }): Promise<PlaceUndo[]>;
  /** What some picks weigh on a box, read on this computer, and how many rows nobody measured. */
  estimate?(picks: RecipeFile): Promise<{ bytes: number; unmeasured: number }>;
}

/** Taking one row off a computer: the line its road takes it off by, the destinations its files landed at, or the
 * folder whose project record goes with the folder left; `ids` are the applied rows it answers for, and a row the
 * computer had before wsp (`present`) is never taken off. `note` is why nothing can be run for it. */
export interface PlaceUndo {
  key: string;
  label: string;
  ids: readonly string[];
  /** The one applied row the road's `cmd` and the folder answer for: they run only where it reads installed. */
  owner?: string;
  cmd?: string;
  dests?: readonly string[];
  folder?: string;
  note?: string;
}

/** One login over ssh as this host holds it: the address in the spelling a person would type back, and the key file
 * the add was given where they named one, which is a path on this computer and stays here. */
export interface PlaceLogin {
  ssh: string;
  keyPath?: string;
  /** The key the box's ssh answered the add with, off the record, where it was kept. */
  hostKey?: string;
}

/** One dial of a computer over the login this host holds for it, with the key file the add was given where there
 * was one. Throws with the road's own sentence (ssh's line on the ssh road), which is what a person reads in place
 * of a wsp-shaped refusal. */
export type PlaceDialler = (login: PlaceLogin) => Promise<void>;

/** The last lines the agent wrote on a computer, read over the login it was installed over. Answers nothing where
 * there is no log to read, which is a fact about that computer and not a reason to stop. */
export type PlaceLogReader = (login: PlaceLogin) => Promise<readonly string[]>;

/** What one update is told: which computer, what it last said about itself (its chip picks the binary), whether
 * this one carries a binary, the link this host is holding where it holds one, and the login it was installed
 * over where the record holds one. Which of the two roads it takes is the updater's own reading, since only it
 * knows what each can carry. */
export interface PlaceUpdateRequest {
  placeId: string;
  name: string;
  report: PlaceReport;
  /** Whether a daemon goes with this update: false on a computer already running this wsp's daemon, where the
   * login files are written all the same, since their spelling moves with the host and not with the daemon. */
  daemon: boolean;
  link?: DaemonReach;
  ssh?: PlaceLogin;
  /** The password the login's sudo took for this update, held for it alone. */
  sudoPassword?: string;
}

/** What an update answers: which road carried the binary, where it landed on that computer, and where the one it
 * replaced was kept, which is the first thing to look at on a box whose daemon will not come up. */
export interface PlaceUpdateLanded {
  road: "link" | "ssh";
  at: string;
  kept?: string;
}

/** How the daemon this host deploys is put on a computer already joined, and how wsp's login files there are
 * written on every update. Nothing is answered where no binary was asked for. Absent on a runtime served without
 * it, where a place stays on the daemon it has and its login files stay as the join wrote them. */
export type PlaceUpdater = (req: PlaceUpdateRequest) => Promise<PlaceUpdateLanded | undefined>;

/** What one leave over the ssh road is told: which computer, what it last said about itself (its own line for
 * running wsp there is in that report), and the login it was installed over. */
export interface PlaceLeaveRequest {
  placeId: string;
  name: string;
  report: PlaceReport;
  ssh: PlaceLogin;
  /** The password the login's sudo took for this remove, held for it alone. */
  sudoPassword?: string;
}

/** How the agent comes off a computer this host holds no link to: the leave that computer already carries, run
 * over the login the install used. Answers the lines it said it took; throws the road's own sentence where the
 * computer will not answer, which leaves the remove saying the agent is still installed. */
export type PlaceLeaver = (req: PlaceLeaveRequest) => Promise<readonly string[]>;

/** What one install is told: where to log in, what to call the computer, the single-use code it spends on this
 * host, and the addresses that computer is to dial it at, in the order its link tries them. The addresses are the
 * door's own reading, handed down rather than read a second time here. */
export interface PlaceInstallRequest {
  address: string;
  name?: string;
  sshPort?: number;
  keyPath?: string;
  /** The host key the person confirmed or pinned; the install compares what answered the first dial against it
   * before anything of wsp's is sent, and refuses a computer nobody confirmed a key for. */
  hostKey?: string;
  /** The password the login's sudo asks for, held for this install alone and on no record. */
  sudoPassword?: string;
  /** The whole token the join on that computer spends: the single-use code and the fingerprint of the key this
   * host will prove, as one word, the same one the printed join line carries. */
  code: string;
  hostUrls: readonly string[];
  /** The door's port on this computer's loopback, where the door is a listener of its own: what a forward over ssh
   * lands on. Absent on a host bound beyond loopback, where a forward would land on the owner's own road. */
  doorPort?: number;
  /** The relay's address among `hostUrls`, when this host is linked to one. */
  relay?: string;
  /** Awaited right before anything of wsp's is sent, with the script that would take it all back off that computer:
   * the host writes it down first, so a host that stops mid-install can finish the join or take the install back. */
  beforeDeploy?(undo: string, ssh: string): Promise<void>;
}

/** What the install answers once the computer has run its own join: the name it was given, and the key its ssh
 * answered with, which a person checks against the computer in front of them. */
export interface PlaceInstalled {
  name: string;
  hostKey?: string;
  /** The login it logged in as, in the spelling a person would type back; kept on the record as that computer's
   * address and used by every later dial of it. */
  ssh?: string;
  /** The key file the person named at the add, where they named one. Every ssh child runs with BatchMode on, so a
   * later dial that did not carry it would be refused for the publickey on a computer that is on, which is the
   * confusion this road exists to end. */
  sshKeyPath?: string;
  /** The forward that computer dials back through, where it reached this host no other way. */
  back?: PlaceBack;
}

/** How far one install has got; the words for each step are the protocol's. */
/** `ms` is how long the step took, said as it ends. */
export type PlaceStaging = (step: PlaceAddStep, state: "running" | "done" | "failed", note?: string, placeId?: string, ms?: number) => void;
export type PlaceInstaller = (req: PlaceInstallRequest, stage: PlaceStaging) => Promise<PlaceInstalled>;

/** The one road into the runtime a place needs, handed in because it is the runtime's own: a place holds its forks
 * and the projects recorded on it, and a remove refuses to take the place out from under either. */
export interface PlaceRecording {
  /** The names of the forks standing on this place: the machines wsp made there, which are the only workspaces a
   * place carries. */
  forksOn(placeId: string): Promise<string[]>;
  /** The names of the projects recorded on this place, which every workspace of them is a copy for. */
  projectsOn(placeId: string): Promise<string[]>;
  /** How many of what that place's cap counts run there now, read against every row the list holds. */
  runningOn(placeId: string, places: readonly Pick<PlaceView, "id" | "kind">[]): Promise<number>;
  /** Signs an agent in on that computer through the sign-in relay, as the app's own sign-in does: every step it
   * reaches, the page and the code among them, goes to `emit`. Absent, a machine sign-in fails its row. */
  signIn?(placeId: string, agent: string, emit: (e: AgentsSignInEvent) => void): Promise<{ leave(): void; stop?(): void }>;
  /** The line an agent's sign-in on that computer runs, its status command and that command's environment among
   * it, as the hand sign-in plans it. */
  signInLine?(placeId: string, agent: string): Promise<SignInLine>;
  /** Records one folder of this computer's as a project on that computer, seeded with what its pick keeps, by the
   * add's own road. Answers the folder's row. Absent, a folder fails its row. */
  addFolder?(placeId: string, key: string, folder: RecipeFile["folders"][string]): Promise<PlaceProvisionRow>;
  /** The remote a folder of this computer's clones from, read here; nothing where it has none. */
  folderRemote?(folder: RecipeFile["folders"][string]): Promise<string | undefined>;
  /** Takes the project a folder became on that computer off this host's list, the folder itself left where it is. */
  removeFolder?(placeId: string, key: string, folder: RecipeFile["folders"][string]): Promise<void>;
}

export interface PlaceDoorOptions {
  store: Store;
  /** The one code store, so a join code and a pairing code are spent by one road. */
  devices: DeviceDoor;
  wiring: PlaceWiring;
  recording: PlaceRecording;
  /** Where this host can fork beyond the computers joined to it: the provider it is wired to and every other
   * provider whose key it holds. A thunk because the runtime builds that table after this door. Absent leaves the
   * wired provider as the only one, which is what a runtime with no provider table has. */
  providers?: () => PlaceBackends;
  /** Every daemon event a place pushes; the panes and the inbox read these once they ride the link. */
  onDaemonEvent?: (placeId: string, event: DaemonEvent) => void;
  /** How far an install on a computer this host has never met has got; the runtime puts these on its own stream. */
  onStage?: (event: PlaceStageEvent) => void;
  /** Every frame of a setup and every move of a pending add; the runtime puts these on its own stream. */
  onSetup?: (event: PlaceSetupEvent | PlacePendingEvent | PlaceSyncEvent | RecipesChangedEvent) => void;
  /** What a place's row says about its copy of the image while it is not standing: the stage of the build running
   * there, or the reason the last one stopped. The runtime holds the builds, so it answers; nothing for a copy that
   * stands. `stopped` says which of the two the line is. */
  copyBuild?: (placeId: string) => { line: string; stopped: boolean } | undefined;
  /** How long a quiet workspace runs before it naps where its place names no window: the runtime's own default. */
  napMs?: number;
  /** The daemon this host runs for the computer it runs on, whose version its own row carries. */
  hereDaemon?: HereDaemon;
  /** A person changed the nap after on one place: the runtime arms its workspaces there again under the new window. */
  napChanged?: (placeId: string) => void;
  /** How long a computer has to dial back after its join before an install gives up on it. */
  joinWaitMs?: number;
  /** How long a computer that took an update has to dial back running it before the row is answered with what it
   * still reads; tests shrink it. */
  updateWaitMs?: number;
  /** How long one dial of a computer gets before it is an answer of its own. The bound is the runtime's and not
   * the backend's: a road that hangs rather than refusing must still answer the person who pressed the button. */
  dialWaitMs?: number;
  /** How long one machine frame waits for its answer when the caller named no bound of its own; tests shrink it. */
  frameWaitMs?: number;
  /** How long a request that may be asked again waits for a computer's link to come back before it fails as one
   * that may not does; tests shrink it. */
  relinkWaitMs?: number;
  /** How long between the writes of a linked place's last seen, so a link held for a day is not a write a second. */
  seenEveryMs?: number;
  /** What this host holds for the agents, read at every ask as the turns read it: which variable is held decides
   * the sign-in word a computer's row says for an agent that keeps no login of its own there. Absent is a vault
   * holding nothing, which is what a host wired without one has. */
  vault?: () => Readonly<Record<string, string>>;
  /** The saved recipes as this computer has them now, by slug, which a computer that follows one is held against.
   * Absent, nothing syncs. */
  recipes?: () => RecipeResolver | undefined;
  now?: () => number;
}

/** A saved recipe resolved against this computer now: its file, what this computer has for each row, the hash. */
export interface RecipeResolver {
  resolve(slug: string): Promise<{ file: RecipeFile; items: Record<string, string>; hash: string }>;
  resolveFile(file: RecipeFile): Promise<{ file: RecipeFile; items: Record<string, string>; hash: string }>;
}

/** The host's half of one handshake: what it answers the other end with, the bytes that end's own signature must
 * cover, and the seal the frames after the answer ride inside. */
export interface PlaceChallenge {
  nonce: string;
  hostPublicKey: string;
  signature: string;
  ephemeral: string;
  expect: Uint8Array;
  seal: Seal;
}

/** The host's side of the place link: the records, the keys, the handshake, the live links and what a remove takes. */
export interface PlaceDoor {
  /** The host's half of a handshake with whoever is on the other end, signed with the key this door holds and
   * nobody outside it reads: a place under its own id, a native client under the client's word. Nothing where the
   * other end sent no half of a key agreement, which only a wsp older than the seal does. */
  answerChallenge(subject: string, nonce: string, ephemeral: string | undefined): PlaceChallenge | undefined;
  /** The first frame of a joining computer. Answers the reply and the bytes its prove must sign, or nothing when
   * the code is not one this host is holding. Throws with its own sentence for a key or a report it cannot take. */
  join(req: PlaceJoinRequest, from: string, now: number): Promise<{ reply: PlaceJoinReply; expect: Uint8Array; seal: Seal; notice?: string } | undefined>;
  /** The first frame of a place that already joined. A place this host holds no record of is refused with this
   * host's own key and a signature over the refusal transcript, which that computer verifies against the key it
   * pinned at join: a refusal it can prove is one it waits ten minutes on rather than dialling every half minute
   * for good. Throws with its own sentence for a computer this host cannot agree a key with. */
  auth(req: PlaceAuthRequest, now: number): Promise<{ reply: PlaceAuthReply; expect: Uint8Array; seal: Seal } | { refusal: string; signed: PlaceAuthRefusal }>;
  /** The fingerprint of the key this door proves at every join, for the token a join line carries. Read off the
   * pair the handshake signs with, so a line can never name a key this door will not answer with. */
  hostKey(): string;
  /** Checks the place's signature over `expect` with the key on record and reads the report it sent by the one rule
   * every report is read by. Answers the report `attach` is to take, or the sentence to refuse the socket with:
   * the key's or the report's own. A join's prove is where its code is spent and its record written, and where
   * the token its own window asked for is answered. Attaches nothing yet. */
  prove(placeId: string, req: PlaceProveRequest, expect: Uint8Array, from: string, now: number): Promise<{ report: PlaceReport; device?: { deviceId: string; deviceToken: string } } | { refusal: string }>;
  /** Takes the proved socket as this place's link, with the report `prove` answered and the seal its frames ride
   * inside; the previous link is cut. */
  attach(placeId: string, socket: WebSocket, report: PlaceReport, from: string, now: number, seal?: Seal): Promise<void>;
  link(placeId: string): DaemonReach | undefined;
  /** A channel to the daemon on one computer this host holds, over the link that computer is holding: frames go
   * up that link and the events it pushes come back to `onEvent`, so a road on this host drives that computer's
   * own terminal. Nothing is dialled and no token is spent: only that computer can open a socket to this host,
   * and this is the one it opened. Undefined on a place that is not connected. */
  channel(placeId: string, onEvent: (event: Record<string, unknown>) => void): DaemonChannel | undefined;
  /** Reads what this host holds about its places into memory, so the backend a fork on one stands on is answered
   * without a read of the store; the hydration calls it once before it reads any workspace record. */
  load(): Promise<void>;
  /** The backend a place offers, off what it last said about it; undefined on a place that has never said. On a
   * place that is not connected the backend is still answered, so a record standing on it can be held without a
   * round trip, and every call on it rejects with PlaceAbsentError. */
  backendOf(placeId: string): MachineBackend | undefined;
  /** The same, asked of the place itself where this host has not heard yet: one frame, remembered on the record, so
   * every road after it is answered without one. Refuses with placeForksNowhereLine on a computer that offers no
   * backend at all. */
  forkingBackend(placeId: string): Promise<MachineBackend>;
  /** The name a place goes by, as its row shows it, for the sentences a person reads: this computer's own name too,
   * and the id itself for a place this host holds no record of. Answered without a read, so a refusal built while
   * a road is running names the computer. */
  nameOf(placeId: string): string;
  /** What the person set on one place, as load read it and every set since wrote it: answered without a read, since
   * the idle policy asks it each time it arms a workspace there. */
  settingsAt(placeId: string): PlaceSettings;
  /** How long one turn on a place runs before its reader stops it, off the kind of row the place is and what the person
   * set there, null being no limit: answered without a read, since every turn's launch asks it. Nothing for a place
   * this door lists no row for. */
  turnLimitAt(placeId: string): number | null | undefined;
  /** The sign-in word per agent on one computer, off the report it last sent and the vault this host holds: the
   * same reading its row carries, so what a turn is handed and what the screen says cannot part ways. Answered
   * without a read of the store, since every launch on that computer asks it. Nothing for a place this host holds
   * no record of and for a computer whose daemon lists no logins. */
  signInsAt(placeId: string): Record<string, AgentSignInState> | undefined;
  /** An agent's own sign-in on that computer landed, as the tool's status there said: the file its shared login
   * writes is taken as listed, so every word read before that computer's next report says signed in. */
  loginLanded(placeId: string, agent: string): Promise<void>;
  /** Which backend that computer offers, by the id of the row it serves; nothing until it has said. What a fork
   * standing there was forked by, so a row names a real provider and not the one this host happens to be wired
   * for. Answered without a read, since every view of every workspace asks it. */
  offerOf(placeId: string): string | undefined;
  /** A port on this computer's loopback carried to one port on the place's own, for as long as this host runs: the
   * place's own daemon port and every fork's daemon port ride the same code. The same pair answers the same local
   * port every time, and the listener stays bound while the link is down, so nothing cached goes stale. */
  forward(placeId: string, placePort: number): Promise<{ localPort: number }>;
  /** The place a person's word names: an id, a name, or this computer itself, which is answered with no id since
   * the host's own backend is what a fork there lands on. Refuses with noSuchPlaceRefusal naming what is held. */
  placeFor(word: string): Promise<{ placeId?: string }>;
  /** Where a fork lands when nobody says: the last place added or used, or this computer when that mark names a
   * row this host no longer holds. */
  defaultPlace(): Promise<{ placeId?: string }>;
  /** Writes the default mark: the last place a fork landed on. */
  markUsed(placeId: string | undefined): Promise<void>;
  /** Marks the place default where no mark names a place this host holds: where the first image is sealed. */
  markDefaultIfNone(placeId: string): Promise<void>;
  /** Puts the agent on a computer over ssh and waits for it to dial back as a place. Refused in one sentence on a
   * host that wired no installer. */
  add(req: { addId?: string; address: string; name?: string; sshPort?: number; keyPath?: string; hostKey?: string; sudoPassword?: string; hostUrls: readonly string[]; doorPort?: number; relay?: string; choices?: RecipeFile; recipe?: string }, now: number): Promise<PlaceAdded>;
  /** Sets a computer up from picks: a pending add that joined and waits on its choices, given them here or holding
   * them already, or a computer already set up, run again for whatever is missing, a sign-in that waits or ran out
   * among it. `ref` is a computer's id or name, or a pending add's id or address. Refused in one sentence for an add
   * that never joined, and for a computer with no picks where none are given. */
  setUp(ref: string, o: { choices?: RecipeFile; recipe?: string; addId?: string }): Promise<PlaceSetUp>;
  /** Every add that has not reached Set up, oldest first. */
  pending(): Promise<PendingComputer[]>;
  /** Keeps the person's picks so far on a pending add, and the recipe they started from, so it resumes there. `ref`
   * is the pending add's id or address, or the computer it joined as. Refused as usage where no pending add answers. */
  choose(ref: string, choices: RecipeFile, recipe?: string): Promise<PendingComputer>;
  /** Dials one computer once: a frame over the link it is holding, or one login over the road it was added on when
   * it holds none. Answers what came back and writes it on the record, so a window opened later reads the same
   * answer. Nothing is installed and nothing is left running either way. */
  dial(placeId: string, now: number): Promise<PlaceDial>;
  /** Sets what a person may set on one place, each key left out keeping what stands and each word reset taking its
   * setting back to the default, and answers the row as it now reads. Refused as usage for a place this host does
   * not hold and for a setting the place's kind does not take. */
  set(placeId: string, set: PlaceSettingsAsk, reset?: readonly PlaceSettingWord[]): Promise<{ place: PlaceView }>;
  /** The port on this computer's loopback that carries to the daemon on a linked place, opened at the first ask
   * and held with the link. Throws with the place's name when it is not connected or has said no port. */
  road(placeId: string): Promise<number>;
  /** One command on that place over its link; the refusal names the place when it is not connected. */
  exec(placeId: string, cmd: string, opts: { timeoutMs?: number; stdin?: Uint8Array }): Promise<ExecResult>;
  /** What the place last reported about itself, off its record. */
  reportOf(placeId: string): Promise<PlaceReport | undefined>;
  /** The home the place's login lands in, which every path a turn there is built from. */
  homeOf(placeId: string): Promise<string | undefined>;
  list(now: number): Promise<PlaceView[]>;
  /** Every row as list has it, caps and running counts read now, less the fork room, which asks each computer. */
  rows(): Promise<PlaceView[]>;
  /** Every add over ssh still running and the last ADDS_KEPT that finished, oldest first. */
  adds(): PlaceAddJob[];
  /** Puts the daemon this host deploys on one place where it is behind, and the login files this host spells. What
   * the computer was set up with stays: a computer that follows a recipe syncs to it, which runs only what moved.
   * Refuses in one sentence a place this host does not hold, and a computer that is behind on a runtime wired with
   * no updater. */
  update(placeId: string, ask?: { sudoPassword?: string }): Promise<PlaceUpdateReply>;
  remove(placeId: string, ask?: { sudoPassword?: string }): Promise<PlaceRemoved>;
  /** Every place a word picks, by id or by the name the person gave it: none, one, or the two that share a name,
   * which is a refusal the caller writes with the ids in it. */
  find(ref: string): Promise<PlaceRecord[]>;
  /** The saved recipe one computer follows from now, by slug, or none; answers its row. A computer that follows one
   * syncs to it. */
  follow(placeId: string, recipe: string): Promise<PlaceView>;
  /** A recipe changed, saved or edited on this computer: every computer that follows it that is out of step reads
   * Behind with what moved and syncs after `afterMs`. Answers their names. */
  recipeChanged(slug: string, afterMs?: number): Promise<string[]>;
  /** The computers that follow each saved recipe, by slug, by name. */
  followers(): Promise<Map<string, string[]>>;
  /** Skip for now on one row of a computer's setup: a sign-in that waits is stopped and its row reads skipped, and a
   * row that failed is set aside the same way, so the computer reads Ready and Settings finishes either later. Answers
   * its row. Refused for a row that neither waits nor failed. */
  skip(placeId: string, row: string): Promise<PlaceView>;
  /** The end of a computer's setup log, read off that computer over its link: a step's own lines where one is named.
   * Refused with the absent sentence where the computer is not linked. */
  setupLog(placeId: string, step?: PlaceSetupStep): Promise<string[]>;
  /** What some picks weigh against a computer's room before Set up; `ref` as setUp takes it. Refused on a runtime
   * whose provisioner weighs nothing. */
  estimate(ref: string, choices: RecipeFile): Promise<PlaceEstimate>;
  /** Takes every computer off one recipe, so each follows none; answers their names. */
  unfollow(slug: string): Promise<string[]>;
  /** What a computer was set up with; nothing for one set up before picks were kept. */
  picksOf(placeId: string): Promise<RecipeFile | undefined>;
  on(fn: (e: PlaceEvent) => void): () => void;
  close(): Promise<void>;
}

/** The one refusal for a runtime served without places wired, so the ops answer plainly rather than pretending
 * this host holds none. */
export const NO_PLACE_DOOR = "this runtime holds no places; the host that serves the app wires them";

/** The refusal an update gets on a runtime wired with no road to put a daemon on a computer. */
export const NO_PLACE_UPDATER = "this runtime carries no daemon to put on a computer; the host that serves the app wires one";

/** What the answer says about a computer that took the daemon and had not come back on it before the wait ran out.
 * Nothing has failed: the unit restarts it and the row moves on its next link. */
export const placeUpdateSlowLine = (name: string, seconds: number): string =>
  `${name} took the daemon and had not dialled back on it within ${seconds}s; its row reads the new version once it does`;

/** What a remove that ran over the login says: what changed on that computer, which is that wsp and the service that
 * starts it are gone, and never the road it took there. */
export const placeSweptOverSshLine = (name: string): string => `wsp and the service that kept it running are removed from ${name}`;

/** Why the leave over the login on the record did not finish it, which is two different things and never one: the
 * login itself would not stand, or that computer took the leave, ran it and stopped before it was done, in which
 * case its own last words are the only reading of how far it got. Every sentence about the road that had to follow
 * carries this one, since a person reading which road finished needs what the first one did. */
export const placeLoginRoadLine = (name: string, at: string, said?: string): string =>
  said === undefined ? `${name} did not answer the login at ${at}` : `${name} ran the leave over the login at ${at} and did not finish it (${said})`;

/** What a remove says when the road that logs in did not finish it and the place swept itself over the link
 * instead. The two roads take different things off, so which one finished is a person's to know: this one left the
 * service that starts the agent on that computer, and nothing here can reach it to take it. */
export const placeSweptOverLinkLine = (name: string, at: string, said?: string): string =>
  `${placeLoginRoadLine(name, at, said)}, so it swept itself over the link: its files came off and the service that starts the agent there did not`;

/** The refusal the login itself got, as against anything the computer at the end of it said: ssh would not take
 * the login, so nothing ran there at all. The roads that log in throw this one for that case alone, and the lines
 * a person reads about them turn on it. */
export class PlaceLoginRefusedError extends Error {
  readonly kind = PLACE_LOGIN_REFUSED_KIND;
}

/** A place that runs no workspaces: a joined computer whose doctor said no, or a provider with nothing to fork on.
 * The one refusal a default place may be passed over for; every other failure on it is the person's to read. */
export class PlaceForksNowhereError extends Error {}

/** An add that failed after bytes landed and whose installer took every one of them back off the computer, so a
 * join that had landed there no longer stands on it either. */
export class PlaceAddTakenBackError extends Error {}

/** A computer that is not forked into while the recipe job on it runs, which is a state of that job and not a
 * fact about the computer: the sentence is the person's own either way, and the class is what tells the roads
 * that only wait for the job apart from the ones that report a refusal. The kind rides the class, so every road
 * that throws one answers the person in the class a create there has always been refused in. */
export class PlaceProvisioningError extends Error {
  readonly kind = "conflict";
}

/** What an install answers once the computer has dialled in: which stream of steps it was, the place it became,
 * the key its ssh answered with, and why the setup did not start where it did not: a computer that joined with
 * nothing picked waits as a pending add, which rides beside it. The place's own row carries the setup while it
 * runs, so a caller reads one or the other and never both. */
export interface PlaceAdded {
  addId: string;
  place: PlaceView;
  hostKey?: string;
  said?: string;
  pending?: PendingComputer;
}

/** What a set up answers: the computer, its setup as it stands the moment it is under way, and why none started. */
export interface PlaceSetUp {
  addId: string;
  place: PlaceView;
  setup?: PlaceSetup;
  said?: string;
}

/** What a remove answers: whether a place of that id was there, what the sweep took off that computer, what the
 * workspaces standing on it said as they went, and the one line for a place that was not connected to sweep. */
export interface PlaceRemoved {
  removed: boolean;
  swept: string[];
  note?: string;
}
