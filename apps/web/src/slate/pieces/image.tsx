// SPDX-License-Identifier: AGPL-3.0-only
// Pictures read by the host and handed over as bytes: a file anywhere on the thread's computer, or an address the host
// fetches once the person allows its domain for the thread, so this window never requests one itself. One image fits
// the panel's width with its caption under it; several sit in a row that scrolls sideways, in a grid, or as a before
// and after under one slider. Each opens large in the diagram's dialog, zoomed and panned in the same frame, with
// previous and next where there are several. A file loading, missing, too big or waiting on the person's word keeps
// the frame at the size the picture would take, so nothing below it moves when it arrives.
import type { SlatesImageAnswer } from "@wsp/protocol";
import { slateListTooLong, SLATE_LIMITS } from "@wsp/protocol/slate";
import { ChevronLeft, ChevronRight, GripVertical, Maximize2, Minus, Plus, Scan, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Button, KEYCAP_BEVEL } from "../../components/ui/button.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "../../components/ui/dialog.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import { DOC, RUNS, type SlateEngine } from "../engine.js";
import type { PieceView } from "../SlateView.js";
import { useWidth } from "./chart.js";
import { str } from "./look.js";
import { EXPANDED_POPUP, ZoomFrame, type ZoomControls } from "./zoom.js";

/** A frame's tallest inline, as the diagram's, so a phone's screenshot never swallows the slate. */
const INLINE_CAP = 420;
/** The shape a frame holds before its picture is known: a laptop screen's. */
const UNKNOWN_RATIO = 10 / 16;
/** The dialog fits a picture whole down to this scale, with zoom in a press away. */
const OVERVIEW_LEAST = 0.2;
const FRAME = `relative ${CARD_SURFACE}`;

export const IMAGE_WORDS = {
  ask: (domain: string) => `Show images from ${domain} in this thread? wsp fetches them, not this window.`,
  allow: "Allow",
} as const;

type Shot = { state: "loading" } | { state: "shown"; url: string; w: number; h: number } | { state: "asking"; domain: string } | { state: "refused"; why: string };
type Read = ((src: string, have?: string) => Promise<SlatesImageAnswer>) | undefined;
type Allow = ((domain: string) => Promise<unknown>) | undefined;

/** Rises each time the person allows a domain in a thread, so every piece there asks again for what waited on one. */
const allowedRounds = new WeakMap<SlateEngine, number>();
const roundListeners = new Set<() => void>();
const allowedNow = (slate: SlateEngine): void => {
  allowedRounds.set(slate, (allowedRounds.get(slate) ?? 0) + 1);
  for (const listen of roundListeners) listen();
};
const useAllowedRound = (slate: SlateEngine): number =>
  useSyncExternalStore(
    listen => {
      roundListeners.add(listen);
      return () => void roundListeners.delete(listen);
    },
    () => allowedRounds.get(slate) ?? 0,
  );

/** A problem's words as the panel says them, capital first, unless they open on a path. */
const sentence = (s: string): string => (/^[a-z]+ /.test(s) ? s[0]!.toUpperCase() + s.slice(1) : s);

/** How many times the slate's runs have finished, which moves when a run ends and not while it ticks along. */
function runsEnded(slate: SlateEngine): number {
  const values = slate.values;
  return Object.keys(slate.document?.runs ?? {}).reduce((n, name) => {
    const run = values[name];
    if (typeof run !== "object" || run === null || Array.isArray(run)) return n;
    const runs = typeof run["runs"] === "number" ? run["runs"] : 0;
    return n + (run["state"] === "running" ? runs - 1 : runs);
  }, 0);
}

/** A picture this piece holds: what it was asked as and the version the host said it is. */
type Held = { src: string; version: string | undefined; url: string };

