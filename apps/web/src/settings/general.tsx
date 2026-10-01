// SPDX-License-Identifier: AGPL-3.0-only
// Settings > General: the editor Open in editor opens a file in, picked from
// the editors installed on the computer the host runs on, whether they open a
// workspace on another computer over ssh, whether the desktop app keeps this
// computer awake while a thread works on it, and whether a notification makes a
// sound, with a play beside it where the shell can.
import type { EditorId } from "@wsp/protocol";
import { Play } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";
import { EditorGlyph } from "../files/EditorGlyph.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { AWAKE_WORDS, GENERAL_WORDS, NOTIFY_WORDS } from "./format.js";
import { hereName } from "./places.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore } from "./settingsStore.js";

export function generalCards(ctx: SettingsContext): SettingsCardData[] {
  const editors = ctx.reads.editors ?? [];
  const picked = editors.find(editor => editor.id === ctx.preferences.editor) ?? editors[0];
  const nameOf = (id: EditorId): string => editors.find(editor => editor.id === id)?.name ?? id;
  const keepAwake = AWAKE_WORDS.keepAwake(hereName(ctx.places));
  const play = desktopBridge()?.playNoticeSound;
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
                  <SelectValue>
                    {(value: EditorId) => (
                      <span className="flex items-center gap-2">
                        <EditorGlyph id={value} />
                        {nameOf(value)}
                      </span>
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {editors.map(editor => (
                    <SelectItem key={editor.id} value={editor.id}>
                      <span className="flex items-center gap-2">
                        <EditorGlyph id={editor.id} />
                        {editor.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ),
        },
        ...(ctx.reads.sshInclude === null
          ? []
          : [
              {
                kind: "row" as const,
                id: "editor-ssh",
                title: EDITOR_SSH_WORDS.setting,
                description: EDITOR_SSH_WORDS.settingNote,
                control: (
                  <Switch
                    data-k="editor-ssh"
                    aria-label={EDITOR_SSH_WORDS.setting}
                    checked={ctx.reads.sshInclude}
                    onCheckedChange={on => void ctx.api?.sshInclude?.(on).then(sshInclude => useSettingsStore.getState().setReads({ sshInclude }), ctx.failed)}
                  />
                ),
              },
            ]),
        {
          kind: "row",
          id: "keep-awake",
          title: keepAwake,
          description: AWAKE_WORDS.keepAwakeDescription,
          control: <Switch data-k="keep-awake" aria-label={keepAwake} checked={ctx.preferences.keepAwake} onCheckedChange={keepAwake => ctx.setPreferences({ keepAwake })} />,
        },
      ],
    },
    {
      id: "notifications",
      head: NOTIFY_WORDS.head,
      lede: NOTIFY_WORDS.lede,
      items: [
        {
          kind: "row",
          id: "notify-sound",
          title: NOTIFY_WORDS.sound,
          description: NOTIFY_WORDS.soundDescription,
          control: (
            <span className="flex items-center gap-3">
              {play === undefined ? null : (
                <Button data-k="notify-play" variant="ghost" size="icon" aria-label={NOTIFY_WORDS.play} title={NOTIFY_WORDS.play} disabled={!ctx.preferences.notifySound} onClick={() => play()}>
                  <Play />
                </Button>
              )}
              <Switch data-k="notify-sound" aria-label={NOTIFY_WORDS.sound} checked={ctx.preferences.notifySound} onCheckedChange={notifySound => ctx.setPreferences({ notifySound })} />
            </span>
          ),
        },
      ],
    },
  ];
}
