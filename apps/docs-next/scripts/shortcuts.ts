// SPDX-License-Identifier: AGPL-3.0-only
// The keyboard shortcuts page: every default chord the app binds, in the words Settings > Keybindings says for its
// command, as a Mac and Linux draw it, and the letters that open a pane from the right panel's launcher.
import { DEFAULT_KEYBINDINGS, parseKeybindingShortcut } from "../../../apps/web/src/keybindingDefaults.js";
import { formatShortcutLabel } from "../../../apps/web/src/keybindings.js";
import { isWorkspaceSelectCommand } from "../../../apps/web/src/keybindingTypes.js";
import { PANES } from "../../../apps/web/src/panes.js";
import { JUMP_WORD, KEYBINDING_WORDS } from "../../../apps/web/src/settings/keybindingWords.js";
import { cell, page, table, type Generated } from "./generated.js";

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

/** Where a chord reaches, for each condition the defaults carry; a new condition fails the script until it has words. */
const WHERE: Record<string, string> = {
  "": "Anywhere",
  terminalFocus: "In the terminal",
  "!terminalFocus": "Outside the terminal",
  "!terminalOwnsMod": "Anywhere on a Mac. On Linux, outside the terminal, which keeps Ctrl for itself",
  panelTabsFocus: "In a right panel of several tabs",
  "!terminalFocus && !panelTabsFocus": "Outside the terminal and a right panel of several tabs",
  "threadOpen && !terminalFocus && !previewFocus": "With a thread on screen, outside the terminal and the right panel",
  "threadFindOpen && !terminalFocus": "While find in thread is open, outside the terminal",
};

const label = (key: string, platform: string): string => {
  const shortcut = parseKeybindingShortcut(key);
  if (shortcut === null) throw new Error(`the default chord ${key} does not parse`);
  return `\`${formatShortcutLabel(shortcut, platform)}\``;
};

export default function shortcuts(): Generated[] {
  const jumps = DEFAULT_KEYBINDINGS.filter(r => isWorkspaceSelectCommand(r.command));
  const rows = DEFAULT_KEYBINDINGS.filter(r => !isWorkspaceSelectCommand(r.command)).map(r => {
    const where = WHERE[r.when ?? ""];
    if (where === undefined) throw new Error(`no words for the condition ${r.when}: add them to WHERE in scripts/shortcuts.ts`);
    return [cell(KEYBINDING_WORDS[r.command]), label(r.key, MAC), label(r.key, LINUX), where];
  });
  const first = jumps[0]!;
  const last = jumps.at(-1)!;
  rows.push([JUMP_WORD, `${label(first.key, MAC)} to ${label(last.key, MAC)}`, `${label(first.key, LINUX)} to ${label(last.key, LINUX)}`, "Anywhere"]);
  const panes = Object.values(PANES).filter(p => p.shortcut !== "").map(p => [`\`${p.shortcut}\``, p.label, cell(p.description)]);
  const body = [
    "The chords the app binds by default. Change any of them in Settings > Keybindings, which also says when a chord is taken.",
    table(["Action", "Mac", "Linux", "Where"], rows),
    "## Opening a pane",
    "While the right panel shows its launcher, a letter opens a pane:",
    table(["Letter", "Pane", "What it shows"], panes),
  ];
  return [page("content/features/shortcuts.mdx", "Keyboard shortcuts", "shortcuts.ts", body.join("\n\n"))];
}
