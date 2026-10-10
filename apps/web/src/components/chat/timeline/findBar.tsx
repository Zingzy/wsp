// SPDX-License-Identifier: AGPL-3.0-only
// The find bar over a transcript, as a browser's: a field, where the current match stands among them all, the step
// up and down, and the close.
import type { KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../ui/input-group";
import { ownsKeys } from "../../../keyOwners";
import type { TranscriptFind } from "./useFind";

export const FIND_WORDS = {
  field: "Find in thread",
  none: "No matches",
  previous: "Previous match",
  next: "Next match",
  close: "Close",
  count: (current: number, total: number) => `${current} of ${total}`,
} as const;

const BAR_KEYS = ownsKeys(["Escape", "Enter", "ArrowUp", "ArrowDown"]);

export function FindBar({ find }: { find: TranscriptFind }) {
  if (!find.open) return null;
  const { query, current, total, step } = find;
  const count = query.length === 0 ? "" : total === 0 ? FIND_WORDS.none : FIND_WORDS.count(Math.max(current, 1), total);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      find.close();
    } else if (event.key === "Enter" || event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event.key === "ArrowUp" || (event.key === "Enter" && event.shiftKey) ? -1 : 1);
    }
  };
  return (
    <div
      role="search"
      data-thread-find
      data-owns-keys={BAR_KEYS}
      className="dropdown-glass popover-shadow absolute top-3 right-4 z-20 flex w-80 max-w-full items-center gap-0.5 rounded-xl p-1"
    >
      <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={find.inputRef}
          type="search"
          size="sm"
          value={query}
          aria-label={FIND_WORDS.field}
          placeholder={FIND_WORDS.field}
          spellCheck={false}
          autoComplete="off"
          onChange={event => find.setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <InputGroupAddon align="inline-end">
          <span data-find-count aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        </InputGroupAddon>
      </InputGroup>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={FIND_WORDS.previous} disabled={total === 0} onClick={() => step(-1)}>
        <ChevronUpIcon />
      </Button>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={FIND_WORDS.next} disabled={total === 0} onClick={() => step(1)}>
        <ChevronDownIcon />
      </Button>
      <Button type="button" size="icon-xs" variant="ghost" aria-label={FIND_WORDS.close} onClick={find.close}>
        <XIcon />
      </Button>
    </div>
  );
}
