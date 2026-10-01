// SPDX-License-Identifier: AGPL-3.0-only
// Settings > General, in the order a person reaches for it: the composer's
// send key and what a message does while a thread works; how each kind of
// moment is said outside the app; when a read thread settles and whether a
// delete asks; the editor Open in editor opens a file in, picked from the
// editors installed on the computer the host runs on, and whether it opens a
// workspace on another computer over ssh; and what quitting the desktop app
// does, whether wsp starts at login and whether the app keeps this computer
// awake while a thread works on it. A row off its default carries the arrow
// that puts it back.
import { DEFAULT_PREFERENCES, NOTIFY_CHOICES, ON_QUIT_CHOICES, SETTLE_CHOICES, type EditorId, type NotifyChoice, type PreferencesPatch } from "@wsp/protocol";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Switch } from "../components/ui/switch.js";
import { EDITOR_SSH_WORDS } from "../files/EditorConsent.js";
import { EditorGlyph } from "../files/EditorGlyph.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { isMacPlatform } from "../lib/utils.js";
import { AWAKE_WORDS, GENERAL_WORDS } from "./format.js";
import { hereName } from "./places.js";
import type { SettingsCardData, SettingsRowData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore } from "./settingsStore.js";
import { SELECT_WIDTH } from "./layout.js";

const W = GENERAL_WORDS;
const SELECT_CLASS = SELECT_WIDTH;

type GeneralField = "sendWith" | "midTurn" | "notifyNeeds" | "notifyDone" | "planAlerts" | "settleAfter" | "askDelete" | "onQuit" | "keepAwake";

/** The arrow a row off the record's default carries, which writes that one field back. */
const resetOf = (ctx: SettingsContext, field: GeneralField): Pick<SettingsRowData, "reset"> =>
  ctx.preferences[field] === DEFAULT_PREFERENCES[field] ? {} : { reset: () => ctx.setPreferences({ [field]: DEFAULT_PREFERENCES[field] } as PreferencesPatch) };

