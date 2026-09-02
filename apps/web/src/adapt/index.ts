// SPDX-License-Identifier: AGPL-3.0-only
// The adapter: pure functions from @wsp/protocol types to the view models the
// transplanted components accept. apps/web imports @wsp/protocol only; nothing
// here touches React, the store or a socket.
export * from "./view-model.js";
export { deriveSession, summarizeOutput, type SessionModel, type DeriveSessionOptions } from "./session.js";
export {
  deriveMessagesTimelineRows,
  formatDuration,
  summarizeToolGroup,
  toolGroupAction,
  toolGroupSummaryKind,
  isToolLike,
  indicatesFailure,
  indicatesSuccess,
  indicatesNeutral,
  type DeriveRowsInput,
} from "./timeline-rows.js";
