// SPDX-License-Identifier: AGPL-3.0-only
// The keybinding contract, hand-written from t3code's
// packages/contracts/src/keybindings.ts (57a66608) without its schema
// library. A rule is what a config file holds; a resolved rule is what the
// matcher reads. Commands are the closed set this shell can dispatch.

export const KEYBINDING_COMMANDS = [
  "sidebar.toggle",
  "terminal.toggle",
  "terminal.split",
  "terminal.new",
  "rightPanel.toggle",
  "preview.toggle",
  "commandPalette.toggle",
  "chat.new",
] as const;
export type KeybindingCommand = (typeof KEYBINDING_COMMANDS)[number];

export const MAX_WHEN_EXPRESSION_DEPTH = 64;
export const MAX_KEYBINDINGS_COUNT = 256;

export interface KeybindingRule {
  readonly key: string;
  readonly command: KeybindingCommand;
  readonly when?: string;
}

export interface KeybindingShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** Command on macOS, Control elsewhere. */
  readonly modKey: boolean;
}

export type KeybindingWhenNode =
  | { readonly type: "identifier"; readonly name: string }
  | { readonly type: "not"; readonly node: KeybindingWhenNode }
  | { readonly type: "and"; readonly left: KeybindingWhenNode; readonly right: KeybindingWhenNode }
  | { readonly type: "or"; readonly left: KeybindingWhenNode; readonly right: KeybindingWhenNode };

export interface ResolvedKeybindingRule {
  readonly command: KeybindingCommand;
  readonly shortcut: KeybindingShortcut;
  readonly whenAst?: KeybindingWhenNode;
}

export type ResolvedKeybindingsConfig = ReadonlyArray<ResolvedKeybindingRule>;

export function isKeybindingCommand(value: string): value is KeybindingCommand {
  return (KEYBINDING_COMMANDS as readonly string[]).includes(value);
}
