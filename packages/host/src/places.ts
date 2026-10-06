// SPDX-License-Identifier: AGPL-3.0-only
// The four words a person types about where their agents run: wsp add, which
// hands out a join line or takes a provider's key; wsp remove, which takes a
// place back out and sweeps wsp off it; wsp join, typed on the computer they
// are sitting at, which dials the host once and then serves the link under
// this computer's own service manager; and wsp leave, the sweep run on a
// computer whose host is gone, which wsp remove cannot reach.
//
// add and remove speak to the host on this computer, at the address its lock
// names and with the token it wrote beside its state file, so neither is a
// road a paired client or an agent can reach: a join code hands out access.
// join and leave touch this computer's own files and dial nobody's host but
// the one the person typed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { addedProjectLine, defaultSeedChoice, kindForComputer, ProjectAddEvent, seedChoiceFrom, seedConsentLines, seedMenuRows, sourceKind, copiesFolder, type ProjectView, type SeedChoice, type SeedPlan, type MacKind,
  ALREADY_JOINED_LINE,
  isHttpUrl,
  machineLacksLine,
  machineNeverAnswered,
  JOIN_ADDRESS_LINE,
  LOOPBACK,
  PLACE_CODE_REFUSAL,
  PLACE_LEAVE_VERB,
  PLACE_LEAVE_LINE,
  parsePlaceFile,
  fmtPrice,
  PLACE_DOOR_UNSERVED,
  PLACE_ADD_WORDS,
  PlaceUpdateReply,
  placeCurrentLine,
  PlaceAddStep,
  SETUP_STEP_WORDS,
  jsonLine,
  lastLine,
  setupLines,
  waitLine,
  type AddLine,
  type PendingComputer,
  type PlaceSetup,
  type PlaceSetupStep,
  type PlaceWait,
  DAEMON_VERSION,
  JOIN_NO_KEY_REFUSAL,
  joinKeyRefusal,
  joinRoads,
  joinToken,
  readJoinToken,
  placeEngineLine,
  PLACE_LINK_NONCE_BYTES,
  PlaceJoinDevice,
  PlaceJoinReply,
  PlaceView,
  type DeviceView,
  type PlaceBack,
  type PlaceDoorView,
  type PlaceFile,
  type PlaceReport,
  authority,
  fmtBytes,
  fmtDuration,
  fmtSize,
  placeDaemonPaths,
  placeUpdateLine,
  shellQuote,
  shellLine,
  placeNoChipLine,
  MACHINE_PUT_PART_BYTES,
  workFolderIn,
  BACK_OVER_SSH,
  backUrl,
  dialsBackWord,
  hostKeyAsk,
  hostKeyKeptNote,
  hostKeyMatches,
  hostKeyMismatchRefusal,
  hostKeyUnconfirmedRefusal,
  PLACE_HOST_KEY_KIND,
  PLACE_SUDO_KIND,
  refusal,
  hostKeyUnscannableRefusal,
  KNOWN_HOSTS,
  PLACE_ROOT_SHELLS,
  placeRootShellRefusal,
  hostKeyRefusal,
  isLoopback,
  joinAddressOf,
  placeLinkTranscript,
  twoPlacesRefusal,
  relayUrlOf,
  usageRefusal,
  cloudOffRefusal,
  wsUrlOf,
  PLACE_NEEDS_ROOT_LINE,
  SignInLine,
  macKindOf,
  TOOL_PREFIX,
} from "@wsp/protocol";
import { GITHUB_TOKEN_ENV, MissingKnownHostsError, PlaceMachine, prefixVolume, runChild, SshBackend, SSH_DIAL_MS, SSH_LINE_CAP, boxWord, checkProviderKey, clientWords, keyCheckLine, keyFingerprint, knownHostKey, landBytes, offeredHostKey, parseSshAddress, sshClient, sshDial, sshDialsThisComputer, sshLoginWord, sshMachineName, sshRefusalLine, sshWordReach, readSshSudo, trySshSudo, knownHostsWritten, type KeyCheck, type MachineBackend, type SshReach, type SshSudo, type SshTransport } from "@wsp/engine";
import { PlaceAddTakenBackError, PlaceLoginRefusedError, freshEphemeral, makeSeal, newPlaceKeyPair, openFrame, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, type Seal, type HerePlace, type PlaceDialler, type PlaceInstaller, type PlaceKeyPair, type PlaceLeaver, type PlaceLogReader, type PlaceStaging, type PlaceUpdateLanded, type PlaceUpdater, type PlaceWiring, type PlaceBackHolder } from "@wsp/runtime";
import { BackCutError, heldPlaceScript, placeBackHolder } from "./place-back.js";
import { writeOwn } from "@wsp/own-file";
import { CATALOG_AGENTS, NO_SIGN_IN, agentName, floorBytes, hasLogin, keyEnvOf, loginSignIn, sharedAgentsOn, sharedOn } from "@wsp/catalog";
import { ADD_TAKEN_LINE, DAEMON_GONE_LINE, PLACE_JOINED_LINE, PlaceAlreadyJoinedError, PlaceJoinedThenFailedError, WSP_READY_LINE, addFound, addFoundScript, addUndoScript, cappedLine, daemonFlags, deployDaemon, joinedAddWrites, joinedLine, joinedPlace, loginFilesStep, placeInstallFailedLine, sshDaemonPlace } from "./doctor.js";
import { assetDir, assetName, daemonBinaryHere } from "./assets.js";
import { DAEMON_BIN, DAEMON_TARGETS, daemonBinaryIn, daemonTargetFor, guestDaemonTarget, guestSystem, noGuestDaemonLine, noPlaceSystemLine, type DaemonTarget } from "./daemon-binary.js";
import { runningWsp, type RunningWsp } from "./mcp-install.js";
import { createHash, randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { CliIO } from "./cli.js";
import { servingHost } from "./host-lock.js";
import { aimName, aimedHost, type HostAim, type HostPick } from "./hosts.js";
import { joinStanding, placeFilePath, placeKeyPath, placeLogPath, placeFacts, placeLogin, placeReport, placeService, readPlaceFile, sweepPlace, sweptLine, sweptSaid, writeExclusive, type ToolFolders, writePlaceFile, wspArgvOf } from "./place-report.js";
import { PROVIDER_ENV, addedProviders, providerBackendFor, unregisteredCloud, type ProviderEnv } from "./providers.js";
import { placeLink, relaySignIn, type BoxSignIn, type BoxSignedIn, type PlaceLink } from "./place-signin.js";
import { publicHostname } from "./relay-link.js";
import { systemOpener } from "./relay.js";
import type { RelayTerminal } from "./signin-relay.js";
import { advertiseWord, pairOnLoopbackLine, reachAddresses } from "./pairing.js";
import {
  installService,
  runFailureLine,
  serviceEnv,
  serviceManagerFor,
  systemRunner,
  type ServiceAddress,
  type ServiceManager,
  type ServiceRunner,
} from "./service.js";
import { dialHost, hostPlatform, sshAsked, table, type DialOpts, type HostClient } from "./verbs.js";
import type { HostStarter } from "./host-start.js";
import { envFileFor, writeEnvFile } from "./env-keys.js";
import { openWaits, watchSetup, type SetupWatch } from "./setup-follow.js";
import { collect, nodeHost } from "@wsp/collect";
import { readBrewTable } from "./init-brew.js";
import { placeProvisioner } from "./place-provision.js";
import { hostKeyHere, hostNameHere, hostPlaceKey, placeHere, placeNameHere } from "./places/this-computer.js";
import { ADD_FLAGS_REFUSAL, ADD_LOOPBACK_REFUSAL, JOIN_MS, NOTHING_TO_LEAVE_LINE, PLACE_CHECK_SCRIPT, PLACE_CHECK_SPARE_BYTES, REACH_LINE, REACH_MS, SIGN_IN_FLAGS_REFUSAL, UNDO_MS, addLines, addRefusal, addTakenLine, addUndoneLine, addableProviders, advertisedLoopbackRefusal, backRefusedLine, boxNotSignedInLine, boxReplacesLine, boxSignedInLine, brokenPlaceLeftLine, dialsBackLine, dialsBackOverSshNote, guestTargetSaid, joinCutByLeaveLine, joinRefusal, joinUnansweredLine, keyIs, noPlaceLine, noPlaceManagerLine, onePlace, parsePlaceCheck, placeCheckNote, placeCheckRows, placeHeldRefusal, placeNoLoginsLine, placeRootHomeRefusal, placeSudoRefusal, providerPlaceLine, reachScript, reachUnsaidLine, reachedUrls, removeLines, signInAgentRefusal, signsInOnComputer, unreachedLine } from "./places/add-words.js";
import type { AddFlags, SshWordReader } from "./places/add-words.js";
export * from "./places/this-computer.js";
export * from "./places/add-words.js";

/** What a host wires for its places: its own pair and this computer's own row. The provider row is the runtime's,
 * read off the provider pick a saved key moves. */
export function placeWiring(statePath: string, advertise?: string): PlaceWiring {
  const hostKey = hostPlaceKey(statePath);
  // One holder for the installer and the records: the forward an add stood is the one the record keeps.
  const back = placeBackHolder({ hostKey: keyFingerprint(hostKey.publicKey) });
  return {
    hostKey,
    back,
    // A computer's picks, planned off this computer by the same two readers a copy of the image is planned from,
    // since a box is set up from the same rows by the same roads.
    provision: placeProvisioner({
      statePath,
      home: homedir(),
      platform: hostPlatform(),
      collect: () => collect(nodeHost()),
      brew: () => readBrewTable(nodeHost()),
    }),
    // The word the person gave --advertise travels to the install, which is the one road that knows the computer
    // being joined is somewhere else and so whether that word could ever be dialled from it.
    install: placeInstaller({ back, ...(advertise === undefined ? {} : { advertise }) }),
    dial: placeDialler(),
    log: placeLogReader(),
    update: placeUpdater(),
    leave: placeLeaver(),
    sudoOver: placeSudoReader(),
    runOver: placeRunner(),
    undo: placeUndoer(),
    githubToken: () => vaultGitHubToken(statePath),
    hostName: hostNameHere,
    // This computer under the name a person would type for it, and what it is off the same read a place sends about
    // itself, so the row for the computer the host runs on carries the facts every other row carries.
    here: () => placeHere(),
  };
}

/** How the daemon is put on a computer over ssh, for the host that wires the runtime: the ssh road the workspace
 * kind already had, reused as one function. The dial and the login read are one call (`adopt`), the bundle and
 * the join code go over the same connection, and the join itself is run on that computer by the deploy, so wsp
 * never writes a unit of its own there. The steps are marked off the lines that deploy prints: WSP_READY once the
 * bundle is on the computer, PLACE_JOINED once its own join has written the place file and the unit.
 *
 * Nothing waits here for the link: the computer dials this host on its own, and the place door is what knows when
 * it has. */
export function placeInstaller(deps: { backend?: SshBackend; sshWord?: SshWordReader; daemonDir?: string; cliDir?: string; advertise?: string; back?: PlaceBackHolder } = {}): PlaceInstaller {
  return async (req, said) => {
    // Each step's time from its running line to its end, as this host saw it; the checks the box timed say their own.
    const began = new Map<PlaceAddStep, number>();
    const stage: PlaceStaging = (step, state, note, placeId, ms) => {
      if (state === "running") began.set(step, Date.now());
      const from = began.get(step);
      said(step, state, note, placeId, ms ?? (state === "running" || from === undefined ? undefined : Date.now() - from));
    };
    // A word naming no login is the one refusal before the dial where the user and the address are the fix.
    const reach = await (deps.sshWord ?? sshWordReach)(req.address, {
      ...(req.sshPort !== undefined ? { port: req.sshPort } : {}),
      ...(req.keyPath !== undefined ? { keyPath: req.keyPath } : {}),
    }).catch((e: unknown) => {
      throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
    });
    const backend = deps.backend ?? new SshBackend();
    // A computer somewhere else cannot dial this computer's own loopback, so an install that would leave the agent
    // there with no address to come back on is refused before anything lands on it. The computer being joined is
    // sometimes this one under another name, and there loopback is the address that works. Read off the address
    // the client dials, since an alias names nothing about where it lands, and a dial through a jump is never here.
    const dials = await backend.hostNameFor(reach).catch(() => reach.host);
    const here = dials !== undefined && sshDialsThisComputer({ ...reach, host: dials }, [hostname()]);
    // Read off the word itself and not off what is left after the filter: a host bound to this computer alone
    // behind a relay also carries a loopback address in that list, and nobody typed that one.
    const named = joinAddressOf(advertiseWord(deps.advertise) ?? "");
    if (!here && named !== undefined && isLoopback(new URL(named).hostname)) throw new Error(advertisedLoopbackRefusal(named));
    const hostUrls = here ? req.hostUrls : req.hostUrls.filter(at => !isLoopback(new URL(at).hostname));
    if (hostUrls.length === 0) throw new Error(ADD_LOOPBACK_REFUSAL);
    stage("connect", "running");
    // A computer this computer's ssh client has never met is dialled only once somebody has seen its key: the dial
    // writes whatever answers into this computer's known_hosts and every later dial of that computer trusts it, so
    // a stranger who controls the route or the name during this one would be recorded as the person's own box. The
    // key rides the request where the person confirmed or pinned it; where it does not and the client holds none of
    // its own, the refusal carries the key the computer answers a scan with and the line that pins it. Read before
    // anything is dialled, so the app's sheet and an older client meet the same wall the command line does.
    if (req.hostKey === undefined && (await backend.keyFor(reach).catch(() => undefined)) === undefined) {
      const offered = await backend.offeredKeyFor(reach).catch((): { key?: string; stoppedBy?: string } => ({}));
      if (offered.key === undefined) throw new Error(hostKeyUnscannableRefusal(req.address, offered.stoppedBy));
      throw Object.assign(new Error(hostKeyUnconfirmedRefusal(req.address, offered.key)), { kind: PLACE_HOST_KEY_KIND, hostKey: offered.key });
    }
    // The dial writes the box's key into this computer's own known_hosts on its way in, whether or not the login
    // that follows it stands, so the step is ticked off what the client holds afterwards and not off the login's
    // outcome: this is the one thing the add does to the computer the person is sitting at, and since the refusal
    // no longer carries ssh's own note about it, a failed login has nothing else that would say so. The file is
    // the client's own answer rather than the default the plan line names, so a config that points it elsewhere is
    // read out. A dial that never got far enough to exchange a key leaves the step where it was: nothing was written.
    const sayKey = async (key: string | undefined): Promise<void> => {
      if (key === undefined) return;
      const entry = await backend.knownHostsEntry(reach).catch((): { file?: string; target?: string } => ({}));
      stage("host-key", "done", hostKeyKeptNote(key, entry.file));
    };
    // Every refusal from the dial on says the key it wrote here; only a login that did not stand is the login's own.
    const stood = async () => {
      const loginRefused = (e: unknown): never => {
        throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
      };
      // How this login reaches root, read as the login with nothing of the person's in it: the first dial, which
      // writes the box's key here the way accept-new does.
      const road = await backend.sudoFor(reach).catch(loginRefused);
      // What answered is held against what the person pinned before anything else is asked of it: before their sudo
      // password is tried and before any session runs as root there. The read that has just run sent nothing of the
      // person's beyond the ssh identity every dial offers, and its sudo only listed a command, which runs nothing as
      // root; accept-new wrote the box's key here on the way in, so the refusal names that key, the file it went into
      // and the line that takes it out again.
      const answered = await backend.keyFor(reach).catch(() => undefined);
      if (req.hostKey !== undefined && !hostKeyMatches(req.hostKey, answered ?? "")) {
        // The file and the name the entry was written under come off the client's own one reading of the dial, never
        // off the word that was typed: a config naming a HostName or a HostKeyAlias writes the entry somewhere else,
        // and a line built here from the address would tell the person to remove an entry that is not there.
        const entry = await backend.knownHostsEntry(reach).catch((): { file?: string; target?: string } => ({}));
        throw new Error(
          hostKeyMismatchRefusal({
            address: req.address,
            pinned: req.hostKey,
            ...(answered !== undefined ? { wrote: answered } : {}),
            target: entry.target ?? reach.host,
            file: entry.file ?? KNOWN_HOSTS,
          }),
        );
      }
      // Only now the road to root: a root login, a sudo that asks for nothing, or a sudo that took the password the
      // person typed for this add. Every script after this rides that road, the password held by this one backend
      // and gone with it. A login with none of the three is read as itself, for the connect and chip rows, and
      // stopped at the root row.
      const rootBy = async (sudo: SshSudo) => {
        const noRoot = placeSudoRefusal(req.address, reach.user, reach.host, sudo);
        const rooted = noRoot !== undefined ? backend.riding({ asLogin: true }) : sudo === "taken" ? backend.riding({ sudoPassword: req.sudoPassword! }) : backend;
        return { noRoot, adopted: await rooted.adopt(reach).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) };
      };
      const tried = async (): Promise<SshSudo> => (req.sudoPassword !== undefined ? await backend.sudoTry(reach, req.sudoPassword).catch(loginRefused) : "asks");
      let { noRoot, adopted: read } = await rootBy(road === "asks" ? await tried() : road);
      // The read said root asks for nothing and the first script under sudo -n was refused for a password: a sudoers
      // the read could not see through. It is the ask, never the login's refusal, and the password where one came.
      if (read instanceof Error && road === "free" && read.message.includes("a password is required")) ({ noRoot, adopted: read } = await rootBy(await tried()));
      if (read instanceof Error) loginRefused(read);
      const adopted = read as Exclude<typeof read, Error>;
      const { machine, login, system, arch, shell, hostKey } = adopted;
      const chip = [system, arch].filter(w => w !== undefined).join(" ");
      if (noRoot !== undefined) return { root: false as const, machine, login, hostKey, chip, noRoot };
      // Which shell root runs, read off the box's own passwd entry with nothing of root's run to read it. sshd hands
      // every command the host sends to that shell with -c before wsp's own bash -c inside it, so a root running zsh
      // or fish reads a file under the /root every workspace on that box writes, as root, on every dial wsp makes.
      // The read that has just run already went through it once; what this stops is the deploy and every dial after.
      // A box that named no shell at all is one this rule says nothing about, and is taken as it always was. Over
      // sudo root's shell never runs: sshd hands the command to the login's own shell, as the login, and sudo runs
      // bash itself.
      if (road === "root" && shell !== undefined && !PLACE_ROOT_SHELLS.includes(shell)) throw new Error(placeRootShellRefusal(req.address, shell));
      if (login.HOME === "/") throw new Error(placeRootHomeRefusal(req.address));
      // The binary that lands is picked off the word the box just said about its own chip, never off this computer's:
      // the two are different computers as often as they are alike, and a binary for the wrong one starts and dies.
      // Read before anything is sent, so a chip wsp builds no daemon for leaves the box exactly as it was found.
      const target = guestTargetSaid(system, arch);
      // The join on the box refuses a computer that already holds a place file, and only after the bundle landed; read
      // by the same rule here so a box in another wsp is refused with nothing of this one's sent.
      const held = parsePlaceFile((await machine.run(heldPlaceScript(login.HOME), { deadlineMs: SSH_DIAL_MS })).stdout);
      if (held !== undefined) throw new Error(placeHeldRefusal(req.address, held, readJoinToken(req.code).hostKey));
      return { root: true as const, machine, login, hostKey, target, chip };
    };
    const standing = await stood().catch(async (e: unknown) => {
      await sayKey(await backend.keyFor(reach).catch(() => undefined));
      throw e;
    });
    const { machine, login, hostKey, chip } = standing;
    const name = req.name?.trim() !== undefined && req.name.trim() !== "" ? req.name.trim() : sshMachineName(reach);
    stage("connect", "done", await osSaid(machine));
    await sayKey(hostKey);
    // What the box must be before anything of wsp's goes on it, read in one run: root, systemd, cgroup v2 and room
    // for the floor and a gigabyte to work in. A reading that did not come back refuses nothing; the deploy's own
    // preflight stands behind it.
    // Each check is a row of its own inside the one check step: the chip and system were read with the login.
    stage("check", "running");
    stage("chip", "done", chip === "" ? undefined : chip);
    if (!standing.root) {
      said("root", "running");
      said("root", "failed", standing.noRoot.message);
      throw standing.noRoot;
    }
    const { target } = standing;
    // The three are read in one run, so each row moves once that run is back; a row after one that failed never ran.
    const checked = parsePlaceCheck((await machine.run(PLACE_CHECK_SCRIPT, { deadlineMs: SSH_DIAL_MS }).catch(() => undefined))?.stdout ?? "");
    const rows = placeCheckRows(req.address, checked, floorBytes(false) + PLACE_CHECK_SPARE_BYTES, reach.host);
    for (const row of rows) {
      said(row.step, "running");
      said(row.step, row.state, row.note, undefined, row.ms);
    }
    const refused = rows.find(r => r.state === "failed")?.note;
    if (refused !== undefined) throw new Error(refused);
    const checkedNote = placeCheckNote(checked);
    stage("check", "done", checkedNote === "" ? undefined : checkedNote);
    stage("reach", "running");
    const probed = await machine.run(reachScript(hostUrls), { deadlineMs: REACH_MS });
    if (!probed.stdout.includes(REACH_LINE)) throw new Error(reachUnsaidLine(req.address, clientWords(probed.stderr) || `exit ${probed.exitCode}`));
    const reached = reachedUrls(probed.stdout, hostUrls);
    const road = { ssh: sshLoginWord(reach), ...(reach.keyPath !== undefined ? { keyPath: reach.keyPath } : {}) };
    // No address of the door answered, so the box dials back through a forward on its own loopback, after the relay
    // where it reached that. A host bound beyond loopback names no door port and gets none: a forward into its main
    // port would land as the owner's own road.
    let back: PlaceBack | undefined;
    if (req.doorPort !== undefined && deps.back !== undefined && reached.every(url => url === req.relay)) {
      const held = await deps.back.hold(road, { boxPort: req.doorPort }, { home: login.HOME }).catch((e: unknown) => {
        deps.back!.release(road);
        return e instanceof Error ? e : new Error(String(e));
      });
      if (held instanceof Error) {
        // A refusal that names its own fix is said whole; ssh's own line goes inside the sentence that names ours.
        if (reached.length === 0) throw new Error(held instanceof BackCutError || held instanceof MissingKnownHostsError ? held.message : backRefusedLine(req.address, hostUrls, held.message));
        stage("reach", "done", `${reached.join(", ")}; the forward back over ssh did not stand: ${held.message}`.slice(0, SSH_LINE_CAP));
      } else {
        back = held;
        stage("reach", "done", dialsBackOverSshNote(hostUrls.filter(url => url !== req.relay), reached[0]));
      }
    } else if (reached.length === 0) {
      throw new Error(unreachedLine(req.address, hostUrls));
    } else {
      stage("reach", "done", reached.join(", "));
    }
    const joinUrls = back === undefined ? reached : [...reached, backUrl(back.boxPort)];
    const at = placeDaemonPaths(login.HOME);
    const place = joinedPlace({ home: login.HOME, path: login.PATH }, { hostUrls: joinUrls, codeFile: `${at.wsp}/join-code`, name });
    stage("wsp", "running", target.uname);
    // What the box already holds of the add's list, read before anything lands: a failed add takes back only what
    // it wrote, and a box that would not say keeps everything.
    const unit = placeUnit(login.HOME);
    const writes = joinedAddWrites(place, unit.path);
    const found = addFound((await machine.run(addFoundScript(place, writes, unit.systemctl.join(" ")), { deadlineMs: SSH_DIAL_MS }).catch(() => undefined))?.stdout ?? "", writes.length);
    // Written down before a byte of wsp's is sent: what takes this install back, join and all, so a host that stops
    // in the middle of it can. A box that would not say what it held gets no undo, which keeps everything there.
    await req.beforeDeploy?.(found === undefined ? "" : addUndoScript(place, writes, found, unit.systemctl.join(" "), true), road.ssh);
    await deployDaemon(machine, {
      place,
      target,
      // The code goes over the byte road and never into a command: what sits in a command line sits in a world
      // readable /proc/<pid>/cmdline for as long as it runs, and this one buys a place in somebody's wsp.
      land: [{ path: place.join!.codeFile, bytes: new TextEncoder().encode(`${req.code}\n`) }],
      onLine: line => {
        if (line.includes(WSP_READY_LINE)) {
          stage("wsp", "done", target.uname);
          // The addresses the box is about to dial, said as its join starts rather than after the wait it ends in:
          // a wrong one is twenty seconds of silence followed by a sentence naming it, and this is the same fact
          // read while it can still be stopped.
          stage("service", "running", dialsBackLine(joinUrls, back === undefined ? undefined : { boxPort: back.boxPort, name }));
        } else if (line.includes(PLACE_JOINED_LINE)) {
          stage("service", "done");
        }
      },
      ...(deps.daemonDir !== undefined ? { daemonDir: deps.daemonDir } : {}),
      ...(deps.cliDir !== undefined ? { cliDir: deps.cliDir } : {}),
    }).catch(async (e: unknown) => {
      if (back !== undefined) deps.back?.release(road);
      // A box that refused at the preflight, or never answered it, was sent nothing. A join refused as already joined
      // stands beside another add that won the box between the read and the deploy, and what is there is that add's.
      if (machineLacksLine(e) !== undefined || machineNeverAnswered(e) || e instanceof PlaceAlreadyJoinedError) throw e;
      const said = e instanceof Error ? e.message : String(e);
      const answer =
        found === undefined
          ? undefined
          : await machine.run(addUndoScript(place, writes, found, unit.systemctl.join(" "), e instanceof PlaceJoinedThenFailedError), { deadlineMs: UNDO_MS }).catch(() => undefined);
      if (answer?.stdout.includes(ADD_TAKEN_LINE) === true) throw new Error(addTakenLine(said));
      const undone = answer !== undefined && answer.exitCode === 0 && answer.stdout.includes(DAEMON_GONE_LINE);
      const agentWasRunning = found !== undefined && writes.some((w, i) => w.as === "running" && found.has(i));
      const line = addUndoneLine(said, undone, agentWasRunning);
      throw undone ? new PlaceAddTakenBackError(line) : new Error(line);
    });
    return { name, ssh: road.ssh, ...(reach.keyPath !== undefined ? { sshKeyPath: reach.keyPath } : {}), ...(hostKey !== undefined ? { hostKey } : {}), ...(back !== undefined ? { back } : {}) };
  };
}

