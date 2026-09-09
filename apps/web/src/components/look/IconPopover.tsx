// SPDX-License-Identifier: AGPL-3.0-only
// The icon picker the workspace's menu opens: a search field over the app's
// own icon set, the current one marked, and the way back to none. A pick goes
// to the runtime as it is made; there is nothing to confirm. Icons only, never
// emoji: emoji are not icons in the chrome.
import { CircleSlashIcon } from "lucide-react";
import { useState } from "react";
import { WORKSPACE_GLYPHS, lookWord, type WorkspaceView } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { cn } from "../../lib/utils.js";
import { Input } from "../ui/input.js";
import { LOOK_WORDS, WorkspaceGlyphMark } from "../workspaceLook.js";
import { LookPopup } from "./LookPopup.js";

/** What a person picks when they want no icon; the struck circle stands for it. */
export const NO_ICON_WORD = "None";
const ICON_LABEL = "Icon";
const CELL_CLASS = "flex size-7 cursor-pointer items-center justify-center rounded-md outline-hidden ring-ring transition-colors duration-150 hover:bg-accent focus-visible:ring-2";
const PICKED_CLASS = "ring-1 ring-foreground/60";

export function IconPopover({ workspace, anchor, onClose }: { workspace: WorkspaceView; anchor: HTMLElement | null; onClose: () => void }) {
  const setLook = useStore(s => s.setWorkspaceLook);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = WORKSPACE_GLYPHS.filter(glyph => needle === "" || glyph.includes(needle) || lookWord(glyph).toLowerCase().includes(needle));
  return (
    <LookPopup title={LOOK_WORDS.glyph} name={workspace.name} anchor={anchor} onClose={onClose} data-icon-picker="">
      <Input size="compact" type="search" aria-label="Search icons" placeholder="Search icons" autoFocus value={query} onChange={event => setQuery(event.target.value)} />
      <div role="group" aria-label={LOOK_WORDS.glyph} className="grid grid-cols-8 gap-1">
        {needle === "" ? (
          <button
            type="button"
            aria-label={`${ICON_LABEL}: ${NO_ICON_WORD}`}
            aria-pressed={workspace.glyph === undefined}
            className={cn(CELL_CLASS, "text-muted-foreground", workspace.glyph === undefined && PICKED_CLASS)}
            onClick={() => void setLook({ workspaceId: workspace.id, look: { glyph: null } })}
          >
            <CircleSlashIcon aria-hidden className="size-4" />
          </button>
        ) : null}
        {shown.map(glyph => (
          <button
            key={glyph}
            type="button"
            aria-label={`${ICON_LABEL}: ${lookWord(glyph)}`}
            aria-pressed={workspace.glyph === glyph}
            className={cn(CELL_CLASS, "text-foreground", workspace.glyph === glyph && PICKED_CLASS)}
            onClick={() => void setLook({ workspaceId: workspace.id, look: { glyph } })}
          >
            <WorkspaceGlyphMark glyph={glyph} className="size-4" />
          </button>
        ))}
      </div>
    </LookPopup>
  );
}
