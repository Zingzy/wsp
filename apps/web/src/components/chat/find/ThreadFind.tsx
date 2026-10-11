// SPDX-License-Identifier: AGPL-3.0-only
// Find in thread over the transcript on screen. Opening it pages in every event the host holds of the thread, reads
// each entry's text a slice at a time (newest first, so the matches near the reader count first), and searches what
// is read on each keystroke: a literal query here, a pattern in a worker that is ended when it runs long. The count
// says "+" until the thread and its text are whole. A step opens what hides its match, brings the row into view and
// paints it as the current match; a match that moves under a page landing or a turn streaming stays the current one.
// Its own component, so a slice or a keystroke draws the bar and not the view around it.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { requestComposerFocus } from "../../../shell/shellRequests";
import type { TimelineEntry } from "../adapt";
import type { TimelineFinder } from "../MessagesTimeline";
import { FindBar, type FindStatus } from "./FindBar";
import { showRange, useFindHighlights } from "./highlights";
import { MATCH_CAP, needleOf, type Needle } from "./match";
import { regexSearch, type RegexSearch } from "./regex";
import { searchDocs, type FindMatch, type FindResult } from "./search";
import { closeThreadFind, findTargetIs, focusBeforeFind, useThreadFind } from "./store";
import { docOf, FindTextCache, type FindDoc } from "./text";
import { FIND_WORDS } from "./words";

/** How long one slice of reading entries' text may run before it yields to the page. */
const SLICE_MS = 12;
/** Room the bar takes over the transcript's top, which a match brought into view stays clear of. */
const BAR_CLEARANCE = 60;
/** Pages read back before paging in gives up on a host that answers without moving. */
const STILL_PAGES = 2;

export interface ThreadHistory {
  readonly whole: boolean;
  readonly trimmed: boolean;
  readonly older: () => Promise<boolean>;
}

type Searched = { readonly result: FindResult; readonly needle: Needle } | { readonly invalid: true } | { readonly slow: true } | null;

/** Whether the part holding a match is drawn inside the transcript's box; a folded or unmounted one is not. */
function drawnInSight(match: FindMatch, finder: TimelineFinder | null): boolean {
  const scroller = finder?.scroller();
  const part = finder?.viewport.querySelector(`[data-find-entry="${CSS.escape(match.entryId)}"] [data-find-part="${match.part}"], [data-find-entry="${CSS.escape(match.entryId)}"][data-find-part="${match.part}"]`);
  if (scroller == null || part == null) return false;
  const rect = part.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  return rect.bottom > box.top && rect.top < box.bottom;
}

const sameMatch = (a: FindMatch, b: FindMatch): boolean => a.entryId === b.entryId && a.part === b.part && a.ordinal === b.ordinal;
const indexOf = (index: ReadonlyMap<string, number>, id: string | undefined): number => (id === undefined ? -1 : (index.get(id) ?? -1));

