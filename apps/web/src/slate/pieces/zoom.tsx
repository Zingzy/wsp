// SPDX-License-Identifier: AGPL-3.0-only
// A drawing in a frame a person can zoom and pan: it opens fitted (to the frame's width, or to the whole frame) but never
// so small its labels drop under the app's 12 px, and past that opens at that size from its top, its first node in
// view. Pinch, or ctrl or cmd with the wheel, zooms around the pointer; a drag pans once the drawing outgrows the frame;
// a double-click fits it again. A plain wheel is left to the page, so the slate still scrolls past it.
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { cn } from "../../lib/utils.js";

export interface ZoomControls {
  fit(): void;
  zoom(by: number): void;
}

type View = { k: number; x: number; y: number };
const MOST = 4;
const LEAST = 0.2;

export function ZoomFrame({ children, floor, fill, cap, className, controls }: {
  children: ReactNode;
  /** The least scale the drawing opens at: the label floor over the label size. */
  floor: number;
  /** Fit the whole frame (the expanded view) rather than its width alone. */
  fill?: boolean;
  /** The frame's tallest, where its height follows the drawing. */
  cap?: number;
  className?: string;
  controls?: Ref<ZoomControls>;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  // The drawing's own size, read off its SVG each time it is drawn again.
  useEffect(() => {
    const node = content.current;
    if (node === null) return;
    const read = () => {
      const vb = node.querySelector("svg")?.viewBox.baseVal;
      if (vb === undefined || vb.width <= 0) setNatural(null);
      else setNatural(was => (was?.w === vb.width && was.h === vb.height ? was : { w: vb.width, h: vb.height }));
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(node, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = frame.current;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const size = () => setBox({ w: node.clientWidth, h: node.clientHeight });
    size();
    const watch = new ResizeObserver(size);
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  const fitted = natural === null || box.w === 0 ? 1 : Math.max(floor, Math.min(1, box.w / natural.w, fill === true && box.h > 0 ? box.h / natural.h : Infinity));
  /** Keeps the drawing in the frame: centred where it is smaller, its edges never inside the frame's where larger. */
  const place = useCallback(
    (v: View): View => {
      if (natural === null) return v;
      const along = (at: number, size: number, room: number) => (size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, at)));
      return { k: v.k, x: along(v.x, natural.w * v.k, box.w), y: fill === true ? along(v.y, natural.h * v.k, box.h) : natural.h * v.k <= box.h ? 0 : along(v.y, natural.h * v.k, box.h) };
    },
    [natural, box, fill],
  );
  const shown = useRef(view);
  shown.current = view;
  // A drawing wider than the frame opens at its top with its first node, the top-most then the left-most, in the middle:
  // a long edge out to one side widens the box, so its corner and its middle can both be empty ground.
  const fit = useCallback(() => {
    if (natural === null) {
      setView({ k: fitted, x: 0, y: 0 });
      return;
    }
    const origin = content.current?.getBoundingClientRect();
    const first = [...(content.current?.querySelectorAll("svg .node") ?? [])].map(n => n.getBoundingClientRect()).sort((a, b) => a.top - b.top || a.left - b.left)[0];
    const middle = origin === undefined || first === undefined ? natural.w / 2 : (first.left + first.width / 2 - origin.left) / shown.current.k;
    setView(place({ k: fitted, x: box.w / 2 - middle * fitted, y: 0 }));
  }, [place, fitted, natural, box]);
  useEffect(fit, [fit]);
  const zoomAt = useCallback((px: number, py: number, by: number) => setView(v => {
    const k = Math.min(MOST, Math.max(LEAST, v.k * by));
    return place({ k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k });
  }), [place]);
  useImperativeHandle(controls, () => ({ fit, zoom: by => zoomAt(box.w / 2, box.h / 2, by) }), [fit, zoomAt, box]);

  // A trackpad's pinch arrives as a wheel with ctrl held; the listener is not passive, so it can keep the page still.
  useEffect(() => {
    const node = frame.current;
    if (node === null) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const at = node.getBoundingClientRect();
      zoomAt(event.clientX - at.left, event.clientY - at.top, Math.exp(-event.deltaY * 0.01));
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  const outgrows = natural !== null && (natural.w * view.k > box.w + 1 || natural.h * view.k > box.h + 1);
  const height = fill === true || natural === null ? undefined : Math.min(cap ?? Infinity, Math.ceil(natural.h * fitted));
  return (
    <div
      ref={frame}
      data-slate-zoom={Math.round(view.k * 1000) / 1000}
      className={cn("relative min-w-0 touch-none overflow-hidden select-none", outgrows && "cursor-grab active:cursor-grabbing", className)}
      style={height === undefined ? undefined : { height }}
      onDoubleClick={fit}
      onPointerDown={event => {
        if (!outgrows || event.button !== 0) return;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const from = drag.current;
        if (from === null || from.id !== event.pointerId) return;
        drag.current = { id: from.id, x: event.clientX, y: event.clientY };
        setView(v => place({ k: v.k, x: v.x + event.clientX - from.x, y: v.y + event.clientY - from.y }));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      {/* Until there is a drawing (loading, refused, or a source that does not parse) what stands lies in the flow. */}
      <div
        ref={content}
        className={cn(natural === null ? "relative" : "absolute top-0 left-0 origin-top-left", "[&_svg]:!m-0 [&_svg]:!h-(--natural-h) [&_svg]:!w-(--natural-w) [&_svg]:!max-w-none [&_svg]:!min-w-0 [&>*]:!overflow-visible [&>*]:!p-0")}
        style={natural === null ? undefined : { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, "--natural-w": `${natural?.w ?? 0}px`, "--natural-h": `${natural?.h ?? 0}px` } as CSSProperties}
      >
        {children}
      </div>
    </div>
  );
}