/** The unit the join on that computer installed and the words that reach the manager holding it, both read off the
 * one rule that writes them: the manager for a Linux box, asked about that box's own place service. A second
 * spelling of `wsp-place-<tag>` here would leave this road behind the day the unit scheme moves. The scope comes
 * from the same manager: a unit it says must be installed by root is the machine's, so it is driven without --user.
 * The uid decides nothing about either, and 0 is passed rather than this computer's, which is another computer's. */
export function placeUnit(home: string): { name: string; path: string; systemctl: readonly string[]; journalctl: readonly string[] } {
  const manager = serviceManagerFor("linux");
  if (manager === undefined) throw new Error(noPlaceManagerLine("linux"));
  const at = placeService(home, 0);
  const scoped = manager.needsRoot?.(at) === true ? [] : ["--user"];
  const unit = manager.unit(at);
  return { name: unit.name, path: unit.path, systemctl: ["systemctl", ...scoped], journalctl: ["journalctl", ...scoped] };
}

/** What a computer answers once the daemon the host sent is the one its unit runs, and what it says instead when
 * the unit did not come back up. Read off stdout, as every other deploy's lines are. */
export const PLACE_UPDATED_LINE = "PLACE_UPDATED";
export const PLACE_UPDATE_DOWN_LINE = "PLACE_UPDATE_DOWN";
/** What the box says when its own service manager holds no unit for this place: the update stops there rather than
 * writing a binary nothing would start. */
