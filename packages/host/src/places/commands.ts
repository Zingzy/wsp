// SPDX-License-Identifier: AGPL-3.0-only

import { platform } from "node:os";
import { addedProjectLine, defaultSeedChoice, kindForComputer, ProjectAddEvent, seedChoiceFrom, seedConsentLines, seedMenuRows, sourceKind, copiesFolder, type ProjectView, type SeedChoice, type SeedPlan, LOOPBACK, PLACE_DOOR_UNSERVED, PLACE_ADD_WORDS, PlaceUpdateReply, placeCurrentLine, PlaceAddStep, SETUP_STEP_WORDS, jsonLine, setupLines, waitLine, type AddLine, type PendingComputer, type PlaceSetup, type PlaceSetupStep, type PlaceWait, DAEMON_VERSION, joinToken, placeEngineLine, PlaceView, type DeviceView, type PlaceDoorView, authority, fmtBytes, fmtDuration, fmtSize, placeUpdateLine, shellQuote, hostKeyAsk, hostKeyUnconfirmedRefusal, PLACE_SUDO_KIND, hostKeyUnscannableRefusal, isLoopback, usageRefusal, cloudOffRefusal, SignInLine, PlaceHolds, PlaceRemoved, placeUnsavedRefusal } from "@wsp/protocol";
import { checkProviderKey, keyCheckLine, knownHostKey, offeredHostKey, sshLoginWord, sshWordReach, type KeyCheck, type MachineBackend, type SshReach } from "@wsp/engine";
import { sharedOn } from "@wsp/catalog";
import { randomBytes } from "node:crypto";
import type { CliIO } from "../cli.js";
import { servingHost } from "../host-lock.js";
import { aimName, aimedHost, type HostAim, type HostPick } from "../hosts.js";
import { PROVIDER_ENV, addedProviders, providerBackendFor, unregisteredCloud, type ProviderEnv } from "../providers.js";
import { placeLink, relaySignIn, type BoxSignIn, type BoxSignedIn, type PlaceLink } from "../place-signin.js";
import { publicHostname } from "../relay-link.js";
import { systemOpener } from "../relay.js";
import type { RelayTerminal } from "../signin-relay.js";
import { pairOnLoopbackLine, reachAddresses } from "../pairing.js";
import { systemRunner, type ServiceRunner } from "../service.js";
import { confirmedAt, dialHost, hostPlatform, table, type DialOpts, type HostClient } from "../verbs.js";
import type { HostStarter } from "../host-start.js";
import { envFileFor, writeEnvFile } from "../env-keys.js";
import { openWaits, watchSetup, type SetupWatch } from "../setup-follow.js";
import { ADD_FLAGS_REFUSAL, SIGN_IN_FLAGS_REFUSAL, addLines, addRefusal, addableProviders, boxNotSignedInLine, boxReplacesLine, boxSignedInLine, noPlaceLine, onePlace, placeNoLoginsLine, providerPlaceLine, removeLines, removeQuestion, signInAgentRefusal, signInRowCommand, signsInOnComputer } from "./add-words.js";
import type { AddFlags, SshWordReader } from "./add-words.js";
import { hostKeyHere } from "./this-computer.js";

interface PlaceDeps {
  dial(statePath: string, opts: DialOpts): Promise<HostClient>;
  now(): number;
  run: ServiceRunner;
  platform: string;
  /** How a provider is put the key this computer holds; the one check every other road takes, unless a test hands
   * its own, since a real provider is nobody's to call from a unit test. */
  checkKey(backend: MachineBackend): Promise<KeyCheck>;
  /** This terminal, for the one thing here that shows another computer's: the sign-in that runs on it. */
  terminal: RelayTerminal;
  /** Opens the tool's page on this computer when the person presses o, as a builder's sign-in does. */
  open(url: string): Promise<boolean>;
  /** The pty road to one computer's own daemon, through the host that holds its link. */
  placeLink(client: HostClient, placeId: string): Promise<PlaceLink>;
  /** Runs the tool's own sign-in on that computer; a test hands its own rather than a pty on a real box. */
  signIn(o: BoxSignIn): Promise<BoxSignedIn>;
  /** The key this computer's ssh client already holds for a computer, read with nothing dialled: a computer it
   * holds one for is one it has met, and the add proceeds as it always did. */
  heldHostKey(reach: SshReach): Promise<string | undefined>;
  /** The key a computer answers a scan with, and what in the person's own ssh config stopped the scan. */
  offeredHostKey(reach: SshReach): Promise<{ key?: string; stoppedBy?: string }>;
  /** The dial a typed word names, a login or an alias out of the person's ssh config. */
  sshWord: SshWordReader;
}

