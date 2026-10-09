// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { AgentsChangedEvent } from "../agents-report.js";
import { InitJobEvent, InitNeedsYouEvent } from "../init-job.js";
import { UsageAccountEvent } from "../usage.js";
import { UsageAlertEvent } from "../plan-alerts.js";
import { SessionSlateEvent, SlateRunEvent, SlateValuesEvent } from "../slate/wire.js";
import { ReleaseChangedEvent } from "../release.js";
import { sequenced } from "./helpers.js";
import { SessionBehindEvent, SessionCappedEvent, SessionChangesEvent, SessionCheckpointEvent, SessionDeltaEvent, SessionDoneEvent, SessionEndEvent, SessionHeldEvent, SessionMovedEvent, SessionNotifyEvent, SessionPermissionClosedEvent, SessionPermissionEvent, SessionPlanEvent, SessionCompactedEvent, SessionContextEvent, SessionQueuedEvent, SessionRowEvent, SessionRunEvent, SessionStartEvent, SessionStartingEvent, SessionSteerEvent, SessionSubagentEvent } from "../views/session-events.js";
import { InboxFileEvent, PortCloseEvent, PortOpenEvent, WorkspaceAgentsEvent, WorkspaceCostEvent, WorkspaceCreatedEvent, WorkspaceCreatingEvent, WorkspaceDeletedEvent, WorkspaceGoneEvent, WorkspaceLookEvent, WorkspaceNappedEvent, WorkspaceRenamedEvent, WorkspaceReviewEvent, WorkspaceStatusEvent, WorkspaceUpgradedEvent, WorkspaceViewedEvent, WorkspaceWokenEvent } from "../views/workspace-events.js";
import { ProjectExportEvent, ProjectImportEvent } from "../views/project-bundle.js";
import { PreferencesChangedEvent, ThreadHeadEvent, ThreadMarkedEvent, ThreadRewoundEvent } from "../views/preferences.js";
import { GoldenStageEvent } from "../views/golden-image.js";
import { AsideTextEvent, ForwardCloseEvent, ForwardOpenEvent, HostNoticeEvent, PlaceAbsentEvent, PlaceChangedEvent, PlaceJoinedEvent, PlacePendingEvent, PlacePresentEvent, PlaceRemovedEvent, PlaceSetupEvent, PlaceStageEvent, PlaceSyncEvent, ProjectAddedEvent, ProjectAddEvent, ProjectRemovedEvent, RecipesChangedEvent } from "../views/place.js";

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatingEvent.extend(sequenced),
  WorkspaceCreatedEvent.extend(sequenced),
  WorkspaceNappedEvent.extend(sequenced),
  WorkspaceWokenEvent.extend(sequenced),
  WorkspaceUpgradedEvent.extend(sequenced),
  WorkspaceRenamedEvent.extend(sequenced),
  WorkspaceLookEvent.extend(sequenced),
  WorkspaceAgentsEvent.extend(sequenced),
  WorkspaceDeletedEvent.extend(sequenced),
  WorkspaceGoneEvent.extend(sequenced),
  WorkspaceStatusEvent.extend(sequenced),
  WorkspaceReviewEvent.extend(sequenced),
  WorkspaceViewedEvent.extend(sequenced),
  WorkspaceCostEvent.extend(sequenced),
  SessionStartEvent.extend(sequenced),
  SessionDeltaEvent.extend(sequenced),
  SessionDoneEvent.extend(sequenced),
  SessionEndEvent.extend(sequenced),
  SessionSteerEvent.extend(sequenced),
  SessionNotifyEvent.extend(sequenced),
  SessionPermissionEvent.extend(sequenced),
  SessionPermissionClosedEvent.extend(sequenced),
  SessionCheckpointEvent.extend(sequenced),
  SessionChangesEvent.extend(sequenced),
  SessionPlanEvent.extend(sequenced),
  SessionCompactedEvent.extend(sequenced),
  SessionContextEvent.extend(sequenced),
  SessionRunEvent.extend(sequenced),
  SessionMovedEvent.extend(sequenced),
  SessionBehindEvent.extend(sequenced),
  SessionCappedEvent.extend(sequenced),
  SessionSubagentEvent.extend(sequenced),
  SessionSlateEvent.extend(sequenced),
  SlateValuesEvent.extend(sequenced),
  SlateRunEvent.extend(sequenced),
  UsageAccountEvent.extend(sequenced),
  SessionQueuedEvent.extend(sequenced),
  SessionHeldEvent.extend(sequenced),
  SessionRowEvent.extend(sequenced),
  SessionStartingEvent.extend(sequenced),
  ThreadMarkedEvent.extend(sequenced),
  ThreadHeadEvent.extend(sequenced),
  ThreadRewoundEvent.extend(sequenced),
  PortOpenEvent.extend(sequenced),
  PortCloseEvent.extend(sequenced),
  InboxFileEvent.extend(sequenced),
  GoldenStageEvent.extend(sequenced),
  ForwardOpenEvent.extend(sequenced),
  ForwardCloseEvent.extend(sequenced),
  ProjectAddedEvent.extend(sequenced),
  ProjectAddEvent.extend(sequenced),
  ProjectRemovedEvent.extend(sequenced),
  ProjectImportEvent.extend(sequenced),
  ProjectExportEvent.extend(sequenced),
  PreferencesChangedEvent.extend(sequenced),
  ReleaseChangedEvent.extend(sequenced),
  InitJobEvent.extend(sequenced),
  InitNeedsYouEvent.extend(sequenced),
  PlaceStageEvent.extend(sequenced),
  PlaceSetupEvent.extend(sequenced),
  PlaceSyncEvent.extend(sequenced),
  RecipesChangedEvent.extend(sequenced),
  PlacePendingEvent.extend(sequenced),
  PlaceJoinedEvent.extend(sequenced),
  PlacePresentEvent.extend(sequenced),
  PlaceAbsentEvent.extend(sequenced),
  PlaceRemovedEvent.extend(sequenced),
  PlaceChangedEvent.extend(sequenced),
  AgentsChangedEvent.extend(sequenced),
  UsageAlertEvent.extend(sequenced),
  HostNoticeEvent.extend(sequenced),
  AsideTextEvent.extend(sequenced),
]);
export type EventUnion = z.infer<typeof EventUnion>;

/** What events.subscribe answers before it pushes anything. seq is the newest sequence the runtime has issued (0
 * before its first event): the cursor a client that has seen no event yet resubscribes from. stream names the
 * runtime process that issued it; sequences from two streams never compare, so a client that stored one and sees
 * another treats the reply as a gap whatever else it says. gap: the `after` sent is not a cursor into this stream
 * (the runtime no longer retains it, or it came with another stream id), nothing was replayed, and a client that
 * folds events must refetch sessions.history. */
export const EventsSubscribeReply = z.object({
  seq: z.number().int().nonnegative(),
  stream: z.string().optional(),
  gap: z.literal(true).optional(),
});
export type EventsSubscribeReply = z.infer<typeof EventsSubscribeReply>;
