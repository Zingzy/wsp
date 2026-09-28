// Adapted from pingdotgg/t3code apps/web/src/components/chat/ComposerStashMenu.tsx at c9a0e8a1 (MIT).
// Differs from upstream: the count is the word "Stashed N" rather than a
// badge; a file count and a dropped count are muted words, with no thumbnails
// and no warning colour; there is no saving state, since nothing is encoded
// after the entry is written.
import { BookmarkIcon, FileTextIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "../../lib/timestampFormat";
import { cn } from "../../lib/utils";
import { ComposerBanner } from "./ComposerBanner";
import type { PromptStashEntry } from "./promptStashStore";

const SNIPPET_MAX_CHARS = 90;

/** The word the composer's footer and the menu's head say for the stash. */
export const stashedWord = (count: number): string => `Stashed ${count}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function stashEntrySnippet(entry: PromptStashEntry): string {
  const words = entry.prompt.trim().replace(/\s+/g, " ");
  if (words.length > 0) return words.length > SNIPPET_MAX_CHARS ? `${words.slice(0, SNIPPET_MAX_CHARS)}…` : words;
  return entry.files.length > 0 ? `(${plural(entry.files.length, "file")})` : "(empty)";
}

/** The stashed prompts over the composer: arrows walk them, Enter restores, Escape closes, Cmd or Ctrl with Backspace
 * deletes. The keys are read in the capture phase on the window, so they win over the composer's while it is open. */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, onRestore, onDelete, onClose } = props;
  const drawerRef = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);
  const highlighted = entries.find(entry => entry.id === highlightedId) ?? entries[0];

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const drawer = drawerRef.current;
      if ((drawer !== null && event.composedPath().includes(drawer)) || (event.target instanceof Element && event.target.closest("[data-composer-stash-word]"))) return;
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "Escape") {
        take();
        onClose();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        take();
        const at = entries.findIndex(entry => entry.id === highlighted?.id);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const next = entries[((at >= 0 ? at : offset === 1 ? -1 : 0) + offset + entries.length) % entries.length];
        setHighlightedId(next?.id ?? null);
        drawerRef.current?.querySelector<HTMLElement>(`[data-stash-entry="${next?.id ?? ""}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        // The delete button owns its own Enter.
        if (event.target instanceof HTMLElement && event.target.closest("[data-stash-delete]")) return;
        if (highlighted === undefined) return;
        take();
        onRestore(highlighted);
      } else if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
        if (highlighted === undefined) return;
        take();
        onDelete(highlighted);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [entries, highlighted, onClose, onDelete, onRestore]);

  return (
    <ComposerBanner.Root ref={drawerRef} data-composer-stash-drawer="true">
      <ComposerBanner.Row render={<button type="button" />} aria-label="Close stash" aria-expanded="true" onPointerDown={event => event.preventDefault()} onClick={onClose}>
        <ComposerBanner.Icon>
          <BookmarkIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="font-mono text-[11px] text-muted-foreground tabular-nums">{stashedWord(entries.length)}</ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.ToggleIcon expanded />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll>
        <ComposerBanner.Children render={<ul role="list" />} aria-label="Stashed prompts">
          {entries.map(entry => {
            const on = highlighted?.id === entry.id;
            return (
              <ComposerBanner.Row
                render={<li />}
                key={entry.id}
                data-stash-entry={entry.id}
                data-highlighted={on || undefined}
                className={cn("relative rounded-sm", on && "bg-accent text-accent-foreground")}
                onMouseMove={() => {
                  if (highlightedId !== entry.id) setHighlightedId(entry.id);
                }}
                onFocus={() => setHighlightedId(entry.id)}
              >
                <ComposerBanner.Icon>
                  <FileTextIcon />
                </ComposerBanner.Icon>
                <ComposerBanner.Content>
                  <button
                    type="button"
                    className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-ring"
                    data-stash-restore={entry.id}
                    aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                    onPointerDown={event => event.preventDefault()}
                    onClick={() => onRestore(entry)}
                  >
                    {stashEntrySnippet(entry)}
                  </button>
                </ComposerBanner.Content>
                <ComposerBanner.Actions className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {entry.files.length > 0 ? <span className="shrink-0">{plural(entry.files.length, "file")}</span> : null}
                  {entry.dropped.length > 0 ? <span className="shrink-0" title={entry.dropped.join(", ")}>{`${entry.dropped.length} dropped`}</span> : null}
                  <time dateTime={entry.createdAt} className="shrink-0 max-sm:hidden">
                    {formatRelativeTimeLabel(entry.createdAt)}
                  </time>
                  <ComposerBanner.Dismiss className="z-10" aria-label="Delete stashed prompt" data-stash-delete="true" onPointerDown={event => event.preventDefault()} onClick={() => onDelete(entry)} />
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            );
          })}
        </ComposerBanner.Children>
      </ComposerBanner.Scroll>
    </ComposerBanner.Root>
  );
});