export const PLACE_NO_UNIT_LINE = "PLACE_NO_UNIT";
/** What it says when the binary it is replacing could not be kept, which is the one refusal both roads share: the
 * link road's install refuses there too, so a box is never left with the new daemon and no way back to the old. */
export const PLACE_NO_KEEP_LINE = "PLACE_NO_KEEP";

/** The update over the ssh road, run on the computer itself once the binary has landed beside its files. The path
 * the new binary is moved over is the one the unit itself names, read back out of systemd rather than worked out
 * here: the join wrote that unit with whatever path the wsp on that computer resolved, and a second reading of that
 * rule here would be a second copy of it. The old binary is kept beside the new one, as the coordinator kept it by
 * hand, and a keep that fails ends the update as it does on the link road. Nothing is swept: the workspaces'
 * records stay on the box and the daemon that comes up reads them again. */
export function placeUpdateScript(home: string, landed: string, unit = placeUnit(home)): string {
  const at = placeDaemonPaths(home);
  const q = shellQuote;
  const systemctl = unit.systemctl.join(" ");
  return [
    // systemd prints ExecStart as a record with the binary under path=; the first is the one it runs.
    `exe="$(${systemctl} show -p ExecStart --value ${q(unit.name)} 2>/dev/null | sed -n 's/.*path=\\([^ ;]*\\).*/\\1/p' | head -n 1)"`,
    `if [ -z "$exe" ]; then echo ${PLACE_NO_UNIT_LINE}; exit 1; fi`,
    `cp -f "$exe" "$exe.old" || { echo ${PLACE_NO_KEEP_LINE}; exit 1; }`,
    // A move, never a write into it: the file is running, and a kernel refuses a write to a mapped executable.
    `mv -f ${q(landed)} "$exe"`,
    'chmod 0755 "$exe"',
    // Before the restart, never after: a Type=simple restart returns the moment the process forks, so a daemon that
    // binds and writes its port quickly would have that file removed out from under it and the wait below would
    // read a daemon that is up as one that never came.
    `rm -f ${q(at.portFile)}`,
    `${systemctl} restart ${q(unit.name)}`,
    `for _ in $(seq 80); do [ -s ${q(at.portFile)} ] && break; sleep 0.25; done`,
    `if [ -s ${q(at.portFile)} ] && ${systemctl} is-active --quiet ${q(unit.name)}; then echo ${PLACE_UPDATED_LINE} "$exe"; else ${unit.journalctl.join(" ")} -u ${q(unit.name)} -n 50 --no-pager; echo ${PLACE_UPDATE_DOWN_LINE}; fi`,
  ].join("\n");
}

