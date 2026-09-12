// SPDX-License-Identifier: AGPL-3.0-only
// The one glyph a workspace's kind puts in the lead slot of every surface that
// draws a machine: the sidebar row, the space bar and the Machine tab's header.
// The glyph's shape says what the machine is; its hue on the sidebar row says
// the state, by the one rule in sidebar/workspaceRows.ts. Adding a kind is a
// row in this table.
import { CloudIcon, LaptopIcon, MonitorIcon, ServerIcon, type LucideIcon } from "lucide-react";
import type { WorkspaceKind } from "@wsp/protocol";

const GLYPHS: Record<WorkspaceKind, LucideIcon> = {
  cloud: CloudIcon,
  local: LaptopIcon,
  ssh: ServerIcon,
  place: MonitorIcon,
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
  ssh: "A computer over ssh",
  place: "A computer you joined",
};

export function newWorkspaceTitle(kind: WorkspaceKind): string {
  return NEW_TITLES[kind];
}