const systemDeps: PlaceDeps = {
  dial: dialHost,
  now: Date.now,
  run: systemRunner,
  platform: platform(),
  checkKey: checkProviderKey,
  terminal: { input: process.stdin, output: process.stdout },
  open: systemOpener(platform()),
  placeLink,
  signIn: relaySignIn,
  heldHostKey: reach => knownHostKey(reach),
  offeredHostKey: reach => offeredHostKey(reach),
  sshWord: (word, opts) => sshWordReach(word, opts),
};

/** What the two host-side words work on: the state file the host on this computer serves, and where this run would
 * aim a line, which is read to refuse anywhere but here. */
export interface PlaceOpts extends HostPick {
  statePath: string;
  /** The environment the provider is picked out of, carrying every registered row's key off the three layers a key
   * is read through: a provider added as a place is put the key this computer already holds under its own variable. */
  providerEnv?: ProviderEnv;
  /** What brings a host up when none serves this state file here, as every verb is handed one: these two words are
   * the host's work too, so a person who has not typed wsp up gets a host rather than a refusal. Absent starts
   * nothing, which is what a caller that wants the refusal hands in. */
  start?: HostStarter;
}

/** Where a line that works on this computer's own host dials and what brings one up if none does: the aim is this
 * computer, never a word in the environment or the account's one host, the starter is the line's own, and the one line a
 * start prints goes where everything else this line says goes. Written once, so no road out of here can dial
 * somewhere else by accident or dial without offering to start the host the others start. A caller that read the
 * aim already for its own refusal hands it back rather than reading it twice. */
export function dialHere(io: CliIO, opts: PlaceOpts, aim: HostAim = { kind: "here" }): DialOpts {
  return { aim, say: line => io.error(line), ...(opts.start !== undefined ? { start: opts.start } : {}) };
}

/** Handing out a join code and taking a place back out happen at the host's own terminal and nowhere else, the same
 * rule wsp host pair and wsp host devices read. */
function aimHere(word: string, opts: PlaceOpts): HostAim {
  const aim = aimedHost(opts.statePath, opts);
  if (aim.kind !== "here") {
    throw usageRefusal(
      `wsp ${word} runs on the computer the host runs on, and this line is aimed at ${aimName(aim)}.`,
      "Run it in a terminal over there. Which computers a wsp runs on is handed out and taken away at that host's own terminal.",
    );
  }
  return aim;
}

