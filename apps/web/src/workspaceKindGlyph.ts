// SPDX-License-Identifier: AGPL-3.0-only
// The one glyph a workspace's kind puts where the state dot goes, for every
// surface that draws a machine: the sidebar row's lead slot and the Machine
// tab's header. A machine wsp drives shows the dot, which says what state it
// is in; a machine that simply exists shows what it is instead, since it has
// no state of its own to report. Adding a kind is a row in this table.
import { LaptopIcon, type LucideIcon } from "lucide-react";
import type { WorkspaceKind } from "@wsp/protocol";

const GLYPHS: Record<WorkspaceKind, LucideIcon | null> = {
  cloud: null,
  local: LaptopIcon,
};

/** The kind's glyph, or null where the state dot is the lead. */
export function workspaceKindGlyph(kind: WorkspaceKind): LucideIcon | null {
  return GLYPHS[kind];
}
