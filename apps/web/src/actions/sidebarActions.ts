// SPDX-License-Identifier: AGPL-3.0-only
// The Workspaces section's own actions, one registry: what the palette offers
// and what a right-click on the section row opens. The body toggle is the one
// entry, and it names the mode a pick moves to, so the palette row and the
// menu row can never say two things about it.
import { GalleryHorizontalEndIcon, ListIcon } from "lucide-react";
import { otherMode, type SidebarMode } from "../sidebar/sidebarMode.js";
import { SIDEBAR_MODE_WORDS } from "./format.js";
import type { ActionEntry } from "./registry.js";

export interface SidebarTarget {
  readonly mode: SidebarMode;
}

export interface SidebarVerbs {
  readonly setMode: (mode: SidebarMode) => void;
}

const MODE_ICON = { spaces: GalleryHorizontalEndIcon, list: ListIcon } as const;

export const SIDEBAR_MODE_ACTION = "sidebar-mode";

export const sidebarActions: ReadonlyArray<ActionEntry<SidebarTarget, SidebarVerbs>> = [
  {
    id: SIDEBAR_MODE_ACTION,
    group: "view",
    icon: target => MODE_ICON[otherMode(target.mode)],
    searchTerms: ["spaces", "sidebar mode", "one workspace at a time", "workspace list"],
    title: target => SIDEBAR_MODE_WORDS[otherMode(target.mode)].title,
    hint: target => SIDEBAR_MODE_WORDS[otherMode(target.mode)].hint,
    refusal: () => null,
    run: (target, verbs) => verbs.setMode(otherMode(target.mode)),
  },
];
