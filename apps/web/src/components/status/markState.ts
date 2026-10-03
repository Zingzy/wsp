// SPDX-License-Identifier: AGPL-3.0-only
/** A machine's or a step's state as StateMark draws it. */
export type MarkState = "working" | "done" | "needs-you" | "failed" | "pending" | "offline" | "waiting" | "ready";