/** A select over a fixed set of words, its value read and written as one of the record's choices. */
function ChoiceSelect<T extends string>({ k, label, value, choices, words, onChange }: { k: string; label: string; value: T; choices: readonly T[]; words: Record<T, string>; onChange: (next: T) => void }) {
  return (
    <Select value={value} onValueChange={next => choices.includes(next as T) && onChange(next as T)}>
      <SelectTrigger size="sm" aria-label={label} data-k={k} className={SELECT_CLASS}>
        <SelectValue>{(picked: T) => words[picked]}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {choices.map(choice => (
          <SelectItem key={choice} value={choice}>
            {words[choice]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const row = (id: string, title: string, description: string, control: SettingsRowData["control"], extra: Pick<SettingsRowData, "reset"> = {}): SettingsRowData => ({ kind: "row", id, title, description, control, ...extra });

function notifyRow(ctx: SettingsContext, id: "notify-needs" | "notify-done", field: "notifyNeeds" | "notifyDone", title: string, description: string): SettingsRowData {
  const set = (next: NotifyChoice): void => ctx.setPreferences({ [field]: next } satisfies PreferencesPatch);
  return row(id, title, description, <ChoiceSelect k={id} label={title} value={ctx.preferences[field]} choices={NOTIFY_CHOICES} words={W.notifyChoices} onChange={set} />, resetOf(ctx, field));
}

export function generalCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences: p, setPreferences: set } = ctx;
  const editors = ctx.reads.editors ?? [];
  const picked = editors.find(editor => editor.id === p.editor) ?? editors[0];
  const nameOf = (id: EditorId): string => editors.find(editor => editor.id === id)?.name ?? id;
  const here = hereName(ctx.places);
  const keepAwake = AWAKE_WORDS.keepAwake(here);
  const sendKeys = W.sendKeys(isMacPlatform(ctx.platform));
  const loginStart = ctx.reads.loginStart;
  const turnLogin = (on: boolean): void => void desktopBridge()?.setLoginStart?.(on).then(next => useSettingsStore.getState().setReads({ loginStart: next }), ctx.failed);
  return [
    {
      id: "composer",
      head: W.composer,
      items: [
        row("send-with", W.sendWith, W.sendWithDescription, <SegmentedControl aria-label={W.sendWith} data-k="send-with" value={p.sendWith} segments={(["enter", "mod-enter"] as const).map(value => ({ value, label: sendKeys[value] }))} onChange={sendWith => set({ sendWith })} />, resetOf(ctx, "sendWith")),
        row("mid-turn", W.midTurn, W.midTurnDescription, <SegmentedControl aria-label={W.midTurn} data-k="mid-turn" value={p.midTurn} segments={(["queue", "steer"] as const).map(value => ({ value, label: W.midTurnChoices[value] }))} onChange={midTurn => set({ midTurn })} />, resetOf(ctx, "midTurn")),
      ],
    },
    {
      id: "notifications",
      head: W.notifications,
      items: [
        notifyRow(ctx, "notify-needs", "notifyNeeds", W.notifyNeeds, W.notifyNeedsDescription),
        notifyRow(ctx, "notify-done", "notifyDone", W.notifyDone, W.notifyDoneDescription),
        row("plan-alerts", W.planAlerts, W.planAlertsDescription, <Switch data-k="plan-alerts" aria-label={W.planAlerts} checked={p.planAlerts} onCheckedChange={planAlerts => set({ planAlerts })} />, resetOf(ctx, "planAlerts")),
      ],
    },
    {
      id: "threads",
      head: W.threads,
      items: [
        row("settle-after", W.settleAfter, W.settleAfterDescription, <ChoiceSelect k="settle-after" label={W.settleAfter} value={p.settleAfter} choices={SETTLE_CHOICES} words={W.settleChoices} onChange={settleAfter => set({ settleAfter })} />, resetOf(ctx, "settleAfter")),
        row("ask-delete", W.askDelete, W.askDeleteDescription, <Switch data-k="ask-delete" aria-label={W.askDelete} checked={p.askDelete} onCheckedChange={askDelete => set({ askDelete })} />, resetOf(ctx, "askDelete")),
      ],
    },
    {
      id: "open-in",
      head: W.openIn,
      items: [
        row(
          "editor",
          W.editor,
          ctx.reads.editors !== null && editors.length === 0 ? W.noEditor : W.editorDescription,
          picked === undefined ? null : (
            <Select value={picked.id} onValueChange={next => set({ editor: next as EditorId })}>
              <SelectTrigger size="sm" aria-label={W.editor} data-k="editor" className={SELECT_CLASS}>
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
        ),
        ...(ctx.reads.sshInclude === null
          ? []
          : [
              row(
                "editor-ssh",
                EDITOR_SSH_WORDS.setting,
                EDITOR_SSH_WORDS.settingNote,
                <Switch
                  data-k="editor-ssh"
                  aria-label={EDITOR_SSH_WORDS.setting}
                  checked={ctx.reads.sshInclude}
                  onCheckedChange={on => void ctx.api?.sshInclude?.(on).then(sshInclude => useSettingsStore.getState().setReads({ sshInclude }), ctx.failed)}
                />,
              ),
            ]),
      ],
    },
    {
      id: "startup",
      head: W.startup,
      items: [
        // Only the desktop app quits; a browser tab closes with nothing to ask.
        ...(ctx.desktopShell ? [row("on-quit", W.onQuit, W.onQuitDescription(here), <ChoiceSelect k="on-quit" label={W.onQuit} value={p.onQuit} choices={ON_QUIT_CHOICES} words={W.onQuitChoices} onChange={onQuit => set({ onQuit })} />, resetOf(ctx, "onQuit"))] : []),
        ...(loginStart === null
          ? []
          : [
              row(
                "login-start",
                W.loginStart,
                W.loginStartDescription(here),
                <Switch data-k="login-start" aria-label={W.loginStart} checked={loginStart} onCheckedChange={turnLogin} />,
                // The service starts at login unless the person turned it off, so on is this row's default.
                loginStart ? {} : { reset: () => turnLogin(true) },
              ),
            ]),
        row("keep-awake", keepAwake, AWAKE_WORDS.keepAwakeDescription, <Switch data-k="keep-awake" aria-label={keepAwake} checked={p.keepAwake} onCheckedChange={keepAwake => set({ keepAwake })} />, resetOf(ctx, "keepAwake")),
      ],
    },
  ];
}
