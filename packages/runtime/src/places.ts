// SPDX-License-Identifier: AGPL-3.0-only
// The places this host holds: the computers somebody joined to it, this
// computer, and the provider it forks on. A joined computer dials in, proves
// itself with the ed25519 key this host learned at its join, and from then on
// this door holds that one socket and drives it with the daemon protocol every
// fork speaks. Nothing here listens: a place opens the socket, always.
//
// The encodings both sides sign and send are pinned in the protocol
// (PlaceNonce, PlacePublicKey, PlaceSignature) and the bytes they sign come
// from placeLinkTranscript, so this file holds the host's half of the
// handshake and no rule of its own about how it is spelled.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  LOOPBACK,
  HERE_PLACE_ID,
  NO_PLACE_INSTALLER,
  NO_RECIPE,
  PAIR_CODE_TTL_MS,
  PLACE_KEY_REFUSAL,
  PLACE_UNKNOWN_REFUSAL,
  PLACE_LEAVE_LINE,
  PLACE_LINK_NONCE_BYTES,
  DAEMON_VERSION,
  NAP_AFTER_MS,
  forkRoom,
  placeCapOf,
  placeSetRefusal,
  placeSettingDropped,
  PlaceSettings,
  type PlaceSettingsAsk,
  type PlaceSettingWord,
  AGENTS_ON,
  agentsFrom,
  placeTakes,
  placeTurnLimit,
  settingFor,
  placeLinkTranscript,
  placeRefusalTranscript,
  isPlainPath,
  joinToken,
  absentComputer,
  namesPlace,
  noSuchPlaceRefusal,
  placeHoldsForksRefusal, placeHoldsProjectsRefusal,
  placeForksNowhereLine,
  placeBlocked,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  placeStillInstalledLine,
  placeDialLine,
  placeDialRoad,
  placeNoHomeLine,
  placeNoPicksLine,
  placeProvisionPaths,
  placeProvisioningLine,
  EXEC_DEADLINE_EXIT,
  placeSyncingLine,
  pluginOffLine,
  pluginsKeptLine,
  setupRowFix,
  ghStatusOf,
  projectLeftLine,
  provisionLogLine,
  PendingComputer,
  RecipeFile,
  recipeCanon,
  recipeCounts,
  importantFailures,
  waitLine,
  plural,
  lastLine,
  SETUP_STEP_WORDS,
  SIGN_IN_WAIT_MS,
  FROM_THE_VAULT,
  SIGNED_IN_THERE,
  NO_SIGN_IN_ROAD,
  NO_FOLDER_ROAD,
  NO_GITHUB_TOKEN_LINE,
  noVaultTokenLine,
  GITHUB_SKIPPED_LINE,
  NEEDS_GITHUB_LINE,
  WAITS_ON_GITHUB_LINE,
  SETUP_LOG_TAIL_BYTES,
  SKIPPED_FOR_NOW,
  nothingToSkipLine,
  wasThereLine,
  UNLAND_FAILED_LINE,
  editedThereLine,
  setupWidth,
  floorFailedLine,
  noAgentLine,
  pendingHeldLine,
  pendingHeldFix,
  pendingNotJoinedLine,
  noPendingRefusal,
  pendingNotJoinedFix,
  CHOOSE_FIX,
  type AgentsSignInEvent,
  type SignInLine,
  type PlaceApplied,
  type PlacePendingEvent,
  type PlaceSetup,
  type PlaceSetupEvent,
  type PlaceSetupLine,
  type PlaceSync,
  type PlaceSyncEvent,
  type RecipesChangedEvent,
  type PlaceSetupStep,
  type PlaceWait,
  type PlaceEstimate,
  type RecipeKind,
  type SetupEnd,
  sshRoadOf,
  placeNoDialLine,
  BackendFacts,
  type AgentSignInState,
  type MacKind,
  type DaemonEvent,
  type DaemonResponse,
  type MachineSizeOffer,
  type PlaceAddStep,
  PLACE_LOGIN_REFUSED_KIND,
  PLACE_HOST_KEY_KIND,
  type PlaceStageEvent,
  type PlaceAddJob,
  withPlaceStage,
  keptSaid,
  markedCut,
  refusalParts,
  usageRefusal,
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
  PLACE_CODE_REFUSAL,
  PLACE_UNSEALED_JOIN_REFUSAL,
  twoPlacesRefusal,
  placeBehindLine,
  placeDaemonBehind,
  placeUpdateLine,
  buildsImages,
  linkedOver,
  type PlaceProveRequest,
  macKindOf,
  githubAddress,
  shellQuote,
} from "@wsp/protocol";
import { GITHUB_TOKEN_ENV, LinkBackend, ownedFloorBytes, unlandFiles, PlaceAbsentError, PlaceMachine, SSH_STORE_VARS, envInput, keyFingerprint, machineServerPort, newSetupRun, pathLine, plainPath, putFiles, serversOutLines, unmergeServers, withEnvFromInput, type EngineStep, type ExecResult, type Machine, type MachineBackend, type MachineLink, type ProvisionPlan, type ProvisionStage, type SetupRun } from "@wsp/engine";
import { CATALOG_AGENTS, keyEnvOf, loginSignIn, mintsToken, sharedFileIn, sharedOn } from "@wsp/catalog";
import type { WebSocket } from "ws";
import type { DeviceDoor } from "./devices.js";
import { openPlaceForward, type PlaceForward } from "./place-forward.js";
import type { HereDaemon, PlaceBackends } from "./runtime.js";
import type { DaemonChannel } from "./daemon-channel.js";
import { connectDaemon, type DaemonReach } from "./reach.js";
import { runGraph, type GraphStep } from "./setup-graph.js";
import { recipeChanges, stepsFor, type RecipeChange } from "./recipe-sync.js";
import { freshEphemeral, makeSeal, newPlaceKeyPair, sealKeys, sharedSecret, signPlaceBytes, verifyPlaceBytes, type PlaceKeyPair, type Seal } from "@wsp/keys";
import type { Store } from "./store.js";
import {
  PLACES, CAPS, DEFAULT_COLLECTION, DEFAULT_ID, type PlaceRecord, madeBySetup, isPlaceRecord, type PlaceLogin, type PlaceWiring, type PlaceRecording,
  type PlaceStaging, type PlaceDoorOptions, type RecipeResolver, type PlaceChallenge, type PlaceDoor, NO_PLACE_UPDATER,
  placeUpdateSlowLine, placeSweptOverSshLine, placeLoginRoadLine, placeSweptOverLinkLine, PlaceLoginRefusedError,
  PlaceForksNowhereError, PlaceAddTakenBackError, PlaceProvisioningError,
} from "./places/types.js";
import {
  bounded, readsAsEd25519, JOIN_PROVE_MS, PLACE_BAD_KEY_REFUSAL, takenReport, signInsOf, sharedLoginFile,
  vaultSignIn, SEEN_EVERY_MS, REPLACED, type Live, type Forward, LINK_FRAME_MS, RELINK_WAIT_MS, BACKEND_FACTS_MS,
  ADD_FACTS_MS, CAPACITY_MS, DIAL_MS, JOIN_WAIT_MS, ADDS_KEPT, ADD_RUNNING_LINE, ADD_RUNNING_FIX, boxSaid, PENDING,
  type PendingRecord, pendingView, ADD_STOPPED_LINE, ADD_STOPPED_FIX, ADD_NOT_TAKEN_BACK_LINE, type SyncJob,
  setupOutcome, NO_ESTIMATE_LINE, LOG_READ_MS, UNDO_MS, SIGN_IN_SLACK_MS, GITHUB_MS, GITHUB_ROW, GITHUB_CLI, INSTALLS,
  FILES, PROBE_MS, SIGNIN_STATUS_MS, firstLineOf, picksHash, PROVISION_LOG_EVERY_MS, PROVISION_LOG_LINES,
  UPDATE_WAIT_MS, UPDATE_POLL_MS, UNMERGE_MS,
} from "./places/helpers.js";
import { placeDoorContext } from "./places/context.js";
import { placeRecords } from "./places/records.js";
import { placeSetup } from "./places/setup.js";
import { placeViews } from "./places/views.js";
import { linkDoor } from "./places/link.js";
import { manageDoor } from "./places/manage.js";

