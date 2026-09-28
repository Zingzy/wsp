// SPDX-License-Identifier: AGPL-3.0-only
import type { EditorId } from "@wsp/protocol";
import type { AgentMark } from "../catalog.js";

/** An editor's published mark, drawn where a thread's copy opens in it; one inline svg, never fetched. */
export interface EditorMark extends AgentMark {
  id: string;
  /** The editors it marks, by the id the host's table opens them by. */
  editors: readonly EditorId[];
}
