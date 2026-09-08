// SPDX-License-Identifier: AGPL-3.0-only
// The Workspaces section's own actions, one registry: what the palette offers
// and what a right-click on the section row opens. The body toggle names the
// mode a pick moves to, and the road to this computer says whether it makes
// the workspace or goes to the one it already is, so the palette row and the
// menu row can never say two things about either.
import { GalleryHorizontalEndIcon, ListIcon } from "lucide-react";
import type { SidebarMode } from "@wsp/protocol";
import { otherMode } from "../sidebar/sidebarMode.js";
import { newWorkspaceTitle, workspaceKindGlyph } from "../workspaceKindGlyph.js";
import { SIDEBAR_MODE_WORDS, THIS_COMPUTER_HINTS } from "./format.js";
import type { ActionEntry } from "./registry.js";

export interface SidebarTarget {
  readonly mode: SidebarMode;
  /** Whether this computer already is a workspace: there is one per host, so the row says which the pick will do. */
  readonly hasLocal: boolean;
  /** Whether the host can be asked at all; false leaves the row refused rather than silent. */
  readonly connected: boolean;
}

export interface SidebarVerbs {
  readonly setMode: (mode: SidebarMode) => void;
  /** Makes this computer the host's local workspace, or selects the one it already is. */
  readonly newLocal: () => void;
}

const MODE_ICON = { spaces: GalleryHorizontalEndIcon, list: ListIcon } as const;
const LOCAL_ICON = workspaceKindGlyph("local")!;

export const SIDEBAR_MODE_ACTION = "sidebar-mode";
export const NEW_LOCAL_ACTION = "new-local-workspace";

export const sidebarActions: ReadonlyArray<ActionEntry<SidebarTarget, SidebarVerbs>> = [
  {
    id: SIDEBAR_MODE_ACTION,
    group: "view",
    labs: true,
    icon: target => MODE_ICON[otherMode(target.mode)],
    searchTerms: ["spaces", "sidebar mode", "one workspace at a time", "workspace list"],
    title: target => SIDEBAR_MODE_WORDS[otherMode(target.mode)].title,
    hint: target => SIDEBAR_MODE_WORDS[otherMode(target.mode)].hint,
    refusal: () => null,
    run: (target, verbs) => verbs.setMode(otherMode(target.mode)),
  },
  {
    id: NEW_LOCAL_ACTION,
    group: "create",
    icon: () => LOCAL_ICON,
    searchTerms: ["this computer", "this mac", "local workspace", "new workspace"],
    title: () => newWorkspaceTitle("local"),
    hint: target => (target.hasLocal ? THIS_COMPUTER_HINTS.existing : THIS_COMPUTER_HINTS.fresh),
    refusal: target => (target.connected ? null : THIS_COMPUTER_HINTS.offline),
    run: (_target, verbs) => verbs.newLocal(),
  },
];
