// SPDX-License-Identifier: AGPL-3.0-only
// Every kind of thread status, in the order a thread is read against them:
// a question outranks a running turn, a turn held for a slot is read before
// one that runs, a usage limit is read before a plain
// failure, a failure outranks a stop, a stop outranks a finish nobody has seen, and resting takes
// whatever is left, so it stays last. A kind is its module and its line here.
import { DONE } from "./done.js";
import { FAILED } from "./failed.js";
import { LIMITED } from "./limited.js";
import type { StatusKind } from "./kind.js";
import { NEEDS_YOU } from "./needs-you.js";
import { RESTING } from "./resting.js";
import { RESUMING } from "./resuming.js";
import { STOPPED } from "./stopped.js";
import { WAITING } from "./waiting.js";
import { WORKING } from "./working.js";

export type { StatusKind, StatusTone, ThreadStatusInput } from "./kind.js";

export const THREAD_STATUS_KINDS: readonly StatusKind[] = [NEEDS_YOU, WAITING, WORKING, LIMITED, RESUMING, FAILED, STOPPED, DONE, RESTING];