/** What the box said when wsp's own login files could not be written there: the update stops on it, since the
 * lines exit 0 by design and a failure is the link going or the login file being unreadable, and the person runs
 * the line again. */
export const placeLoginFilesFailedLine = (name: string, said: string): string => placeInstallFailedLine(name, "login", said);

/** The refusal an update gets on a computer this host is holding no link to and was never installed over ssh: a
 * computer joined by typing a code is reached over its link alone. */
export const placeNoUpdateRoadLine = (name: string): string =>
  `${name} is not connected and this wsp has no login for it, so there is no road to put a daemon on it; switch it on and run the line again`;

/** What the box said when its update did not come back up, for the one sentence a person reads. */
export const placeUpdateFailedLine = (name: string, said: string): string => `${name} took the daemon and its agent did not come back up: ${said}`;

/** How the daemon this host deploys is put on a computer that is already a place, for the host that wires the
 * runtime. Which binary is the computer's own word about its chip, never this computer's: the two are different
 * computers as often as they are alike, and a binary for the wrong one starts and dies.
 *
 * Two roads, one rule about which: the link the place is holding, which carries the bytes as frames and ends in the
 * agent restarting itself, and the ssh road the install used where there is no link. Neither carries the binary on
 * a command line.
 *
 * wsp's own login files on that computer are written first on whichever road this holds, and on every update
 * rather than only where a binary goes: their text is this host's and moves with it. Over the link they are one
 * exec on the daemon the box is running now, sent before the first frame of the swap, since the swap restarts
 * that daemon and drops the link; over ssh they are the lines ahead of the swap in the one script. A computer
 * whose report records no home is passed over, and the update's own answer says the recipe got none.
 */
export function placeUpdater(deps: { backend?: SshBackend; daemonDir?: string } = {}): PlaceUpdater {
  /** The binary this wsp holds for one target, refused by the file's own name where this command carries none. */
  const binaryFor = (target: DaemonTarget): Uint8Array => {
    const bin = daemonBinaryIn(deps.daemonDir ?? assetDir("daemon"), target.triple);
    if (!existsSync(bin)) throw new Error(`${assetName("daemon")} missing: ${bin}`);
    return new Uint8Array(readFileSync(bin));
  };
  /** wsp's login files as this host spells them, run on that computer: the one home of the text, read here and by
   * the deploy at the join. The place is built off the login given, so the two roads write the one home on a box
   * whose login has not moved, and the road that adopted afresh writes where it now is. */
  const loginFiles = (login: { home: string; path: string }): string => loginFilesStep(sshDaemonPlace(login)).join("\n");
  return async req => {
    const home = req.report.login["HOME"];
    if (req.link !== undefined) {
      // Every check before the first thing that writes: a chip this wsp has no daemon for, or a command carrying
      // no binary for it, leaves the box exactly as it was found.
      const target = req.daemon ? daemonTargetFor(req.report.platform, req.report.arch) : undefined;
      if (req.daemon && target === undefined) throw new Error(placeNoChipLine(req.name, req.report.platform, req.report.arch));
      const bytes = target === undefined ? undefined : binaryFor(target);
      // Ahead of the frames: the swap restarts the daemon under this link, so an exec sent after it would reach
      // a link that is gone. The daemon the box runs now takes it, whatever version that is.
      if (home !== undefined) {
        const said = await new PlaceMachine(req.link, { id: req.name, home }).exec(loginFiles({ home, path: req.report.login["PATH"] ?? "" }));
        if (said.exitCode !== 0) throw new Error(placeLoginFilesFailedLine(req.name, `${said.stdout.slice(-300)} ${said.stderr.slice(-200)}`.trim()));
      }
      if (bytes === undefined) return undefined;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uploadId = randomBytes(8).toString("hex");
      const parts = Math.max(1, Math.ceil(bytes.length / MACHINE_PUT_PART_BYTES));
      let landed: PlaceUpdateLanded = { road: "link", at: "" };
      for (let seq = 0; seq < parts; seq++) {
        const part = bytes.subarray(seq * MACHINE_PUT_PART_BYTES, (seq + 1) * MACHINE_PUT_PART_BYTES);
        const answer = await req.link.request("place.update", {
          uploadId,
          seq,
          last: seq === parts - 1,
          data: Buffer.from(part).toString("base64"),
          sha256,
        });
        if (typeof answer["at"] === "string") landed = { road: "link", at: answer["at"], ...(typeof answer["kept"] === "string" ? { kept: answer["kept"] } : {}) };
      }
      return landed;
    }
    if (req.ssh === undefined) throw new Error(placeNoUpdateRoadLine(req.name));
    const reach = parseSshAddress(req.ssh.ssh, req.ssh.keyPath === undefined ? {} : { keyPath: req.ssh.keyPath });
    const backend = deps.backend ?? new SshBackend();
    const { machine, login, system, arch } = await (req.sudoPassword === undefined ? backend : backend.riding({ sudoPassword: req.sudoPassword })).adopt(reach);
    // The login this road just read rather than the one the record kept, as the join builds its place from: a box
    // whose login moved takes wsp's files where it now is.
    const files = loginFiles({ home: login.HOME, path: login.PATH });
    if (!req.daemon) {
      const wrote = await machine.run(files, { deadlineMs: 180_000 });
      if (wrote.exitCode !== 0) throw new Error(placeLoginFilesFailedLine(req.name, `${wrote.stdout.slice(-300)} ${wrote.stderr.slice(-200)}`.trim()));
      return undefined;
    }
    // The chip the box says now rather than the one the record kept, read before a byte is sent: a computer that
    // was rebuilt on another chip since it joined takes the binary it can run or none at all.
    const said = guestTargetSaid(system, arch, true);
    const landing = `${placeDaemonPaths(login.HOME).putDir}/${DAEMON_BIN}`;
    await landBytes(machine, landing, binaryFor(said));
    const res = await machine.run([files, placeUpdateScript(login.HOME, landing)].join("\n"), { deadlineMs: 180_000 });
    const printed = res.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
    const landed = printed.find(line => line.startsWith(PLACE_UPDATED_LINE));
    if (landed === undefined) throw new Error(placeUpdateFailedLine(req.name, `${res.stdout.slice(-300)} ${res.stderr.slice(-200)}`.trim()));
    const exe = landed.slice(PLACE_UPDATED_LINE.length).trim();
    // The script keeps the old one beside the new under this name, and refuses the update where it could not.
    return { road: "ssh", at: exe, kept: `${exe}.old` };
  };
}

