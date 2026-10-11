// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/ThreadFindBar.tsx at a8bdfdb5 (MIT).
// Differs from upstream: the frame is the popover tier's own (fill, edge, shadow, radius), the four toggles stand in
// the field's end (a row of their own on a narrow screen), the count has a slot of its own with the spinner while
// the thread pages in, a second line says what stops a search, and every key is the bar's or the keybinding rules'
// with its chord in a tooltip.
import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { CaseSensitiveIcon, ChevronDownIcon, ChevronUpIcon, RegexIcon, WholeWordIcon, WrenchIcon, XIcon, type LucideIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { Spinner } from "../../ui/spinner";
import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { parseKeybindingShortcut } from "../../../keybindingDefaults";
import { formatShortcutLabel, matchesShortcut } from "../../../keybindings";
import { cn, isMacPlatform } from "../../../lib/utils";
import { FACT } from "../../../settings/format";
import { NOTE } from "../../../settings/layout";
import { useShortcutLabel } from "../../../shell/useKeybindings";
import { useMediaQuery } from "../../../hooks/useMediaQuery";
import { setFindQuery, takeFocusAsk, toggleFind, useThreadFind, type FindToggle } from "./store";
import { FIND_WORDS } from "./words";

/** What the bar shows of the search: the count's words, a spinner while the thread pages in, whether there is a
 * match to step to, and the one sentence that says why a search found nothing. */
export interface FindStatus {
  readonly count: string | null;
  readonly busy: boolean;
  readonly canStep: boolean;
  readonly note: string | null;
}

/** The toggles in the order they stand, each with its glyph and, for the three VS Code binds, its key. */
const TOGGLES: ReadonlyArray<{ readonly toggle: FindToggle; readonly Glyph: LucideIcon; readonly key: string | null }> = [
  { toggle: "matchCase", Glyph: CaseSensitiveIcon, key: "c" },
  { toggle: "wholeWord", Glyph: WholeWordIcon, key: "w" },
  { toggle: "regex", Glyph: RegexIcon, key: "r" },
  { toggle: "tools", Glyph: WrenchIcon, key: null },
];

const FIELD_MAX = 200;

/** A toggle's chord: Option with Command on a Mac, where Option alone types a character, and Alt elsewhere. */
function toggleChord(key: string, platform: string) {
  return parseKeybindingShortcut(isMacPlatform(platform) ? `mod+alt+${key}` : `alt+${key}`);
}

function Tip({ label, chord, children }: { label: string; chord: string | null; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="bottom">
        {label}
        {chord === null ? null : <span className="ms-2 font-mono text-muted-foreground">{chord}</span>}
      </TooltipPopup>
    </Tooltip>
  );
}

export function FindBar({ status, onOlder, onNewer, onClose }: { status: FindStatus; onOlder: () => void; onNewer: () => void; onClose: () => void }): ReactNode {
  const query = useThreadFind(s => s.query);
  const focusAsk = useThreadFind(s => s.focusAsk);
  const pressed = useThreadFind(useShallow(s => ({ matchCase: s.matchCase, wholeWord: s.wholeWord, regex: s.regex, tools: s.tools })));
  const input = useRef<HTMLInputElement | null>(null);
  // On a narrow screen the toggles take a row of their own, so the field keeps room for the query.
  const narrow = useMediaQuery("max-sm");
  const platform = navigator.platform;
  const chords = useMemo(() => TOGGLES.map(t => (t.key === null ? null : toggleChord(t.key, platform))), [platform]);
  const enter = useMemo(() => ["enter", "shift+enter"].map(key => formatShortcutLabel(parseKeybindingShortcut(key)!, platform)), [platform]);
  const olderChord = useShortcutLabel("thread.findOlder");
  const newerChord = useShortcutLabel("thread.findNewer");

  useEffect(() => {
    if (!takeFocusAsk(focusAsk)) return;
    input.current?.focus();
    input.current?.select();
  }, [focusAsk]);

  const toggles = TOGGLES.map(({ toggle, Glyph }, i) => (
    <Tip key={toggle} label={FIND_WORDS[toggle]} chord={chords[i] == null ? null : formatShortcutLabel(chords[i]!, platform)}>
      <Toggle variant="ghost" size="xs" aria-label={FIND_WORDS[toggle]} pressed={pressed[toggle]} onPressedChange={() => toggleFind(toggle)} data-find-toggle={toggle}>
        <Glyph className="size-3.5" aria-hidden />
      </Toggle>
    </Tip>
  ));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "Enter" && event.target === input.current) {
      event.preventDefault();
      if (event.shiftKey) onNewer();
      else onOlder();
      return;
    }
    const at = chords.findIndex(chord => chord !== null && matchesShortcut(event.nativeEvent, chord, platform));
    if (at >= 0) {
      event.preventDefault();
      event.stopPropagation();
      toggleFind(TOGGLES[at]!.toggle);
    }
  };

  return (
    <div
      role="search"
      aria-label={FIND_WORDS.field}
      aria-busy={status.busy}
      data-thread-find={status.busy ? "paging" : "whole"}
      className="dropdown-glass popover-shadow absolute inset-x-3 top-3 z-20 ms-auto max-w-105 rounded-(--radius-popover)"
      onKeyDown={onKeyDown}
    >
      <div className="flex h-9 items-center gap-1 p-1">
        <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
          <InputGroupInput
            ref={input}
            size="sm"
            value={query}
            aria-label={FIND_WORDS.field}
            placeholder={FIND_WORDS.field}
            maxLength={FIELD_MAX}
            spellCheck={false}
            autoComplete="off"
            onChange={event => setFindQuery(event.target.value)}
          />
          {narrow ? null : (
            <InputGroupAddon align="inline-end" className="gap-0">
              {toggles}
            </InputGroupAddon>
          )}
        </InputGroup>
        <span aria-live="polite" data-find-count className={cn(FACT, "flex w-18 shrink-0 items-center justify-end gap-1.5 whitespace-nowrap sm:w-24")}>
          {status.busy && query.length > 0 ? <Spinner className="size-3.5" aria-hidden /> : null}
          {status.count}
        </span>
        <Tip label={FIND_WORDS.older} chord={[enter[0], olderChord].filter(Boolean).join(" ")}>
          <Button variant="ghost" size="icon-xs" aria-label={FIND_WORDS.older} disabled={!status.canStep} onClick={onOlder}>
            <ChevronUpIcon className="size-3.5" aria-hidden />
          </Button>
        </Tip>
        <Tip label={FIND_WORDS.newer} chord={[enter[1], newerChord].filter(Boolean).join(" ")}>
          <Button variant="ghost" size="icon-xs" aria-label={FIND_WORDS.newer} disabled={!status.canStep} onClick={onNewer}>
            <ChevronDownIcon className="size-3.5" aria-hidden />
          </Button>
        </Tip>
        <Tip label={FIND_WORDS.close} chord="Esc">
          <Button variant="ghost" size="icon-xs" aria-label={FIND_WORDS.close} onClick={onClose}>
            <XIcon className="size-3.5" aria-hidden />
          </Button>
        </Tip>
      </div>
      {narrow ? <div className="flex items-center gap-1 px-1 pb-1">{toggles}</div> : null}
      {status.note === null ? null : <p className={cn(NOTE, "px-3 pb-2")} data-find-note>{status.note}</p>}
    </div>
  );
}
