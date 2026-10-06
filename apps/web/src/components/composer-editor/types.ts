// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ComposerPromptEditor.tsx at 57a66608 (MIT).

export type ComposerCommandKey = "ArrowDown" | "ArrowUp" | "Enter" | "Escape" | "Tab";

export interface ComposerSnapshot {
  value: string;
  /** Collapsed: a chip counts one place. */
  cursor: number;
  /** In the text as sent: a chip counts every character of its text. */
  expandedCursor: number;
}

export interface ComposerPromptEditorHandle {
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  readSnapshot: () => ComposerSnapshot;
}

export interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  disabled: boolean;
  placeholder: string;
  /** What the placeholder says where the editor is too narrow for the whole of it. */
  shortPlaceholder?: string;
  className?: string;
  onChange: (nextValue: string, nextCursor: number) => void;
  onCommandKeyDown?: (key: ComposerCommandKey, event: KeyboardEvent) => boolean;
  editorRef: React.RefObject<ComposerPromptEditorHandle | null>;
}
