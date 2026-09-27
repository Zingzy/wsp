// SPDX-License-Identifier: AGPL-3.0-only
// Settings > General: the editor Open in editor opens a file in, picked from
// the editors installed on the computer the host runs on.
import type { EditorId } from "@wsp/protocol";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { GENERAL_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

export function generalCards(ctx: SettingsContext): SettingsCardData[] {
  const editors = ctx.reads.editors ?? [];
  const picked = editors.find(editor => editor.id === ctx.preferences.editor) ?? editors[0];
  const nameOf = (id: EditorId): string => editors.find(editor => editor.id === id)?.name ?? id;
  return [
    {
      id: "editor",
      items: [
        {
          kind: "row",
          id: "editor",
          title: GENERAL_WORDS.editor,
          description: ctx.reads.editors !== null && editors.length === 0 ? GENERAL_WORDS.noEditor : GENERAL_WORDS.editorDescription,
          control:
            picked === undefined ? null : (
              <Select value={picked.id} onValueChange={next => ctx.setPreferences({ editor: next as EditorId })}>
                <SelectTrigger size="sm" aria-label={GENERAL_WORDS.editor} data-k="editor" className="w-44">
                  <SelectValue>{(value: EditorId) => <span>{nameOf(value)}</span>}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {editors.map(editor => (
                    <SelectItem key={editor.id} value={editor.id}>
                      <span>{editor.name}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ),
        },
      ],
    },
  ];
}