export async function addCommand(io: CliIO, opts: PlaceOpts, args: readonly string[], flags: AddFlags = {}, deps: PlaceDeps = systemDeps): Promise<number> {
  const [word] = args;
  if (args.length > 1) throw usageRefusal(`wsp add takes ${addedProviders().length === 0 ? "" : "one provider or "}one address, or nothing at all.`, ADD_USAGE);
  const aim = aimHere("add", opts);
  if (flags.resume === true) {
    if (word === undefined) throw usageRefusal("wsp add --resume names the computer to set up.", ADD_USAGE);
    if (flags.update === true || flags.signIn !== undefined || flags.name !== undefined || flags.sshPort !== undefined || flags.keyPath !== undefined || flags.hostKey !== undefined) throw usageRefusal(RESUME_FLAGS_REFUSAL, ADD_USAGE);
    return setUpPlace(io, opts, aim, word, flags, deps);
  }
  // A recipe, a sign-in left waiting and JSON frames are a computer's add alone; every other road takes none of them.
  const computerRoad = word !== undefined && flags.update !== true && flags.signIn === undefined && (sourceKindOf(word) === "computer" || (sourceKindOf(word) === undefined && !addableProviders().includes(word)));
  if (!computerRoad && (flags.recipe !== undefined || flags.later === true || flags.json === true)) throw usageRefusal(SETUP_FLAGS_REFUSAL, ADD_USAGE);
  if (flags.signIn !== undefined) {
    if (word === undefined) throw usageRefusal("wsp add --sign-in names the computer to sign the agent in on.", ADD_USAGE);
    if (flags.update === true || flags.name !== undefined || flags.sshPort !== undefined || flags.keyPath !== undefined || flags.hostKey !== undefined) {
      io.error(SIGN_IN_FLAGS_REFUSAL);
      return 1;
    }
    return signInOnPlace(io, opts, aim, word, flags.signIn, deps);
  }
  if (flags.update === true) {
    if (word === undefined) throw usageRefusal("wsp add --update takes the place to move onto this wsp's daemon.", ADD_USAGE);
    if (flags.name !== undefined || flags.sshPort !== undefined || flags.keyPath !== undefined || flags.hostKey !== undefined) {
      io.error(UPDATE_FLAGS_REFUSAL);
      return 1;
    }
    return updatePlace(io, opts, aim, word, deps);
  }
  const named = flags.name !== undefined || flags.sshPort !== undefined || flags.keyPath !== undefined || flags.hostKey !== undefined;
  // What one word names is read once, in the protocol: a computer of the person's own over ssh, a repo a computer
  // clones, or a folder this computer holds. A provider's own word is neither and is read first.
  const provider = word !== undefined && addableProviders().includes(word);
  const kind = word === undefined || provider ? undefined : sourceKindOf(word);
  if (kind === "computer") return addOverSsh(io, opts, aim, word!, flags, deps);
  // Every other kind a word can name is a project's source, whichever of them it is: the host reads the word again
  // and records it, so a source added to the protocol's own reading needs no second list here.
  if (kind !== undefined) return addProject(io, opts, aim, word!, flags, deps);
  // A bare word is a computer when the person's ssh config renames it, and the login its block names is what is sent.
  const alias = word === undefined || provider ? undefined : await deps.sshWord(word, sshFlags(flags)).catch(() => undefined);
  if (alias !== undefined) return addOverSsh(io, opts, aim, sshLoginWord(alias), flags, deps);
  if (named) {
    io.error(ADD_FLAGS_REFUSAL);
    return 1;
  }
  if (provider) return addProvider(io, opts, word!, deps);
  // Read after the ssh road, so a computer the person's ssh config calls by a cloud's word still joins.
  if (unregisteredCloud(word)) throw cloudOffRefusal(`wsp add ${word!}`);
  if (word !== undefined) {
    io.error(addRefusal(word));
    return 1;
  }
  const lock = servingHost(opts.statePath);
  const address = lock?.address ?? LOOPBACK;
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    const { code, expiresAt } = await client.request<{ code: string; expiresAt: number }>("pair.issue");
    const publicAt = publicHostname(opts.statePath);
    // The door a computer you own dials is the host's to open, and asking for it is what opens it: a host on
    // loopback alone can be joined once it has one, so the loopback refusal is only for a host that serves none.
    // A host that serves one and could not open it says why in its own words; pointing at --listen there would send
    // the person to fix the wrong thing.
    const asked = await client.request<{ door: PlaceDoorView }>("places.door").then(
      answer => ({ door: answer.door }),
      (e: unknown) => ({ refusal: e instanceof Error ? e.message : String(e) }),
    );
    const door = "door" in asked ? asked.door : undefined;
    if ("refusal" in asked && asked.refusal !== PLACE_DOOR_UNSERVED) io.error(asked.refusal);
    else if (door === undefined && isLoopback(address) && publicAt === undefined) io.error(pairOnLoopbackLine(address));
    const urls = door?.addresses ?? reachAddresses(address).map(at => `http://${authority(at, lock?.port ?? 0)}`);
    // Off the key file beside the state file this line is aimed at, which is the pair the host serving it signs
    // with: a door that would not open still prints a line naming the key that will answer once one does.
    for (const line of addLines(joinToken(code, hostKeyHere(opts.statePath)), expiresAt, deps.now(), urls, publicAt)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

/** The whole of what this verb answers to, printed by every refusal it has about its own shape. */
const ADD_USAGE = [
  "usage: wsp add",
  ...(addedProviders().length === 0 ? [] : ["       wsp add <provider>"]),
  "       wsp add <user@host|ssh alias> [--recipe <name>] [--later] [--name <name>] [--ssh-port <port>] [--ssh-key <path>] [--host-key <key>]",
  "       wsp add <computer> --resume [--recipe <name>] [--later]",
  "       wsp add <place> --update",
  "       wsp add <place> --sign-in <agent>",
].join("\n");

/** The refusal for --resume beside a flag about joining a computer that is not in yet. */
export const RESUME_FLAGS_REFUSAL = "wsp add --resume sets up a computer already added, so it takes --recipe, --later and --json alone.";

/** The refusal for the setup's flags on an add that is not a computer's. */
export const SETUP_FLAGS_REFUSAL = "wsp add takes --recipe, --later and --json for a computer alone: a user@host, an ssh alias, or a computer with --resume.";

/** The refusal for the update flag beside a flag about joining a computer that is not in yet. */
export const UPDATE_FLAGS_REFUSAL =
  "wsp add --update names a computer already in this wsp, so it takes none of the flags a join takes. Drop them, or drop --update to join a computer.";

/** What the line prints about the daemon half of an update: the versions either side and the road the binary took,
 * so a person reading it can tell the link road from the ssh one without asking, or the one line for a computer
 * that already runs this wsp's daemon and took the recipe alone. */
export function updatedLines(answer: PlaceUpdateReply): string[] {
  const daemon = answer.daemon;
  if (daemon === undefined) return [placeCurrentLine(answer.name, DAEMON_VERSION)];
  return [
    `${answer.name}: daemon ${daemon.from} to ${daemon.to}, over the ${daemon.road === "ssh" ? "ssh road" : "link"}`,
    `its binary      ${daemon.at}`,
    // Where the one it replaced was kept: the first thing to look at on a box whose daemon will not come up.
    ...(daemon.kept === undefined ? [] : [`the old one     ${daemon.kept}`]),
    ...(daemon.note === undefined ? [] : [daemon.note]),
  ];
}

/** One line of an add or a setup as a terminal prints it: the step's own words under its mark, how long it took
 * once it ended, and what it answered beside it. A failed step's note is the failure's first line, which the
 * terminal prints whole as the command's error where the install stopped. */
export function addLineWords(l: AddLine): string {
  const mark = l.state === "done" ? "·" : l.state === "failed" ? "x" : l.state === "skipped" ? "-" : " ";
  const words = (PlaceAddStep.options as readonly string[]).includes(l.step) ? PLACE_ADD_WORDS[l.step as PlaceAddStep] : SETUP_STEP_WORDS[l.step as PlaceSetupStep];
  const took = l.ms === undefined ? "" : ` (${fmtDuration(l.ms)})`;
  const note = l.note === undefined || (l.state === "failed" && (PlaceAddStep.options as readonly string[]).includes(l.step)) ? "" : `: ${l.note}`;
  return `  ${mark} ${words}${took}${note}`;
}

/** What a terminal prints for a sign-in that waits on the person, and for one that ran out. */
export const waitWords = (w: PlaceWait): string => `  ? ${waitLine(w)}`;

/** Where an add or a setup came to, as the line answers it: the computer's row and every step heard. */
export interface SetupFollowed {
  computer: PlaceView;
  setup: AddLine[];
  waiting: PlaceWait[];
}

/** Waits out a setup this line started and answers how it stands: until its end, and past it while a sign-in still
 * waits on the person, unless `later` says to go on and leave those waiting. The computer's row is read at the end,
 * since a wait that landed is gone from it. */
export async function followSetup(client: HostClient, placeId: string, watch: SetupWatch, o: { later?: boolean } = {}): Promise<SetupFollowed> {
  const row = async (): Promise<PlaceView | undefined> => (await client.request<{ places: PlaceView[] }>("places.list")).places.find(p => p.id === placeId);
  for (;;) {
    // Taken before the row is read, so a frame landing during the read is not missed.
    const heard = watch.next();
    const now = await row();
    if (now === undefined) throw new Error(`the computer this setup was on is gone from this host`);
    const waiting = openWaits(now.setup?.waiting ?? []);
    const ended = now.setup === undefined || now.setup.state !== "running";
    if (ended && (o.later === true || waiting.length === 0)) return { computer: now, setup: watch.lines, waiting: now.setup?.waiting ?? [] };
    await Promise.race([heard, client.closed.then(() => Promise.reject(new Error(client.closeWords())))]);
  }
}

/** The lines a terminal prints once a setup is over, or the one line for a computer that waits on its picks. */
function setupEndLines(followed: SetupFollowed): string[] {
  const { computer } = followed;
  if (computer.setup === undefined) return [];
  return setupLines(computer.name, computer.setup, computer.applied, row => signInRowCommand(computer.name, row));
}

/** What the line exits with once a setup it followed is over: 1 where a step that blocks stopped it, 0 at Ready and
 * at Needs you, since the computer is there and the person has what to do. */
const setupExit = (followed: SetupFollowed): number => (followed.computer.setup?.state === "failed" ? 1 : 0);

/** One place moved onto this wsp's daemon. The work is the host's, over the socket this line opens, as the install
 * is: the binary goes over the link that place is holding, or over the ssh road the install used when it holds none,
 * and the workspaces on it and what it was set up with are kept either way. */
async function updatePlace(io: CliIO, opts: PlaceOpts, aim: HostAim, ref: string, deps: PlaceDeps): Promise<number> {
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    const picked = await onePlace(client, placeUpdateLine(ref), ref);
    if ("refusal" in picked) {
      io.error(picked.refusal);
      return 1;
    }
    try {
      const place = picked.place;
      const answer = PlaceUpdateReply.parse(
        await withSudoAsk(io, place.road?.ssh ?? place.name, sudoPassword => client.request<Record<string, unknown>>("places.update", { placeId: place.id, ...(sudoPassword !== undefined ? { sudoPassword } : {}) })),
      );
      for (const line of updatedLines(answer)) io.log(line);
      return 0;
    } catch (e) {
      // The host's own refusal: a setup already going on that computer is one sentence, and this line is over
      // rather than waiting on a run somebody else started.
      if ((e as { kind?: unknown }).kind !== "conflict") throw e;
      io.error(e instanceof Error ? e.message : String(e));
      return 1;
    }
  } finally {
    client.close();
  }
}

/** What one word to wsp add names, with the verb's own refusal for a word that names none of the forms. */
function sourceKindOf(word: string): ReturnType<typeof sourceKind> | undefined {
  try {
    return sourceKind(word);
  } catch {
    return undefined;
  }
}

/** One typed folder or repo url: a project recorded on a computer, which is what every workspace is a copy for.
 * The work is the host's, over the socket this line opens, so the app and the command line record one project the
 * same way. */
async function addProject(io: CliIO, opts: PlaceOpts, aim: HostAim, source: string, flags: AddFlags, deps: PlaceDeps): Promise<number> {
  if (flags.sshPort !== undefined || flags.keyPath !== undefined) {
    io.error(ADD_FLAGS_REFUSAL);
    return 1;
  }
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    // A folder of the person's seeding a project on a computer that clones: the menu first, and nothing is sent
    // until they have said what travels. A folder this computer copies seeds nothing and reads no menu, which the
    // computer's own kind says rather than this line: naming this computer with --on is the same road as naming
    // none, and both copy the folder where it already is.
    const onComputer = flags.on;
    const seeding = sourceKindOf(source) === "folder" && onComputer !== undefined && !(await copiesFolderOn(client, onComputer));
    let seed: SeedChoice | undefined;
    if (seeding && onComputer !== undefined) {
      const { plan } = await client.request<{ plan: SeedPlan }>("project.seed.plan", { source });
      // What would travel: their own words where they gave any, else what the catalogue ticks itself. Read before
      // the menu is drawn, so a word naming a path that never travels is refused rather than shown as ticked.
      const choice = flags.yes === true ? choiceFrom(plan, flags) : defaultSeedChoice(plan);
      for (const line of table(seedMenuRows(plan, choice))) io.log(line);
      if (flags.yes !== true) {
        for (const line of seedConsentLines(plan, onComputer, more => `wsp add ${shellQuote(source)} --on ${shellQuote(onComputer)} ${more}`)) io.log(line);
        return 0;
      }
      seed = choice;
    }
    // The computer by the name this wsp holds for it, off the same list every table reads; read before the add,
    // since the stages below land while it runs and each names the computer by its id.
    const { places } = await client.request<{ places: PlaceView[] }>("places.list").catch(() => ({ places: [] as PlaceView[] }));
    const onId = places.find(p => p.id === onComputer || p.name === onComputer)?.id;
    // The add's own stages as they land on that computer: a clone, a seed and an install take minutes there, and
    // a person watching a line that says nothing cannot tell a slow clone from a wedged one. Only that computer's,
    // and nothing at all where this line named none: a host serves every session at once, so a filter that let
    // every computer through would print another session's add into this terminal, and a folder worked where it
    // sits has no stages of its own anyway. The last of them says where the project is and the ones before it say
    // what did not land the way it was asked, so a terminal that read them says none of it again.
    const said = new Set<string>();
    const off = client.onFrame(frame => {
      const stage = ProjectAddEvent.safeParse(frame);
      if (!stage.success || onId === undefined || stage.data.computer !== onId) return;
      if (stage.data.stage === "done") said.add(stage.data.projectId);
      // A failed stage's sentence is the failure's own, which the terminal prints as the command's error.
      if (stage.data.stage !== "failed") io.log(stage.data.message);
    });
    await client.events();
    try {
      const { project, notice } = await client.request<{ project: ProjectView; notice?: string }>("projects.add", {
        source,
        ...(flags.on !== undefined ? { on: flags.on } : {}),
        ...(flags.name !== undefined ? { name: flags.name } : {}),
        ...(flags.base !== undefined ? { base: flags.base } : {}),
        ...(flags.into !== undefined ? { into: flags.into } : {}),
        ...(seed !== undefined ? { seed } : {}),
      });
      // A record that stood with nothing to land on that computer runs no stage at all, so this terminal says
      // both itself: the folder worked where it sits, and a repo a workspace of it clones inside its own copy.
      // By the project's own id, since another session's add on the same computer prints into this terminal too.
      if (!said.has(project.id)) {
        io.log(addedProjectLine(project, new Map(places.map(p => [p.id, p.name])), hostPlatform()));
        if (notice !== undefined) io.log(notice);
      }
    } finally {
      off();
    }
    return 0;
  } finally {
    client.close();
  }
}

