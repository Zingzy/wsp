// SPDX-License-Identifier: AGPL-3.0-only
// Open, in the thread header: the thread's copy in an editor on this computer.
// The main part opens the default, the editor last picked or else the first
// the host found, and wears its mark; the menu lists every editor the host
// found installed with its mark and the default's shortcut as a keycap. A pick
// opens in that editor and makes it the default. The slot is held, hidden,
// while the host lists its editors, so the header does not move when they
// arrive. A running workspace on another computer lists only the editors with
// a road there, opens in the default where it has one and in the first that
// does otherwise, and on a small machine the menu says what an editor costs
// there. A napping one draws nothing.
import { isLocalWorkspace, type EditorChoice } from "@wsp/protocol";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Kbd } from "../components/ui/kbd.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { cn } from "../lib/utils.js";
import { useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { useShortcutLabel } from "../shell/useKeybindings.js";
import { EditorGlyph } from "./EditorGlyph.js";
import { EDITOR_SSH_WORDS, EditorConsent } from "./EditorConsent.js";
import { openCopyInEditor, opensInEditor } from "./openCopy.js";

/** Memory at or under this, a workspace on another computer hears what an editor there costs: the editors' own
 * servers took 1.1 to 1.8 GB on the wsp repo, measured 2026-09-29. */
const SMALL_MB = 4096;

export const OPEN_WORDS = {
  open: "Open",
  openIn: (editor: string) => `Open in ${editor}`,
  choose: "Choose an editor",
} as const;

/** The editors the host found installed, read once per host; null until it answers, none where it refused. */
function useEditors(): readonly EditorChoice[] | null {
  const list = useStore(s => s.api?.editorList);
  const [editors, setEditors] = useState<readonly EditorChoice[] | null>(null);
  useEffect(() => {
    if (list === undefined) return;
    let live = true;
    list().then(
      found => live && setEditors(found),
      () => live && setEditors([]),
    );
    return () => {
      live = false;
    };
  }, [list]);
  return editors;
}

export function OpenSplit({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const picked = useStore(s => s.preferences.editor);
  const editors = useEditors();
  const shortcut = useShortcutLabel("editor.open");
  const memMb = useStatus(workspaceId)?.size?.memMb;
  const here = workspace !== null && isLocalWorkspace(workspace);
  const usable = editors === null ? null : here ? editors : editors.filter(e => e.remote === true);
  if (workspace === null || !opensInEditor(workspace) || usable?.length === 0) return null;
  const current = usable === null ? null : (usable.find(e => e.id === picked) ?? usable[0]!);
  const openIn = current === null ? OPEN_WORDS.open : OPEN_WORDS.openIn(current.name);
  const openCurrent = (): void => void openCopyInEditor(workspaceId, undefined, here ? undefined : current?.id);
  return (
    <div data-open-split className={cn("flex shrink-0 items-center", current === null && "invisible")} {...(current === null ? { "aria-hidden": true, inert: true } : {})}>
      <Button variant="outline" size="sm" data-k="open" aria-label={openIn} title={openIn} onClick={openCurrent} className="rounded-e-none before:rounded-e-none [-webkit-app-region:no-drag]">
        {current === null ? <span className="size-4" /> : <EditorGlyph id={current.id} />}
        {/* A phone's header has room for the mark alone; the button still says what it does to a reader. */}
        <span className="max-sm:sr-only">{OPEN_WORDS.open}</span>
      </Button>
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="icon-sm" data-k="open-choose" aria-label={OPEN_WORDS.choose} className="-ms-px rounded-s-none before:rounded-s-none [-webkit-app-region:no-drag]" />}>
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" data-k="open-menu">
          {!here && memMb !== undefined && memMb <= SMALL_MB ? <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">{EDITOR_SSH_WORDS.small}</p> : null}
          {(usable ?? []).map(editor => (
            <MenuItem key={editor.id} onClick={() => void openCopyInEditor(workspaceId, editor.id)}>
              <EditorGlyph id={editor.id} />
              <span data-editor-name>{editor.name}</span>
              {/* In sans: the system mono draws O as narrow as a zero, and ⌘O read as ⌘0. */}
              {editor.id === current?.id && shortcut !== null ? <Kbd className="ms-auto font-sans">{shortcut}</Kbd> : null}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <EditorConsent workspaceId={workspaceId} />
    </div>
  );
}