export {
  type PlaceRecord, type PlaceRecordRoad, type PlaceEvent, type HerePlace, type PlaceWiring,
  type PlaceBackHolder, type PlaceProvisioner, type PlaceUndo, type PlaceLogin, type PlaceDialler, type PlaceLogReader,
  type PlaceUpdateRequest, type PlaceUpdateLanded, type PlaceUpdater, type PlaceLeaveRequest, type PlaceLeaver,
  type PlaceInstallRequest, type PlaceInstalled, type PlaceStaging, type PlaceInstaller, type PlaceRecording,
  type PlaceDoorOptions, type RecipeResolver, type PlaceChallenge, type PlaceDoor, NO_PLACE_DOOR, NO_PLACE_UPDATER,
  placeUpdateSlowLine, placeSweptOverSshLine, placeLoginRoadLine, placeSweptOverLinkLine, PlaceLoginRefusedError,
  PlaceForksNowhereError, PlaceAddTakenBackError, PlaceProvisioningError, type PlaceAdded, type PlaceSetUp,
  type PlaceRemoved,
} from "./places/types.js";
export {
  newPlaceKeyPair, signPlaceBytes, verifyPlaceBytes, type PlaceKeyPair, PLACE_BAD_KEY_REFUSAL,
  placeHomeRefusal, takenReport, signInsOf, vaultSignIn, ADD_STOPPED_LINE, ADD_STOPPED_FIX, ADD_NOT_TAKEN_BACK_LINE,
} from "./places/helpers.js";

export function makePlaceDoor(opts: PlaceDoorOptions): PlaceDoor {
  const ctx = placeDoorContext(opts);
  const recordArea = placeRecords(ctx);
  const setupArea = placeSetup(ctx, recordArea);
  const viewArea = placeViews(ctx, recordArea, setupArea);
  const door: PlaceDoor = { ...linkDoor(ctx, recordArea, setupArea, viewArea), ...manageDoor(ctx, recordArea, setupArea, viewArea) };
  ctx.door = door;
  return door;
}