/** Whether the computer a word names copies a folder here by directory rather than cloning onto its own disk: the
 * kind table's own answer for the computer that word is, off the same places listing every other row reads. A
 * word naming no computer is left to the host, which refuses it naming the computers there are. */
async function copiesFolderOn(client: HostClient, word: string): Promise<boolean> {
  const { places } = await client.request<{ places: PlaceView[] }>("places.list").catch(() => ({ places: [] as PlaceView[] }));
  const found = places.find(p => p.id === word || p.name === word);
  return found !== undefined && copiesFolder(kindForComputer(found.id));
}

/** What the person's own words make of the menu: the ticks the catalog decided, then their keeps and cuts and the
 * two words that drop the memory folder and the patch. The rules are the protocol's, read the same way by the app. */
function choiceFrom(plan: SeedPlan, flags: AddFlags): SeedChoice {
  return seedChoiceFrom(plan, flags.keep ?? [], flags.cut ?? [], {
    ...(flags.noMemory === true ? { memory: false } : {}),
    ...(flags.noCommits === true ? { commits: false } : {}),
    ...(flags.remember === true ? { remember: true } : {}),
  });
}

/** One typed address: the host logs in over ssh, installs the agent and waits for that computer to dial back. The
 * work is the host's, over the socket this line opens, so what the app does and what this prints are one road; the
 * steps come back as events and each is printed as it lands. */
