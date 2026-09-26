// SPDX-License-Identifier: AGPL-3.0-only
// Every kind of thread status, in the order a thread is read against them:
// a question outranks a running turn, and resting takes whatever is left, so
// it stays last. A kind is its module and its line here.
import { FAILED } from "./failed.js";
import type { StatusKind } from "./kind.js";
import { NEEDS_YOU } from "./needs-you.js";
import { RESTING } from "./resting.js";
import { WORKING } from "./working.js";

export type { StatusKind, StatusTone, ThreadStatusInput } from "./kind.js";

export const THREAD_STATUS_KINDS: readonly StatusKind[] = [NEEDS_YOU, WORKING, FAILED, RESTING];
