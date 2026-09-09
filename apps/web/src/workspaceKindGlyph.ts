// SPDX-License-Identifier: AGPL-3.0-only
// The one glyph a workspace's kind puts in the lead slot of every surface that
// draws a machine: the sidebar row and the Machine tab's header. The glyph
// says what the machine is and nothing about its state; the state is a word in
// the row's own slot, and no hue changes with it. Adding a kind is a row in
// this table.
import { CloudIcon, LaptopIcon, ServerIcon, type LucideIcon } from "lucide-react";
import type { WorkspaceKind } from "@wsp/protocol";

const GLYPHS: Record<WorkspaceKind, LucideIcon> = {
  cloud: CloudIcon,
  local: LaptopIcon,
  ssh: ServerIcon,
};

export function workspaceKindGlyph(kind: WorkspaceKind): LucideIcon {
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
