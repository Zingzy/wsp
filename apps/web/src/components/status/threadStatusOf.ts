// SPDX-License-Identifier: AGPL-3.0-only
import { THREAD_STATUS_KINDS, type StatusKind, type ThreadStatusInput } from "./kinds/index.js";

/** The one reading of a thread's status every surface that shows a thread draws. */
export function threadStatusOf(thread: ThreadStatusInput): StatusKind {
  return THREAD_STATUS_KINDS.find(kind => kind.is(thread))!;
}