async function addOverSsh(io: CliIO, opts: PlaceOpts, aim: HostAim, address: string, flags: AddFlags, deps: PlaceDeps): Promise<number> {
  const confirmed = await confirmedHostKey(io, address, flags, deps);
  if (confirmed === undefined) return 1;
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  // Minted here rather than read off the reply: the steps come back while the install runs and the reply lands
  // only once it is over, so a line printed as it happens has to know which stream is this one's.
  const addId = `a_${randomBytes(6).toString("hex")}`;
  try {
    // The setup's own lines ride the same stream and are watched from here too, since it starts inside the add and
    // its first steps land before the add answers.
    const watch = watchSetup(client, addId, setupSay(io, flags, deps));
    await client.events();
    try {
      const added = await withSudoAsk(io, address, sudoPassword =>
        client.request<{ place: PlaceView; hostKey?: string; said?: string; pending?: PendingComputer }>("places.add", {
          addId,
          address,
          ...(flags.name !== undefined ? { name: flags.name } : {}),
          ...(flags.sshPort !== undefined ? { sshPort: flags.sshPort } : {}),
          ...(flags.keyPath !== undefined ? { keyPath: flags.keyPath } : {}),
          ...(flags.recipe !== undefined ? { recipe: flags.recipe } : {}),
          ...(sudoPassword !== undefined ? { sudoPassword } : {}),
          ...confirmed,
        }),
      );
      if (flags.json !== true) for (const line of addedLines(added.place, added.hostKey)) io.log(line);
      return await followAdded(io, client, flags, added.place, watch, added.said, added.pending);
    } finally {
      watch.off();
    }
  } finally {
    client.close();
  }
}