/** One login over ssh and nothing else: the road the app's Try now takes on a computer whose agent has stopped
 * dialling in. It reads what that computer says about itself, which is one connection's worth of printf, and it
 * installs nothing and leaves nothing running. ssh's own refusal is what a person reads when it will not take.
 *
 * The key file the add was given is carried here: every ssh child this host starts runs with BatchMode on, so a
 * dial without it would be refused for the publickey on a computer that is switched on and answering. What a
 * refusal reads as is ssh's own line and not a reading of the machine wrapped around it: a person needs the
 * sentence their own terminal would have shown them. */
export function placeDialler(deps: { transport?: SshTransport } = {}): PlaceDialler {
  return async login => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    await sshDial(reach, ...(deps.transport === undefined ? [] : [deps.transport]));
  };
}

/** How long the leave over ssh is given. The stop it starts with is systemd's own, which waits a unit's
 * TimeoutStopSec (90 seconds where nothing names another) before it kills what is left of a daemon writing its
 * last frames, and the rest of the sweep follows that stop. */
const PLACE_LEAVE_MS = 180_000;

/** What the ssh client itself exits with when the login would not stand, which is the one exit that is the road
 * talking rather than the computer at the end of it. */
const SSH_REFUSED_EXIT = 255;

/** What a computer said when the leave on it did not finish: its own last words, since a person reading why the
 * agent is still on it needs that computer's sentence and not a reading of it. A computer that said nothing at all
 * is one the wait ran out on, and the line says so with the wait rather than ending on a colon. */
export const placeLeaveFailedLine = (name: string, said: { stdout: string; stderr: string }): string => {
  const words = `${said.stdout.slice(-300)} ${said.stderr.slice(-200)}`.trim();
  return words === ""
    ? `${name} ran the leave and had not finished it within ${Math.round(PLACE_LEAVE_MS / 1000)}s`
    : `${name} ran the leave and did not finish it: ${words}`;
};

/** How the agent is taken off a computer this host holds no link to, for the host that wires the runtime: the
 * leave that computer already carries, run over the login the install used. What comes off, in what order, and
 * what stays is that computer's own wsp, the same code a person at its terminal runs, so nothing of the sweep is
 * spelled here. The line that starts it is the one the box itself reported for running wsp there, word for word,
 * and what came off is read back by the rule that leave prints those lines by. */
export function placeLeaver(deps: { transport?: SshTransport } = {}): PlaceLeaver {
  return async req => {
    const reach = parseSshAddress(req.ssh.ssh, req.ssh.keyPath === undefined ? {} : { keyPath: req.ssh.keyPath });
    const line = shellLine([...req.report.wsp, PLACE_LEAVE_VERB]);
    const said = await (deps.transport ?? sshClient)(reach, line, { timeoutMs: PLACE_LEAVE_MS, ...(req.sudoPassword === undefined ? {} : { sudoPassword: req.sudoPassword }) });
    // ssh's own line where the login would not stand, which is what a person would have read in their own
    // terminal; a leave that ran and stopped carries that computer's own words instead.
    if (said.exitCode === SSH_REFUSED_EXIT) throw new PlaceLoginRefusedError(sshRefusalLine(said, reach));
    if (said.exitCode !== 0) throw new Error(placeLeaveFailedLine(req.name, said));
    return sweptSaid(said.stdout);
  };
}

/** How one script runs on a computer this host holds no link to, for the host that wires the runtime: over the login
 * the install used, as bash. Answers what it exited with; throws ssh's own line where the login would not stand. */
export function placeRunner(deps: { transport?: SshTransport } = {}): NonNullable<PlaceWiring["runOver"]> {
  return async (login, script, timeoutMs, sudoPassword) => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const said = await (deps.transport ?? sshClient)(reach, shellLine(["bash", "-c", script]), { timeoutMs, ...(sudoPassword === undefined ? {} : { sudoPassword }) });
    if (said.exitCode === SSH_REFUSED_EXIT) throw new PlaceLoginRefusedError(sshRefusalLine(said, reach));
    return said;
  };
}

/** What a remove or an update says where the login's sudo asks for a password and the record keeps no key the box's
 * ssh answered the add with: nothing here can tell that box from another, so no password goes to it. */
export const placeNoKeyForSudoLine = (ssh: string, host: string): string =>
  `${ssh.slice(0, 64)} runs sudo with a password, and this wsp kept no key its ssh answered the add with, so it sends that password to no box it cannot check; remove it as root@${host}, or run sudo ${PLACE_LEAVE_LINE} on that computer`;

/** How a remove or an update reads the road to root over the login the install used, before it does anything
 * there: the same read and the same one try of the person's password the add makes, and the add's own refusals.
 * Where sudo asks for a password, the key the box answers with now is held against the one the add kept before the
 * person is asked for it or it is tried: ssh's accept-new takes any key once the old entry is gone, which the add's
 * own mismatch line tells a person to do. */
export function placeSudoReader(
  deps: { transport?: SshTransport; hostKey?: (reach: SshReach) => Promise<string | undefined>; knownHosts?: (reach: SshReach) => Promise<{ file?: string; target?: string }> } = {},
): NonNullable<PlaceWiring["sudoOver"]> {
  return async (login, sudoPassword, act) => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const transport = deps.transport ?? sshClient;
    const road = await readSshSudo(reach, transport).catch((e: unknown) => {
      throw new PlaceLoginRefusedError(e instanceof Error ? e.message : String(e));
    });
    // Only the password road is held to the record's key: on a root login or a passwordless sudo nothing of the
    // person's goes there, and the leave rides ssh's own known_hosts as the root road always did.
    if (road === "asks") {
      if (login.hostKey === undefined) throw new Error(placeNoKeyForSudoLine(login.ssh, reach.host));
      const answered = await (deps.hostKey ?? knownHostKey)(reach).catch(() => undefined);
      if (!hostKeyMatches(login.hostKey, answered ?? "")) {
        const entry = await (deps.knownHosts ?? knownHostsWritten)(reach).catch((): { file?: string; target?: string } => ({}));
        throw new Error(hostKeyMismatchRefusal({ address: login.ssh, pinned: login.hostKey, ...(answered !== undefined ? { wrote: answered } : {}), target: entry.target ?? reach.host, file: entry.file ?? KNOWN_HOSTS }));
      }
    }
    const sudo = road === "asks" && sudoPassword !== undefined ? await trySshSudo(reach, sudoPassword, transport) : road;
    const refused = placeSudoRefusal(login.ssh, reach.user, reach.host, sudo, act);
    if (refused !== undefined) throw refused;
    return sudo;
  };
}

/** What a failed undo says where the login's sudo asks for a password: the undo runs at a host's start with nobody at
 * it to type one, so what the add put there stays until somebody takes it off at that computer. */
