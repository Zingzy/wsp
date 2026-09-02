// SPDX-License-Identifier: AGPL-3.0-only
// The one seam between the chat components and the adapter that turns wsp
// protocol events into their view models. Until src/adapt lands on main the
// stand-in under ./adapt-local backs it; swapping the source here moves every
// chat import at once.
export * from "./adapt-local/types";
export * from "./adapt-local/sessionLogic";
export * from "./adapt-local/foldSessionEvents";
