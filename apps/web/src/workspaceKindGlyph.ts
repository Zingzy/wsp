// SPDX-License-Identifier: AGPL-3.0-only
// The one glyph a workspace's kind puts in the lead slot of every surface that
// draws a machine: the sidebar row, the space bar and the Machine tab's header.
// The glyph's shape says what the machine is; its hue on the sidebar row says
// the state, by the one rule in sidebar/workspaceRows.ts. Adding a kind is a
// row in this table.
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