export const placeUndoNeedsSudoLine = (ssh: string): string =>
  `${ssh.slice(0, 64)} runs sudo only with a password, which an undo with nobody at it cannot give, so what the add put there stays; log in there and run ${PLACE_LEAVE_LINE}`;

/** How long taking back an add the host stopped in the middle of gets: systemd's own stop, then the files. */
const PLACE_UNDO_MS = 120_000;

/** Takes back what an add put on a box before the host stopped mid-install, over the login that add used: the script
 * the installer wrote down before it sent anything. Throws ssh's own line, or the box's, where it did not finish. */
export function placeUndoer(deps: { transport?: SshTransport } = {}): NonNullable<PlaceWiring["undo"]> {
  return async (login, script) => {
    if (script === "") throw new Error("the box would not say what it held before the install, so nothing of it is taken back");
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const said = await (deps.transport ?? sshClient)(reach, shellLine(["bash", "-c", script]), { timeoutMs: PLACE_UNDO_MS });
    if (said.exitCode === SSH_REFUSED_EXIT) throw new PlaceLoginRefusedError(sshRefusalLine(said, reach));
    if (said.stderr.includes("a password is required")) throw new Error(placeUndoNeedsSudoLine(login.ssh));
    if (said.exitCode !== 0 || !said.stdout.includes(DAEMON_GONE_LINE)) throw new Error(lastLine(said.stderr) ?? lastLine(said.stdout) ?? `exit ${said.exitCode}`);
  };
}

/** Puts the token gh holds on this computer into the vault under the name gh reads, where it is not there yet: what
 * a box set up with GitHub from the vault is handed in every run there. The token never leaves this function but
 * into the vault file; a gh that holds none leaves the vault as it is and the GitHub row says so. */
export async function vaultGitHubToken(statePath: string, run: typeof runChild = runChild): Promise<void> {
  const res = await run("gh", ["auth", "token", "--hostname", "github.com"], { timeoutMs: 20_000 }).catch(() => undefined);
  const token = res?.exitCode === 0 ? res.stdout.trim() : "";
  if (token !== "" && !/\s/.test(token)) writeEnvFile(envFileFor(statePath), { [GITHUB_TOKEN_ENV]: token });
}

/** How many of the agent's own last lines go under a wait that ran out: enough to carry the address it refused and
 * the one that did not answer, short enough to read under one sentence. */
export const PLACE_LOG_TAIL = 10;

/** The end of the agent's own log on a computer that took it and has not dialled back, over the login the install
 * used. The daemon writes the address it could not dial and why into that log every ten seconds, so this is the
 * fact a person would otherwise go looking for by hand on a box they just met.
 *
 * The path is the one placeDaemonPaths writes, spelled against the box's own HOME rather than a home read here: a
 * second ssh child to ask what that home is costs a person who is already past a wait that ran out. A box with no
 * log yet answers nothing, which leaves the wait's own sentence exactly as it stood. */
export function placeLogReader(deps: { transport?: SshTransport } = {}): PlaceLogReader {
  return async login => {
    const reach = parseSshAddress(login.ssh, login.keyPath === undefined ? {} : { keyPath: login.keyPath });
    const at = placeDaemonPaths("$HOME").placeLog;
    const said = await (deps.transport ?? sshClient)(reach, `tail -n ${PLACE_LOG_TAIL} "${at}" 2>/dev/null`, { timeoutMs: SSH_DIAL_MS });
    return said.stdout.split("\n").map(line => line.trimEnd()).filter(line => line !== "").slice(-PLACE_LOG_TAIL);
  };
}

/** What the computer says it is, for the line beside the step that reached it; nothing when it will not say, which
 * is a fact about that computer and not a reason to stop. */
async function osSaid(machine: { facts(): Promise<{ os: string }> }): Promise<string | undefined> {
  try {
    return (await machine.facts()).os;
  } catch {
    return undefined;
  }
}

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
  return setupLines(computer.name, computer.setup, computer.applied);
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
    const answer = await deps.signIn({ link: road.link, agent, line: SignInLine.parse(line), terminal: deps.terminal, open: deps.open });
    io.log(answer.signedIn ? boxSignedInLine(place.name, agent, answer.detail) : boxNotSignedInLine(place.name, agent, answer.said));
    // That computer lists its logins only when it dials, so the host notes this one as the app's own sign-in does.
    if (answer.signedIn) await client.request("places.loginLanded", { placeId: place.id, agent });
    return answer.signedIn;
  } finally {
    await road.close();
  }
}

export async function removeCommand(io: CliIO, opts: PlaceOpts, args: readonly string[], deps: PlaceDeps = systemDeps): Promise<number> {
  const [ref] = args;
  if (ref === undefined || args.length !== 1) throw usageRefusal("wsp remove takes one place.", "usage: wsp remove <place>");
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
    const answer = await withSudoAsk(io, place.road?.ssh ?? place.name, sudoPassword =>
      client.request<{ removed: boolean; swept: string[]; note?: string }>("places.remove", { placeId: place.id, ...(sudoPassword !== undefined ? { sudoPassword } : {}) }),
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
    for (const line of removeLines(place.name, answer, held)) io.log(line);
    return 0;
  } finally {
    client.close();
  }
}

/** The two lines wsp join answers to, in one place, since both its refusals print them. */
const JOIN_USAGE = "usage: wsp join <address>... --code <code> [--name <name>]";

/** Which of the two things a person typed a join refusal is about, where it is about one of them: an address
 * nothing answered at, or a code the host would not take. A refusal about neither (a host that would not prove its
 * key, a computer already in a wsp) carries none. */
export type JoinRefusalAbout = "address" | "code" | "host";

/** A join that did not happen, carrying what it was about where that is known. It is thrown where the reason is
 * known, so a screen with one slot per field puts a refusal under the right field rather than reading it back out
 * of the sentence. */
export class JoinRefused extends Error {
  constructor(
    readonly about: JoinRefusalAbout,
    message: string,
  ) {
    super(message);
    this.name = "JoinRefused";
  }
}

export interface JoinFlags {
  code?: string;
  codeFile?: string;
  name?: string;
}

export interface JoinDeps {
  /** How the socket to the host is opened; the ws client unless a test hands its own. */
  dial(url: string): WebSocket;
  run: ServiceRunner;
  platform: string;
  home: string;
  now(): number;
  /** Which manager holds the unit and which login is running this, for a caller that is not this process; this
   * computer's own by default, which is what every terminal means. */
  manager?: ServiceManager;
  uid?: number;
}

const joinDeps = (): JoinDeps => ({
  dial: url => new WebSocket(wsUrlOf(url)),
  run: systemRunner,
  platform: platform(),
  home: process.env["HOME"] ?? "",
  now: Date.now,
});

/** The daemon's line on a computer joined as a place: the flags every daemon under a login takes, told the place
 * kind, then the place file it dials its host off, the home it keeps its files under and sweeps on a leave, the
 * folder its turns start in, the line that runs wsp here word by word, and the agents to look for on PATH at each
 * dial, as catalog id and command. Only the list of ids is fixed at the join; PATH is read at every dial. */
export function placeDaemonFlags(home: string, file: string, run: RunningWsp = runningWsp()): string[] {
  return [
    ...daemonFlags(sshDaemonPlace({ home, path: "" })),
    "--home",
    home,
    "--work-folder",
    workFolderIn(home),
    "--place-file",
    file,
    ...wspArgvOf(run).flatMap(word => ["--wsp-argv", word]),
    "--agents",
    CATALOG_AGENTS.map(a => `${a.id}=${a.bin}`).join(","),
  ];
}

/** What the daemon on a place needs on disk before it starts: wsp's own folder, the inbox and the work folder, and
 * a token file, minted fresh here; the host replaces it through the ordinary rotation on its first reach, which is
 * the road every other daemon's token takes. */
