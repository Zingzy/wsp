// SPDX-License-Identifier: AGPL-3.0-only
// The one glyph a workspace's kind puts where the state dot goes, for every
// surface that draws a machine: the sidebar row's lead slot and the Machine
// tab's header. A machine wsp drives shows the dot, which says what state it
// is in; a machine that simply exists shows what it is instead, since it has
// no state of its own to report. Adding a kind is a row in this table.
import { LaptopIcon, ServerIcon, type LucideIcon } from "lucide-react";
import type { WorkspaceKind } from "@wsp/protocol";

const GLYPHS: Record<WorkspaceKind, LucideIcon | null> = {
  cloud: null,
  local: LaptopIcon,
  ssh: ServerIcon,
};

/** The kind's glyph, or null where the state dot is the lead. */
export function workspaceKindGlyph(kind: WorkspaceKind): LucideIcon | null {
  return GLYPHS[kind];
}

/** What the road that makes a workspace of this kind is called, on the sidebar's plus menu and in the palette. A
 * kind wsp forks says what it makes; a kind that already exists says what it is, in the one phrase every local
 * surface uses. Adding a kind is a row here, beside its glyph. */
const NEW_TITLES: Record<WorkspaceKind, string> = {
  cloud: "New workspace",
  local: "This computer",
  ssh: "A machine over ssh",
};

export function newWorkspaceTitle(kind: WorkspaceKind): string {
  return NEW_TITLES[kind];
}
