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
import { placeDialler, placeInstaller, placeLeaver, placeLogReader, placeRunner, placeSudoReader, placeUndoer, placeUpdater, vaultGitHubToken } from "./places/install.js";
export * from "./places/this-computer.js";
export * from "./places/add-words.js";
export * from "./places/install.js";
export * from "./places/commands.js";
export * from "./places/join.js";

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
