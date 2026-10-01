// SPDX-License-Identifier: AGPL-3.0-only
// A keybinding line's keycaps as the button that changes them. A press starts
// listening: the keycaps say so, the next chord is written as the person's own
// for that command, and Esc or a second press on the keycaps stops. A chord the
// rules refuse puts its reason where the keycaps were, in the error ink, until
// the next key goes down. One line listens at a time. The listener sits on the
// window's capture side, so the chord pressed here never reaches the
// dispatcher and runs the command it names.
import type { PreferencesPatch } from "@wsp/protocol";
import { useEffect } from "react";
import { create } from "zustand";
import { Button } from "../components/ui/button.js";
import { chordRefusal, keybindingFromKeyboardEvent } from "../keybindingOverrides.js";
import type { KeybindingCommand, KeybindingRule } from "../keybindingTypes.js";
import { cn } from "../lib/utils.js";
import { CHORD_WORDS, KEYBINDING_WORDS } from "./keybindingWords.js";
import { KeyCaps } from "./rows.js";

interface CaptureState {
  readonly command: KeybindingCommand | null;
  readonly refused: string | null;
}

export const useChordCapture = create<CaptureState>(() => ({ command: null, refused: null }));

const stop = (): void => useChordCapture.setState({ command: null, refused: null });

export interface ChordKeysProps {
  readonly command: KeybindingCommand;
  readonly keys: ReadonlyArray<ReadonlyArray<string>>;
  /** The rules as they stand, the person's own chords in place; what a new chord is checked against. */
  readonly rules: ReadonlyArray<KeybindingRule>;
  /** The command's default rules, so a chord pressed back onto its only default clears the override instead. */
  readonly defaults: ReadonlyArray<KeybindingRule>;
  readonly overridden: boolean;
  readonly platform: string;
  readonly write: (patch: PreferencesPatch) => void;
}

export function ChordKeys({ command, keys, rules, defaults, overridden, platform, write }: ChordKeysProps) {
  const capturing = useChordCapture(s => s.command === command);
  const refused = useChordCapture(s => (s.command === command ? s.refused : null));

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") return stop();
      const chord = keybindingFromKeyboardEvent(event, platform);
      if (chord === null) {
        useChordCapture.setState({ refused: null });
        return;
      }
      const refusal = chordRefusal(rules, command, chord, { platform, labelOf: at => KEYBINDING_WORDS[at] });
      if (refusal !== null) {
        useChordCapture.setState({ refused: refusal });
        return;
      }
      stop();
      const own = defaults.filter(rule => rule.command === command);
      write({ keybindings: { [command]: own.length === 1 && own[0]!.key === chord ? null : chord } });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, command, rules, defaults, platform, write]);

  useEffect(() => () => {
    if (useChordCapture.getState().command === command) stop();
  }, [command]);

  return (
    <span className="flex shrink-0 items-center gap-2">
      {overridden && !capturing ? (
        <Button data-k="reset-chord" size="xs" variant="ghost" onClick={() => write({ keybindings: { [command]: null } })}>
          {CHORD_WORDS.reset}
        </Button>
      ) : null}
      <button
        type="button"
        data-chord={command}
        aria-label={CHORD_WORDS.capture(KEYBINDING_WORDS[command])}
        aria-pressed={capturing}
        onClick={() => (capturing ? stop() : useChordCapture.setState({ command, refused: null }))}
        className={cn("-mx-1.5 flex h-7 cursor-pointer items-center rounded-lg px-1.5 transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", capturing && "bg-accent")}
      >
        {!capturing ? (
          <KeyCaps keys={keys} />
        ) : refused === null ? (
          <span data-k="capturing" className="text-xs leading-4 text-muted-foreground">
            {CHORD_WORDS.capturing}
          </span>
        ) : (
          <span data-k="chord-refused" className="text-xs leading-4 text-error-foreground">
            {refused}
          </span>
        )}
      </button>
    </span>
  );
}
