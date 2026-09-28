// SPDX-License-Identifier: AGPL-3.0-only
// A workspace being made, before it holds a thread to read a status off: in
// Working's tone, with its crab, and never in the registry, since no thread
// reads as it.
import type { StatusKind } from "./kind.js";

export const STARTING: StatusKind = {
  id: "starting",
  is: () => false,
  tone: "working",
  ink: "text-status-working",
  word: "Starting",
  crab: true,
};