export function preparePlaceHome(home: string): void {
  const at = placeDaemonPaths(home);
  mkdirSync(at.wsp, { recursive: true, mode: 0o700 });
  mkdirSync(at.inbox, { recursive: true, mode: 0o700 });
  mkdirSync(workFolderIn(home), { recursive: true });
  writeFileSync(at.tokenPath, `${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
}

/** The join token, off the flag or off the file the installer landed it in, which is deleted before the dial: a
 * token left on a computer's disk is a join somebody else could spend. It carries the code and the fingerprint of
 * the key the host is to prove; a token that names no key is refused here, before anything is dialled. */
function joinCode(flags: JoinFlags): { code: string; hostKey: string } {
  if (flags.code !== undefined && flags.codeFile !== undefined) throw usageRefusal("wsp join takes --code or --code-file, not both.", "Drop one of them.");
  if (flags.code !== undefined) return withHostKey(readJoinToken(flags.code));
  if (flags.codeFile === undefined) throw usageRefusal("wsp join needs the code the host printed.", JOIN_USAGE);
  const path = resolve(flags.codeFile);
  const read = readJoinToken(readFileSync(path, "utf8"));
  rmSync(path, { force: true });
  if (read.code === "") throw usageRefusal(`${path} held no join code.`, "Run wsp add on the host again and write the code it prints into that file.");
  return withHostKey(read);
}

/** The one rule for a token whichever road it came by: a code with no key beside it is a line this computer cannot
 * hold a host to, so it says so rather than pinning whatever answers. */
function withHostKey(read: { code: string; hostKey?: string }): { code: string; hostKey: string } {
  if (read.hostKey === undefined) throw new Error(JOIN_NO_KEY_REFUSAL);
  return { code: read.code, hostKey: read.hostKey };
}

/** Every address in turn until one answers: a host on a network answers on several, and the one a person typed or
 * an installer picked may be the one this computer cannot route to. An address that answered nothing is skipped;
 * anything the host itself said, about the code or about its own key, ends the walk, since its other addresses are
 * the same host and would say the same. */
async function handshakeAt(
  io: CliIO,
  urls: readonly string[],
  code: string,
  hostKey: string,
  name: string,
  home: string,
  client: boolean,
  dial: (url: string) => WebSocket,
): Promise<Awaited<ReturnType<typeof handshake>> & { dialed: string }> {
  let last: Error | undefined;
  for (const url of urls) {
    try {
      return { ...(await handshake(io, url, code, hostKey, name, home, client, dial)), dialed: url };
    } catch (e) {
      if (!(e instanceof JoinRefused) || e.about !== "address") throw e;
      last = e;
      // Said as it happens rather than kept: a person watching a join wants to read which address went nowhere.
      if (urls.length > 1) io.error(e.message);
    }
  }
  throw last ?? usageRefusal("wsp join needs an address to dial.", JOIN_USAGE);
}

/** One dial that joins this computer to a wsp: the key is made here, the host's own key is held to the fingerprint
 * the join line carried, and nothing is written or sent until the host has proved that key back. */
async function handshake(
  io: CliIO,
  url: string,
  code: string,
  /** The fingerprint the join line named, which the key the host answers with has to match. */
  hostKey: string,
  name: string,
  home: string,
  /** Whether this join also buys the device token this computer's own window holds; it wears `name`. */
  client: boolean,
  dial: (url: string) => WebSocket,
): Promise<{ placeId: string; hostPublicKey: string; hostName: string; privateKeyPem: string; report: PlaceReport; device?: { deviceId: string; deviceToken: string } }> {
  const pair = newPlaceKeyPair();
  const nonce = randomBytes(PLACE_LINK_NONCE_BYTES).toString("base64");
  // One key agreement per join, thrown away with the socket: from the prove on every frame rides inside it, so
  // the code this computer spends and the report it sends are read by the host and by nobody carrying the bytes.
  const mine = freshEphemeral();
  const report = { ...(await placeReport({ name, home })), dialed: url };
  const ws = dial(url);
  let seal: Seal | undefined;
  let answered: { placeId: string; hostPublicKey: string; hostName: string } | undefined;
  try {
    return await new Promise((done, fail) => {
      const deadline = setTimeout(() => fail(new JoinRefused("address", joinUnansweredLine(url))), JOIN_MS);
      const end = (e: Error): void => {
        clearTimeout(deadline);
        fail(e);
      };
      ws.on("error", (e: Error) => end(new JoinRefused("address", `${url} could not be reached: ${e.message}`)));
      ws.once("close", () => end(new JoinRefused("address", `${url} closed the socket before this computer had joined`)));
      // Frame one carries public values only: the key this computer will prove, its nonce and its half of the
      // agreement. Nothing of the person's crosses before the host has proved the key the join line named.
      ws.once("open", () => ws.send(JSON.stringify({ id: 1, op: "place.join", publicKey: pair.publicKey, nonce, ephemeral: mine.publicKey })));
      ws.on("message", raw => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(openFrame(seal, raw)) as Record<string, unknown>;
        } catch {
          end(new JoinRefused("address", `${url} sent something that is not a frame`));
          return;
        }
        if (frame["ok"] !== true) {
          const said = String(frame["error"] ?? `${url} refused this join`);
          // The one refusal a host has for a code it is not holding, spent or expired or never minted, is the
          // protocol's own constant; every other refusal from over there is about this computer rather than about
          // a field, and travels as the host's own sentence so a screen can print it instead of guessing.
          end(new JoinRefused(said === PLACE_CODE_REFUSAL ? "code" : "host", said));
          return;
        }
        if (frame["id"] === 1) {
          const reply = PlaceJoinReply.safeParse(frame);
          if (!reply.success) {
            end(new Error(`${url} answered the join with something this computer cannot read: ${reply.error.message.replace(/\s+/g, " ").trim()}`));
            return;
          }
          const { placeId, hostPublicKey, nonce: hostNonce, signature, ephemeral, hostName } = reply.data;
          // Nothing of this computer's is written or sent past here: not its report, not its own signature. The key
          // is read before the signature it came with, since a stranger answering at this address signs for itself
          // perfectly well and the only thing that tells it from the host is which key it is.
          if (keyFingerprint(hostPublicKey) !== hostKey) {
            end(new Error(joinKeyRefusal(url)));
            return;
          }
          if (!verifyPlaceBytes(hostPublicKey, placeLinkTranscript("host", placeId, nonce, hostNonce, { challenger: mine.publicKey, answerer: ephemeral }), signature)) {
            end(new Error(hostKeyRefusal(url)));
            return;
          }
          answered = { placeId, hostPublicKey, hostName };
          if (frame["notice"] !== undefined) io.error(String(frame["notice"]));
          // The key both signatures cover, since the transcript named both ephemerals: the prove and everything
          // after it ride inside it, and a carrier that swapped either of them has signed nothing.
          const sealed = makeSeal(sealKeys(sharedSecret(mine.privateKey, ephemeral), placeId), "place");
          ws.send(
            sealed.seal(
              JSON.stringify({
                id: 2,
                op: "place.prove",
                signature: signPlaceBytes(pair.privateKeyPem, placeLinkTranscript("place", placeId, hostNonce, nonce, { challenger: ephemeral, answerer: mine.publicKey })),
                report,
                code,
                ...(client ? { client: { name } } : {}),
              }),
            ),
          );
          seal = sealed;
          return;
        }
        if (frame["id"] === 2 && answered !== undefined) {
          clearTimeout(deadline);
          const device = PlaceJoinDevice.safeParse(frame["device"]);
          done({ ...answered, ...(device.success ? { device: device.data } : {}), privateKeyPem: pair.privateKeyPem, report });
        }
      });
    });
  } finally {
    // The join's own socket is not the link: the service that starts below dials one of its own, and this one would
    // otherwise sit as a place the host thinks is present with nothing serving it.
    ws.close(1000, "the join is done; the agent dials the link");
  }
}

/** What one join needs, whoever asked for it. The road below is the whole of a join, so the command line and the
 * app's shell take the same one; the app hands the shim it writes as the wsp this computer runs. */
export interface JoinPlaceOptions {
  /** The home holding place.json and the key beside it. */
  home: string;
  /** Every address this host answers on, as joinAddressOf gave them, tried in the order they are in: one host is
   * on several networks, and the first that answers is the one this computer can reach. The place file keeps them
   * all, so it keeps dialling when the one it reached stops answering. */
  addresses: readonly string[];
  code: string;
  /** The fingerprint of the key the host is to prove, as the join line carried it beside the code. A host that
   * answers with any other key is refused before this computer sends its own report or signature. */
  hostKey: string;
  /** What the host will call this computer; its own name lowercased when nobody says. */
  name?: string;
  /** Also buy a device token for this computer's own window with the same code. The device is named after the
   * place, off the one `name` below: `wsp remove` finds the token a computer still holds by that name, so the two
   * cannot be two words. An ask rather than a name, so no caller can pass a second one. */
  client?: boolean;
  /** The wsp this computer runs, which the daemon reports as the line a turn's agent is given: this process's own
   * unless the caller runs behind a shim, as the app does. */
  wsp?: RunningWsp;
  /** Which computer this is, for the manager that holds the unit and the line said where there is none; this
   * process's own unless a caller names another. */
  platform?: string;
  /** The login running the join, for the manager that says whether its unit needs root; this process's own unless
   * a caller names another. */
  uid?: number;
  /** Which manager holds the unit: the one that platform has unless the caller names another, and a caller that
   * means none names the key with nothing in it, as the sweep's own option already reads. */
  manager?: ServiceManager | undefined;
  run?: ServiceRunner;
  /** How the socket to the host is opened, and the clock the joined stamp is read off; the real ones by default. */
  dial?: (url: string) => WebSocket;
  now?: () => number;
}

/** What a join answers its caller: enough for the app to open its window on the other wsp with no second read. */
export interface JoinedPlace {
  placeId: string;
  hostName: string;
  hostUrls: string[];
  report: PlaceReport;
  device?: { deviceId: string; deviceToken: string };
}

/** The whole of a join, as a function: the key, the handshake, the two files at the person's own mode, and the unit
 * that dials again at every start. It refuses a computer that already belongs to a wsp, since a place file is the
 * one wsp this computer is in. Throws the host's own sentence on a refusal; the caller decides what a person reads. */
export async function joinPlace(io: CliIO, opts: JoinPlaceOptions): Promise<JoinedPlace> {
  const { home, addresses, code, hostKey } = opts;
  if (home === "") throw new Error("a join needs this login's home folder, and this process has none");
  const file = placeFilePath(home);
  const standing = joinRefusal(home);
  if (standing !== undefined) throw new Error(standing);
  // Before the handshake: a computer nothing would keep the daemon up on is refused with nothing written on it.
  const on = opts.platform ?? platform();
  const row = DAEMON_TARGETS.find(t => t.platform === on);
  if (row !== undefined && !guestSystem(row.system)) throw new Error(noPlaceSystemLine(row.system, "this computer"));
  const manager = "manager" in opts ? opts.manager : serviceManagerFor(on);
  if (manager === undefined) throw new Error(noPlaceManagerLine(on));
  // The agent here is the machine's own service, so a login that cannot write one reads the sentence and stops:
  // before the handshake, before the key, before the place file, before anything of wsp's is on this computer.
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  if (manager.needsRoot?.({ role: "place", statePath: file, home, uid }) === true && uid !== 0) throw new Error(PLACE_NEEDS_ROOT_LINE);
  const bin = daemonBinaryHere();
  const name = opts.name?.trim() !== undefined && opts.name.trim() !== "" ? opts.name.trim() : placeNameHere();
  const now = opts.now ?? Date.now;
  const dial = opts.dial ?? ((url: string) => new WebSocket(wsUrlOf(url)));
  const joined = await handshakeAt(io, addresses, code, hostKey, name, home, opts.client === true, dial);
  const address = joined.dialed;
  const key = placeKeyPath(home);
  const placeFile: PlaceFile = {
    placeId: joined.placeId,
    name,
    hostName: joined.hostName,
    // The one that answered first, then the rest: that is the order the link tries them in from now on.
    hostUrls: [address, ...addresses.filter(at => at !== address)],
    hostPublicKey: joined.hostPublicKey,
    keyPath: key,
    joinedAt: new Date(now()).toISOString(),
  };
  // The handshake ran since the check above, so another join may be writing meanwhile. The key is the claim: of two
  // joins one creates it and the other stops here with nothing written, and the create never follows a link. The
  // place file is the last write, so a join cut off between the two leaves a key alone, which reads as broken.
  if (!writeExclusive(key, joined.privateKeyPem)) throw new Error(ALREADY_JOINED_LINE);
  if (!writePlaceFile(file, placeFile)) {
    if (keyIs(key, joined.privateKeyPem)) rmSync(key, { force: true });
    throw new Error(joinRefusal(home) ?? ALREADY_JOINED_LINE);
  }
  if (!keyIs(key, joined.privateKeyPem)) {
    rmSync(file, { force: true });
    throw new Error(joinCutByLeaveLine);
  }
  io.log(joinedLine(name, address));
  const answer: JoinedPlace = {
    placeId: joined.placeId,
    hostName: joined.hostName,
    hostUrls: placeFile.hostUrls,
    report: joined.report,
    ...(joined.device === undefined ? {} : { device: joined.device }),
  };
  const at: ServiceAddress = { role: "place", statePath: file, home, uid };
  const logPath = placeLogPath(home);
  // HOME is stated rather than inherited: the daemon keeps every file it has under the home its place file sits in,
  // and a manager that hands it the login's own default would put them somewhere else entirely. PATH is the one a
  // login shell here gives, which is what the daemon reports and what a turn on this computer finds: a service
  // starts with almost none, and the app that asked for this join may hold a bare one itself.
  const env = { ...serviceEnv(process.env), HOME: home, PATH: (await placeLogin(process.env, home))["PATH"]! };
  preparePlaceHome(home);
  const { unit, installed, failure } = await installService(manager, { ...at, argv: [bin, ...placeDaemonFlags(home, file, opts.wsp)], cwd: home, env, logPath }, opts.run ?? systemRunner);
  if (failure !== undefined) {
    if (installed) io.error(`the ${manager.words} ${unit.name} is still there at ${unit.path}; wsp leave takes it away.`);
    throw new Error(runFailureLine(failure));
  }
  io.log(`${manager.words} ${unit.name} is loaded; it dials again at every start`);
  io.log(`log         ${logPath}`);
  const after = manager.afterLoad?.(at);
  if (after !== undefined) io.log(after);
  io.log("wsp leave takes this computer back out.");
  return answer;
}

/** The place file as it stands on this computer, or nothing when it belongs to no wsp. */
export function placeStanding(home: string): PlaceFile | undefined {
  return readPlaceFile(placeFilePath(home));
}

/** The sweep a computer runs on itself, and the lines naming what it took. The host's own remove asks the agent for
 * this over the link; this is the road for a wsp that cannot be reached. */
export async function leavePlace(home: string, run?: ServiceRunner, forPlatform: string = platform()): Promise<string[]> {
  const manager = serviceManagerFor(forPlatform);
  const swept = await sweepPlace({ home, ...(manager !== undefined ? { manager } : {}), ...(run !== undefined ? { run } : {}) });
  return swept.removed;
}


/** The road wsp join takes, and the one the app's own join screen takes through the same function. A caller that
 * is not a terminal hands the parts of it that differ there (the line its service runs, the home it works under)
 * and takes the rest as it stands, so nothing about a join is written twice. */
export async function joinCommand(io: CliIO, args: readonly string[], flags: JoinFlags, given: Partial<JoinDeps> = {}): Promise<number> {
  const deps: JoinDeps = { ...joinDeps(), ...given };
  const home = deps.home;
  if (home === "") throw new Error("wsp join needs this login's home folder, and this process has none");
  if (args.length === 0) throw usageRefusal("wsp join takes one address or more.", JOIN_USAGE);
  // One host answers on several addresses, and the one an installer picked may be the one this computer cannot
  // route to: every word is read, and the join tries them in the order they were given.
  const addresses = args.map(typed => {
    const at = joinAddressOf(typed);
    if (at === undefined) throw new JoinRefused("address", `${JOIN_ADDRESS_LINE.what} ${JOIN_ADDRESS_LINE.fix}`);
    return at;
  });
  const standing = joinRefusal(home);
  if (standing !== undefined) {
    io.error(standing);
    return 1;
  }
  const { code, hostKey } = joinCode(flags);
  await joinPlace(io, {
    home,
    addresses,
    code,
    hostKey,
    ...(flags.name !== undefined ? { name: flags.name } : {}),
    platform: deps.platform,
    ...(deps.manager !== undefined ? { manager: deps.manager } : {}),
    ...(deps.uid !== undefined ? { uid: deps.uid } : {}),
    run: deps.run,
    dial: deps.dial,
    now: deps.now,
  });
  return 0;
}

export async function leaveCommand(
  io: CliIO,
  args: readonly string[],
  /** The workspace profile the sweep takes off as root is the one every install writes unless a caller names another. */
  deps: { home: string; run: ServiceRunner; platform: string; apparmorProfile?: string; tools?: ToolFolders; systemRoot?: string } = { home: process.env["HOME"] ?? "", run: systemRunner, platform: platform() },
): Promise<number> {
  if (args.length !== 0) throw usageRefusal("wsp leave takes no positional arguments.", "Run wsp leave on its own; it takes wsp off the computer you are sitting at.");
  const home = deps.home;
  if (home === "") throw new Error("wsp leave needs this login's home folder, and this process has none");
  const standing = joinStanding(home);
  if (standing === undefined) {
    io.error(NOTHING_TO_LEAVE_LINE);
    return 1;
  }
  const held = "joined" in standing ? standing.joined : undefined;
  const manager = serviceManagerFor(deps.platform);
  // The agent is another process from this one, so the sweep stops it before taking its unit file, and the lines
  // below say so.
  const swept = await sweepPlace({ home, ...(manager !== undefined ? { manager } : {}), run: deps.run, ...(deps.apparmorProfile === undefined ? {} : { apparmorProfile: deps.apparmorProfile }), ...(deps.tools === undefined ? {} : { tools: deps.tools }), ...(deps.systemRoot === undefined ? {} : { systemRoot: deps.systemRoot }) });
  io.log("broken" in standing ? brokenPlaceLeftLine(standing.broken) : `${standing.joined.name} left the wsp at ${standing.joined.hostUrls.join(", ")}; removed:`);
  for (const line of swept.removed) io.log(sweptLine(line));
  for (const line of swept.kept) io.log(line);
  if (held !== undefined) io.log("The host over there still lists it until somebody runs wsp remove on it.");
  return 0;
}
