// SPDX-License-Identifier: AGPL-3.0-only
// Open, in the thread header: the thread's copy in an editor on this computer.
// The main part opens the default, the editor last picked or else the first
// the host found, and wears its mark; the menu lists every editor the host
// found installed with its mark and the default's shortcut as a keycap. A pick
// opens in that editor and makes it the default. The slot is held, hidden,
// while the host lists its editors, so the header does not move when they
// arrive. A workspace whose files are on another machine draws nothing here;
// its sentence stands on the file tab.
import { isLocalWorkspace, type EditorChoice } from "@wsp/protocol";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Kbd } from "../components/ui/kbd.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { cn } from "../lib/utils.js";
import { useStore, useWorkspace } from "../protocol/store.js";
import { useShortcutLabel } from "../shell/useKeybindings.js";
import { EditorGlyph } from "./EditorGlyph.js";
import { openCopyInEditor } from "./openCopy.js";

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
  if (workspace === null || !isLocalWorkspace(workspace) || editors?.length === 0) return null;
  const current = editors === null ? null : (editors.find(e => e.id === picked) ?? editors[0]!);
  const openIn = current === null ? OPEN_WORDS.open : OPEN_WORDS.openIn(current.name);
  return (
    <div data-open-split className={cn("flex shrink-0 items-center", current === null && "invisible")} {...(current === null ? { "aria-hidden": true, inert: true } : {})}>
      <Button variant="outline" size="sm" data-k="open" aria-label={openIn} title={openIn} onClick={() => void openCopyInEditor(workspaceId)} className="rounded-e-none before:rounded-e-none">
        {current === null ? <span className="size-4" /> : <EditorGlyph id={current.id} />}
        {/* A phone's header has room for the mark alone; the button still says what it does to a reader. */}
        <span className="max-sm:sr-only">{OPEN_WORDS.open}</span>
      </Button>
      <Menu>
        <MenuTrigger render={<Button variant="outline" size="icon-sm" data-k="open-choose" aria-label={OPEN_WORDS.choose} className="-ms-px rounded-s-none before:rounded-s-none" />}>
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" data-k="open-menu">
          {(editors ?? []).map(editor => (
            <MenuItem key={editor.id} onClick={() => void openCopyInEditor(workspaceId, editor.id)}>
              <EditorGlyph id={editor.id} />
              <span data-editor-name>{editor.name}</span>
              {/* In sans: the system mono draws O as narrow as a zero, and ⌘O read as ⌘0. */}
              {editor.id === current?.id && shortcut !== null ? <Kbd className="ms-auto font-sans">{shortcut}</Kbd> : null}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </div>
  );
}