/** How many times a line at a terminal asks for a sudo password before it says sudo's refusal: sudo's own default. */
const SUDO_ASKS = 3;

/** One request that may need the password a login's sudo asks for: an add, a remove, an update. The password is
 * asked here, without echo, only once the host has said sudo wants one, and rides the one request that carries it
 * to the host; it is held in nothing that outlives the act. Off a terminal the host's own sentence stands. */
async function withSudoAsk<T>(io: CliIO, address: string, request: (sudoPassword: string | undefined) => Promise<T>): Promise<T> {
  let sudoPassword: string | undefined;
  for (let asked = 0; ; asked++) {
    try {
      return await request(sudoPassword);
    } catch (e) {
      if ((e as { kind?: unknown }).kind !== PLACE_SUDO_KIND || io.isTTY !== true || asked === SUDO_ASKS) throw e;
      sudoPassword = await io.askSecret(sudoPasswordAsk(address, asked > 0));
    }
  }
}

/** The question an add at a terminal puts for a sudo password, the first time and after sudo refused one. */
export const sudoPasswordAsk = (address: string, again: boolean): string =>
  `${again ? "sudo did not take that password; the password" : "The password"} sudo asks for on ${address.slice(0, 64)}, handed to sudo there and kept nowhere`;

/** A computer set up from its picks: a pending add that joined and waits on its choices, given a recipe here or
 * holding its choices already, or a computer already set up, run again for whatever is missing. The work is the
 * host's; this line follows it as an add's does. */
async function setUpPlace(io: CliIO, opts: PlaceOpts, aim: HostAim, ref: string, flags: AddFlags, deps: PlaceDeps): Promise<number> {
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  const addId = `a_${randomBytes(6).toString("hex")}`;
  try {
    const watch = watchSetup(client, addId, setupSay(io, flags, deps));
    await client.events();
    try {
      const answer = await client.request<{ addId: string; place: PlaceView; setup?: PlaceSetup; said?: string }>("places.setup", { ref, addId, ...(flags.recipe !== undefined ? { recipe: flags.recipe } : {}) });
      // A setup already under way answers with its own stream, which this line then follows.
      watch.also(answer.addId);
      return await followAdded(io, client, flags, answer.place, watch, answer.said);
    } finally {
      watch.off();
    }
  } finally {
    client.close();
  }
}

/** How the lines of one add or setup are said as they arrive: prose at a terminal, one frame a line under --json,
 * and a sign-in's page opened here where a person is at the terminal to finish it and did not say --later. */
function setupSay(io: CliIO, flags: AddFlags, deps: PlaceDeps): { line(l: AddLine): void; wait(w: PlaceWait): void } {
  const opened = new Set<string>();
  return {
    line: l => io.log(flags.json === true ? jsonLine({ setup: l }) : addLineWords(l)),
    wait: w => {
      io.log(flags.json === true ? jsonLine({ waiting: w }) : waitWords(w));
      if (flags.json !== true && flags.later !== true && io.isTTY === true && w.url !== undefined && w.state === "waiting" && !opened.has(w.url)) {
        opened.add(w.url);
        void deps.open(w.url).catch(() => false);
      }
    },
  };
}

