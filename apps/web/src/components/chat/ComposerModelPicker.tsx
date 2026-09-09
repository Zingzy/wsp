// SPDX-License-Identifier: AGPL-3.0-only
// The model picker in the composer box: the harness's mark and the model on
// the button; behind it a rail of the harnesses that can run a turn, a search
// box, the models with favourites first and a jump chip per row, and a footer
// naming where the list came from in that agent's own words, on one line
// whatever the words are and whole on hover. Cmd-1 to cmd-9 pick a listed
// model while the menu is open. The harness is pinned once the thread has a
// turn: a thread is one resumed session, so picking another harness changes
// nothing and the footer says to start a new thread for it.
import { ChevronDownIcon, SearchIcon, StarIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { catalogSourceLine, noModelsLine } from "@wsp/protocol";
import type { HarnessCatalog, HarnessModel } from "@wsp/protocol";
import { cn, isMacPlatform, normalizeSearchText } from "../../lib/utils";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { favouriteKey, useComposerFavouritesStore } from "./composerFavouritesStore";
import { HarnessMark } from "./HarnessMark";

const JUMP_KEYS = 9;

export interface ModelPickerProps {
  catalogs: ReadonlyArray<HarnessCatalog>;
  catalog: HarnessCatalog;
  model: HarnessModel | null;
  /** The thread already has a turn on this harness, so the rail offers no other. */
  pinned: boolean;
  onPickHarness: (harness: string) => void;
  onPickModel: (harness: string, model: string) => void;
}

/** Favourites first, then the catalog's order; a search narrows by label, slug and description. */
export function listModels(catalog: HarnessCatalog, favourites: ReadonlyArray<string>, query: string): HarnessModel[] {
  const q = normalizeSearchText(query);
  const rows = catalog.models.filter(m => q === "" || normalizeSearchText(`${m.label} ${m.value} ${m.description ?? ""}`).includes(q));
  const starred = (m: HarnessModel) => favourites.includes(favouriteKey(catalog.harness, m.value));
  return [...rows.filter(starred), ...rows.filter(m => !starred(m))];
}

export function jumpLabel(index: number, platform: string): string | null {
  if (index >= JUMP_KEYS) return null;
  return isMacPlatform(platform) ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

/** The one line the composer answers a cross-harness pick on a started thread with. */
export function newThreadNotice(entry: HarnessCatalog): string {
  return `Start a new thread to use ${entry.label} here`;
}

export function ComposerModelPicker({ catalogs, catalog, model, pinned, onPickHarness, onPickModel }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const favourites = useComposerFavouritesStore(s => s.keys);
  const toggle = useComposerFavouritesStore(s => s.toggle);
  const rows = useMemo(() => listModels(catalog, favourites, query), [catalog, favourites, query]);
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setNotice(null);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const pick = useCallback(
    (m: HarnessModel) => {
      onPickModel(catalog.harness, m.value);
      setOpen(false);
    },
    [catalog.harness, onPickModel],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
        const row = rows[Number(event.key) - 1];
        if (row === undefined) return;
        event.preventDefault();
        pick(row);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (rows.length === 0) return;
        setActive(i => (i + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        return;
      }
      if (event.key === "Enter") {
        const row = rows[active];
        if (row === undefined) return;
        event.preventDefault();
        pick(row);
      }
    },
    [active, pick, rows],
  );

  const label = model?.label ?? "Model";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="ghost" size="xs" />}
        className="shrink-0 font-medium text-muted-foreground/70 hover:text-foreground/80"
        aria-label={model === null ? "Model" : `Model: ${label}`}
        data-composer-picker="model"
        data-value={model?.value}
        data-harness={catalog.harness}
      >
        <span className="inline-flex text-foreground">
          <HarnessMark harness={catalog.harness} label={catalog.label} className="size-3.5" />
        </span>
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverPopup align="start" side="top" className="w-[22rem] p-0" viewportClassName="p-0 [--viewport-inline-padding:0]">
        <div className="flex max-h-80 min-h-0" data-composer-model-menu onKeyDown={onKeyDown}>
          <div className="flex w-10 shrink-0 flex-col gap-1 border-e border-border p-1" role="tablist" aria-label="Harness">
            {catalogs.map(entry => {
              const selected = entry.harness === catalog.harness;
              return (
                <button
                  key={entry.harness}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={entry.label}
                  title={entry.label}
                  data-composer-harness={entry.harness}
                  onClick={() => {
                    if (selected) return;
                    if (pinned) setNotice(newThreadNotice(entry));
                    else onPickHarness(entry.harness);
                  }}
                  className={cn(
                    "flex aspect-square w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected && "bg-foreground/[0.08] text-foreground",
                  )}
                >
                  <HarnessMark harness={entry.harness} label={entry.label} className="size-4" />
                </button>
              );
            })}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <label className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-sm">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={inputRef}
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                placeholder="Search models"
                aria-label="Search models"
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-placeholder"
                data-composer-model-search
              />
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label="Models">
              {rows.length === 0 ? (
                <div className="px-2 py-3 text-center text-xs text-muted-foreground">{catalog.models.length === 0 ? noModelsLine(catalog) : "No model matches"}</div>
              ) : (
                rows.map((m, index) => {
                  const starred = favourites.includes(favouriteKey(catalog.harness, m.value));
                  const chip = jumpLabel(index, platform);
                  return (
                    <div
                      key={m.value}
                      role="option"
                      aria-selected={model?.value === m.value}
                      data-composer-option={m.value}
                      data-active={index === active || undefined}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(m)}
                      className={cn(
                        "group flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-foreground",
                        index === active && "bg-accent text-accent-foreground",
                        model?.value === m.value && "bg-foreground/[0.08]",
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">{m.label}</span>
                          {m.isDefault ? <span className="rounded border border-border/70 bg-muted/60 px-1 font-mono text-[10px] leading-4 text-muted-foreground">default</span> : null}
                        </div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground/70">{m.description ?? m.value}</div>
                      </div>
                      {chip !== null ? <Kbd className="h-4 min-w-0 rounded-sm px-1 font-mono text-[10px]">{chip}</Kbd> : null}
                      <button
                        type="button"
                        aria-label={starred ? `Remove ${m.label} from favourites` : `Add ${m.label} to favourites`}
                        aria-pressed={starred}
                        data-composer-favourite={m.value}
                        onClick={e => {
                          e.stopPropagation();
                          toggle(catalog.harness, m.value);
                        }}
                        className={cn("shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-60 hover:text-foreground group-hover:opacity-100", starred && "text-foreground opacity-100")}
                      >
                        <StarIcon className={cn("size-3", starred && "fill-current")} aria-hidden />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
            <div
              className="truncate border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground/70"
              data-composer-catalog-source={catalog.source}
              role={notice !== null ? "status" : undefined}
              title={notice ?? catalogSourceLine(catalog)}
            >
              {notice ?? catalogSourceLine(catalog)}
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
