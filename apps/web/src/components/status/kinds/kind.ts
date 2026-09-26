// SPDX-License-Identifier: AGPL-3.0-only
// One kind of thread status: when a thread reads as it, and what the one
// status slot draws for it. The slot draws every kind through this shape, so a
// kind is its module and one line in the registry.
import type { LucideIcon } from "lucide-react";
import type { SidebarThreadSnapshot } from "../../../adapt/index.js";

/** What a thread's status is read off, the fields every surface that shows a thread holds. */
export type ThreadStatusInput = Pick<SidebarThreadSnapshot, "status" | "asking" | "startedAt">;

/** The suffix of the theme token a status is inked in: `input` is drawn in `--status-input`. */
export type StatusTone = "input" | "working" | "failed" | "done";

export interface StatusKind {
  readonly id: string;
  /** Whether a thread reads as this kind; the registry asks in its order and the first yes wins. */
  readonly is: (thread: ThreadStatusInput) => boolean;
  /** No tone leaves the slot in the row's own ink. */
  readonly tone?: StatusTone;
  /** The colour utility the tone's token is registered as, written out whole so the stylesheet carries it. */
  readonly ink?: string;
  readonly glyph?: LucideIcon;
  readonly word?: string;
  /** The elapsed time since the latest turn began stands in the word's place, which is then read to a screen
   * reader alone. */
  readonly timed?: boolean;
  /** The crab walks beside it. */
  readonly crab?: boolean;
  /** The thread's age is its only text. */
  readonly aged?: boolean;
}