export function ThreadFind({
  workspaceId,
  entries,
  cwd,
  threadKey,
  finder,
  history,
  makeRegex = regexSearch,
  cap = MATCH_CAP,
}: {
  /** Whose composer takes focus back when the bar closes. */
  workspaceId: string;
  entries: ReadonlyArray<TimelineEntry>;
  cwd: string | undefined;
  /** The thread shown; a new one is searched again from its newest match. */
  threadKey: string;
  /** The list on screen, null while none is drawn. */
  finder: TimelineFinder | null;
  history: ThreadHistory;
  makeRegex?: () => RegexSearch;
  /** How many matches a search keeps; a test lowers it to reach the cap on a small thread. */
  cap?: number;
}): ReactNode {
  const { open, query, matchCase, wholeWord, regex, tools } = useThreadFind(
    useShallow(s => ({ open: s.open, query: s.query, matchCase: s.matchCase, wholeWord: s.wholeWord, regex: s.regex, tools: s.tools })),
  );

  const finderRef = useRef(finder);
  finderRef.current = finder;
  const stepRef = useRef<(direction: -1 | 1) => void>(() => {});
  useEffect(() => {
    if (finder === null) return;
    return findTargetIs({ holds: node => finderRef.current?.viewport.contains(node) === true, step: direction => stepRef.current(direction) });
  }, [finder]);

  // Every event the host holds, paged in while the bar is open.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const { whole, older } = history;
  useEffect(() => {
    if (!open || whole) return;
    let live = true;
    void (async () => {
      let still = 0;
      while (live && still < STILL_PAGES) {
        const before = entriesRef.current.length;
        const more = await older();
        if (!more) return;
        still = entriesRef.current.length === before ? still + 1 : 0;
      }
    })();
    return () => {
      live = false;
    };
  }, [open, whole, older, threadKey]);

  // Each entry's text, read once per entry object and kept for the thread shown while the bar is open; closing it lets
  // the text go.
  const caches = useMemo(() => ({ text: new FindTextCache(), docs: new WeakMap<TimelineEntry, FindDoc | null>() }), [threadKey, cwd, open]);
  const [read, setRead] = useState<{ readonly docs: ReadonlyArray<FindDoc>; readonly whole: boolean } | null>(null);
  useEffect(() => {
    if (!open) {
      setRead(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slice = (): void => {
      const deadline = performance.now() + SLICE_MS;
      const docs: FindDoc[] = [];
      let readAll = true;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        let doc = caches.docs.get(entry);
        if (doc === undefined) {
          if (performance.now() > deadline) {
            readAll = false;
            continue;
          }
          doc = docOf(entry, cwd, caches.text);
          caches.docs.set(entry, doc);
        }
        if (doc !== null) docs.push(doc);
      }
      docs.reverse();
      setRead({ docs, whole: readAll });
      if (!readAll) timer = setTimeout(slice, 0);
      else caches.text.keepOnly(new Set(entries.map(e => e.id)));
    };
    slice();
    return () => clearTimeout(timer);
  }, [open, entries, cwd, caches]);

  // Where the person is reading, read once each time the query, the toggles or the thread change: a capped search
  // keeps the matches nearest it, and the first match picked is the newest at or above it. A new thread is read from
  // its newest match. Typing moves nothing, so the place stays the reader's own. It is held as the entry, since older
  // pages landing above the reader move every index.
  const entryIndex = useMemo(() => new Map(entries.map((e, i) => [e.id, i])), [entries]);
  const readKey = `${open}\n${query}\n${matchCase}\n${wholeWord}\n${regex}\n${tools}`;
  const reader = useRef<{ key: string; thread: string; at: string | undefined; fresh: boolean }>({ key: "", thread: threadKey, at: undefined, fresh: true });
  if (reader.current.key !== readKey || reader.current.thread !== threadKey) {
    const switched = reader.current.thread !== threadKey;
    reader.current = { key: readKey, thread: threadKey, at: switched || !open ? undefined : entries[finderRef.current?.bottomEntry() ?? -1]?.id, fresh: true };
  }
  const anchorIn = useCallback(
    (docs: ReadonlyArray<FindDoc>): number | undefined => {
      const at = indexOf(entryIndex, reader.current.at);
      return at < 0 ? undefined : Math.max(0, docs.findLastIndex(d => (entryIndex.get(d.entryId) ?? 0) <= at));
    },
    [entryIndex],
  );

  // The search: a literal query on this thread, a pattern in the worker.
  const options = useMemo(() => ({ matchCase, wholeWord, regex }), [matchCase, wholeWord, regex]);
  const needle = useMemo(() => needleOf(query, options), [query, options]);
  const literal = useMemo<Searched>(() => {
    if (!open || needle === null || read === null) return null;
    if ("invalid" in needle) return { invalid: true };
    return needle.kind === "literal" ? { result: searchDocs(read.docs, needle, tools, { anchor: anchorIn(read.docs), cap }), needle } : null;
  }, [open, needle, read, tools, anchorIn, cap]);
  const [patterned, setPatterned] = useState<Searched>(null);
  const [regexer] = useState(() => ({ held: null as RegexSearch | null }));
  useEffect(() => () => regexer.held?.dispose(), [regexer]);
  useEffect(() => {
    if (!open || needle === null || "invalid" in needle || needle.kind !== "regex" || read === null) {
      setPatterned(null);
      return;
    }
    let live = true;
    regexer.held ??= makeRegex();
    void regexer.held.search(read.docs, query, { matchCase, wholeWord }, tools, { anchor: anchorIn(read.docs), cap }).then(answer => {
      if (!live || answer === "stale") return;
      setPatterned(answer === "slow" ? { slow: true } : "invalid" in answer ? { invalid: true } : { result: answer.result, needle });
    });
    return () => {
      live = false;
    };
  }, [open, needle, read, query, matchCase, wholeWord, tools, regexer, makeRegex, anchorIn, cap]);
  const searched = needle !== null && !("invalid" in needle) && needle.kind === "regex" ? patterned : literal;
  const result = searched !== null && "result" in searched ? searched.result : null;
  const painted = searched !== null && "result" in searched ? searched.needle : null;

  // The current match: picked fresh when the query, the toggles or the thread change, kept through anything else.
  // A fresh pick is painted where it stands and scrolls nothing; the first step shows it if it is not in sight.
  const [current, setCurrent] = useState<FindMatch | null>(null);
  const inSight = useRef(false);
  const wantShown = useRef<FindMatch | null>(null);
  const show = useCallback((match: FindMatch) => {
    wantShown.current = match;
    inSight.current = true;
    finderRef.current?.show(match);
  }, []);
  useLayoutEffect(() => {
    if (result === null || result.matches.length === 0) {
      if (current !== null && result !== null) setCurrent(null);
      return;
    }
    const matches = result.matches;
    if (reader.current.fresh) {
      const at = indexOf(entryIndex, reader.current.at);
      let pick = matches.length - 1;
      if (at >= 0) {
        const above = matches.findLastIndex(m => (entryIndex.get(m.entryId) ?? 0) <= at);
        pick = above >= 0 ? above : 0;
      }
      reader.current.fresh = false;
      inSight.current = false;
      setCurrent(matches[pick]!);
      return;
    }
    if (current !== null && matches.some(m => sameMatch(m, current))) return;
    const at = current === null ? -1 : (entryIndex.get(current.entryId) ?? -1);
    const near = at < 0 ? matches.length - 1 : Math.max(0, matches.findLastIndex(m => (entryIndex.get(m.entryId) ?? 0) <= at));
    setCurrent(matches[near]!);
  }, [result, entryIndex, current]);
  const index = current === null || result === null ? -1 : result.matches.findIndex(m => sameMatch(m, current));

  const step = useCallback(
    (direction: -1 | 1) => {
      const matches = result?.matches ?? [];
      if (matches.length === 0) return;
      if (current !== null && index >= 0 && !inSight.current && !drawnInSight(current, finderRef.current)) {
        show(current);
        return;
      }
      const from = index < 0 ? (direction < 0 ? matches.length : -1) : index;
      const next = matches[(from + direction + matches.length) % matches.length]!;
      setCurrent(next);
      show(next);
    },
    [result, index, current, show],
  );
  stepRef.current = step;

  const viewport = open ? (finder?.viewport ?? null) : null;
  useFindHighlights({
    viewport,
    needle: painted,
    tools,
    current,
    onCurrent: range => {
      const want = wantShown.current;
      const scroller = finderRef.current?.scroller();
      if (want === null || current === null || !sameMatch(want, current) || scroller == null) return;
      wantShown.current = null;
      const inset = parseFloat(getComputedStyle(scroller).getPropertyValue("--chat-composer-inset")) || 0;
      showRange(range, scroller, BAR_CLEARANCE, inset + 16);
    },
  });

  const close = useCallback(() => {
    const back = focusBeforeFind();
    closeThreadFind();
    if (back instanceof HTMLElement && back.isConnected && back.closest("[data-chat-composer-dock]") === null && back !== document.body) back.focus();
    else requestComposerFocus(workspaceId);
  }, [workspaceId]);

  if (!open || finder === null) return null;
  const partial = !history.whole || read === null || !read.whole;
  const total = result?.matches.length ?? 0;
  const status: FindStatus = {
    count: needle === null || searched === null || !("result" in searched) ? null : total === 0 ? (partial ? null : FIND_WORDS.noResults) : FIND_WORDS.count(index + 1, total, partial || result!.capped),
    busy: partial && !(searched !== null && !("result" in searched)),
    canStep: total > 0,
    note: searched !== null && "invalid" in searched ? FIND_WORDS.invalid : searched !== null && "slow" in searched ? FIND_WORDS.slow : history.trimmed ? FIND_WORDS.trimmed : null,
  };
  return <FindBar status={status} onOlder={() => step(-1)} onNewer={() => step(1)} onClose={close} />;
}