/** The answer as a frame shows it; a picture's bytes become a URL this piece owns until it lets it go. */
async function shotOf(src: string, answer: SlatesImageAnswer): Promise<{ shot: Shot; held?: Held }> {
  if ("ask" in answer) return { shot: { state: "asking", domain: answer.ask.domain } };
  if ("problem" in answer) return { shot: { state: "refused", why: sentence(answer.problem.message) } };
  if ("unchanged" in answer) return { shot: { state: "loading" } };
  const bytes = Uint8Array.from(atob(answer.bytes), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: answer.mediaType }));
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    return { shot: { state: "refused", why: `${src} did not draw` } };
  }
  return { shot: { state: "shown", url, w: img.naturalWidth, h: img.naturalHeight }, held: { src, version: answer.version, url } };
}

/** The pictures for these srcs, each asked for once it is near view, and again at every write of the slate, every run
 * on it that finishes (a timed run may shoot the file again) and every domain the person allows, naming the version held so an unchanged file is not sent again. Only a picture is kept:
 * a refusal is asked again at the next write. A picture replaced or left behind at unmount is released. */
function useShots(slate: SlateEngine, srcs: readonly string[], ask: Read, near: readonly boolean[]): Shot[] {
  const written = useSyncExternalStore(listen => slate.subscribe(DOC, listen), () => slate.version);
  const ended = useSyncExternalStore(listen => slate.subscribe(RUNS, listen), () => runsEnded(slate));
  const round = useAllowedRound(slate);
  const [shots, setShots] = useState<Shot[]>(() => srcs.map(() => ({ state: "loading" })));
  const held = useRef(new Map<number, Held>());
  const asked = useRef(new Map<number, string>());
  const turn = useRef(new Map<number, number>());
  const mounted = useRef(false);
  const release = (i: number): void => {
    const was = held.current.get(i);
    if (was !== undefined) URL.revokeObjectURL(was.url);
    held.current.delete(i);
  };
  useEffect(() => {
    mounted.current = true;
    const mine = held.current;
    return () => {
      mounted.current = false;
      for (const i of [...mine.keys()]) release(i);
      asked.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const key = srcs.join("\u0000");
  const nearKey = near.map(n => (n ? 1 : 0)).join("");
  useEffect(() => {
    setShots(was => srcs.map((src, i) => (held.current.get(i)?.src === src ? (was[i] ?? { state: "loading" }) : { state: "loading" })));
    srcs.forEach((src, i) => {
      if (near[i] !== true) return;
      const mark = `${written}:${ended}:${round}:${src}`;
      if (asked.current.get(i) === mark) return;
      asked.current.set(i, mark);
      const mine = (turn.current.get(i) ?? 0) + 1;
      turn.current.set(i, mine);
      const have = held.current.get(i)?.src === src ? held.current.get(i)?.version : undefined;
      void (ask?.(src, have) ?? Promise.reject(new Error("This window reads no images")))
        .then(answer => shotOf(src, answer), (e: unknown) => ({ shot: { state: "refused", why: e instanceof Error ? e.message : String(e) } as Shot }))
        .then(({ shot, held: next }: { shot: Shot; held?: Held }) => {
          if (!mounted.current || turn.current.get(i) !== mine) {
            if (next !== undefined) URL.revokeObjectURL(next.url);
            return;
          }
          if (shot.state === "loading") return;
          release(i);
          if (next !== undefined) held.current.set(i, next);
          else asked.current.delete(i);
          setShots(was => was.map((s, k) => (k === i ? shot : s)));
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slate, key, nearKey, written, ended, round]);
  return shots;
}

/** Which of several frames are near view: each one once it comes within a screen of its scroll box, or once the
 * person steps to it, and every one where this window has no observer. Once near, a frame stays near. */
function useNear(count: number): { near: boolean[]; watch: (i: number) => (el: Element | null) => void; reach: (i: number) => void } {
  const all = typeof IntersectionObserver === "undefined";
  const [near, setNear] = useState<boolean[]>(() => new Array<boolean>(count).fill(all));
  const els = useRef(new Map<number, Element>());
  useEffect(() => {
    if (all) return void setNear(new Array<boolean>(count).fill(true));
    let root: Element | null = els.current.values().next().value?.parentElement ?? null;
    while (root !== null && !/auto|scroll/.test(`${getComputedStyle(root).overflowX} ${getComputedStyle(root).overflowY}`)) root = root.parentElement;
    const seen = new IntersectionObserver(
      entries => {
        const now = entries.filter(e => e.isIntersecting).map(e => Number((e.target as HTMLElement).dataset["slateNear"]));
        if (now.length > 0) setNear(was => was.map((n, i) => n || now.includes(i)));
      },
      { root, rootMargin: "100%" },
    );
    for (const el of els.current.values()) seen.observe(el);
    return () => seen.disconnect();
  }, [count, all]);
  const watch = (i: number) => (el: Element | null) => void (el === null ? els.current.delete(i) : els.current.set(i, el));
  const reach = (i: number) => setNear(was => was.map((n, k) => n || k === i));
  return { near: near.length === count ? near : new Array<boolean>(count).fill(all), watch, reach };
}

/** How tall a picture stands at this width, held to the cap; one not known yet takes the laptop screen's shape. */
const heightAt = (shot: Shot | undefined, width: number): number => Math.min(INLINE_CAP, Math.round(width * (shot?.state === "shown" ? shot.h / shot.w : UNKNOWN_RATIO)));

/** The person's word on a domain, asked inside the frame its picture would fill; nothing is fetched before it. A
 * thumbnail holds the domain alone, its question on hover. */
function AllowDomain({ slate, domain, allow, compact }: { slate: SlateEngine; domain: string; allow: Allow; compact: boolean }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const yes = () => {
    if (allow === undefined) return;
    setBusy(true);
    setRefused(undefined);
    void allow(domain).then(
      () => allowedNow(slate),
      (e: unknown) => {
        setBusy(false);
        setRefused(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <span data-slate-image-asking title={compact ? IMAGE_WORDS.ask(domain) : undefined} className={cn("absolute inset-0 flex flex-col items-start justify-center text-left text-xs leading-4 text-pretty text-muted-foreground", compact ? "gap-1.5 px-3 py-2" : "gap-2 px-4 py-3")}>
      <span className={cn(compact && "max-w-full truncate")}>{refused ?? (compact ? domain : IMAGE_WORDS.ask(domain))}</span>
      <Button variant="outline" size="xs" disabled={busy || allow === undefined} onClick={yes}>{IMAGE_WORDS.allow}</Button>
    </span>
  );
}

/** What a frame holds: the picture, the spinner while it loads, the domain's question, or one muted line where it
 * cannot be shown. */
function Inside({ shot, alt, cover, slate, allow }: { shot: Shot; alt: string; cover?: boolean; slate: SlateEngine; allow: Allow }) {
  if (shot.state === "shown") return <img src={shot.url} alt={alt} draggable={false} className={cn("absolute inset-0 size-full", cover === true ? "object-cover object-top" : "object-contain")} />;
  if (shot.state === "loading") return <span data-slate-image-loading className="absolute inset-0 flex items-center justify-center text-muted-foreground"><Spinner className="size-4" /></span>;
  if (shot.state === "asking") return <AllowDomain slate={slate} domain={shot.domain} allow={allow} compact={cover === true} />;
  return <span data-slate-image-refused className="absolute inset-0 flex items-center px-4 py-3 text-left text-xs leading-4 text-pretty text-muted-foreground">{shot.why}</span>;
}

/** The box a picture sits in: a button that opens it large once shown, else a plain box, since the domain's question
 * holds a button of its own. */
function Frame({ shot, label, onOpen, className, style, children }: { shot: Shot; label: string; onOpen: () => void; className: string; style?: CSSProperties; children: ReactNode }) {
  if (shot.state === "shown") return <button type="button" onClick={onOpen} aria-label={label} className={cn(FRAME, "block w-full cursor-zoom-in", className)} style={style}>{children}</button>;
  return <div data-slate-image-frame aria-label={label} className={cn(FRAME, "block w-full", className)} style={style}>{children}</div>;
}

function IconButton({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} className="text-muted-foreground" />}>{children}</TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Previous and next, and where the person is as "2 of 5" in mono. */
function Stepper({ at, count, onAt }: { at: number; count: number; onAt: (i: number) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <IconButton label="Previous" onClick={() => onAt((at + count - 1) % count)}><ChevronLeft aria-hidden className="size-3.5" /></IconButton>
      <span data-slate-image-at className="min-w-12 text-center font-mono text-xs leading-4 text-muted-foreground tabular-nums">{at + 1} of {count}</span>
      <IconButton label="Next" onClick={() => onAt((at + 1) % count)}><ChevronRight aria-hidden className="size-3.5" /></IconButton>
    </span>
  );
}

const arrows = (at: number, count: number, onAt: (i: number) => void) => (event: KeyboardEvent) => {
  if (count < 2) return;
  if (event.key === "ArrowLeft") onAt((at + count - 1) % count);
  else if (event.key === "ArrowRight") onAt((at + 1) % count);
  else return;
  event.preventDefault();
};

type Pic = { path: string; caption?: string };

const BOTH = [true, true];

/** The diagram's dialog over the window, one picture at a time, zoomed and panned in the same frame. */
function Expanded({ pics, shots, at, onAt, open, onOpenChange, slate, allow }: { pics: readonly Pic[]; shots: readonly Shot[]; at: number; onAt: (i: number) => void; open: boolean; onOpenChange: (open: boolean) => void; slate: SlateEngine; allow: Allow }) {
  const big = useRef<ZoomControls>(null);
  const popup = useRef<HTMLDivElement>(null);
  const shot = shots[at] ?? { state: "loading" };
  const pic = pics[at];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup ref={popup} initialFocus={popup} data-slate-image-expanded onKeyDown={arrows(at, pics.length, onAt)} className={EXPANDED_POPUP} bottomStickOnMobile={false}>
        <div className="flex items-center gap-1 px-5 pt-4 pb-3">
          <DialogTitle className="min-w-0 flex-1 truncate">{pic?.caption ?? pic?.path ?? "Image"}</DialogTitle>
          {pics.length > 1 ? <Stepper at={at} count={pics.length} onAt={onAt} /> : null}
          <IconButton label="Zoom out" onClick={() => big.current?.zoom(1 / 1.25)}><Minus aria-hidden className="size-3.5" /></IconButton>
          <IconButton label="Zoom in" onClick={() => big.current?.zoom(1.25)}><Plus aria-hidden className="size-3.5" /></IconButton>
          <IconButton label="Fit" onClick={() => big.current?.fit()}><Scan aria-hidden className="size-3.5" /></IconButton>
          <DialogClose render={<Button variant="ghost" size="icon-xs" aria-label="Close" className="text-muted-foreground" />}><X aria-hidden className="size-3.5" /></DialogClose>
        </div>
        <ZoomFrame key={at} floor={OVERVIEW_LEAST} fill controls={big} className="mx-5 mb-5 flex-1 rounded-xl bg-background">
          {shot.state === "shown" ? (
            <svg viewBox={`0 0 ${shot.w} ${shot.h}`} width={shot.w} height={shot.h} role="img" aria-label={pic?.caption ?? pic?.path}>
              <image href={shot.url} width={shot.w} height={shot.h} />
            </svg>
          ) : (
            <div className="relative h-40"><Inside shot={shot} alt="" slate={slate} allow={allow} /></div>
          )}
        </ZoomFrame>
      </DialogPopup>
    </Dialog>
  );
}

const Caption = ({ children, className }: { children?: ReactNode; className?: string }) => (children === undefined || children === "" ? null : <figcaption className={cn("min-w-0 truncate text-xs leading-4 text-muted-foreground", className)}>{children}</figcaption>);

export const image: PieceView = {
  type: "image",
  card: false,
  component: function ImagePiece({ props, slate, image: ask, allow }) {
    const path = str(props["src"]) ?? "";
    const caption = str(props["caption"]);
    const seen = useNear(1);
    const [shot] = useShots(slate, [path], ask, seen.near);
    const [ref, width] = useWidth();
    const [open, setOpen] = useState(false);
    const shown = shot ?? { state: "loading" };
    return (
      <figure data-slate-image ref={ref} className="flex min-w-0 flex-col gap-2">
        <div ref={seen.watch(0)} data-slate-near={0}>
          <Frame shot={shown} label={caption ?? path} onOpen={() => setOpen(true)} className="" style={{ height: width === 0 ? undefined : heightAt(shown, width) }}>
            <Inside shot={shown} alt={caption ?? path} slate={slate} allow={allow} />
          </Frame>
        </div>
        <div className="flex min-h-6 items-center gap-3">
          <Caption className="flex-1">{caption}</Caption>
          {shown.state === "shown" ? <span className="ml-auto"><IconButton label="Expand" onClick={() => setOpen(true)}><Maximize2 aria-hidden className="size-3.5" /></IconButton></span> : null}
        </div>
        <Expanded pics={[{ path, ...(caption !== undefined ? { caption } : {}) }]} shots={[shown]} at={0} onAt={() => {}} open={open} onOpenChange={setOpen} slate={slate} allow={allow} />
      </figure>
    );
  },
};

/** A row of pictures at one height, each cropped to fill its box, scrolling sideways past what the panel holds. */
type Several = { pics: readonly Pic[]; shots: readonly Shot[]; slate: SlateEngine; allow: Allow };
/** Where the thumbnails tell which of them are near view, and the step that loads one the person moved to. */
type Seen = { watch: (i: number) => (el: Element | null) => void; reach: (i: number) => void };

function Strip({ pics, shots, slate, allow, watch, reach }: Several & Seen) {
  const [at, setAt] = useState<number | null>(null);
  const step = (i: number) => (reach(i), setAt(i));
  return (
    <div data-slate-images="strip" className="min-w-0">
      <ScrollArea hideScrollbars scrollFade className="h-auto min-w-0">
        <ul className="flex w-max gap-3">
          {pics.map((pic, i) => (
            <li key={`${i}:${pic.path}`} ref={watch(i)} data-slate-near={i} data-slate-thumb className="flex w-40 flex-none flex-col gap-1.5">
              <Frame shot={shots[i] ?? { state: "loading" }} label={pic.caption ?? pic.path} onOpen={() => setAt(i)} className="aspect-[16/10]">
                <Inside shot={shots[i] ?? { state: "loading" }} alt={pic.caption ?? pic.path} cover slate={slate} allow={allow} />
              </Frame>
              <Caption>{pic.caption}</Caption>
            </li>
          ))}
        </ul>
      </ScrollArea>
      <Expanded pics={pics} shots={shots} at={at ?? 0} onAt={step} open={at !== null} onOpenChange={open => !open && setAt(null)} slate={slate} allow={allow} />
    </div>
  );
}

function Gallery({ pics, shots, slate, allow, watch, reach }: Several & Seen) {
  const [at, setAt] = useState<number | null>(null);
  const step = (i: number) => (reach(i), setAt(i));
  return (
    <div data-slate-images="gallery" className="@container min-w-0">
      <ul className="grid grid-cols-2 gap-x-3 gap-y-4 @min-[400px]:grid-cols-3">
        {pics.map((pic, i) => (
          <li key={`${i}:${pic.path}`} ref={watch(i)} data-slate-near={i} data-slate-thumb className="flex min-w-0 flex-col gap-1.5">
            <Frame shot={shots[i] ?? { state: "loading" }} label={pic.caption ?? pic.path} onOpen={() => setAt(i)} className="aspect-[16/10]">
              <Inside shot={shots[i] ?? { state: "loading" }} alt={pic.caption ?? pic.path} cover slate={slate} allow={allow} />
            </Frame>
            <Caption>{pic.caption}</Caption>
          </li>
        ))}
      </ul>
      <Expanded pics={pics} shots={shots} at={at ?? 0} onAt={step} open={at !== null} onOpenChange={open => !open && setAt(null)} slate={slate} allow={allow} />
    </div>
  );
}

/** Before and after in one frame: the after drawn over the before up to a line the person drags or moves with the
 * arrow keys. */
function Slider({ pics, shots, width, slate, allow }: Several & { width: number }) {
  const [split, setSplit] = useState(50);
  const frame = useRef<HTMLDivElement>(null);
  const [before, after] = [shots[0] ?? { state: "loading" as const }, shots[1] ?? { state: "loading" as const }];
  const height = Math.max(heightAt(before, width), heightAt(after, width));
  const both = before.state === "shown" && after.state === "shown";
  const moveTo = (clientX: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (box !== undefined && box.width > 0) setSplit(Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)));
  };
  return (
    <div data-slate-images="compare" className="flex min-w-0 flex-col gap-2">
      <div
        ref={frame}
        role="slider"
        tabIndex={0}
        aria-label="Before and after"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(split)}
        className={cn(FRAME, "w-full touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40", both && "cursor-ew-resize")}
        style={{ height: width === 0 ? undefined : height }}
        onPointerDown={event => {
          if (!both) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          moveTo(event.clientX);
        }}
        onPointerMove={event => event.currentTarget.hasPointerCapture(event.pointerId) && moveTo(event.clientX)}
        onKeyDown={event => {
          const by = event.key === "ArrowLeft" ? -5 : event.key === "ArrowRight" ? 5 : 0;
          if (by === 0) return;
          event.preventDefault();
          setSplit(s => Math.min(100, Math.max(0, s + by)));
        }}
      >
        {!both ? (
          <Inside shot={before.state !== "shown" ? before : after} alt="" slate={slate} allow={allow} />
        ) : (
          <>
            <Inside shot={before} alt={pics[0]?.caption ?? pics[0]?.path ?? ""} slate={slate} allow={allow} />
            <span className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
              <Inside shot={after} alt={pics[1]?.caption ?? pics[1]?.path ?? ""} slate={slate} allow={allow} />
            </span>
            <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/70" style={{ left: `${split}%` }} />
            <span aria-hidden className={`absolute top-1/2 flex h-7 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-background text-muted-foreground ${KEYCAP_BEVEL}`} style={{ left: `${split}%` }}>
              <GripVertical className="size-3" />
            </span>
          </>
        )}
      </div>
      <div className="flex min-h-6 items-center gap-3">
        <Caption className="flex-1">{pics[0]?.caption}</Caption>
        <Caption className="text-right">{pics[1]?.caption}</Caption>
      </div>
    </div>
  );
}

export const images: PieceView = {
  type: "images",
  card: false,
  rowScoped: ["src", "caption"],
  component: function ImagesPiece({ piece, props, slate, image: ask, allow }) {
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const pics: Pic[] = items.map((item, index) => {
      const caption = str(slate.resolve(piece.props?.["caption"], { item, index }));
      return { path: str(slate.resolve(piece.props?.["src"], { item, index })) ?? "", ...(caption !== undefined ? { caption } : {}) };
    });
    const layout = str(props["layout"]) ?? "gallery";
    const pair = layout === "compare";
    const over = pics.length > SLATE_LIMITS.imagesPerList;
    const shown = over ? [] : pair ? pics.slice(0, 2) : pics;
    const seen = useNear(shown.length);
    const shots = useShots(slate, shown.map(p => p.path), ask, pair ? BOTH : seen.near);
    const [ref, width] = useWidth();
    return (
      <div ref={ref} data-slate-images-piece className="flex min-w-0 flex-col gap-2">
        {over ? <span data-slate-image-refused className="text-xs leading-4 text-pretty text-muted-foreground">{sentence(slateListTooLong(pics.length, SLATE_LIMITS.imagesPerList, "images").message)}</span>
          : pics.length === 0 ? <span className="text-xs leading-4 text-muted-foreground">No images yet</span>
          : layout === "strip" ? <Strip pics={shown} shots={shots} slate={slate} allow={allow} {...seen} />
          : layout === "compare" ? <Slider pics={shown} shots={shots} width={width} slate={slate} allow={allow} />
          : <Gallery pics={shown} shots={shots} slate={slate} allow={allow} {...seen} />}
        {pair && pics.length !== 2 ? <span className="text-xs leading-4 text-muted-foreground">A before and after shows two images; this list has {pics.length}</span> : null}
      </div>
    );
  },
};