/** The tail every add and setup shares: what the host said instead of starting one, the line for a computer that
 * joined and waits on its picks, else the setup followed to its end, and the computer's row as the result. */
async function followAdded(io: CliIO, client: HostClient, flags: AddFlags, place: PlaceView, watch: SetupWatch, said?: string, pending?: PendingComputer): Promise<number> {
  const result = (computer: PlaceView): void => {
    if (flags.json === true) io.log(jsonLine({ computer }));
  };
  if (said !== undefined) (flags.json === true ? io.error : io.log)(said);
  if (pending !== undefined || place.setup === undefined) {
    if (pending !== undefined && flags.json !== true) io.log(choosingLine(place.name));
    result(place);
    return 0;
  }
  const followed = await followSetup(client, place.id, watch, flags.later === true ? { later: true } : {});
  if (flags.json !== true) for (const line of setupEndLines(followed)) io.log(line);
  result(followed.computer);
  return setupExit(followed);
}

/** What an add says for a computer that joined with nothing picked: the floor goes on, and the two roads to the rest. */
export const choosingLine = (name: string): string =>
  `${name} waits on what goes on it, with the base tools going on meanwhile: choose in the app's Add a computer, or run wsp add ${name} --resume --recipe <name>`;

/** What this add sends about the computer's key, decided before anything is dialled: the one the person pinned on
 * the line, else nothing at all where this computer's ssh client already holds a key for that computer, since it
 * has met it. A computer it has never met is scanned and the key it answers with is put to the person; off a
 * terminal, and on a no, the add refuses with that key and the line that pins it, and nothing is sent. Nothing
 * back at all where the add is not to go on. */
async function confirmedHostKey(io: CliIO, address: string, flags: AddFlags, deps: PlaceDeps): Promise<{ hostKey?: string } | undefined> {
  if (flags.hostKey !== undefined) return { hostKey: flags.hostKey };
  const reach = await deps.sshWord(address, sshFlags(flags));
  if ((await deps.heldHostKey(reach).catch(() => undefined)) !== undefined) return {};
  const offered = await deps.offeredHostKey(reach).catch((): { key?: string; stoppedBy?: string } => ({}));
  if (offered.key === undefined) {
    io.error(hostKeyUnscannableRefusal(address, offered.stoppedBy));
    return undefined;
  }
  if (io.isTTY === true && (await io.ask(hostKeyAsk(address, offered.key))) === "yes") return { hostKey: offered.key };
  io.error(hostKeyUnconfirmedRefusal(address, offered.key));
  return undefined;
}

/** The port and key a person typed beside an address, in the shape every ssh reading takes them. */
function sshFlags(flags: AddFlags): { port?: number; keyPath?: string } {
  return { ...(flags.sshPort !== undefined ? { port: flags.sshPort } : {}), ...(flags.keyPath !== undefined ? { keyPath: flags.keyPath } : {}) };
}

/** What an install prints once the computer is in: what it is, the key its ssh answered with so a person can check
 * it against the computer in front of them, and what it can do. */
export function addedLines(place: PlaceView, hostKey: string | undefined): string[] {
  return [
    `${place.name} joined this wsp${place.shape === undefined ? "" : `, ${fmtSize(place.shape, "cores")}`}${place.diskFreeBytes === undefined ? "" : `, ${fmtBytes(place.diskFreeBytes)} free`}`,
    ...(hostKey === undefined ? [] : [`its ssh key      ${hostKey}`]),
    ...[placeEngineLine(place)].filter((line): line is string => line !== undefined),
    `wsp remove ${place.name} takes it back out and sweeps wsp off it.`,
  ];
}

/** A provider as a place: the words name it, and the key that opens it is put to the provider before anything is
 * written. The key is read under the variable that provider's row declares, off the same three layers every other
 * road reads a key through, and is never written here. Every row a person can add declares one, which is what
 * addedProviders answers with. */
async function addProvider(io: CliIO, opts: PlaceOpts, id: string, deps: PlaceDeps): Promise<number> {
  const env: ProviderEnv = { ...(opts.providerEnv ?? process.env), [PROVIDER_ENV]: id };
  const backend = providerBackendFor(env);
  const check = await deps.checkKey(backend);
  const said = keyCheckLine(check, id, true);
  if (check.state === "refused" && said !== undefined) {
    io.error(said);
    return 1;
  }
  // A check nothing answered says nothing about the key: it is taken, and the first fork says its own piece.
  if (said !== undefined) io.error(said);
  writeEnvFile(envFileFor(opts.statePath), { [PROVIDER_ENV]: id });
  const { pricing } = backend;
  io.log(providerPlaceLine(id, pricing.rateUsdPerHour(pricing.defaultSize)));
  if (servingHost(opts.statePath) !== undefined) io.log(`the host serving ${opts.statePath} reads that at its next start; wsp down and wsp up pick it up now.`);
  return 0;
}

