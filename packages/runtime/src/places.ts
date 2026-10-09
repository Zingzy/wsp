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
import type { PlaceDoorOptions, PlaceDoor } from "./places/types.js";
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
  placeUpdateSlowLine, placeSweptOverSshLine, placeLoginRoadLine, placeSweptOverLinkLine, placeElsewhereSweptOverLinkLine, PlaceLoginRefusedError, PlaceHostKeyChangedError,
  PlaceForksNowhereError, PlaceAddTakenBackError, PlaceProvisioningError, type PlaceAdded, type PlaceSetUp, PLACES, isPlaceRecord,
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