/** One agent signed in on one computer already in this wsp. The work runs at this terminal: the tool's own flow is
 * shown here while it runs on that computer, over the link that computer is holding. */
async function signInOnPlace(io: CliIO, opts: PlaceOpts, aim: HostAim, ref: string, agent: string, deps: PlaceDeps): Promise<number> {
  if (!signsInOnComputer().includes(agent)) {
    io.error(signInAgentRefusal(agent));
    return 1;
  }
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  try {
    const picked = await onePlace(client, `wsp add ${ref} --sign-in ${agent}`, ref);
    if ("refusal" in picked) {
      io.error(picked.refusal);
      return 1;
    }
    return (await runBoxSignIn(io, client, picked.place, agent, deps)) ? 0 : 1;
  } finally {
    client.close();
  }
}

/** The sign-in itself and the one line it comes to. Whether it landed is what the caller answers with. */
async function runBoxSignIn(io: CliIO, client: HostClient, place: PlaceView, agent: string, deps: PlaceDeps): Promise<boolean> {
  if (sharedOn(agent) !== undefined && place.logins === undefined) {
    io.error(placeNoLoginsLine(place.name));
    return false;
  }
  if (place.signIns?.[agent] === "signed-in") io.log(boxReplacesLine(place.name, agent));
  // The host plans the line: a shared login at that computer's logins folder, any other as the owner of its home.
  const { line } = await client.request<{ line: unknown }>("agents.signInLine", { target: { placeId: place.id }, agent });
  const road = await deps.placeLink(client, place.id);
  try {
    const answer = await deps.signIn({ where: place.name, link: road.link, agent, line: SignInLine.parse(line), terminal: deps.terminal, open: deps.open });
    io.log(answer.signedIn ? boxSignedInLine(place.name, agent, answer.detail) : boxNotSignedInLine(place.name, agent, answer.said));
    // That computer lists its logins only when it dials, so the host notes this one as the app's own sign-in does.
    if (answer.signedIn) await client.request("places.loginLanded", { placeId: place.id, agent });
    return answer.signedIn;
  } finally {
    await road.close();
  }
}

/** The words wsp remove reads off its line beyond the computer it names. */
export interface RemoveFlags {
  yes?: boolean;
  force?: boolean;
  json?: boolean;
}

export const REMOVE_USAGE = "wsp remove <computer> [--yes] [--force] [--json]";

export async function removeCommand(io: CliIO, opts: PlaceOpts, args: readonly string[], flags: RemoveFlags = {}, deps: PlaceDeps = systemDeps): Promise<number> {
  const [ref] = args;
  if (ref === undefined || args.length !== 1) throw usageRefusal("wsp remove takes one computer.", `usage: ${REMOVE_USAGE}`);
  const aim = aimHere("remove", opts);
  const client = await deps.dial(opts.statePath, dialHere(io, opts, aim));
  const typed = `wsp remove ${ref}`;
  try {
    const picked = await onePlace(client, typed, ref);
    if ("refusal" in picked) {
      io.error(picked.refusal);
      return 1;
    }
    const place = picked.place;
    // What goes with it is read before the one question, so the question names it and work no remote has stops
    // the line before anybody is asked to say yes to losing it.
    const holds = PlaceHolds.parse(await client.request("places.holds", { placeId: place.id }));
    if (holds.unsaved.length > 0 && flags.force !== true) {
      const refused = placeUnsavedRefusal(place.name, holds.unsaved);
      throw usageRefusal(refused.said, refused.fix);
    }
    if (!(await confirmedAt(io, flags.yes === true, removeQuestion(place.name, holds), place.name))) return 1;
    const answer = PlaceRemoved.parse(
      await withSudoAsk(io, place.road?.ssh ?? place.name, sudoPassword =>
        client.request("places.remove", { placeId: place.id, ...(sudoPassword !== undefined ? { sudoPassword } : {}), ...(flags.force === true ? { force: true } : {}) }),
      ),
    );
    if (!answer.removed) {
      // The list this place was picked out of, so a host that holds others still names them: the record went
      // between the listing and the remove, which is the one way this is answered false.
      io.error(noPlaceLine(typed, picked.joined.map(p => p.name)));
      return 1;
    }
    // The place's own name is what a join names the device it buys, so a device still wearing it is that computer's
    // window token. Read after the remove: a host that answers no device list simply names none.
    const held = await client.request<{ devices: DeviceView[] }>("devices.list").then(
      answered => answered.devices.filter(d => d.name === place.name).map(d => d.id),
      () => [],
    );
    if (flags.json === true) io.log(jsonLine({ ...answer, ...(held.length > 0 ? { devices: held } : {}) }));
    else for (const line of removeLines(place.name, answer, held)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}
