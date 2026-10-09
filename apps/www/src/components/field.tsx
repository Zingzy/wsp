// SPDX-License-Identifier: AGPL-3.0-only
// The app's New thread field (apps/web/src/components/chat/EmptyHero.tsx): value noise drawn as mono characters by
// brightness, about eight frames a second. The app clears an oval in code; here each section shapes it with a CSS mask.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const RAMP = " .:~>x*#";
const CELL_W = 10;
const CELL_H = 17;
const FRAME_MS = 120;

const hash = (x: number, y: number): number => {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};
const smooth = (t: number): number => t * t * (3 - 2 * t);
function noise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const top = hash(xi, yi) * (1 - u) + hash(xi + 1, yi) * u;
  const bottom = hash(xi, yi + 1) * (1 - u) + hash(xi + 1, yi + 1) * u;
  return top * (1 - v) + bottom * v;
}
const field = (x: number, y: number): number => noise(x, y) * 0.6 + noise(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.3 + noise(x * 4.3 + 9.1, y * 4.3 + 7.7) * 0.1;

function paint(canvas: HTMLCanvasElement, t: number, seed: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (ctx === null || w === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const style = getComputedStyle(canvas);
  ctx.fillStyle = style.color;
  ctx.font = `11px ${style.getPropertyValue("--font-mono") || "ui-monospace, monospace"}`;
  ctx.textBaseline = "top";
  const cols = Math.ceil(w / CELL_W);
  const rows = Math.ceil(h / CELL_H);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = (field(c * 0.07 + seed + t * 0.018, r * 0.12 + seed * 0.5 - t * 0.006) - 0.42) * 2.4;
      if (v <= 0) continue;
      const level = Math.min(RAMP.length - 1, Math.floor(v * RAMP.length));
      if (level === 0) continue;
      ctx.globalAlpha = 0.14 + 0.3 * (level / (RAMP.length - 1));
      ctx.fillText(RAMP[level]!, c * CELL_W, r * CELL_H);
    }
  }
}

/** Painted only while on screen and the tab shows; one still frame under reduced motion. */
export function Field({ className, seed = 0 }: { className?: string; seed?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const born = performance.now();
    let frame = 0;
    let last = -FRAME_MS;
    let seen = false;
    const loop = (now: number): void => {
      if (now - last >= FRAME_MS && !document.hidden) {
        last = now;
        paint(el, (now - born) / 1000, seed);
      }
      frame = requestAnimationFrame(loop);
    };
    const start = (): void => {
      cancelAnimationFrame(frame);
      if (seen && !still) frame = requestAnimationFrame(loop);
    };
    paint(el, 0, seed);
    const shown = new IntersectionObserver(([entry]) => {
      seen = entry?.isIntersecting ?? false;
      if (seen) start();
      else cancelAnimationFrame(frame);
    });
    shown.observe(el);
    const sized = new ResizeObserver(() => paint(el, (performance.now() - born) / 1000, seed));
    sized.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      shown.disconnect();
      sized.disconnect();
    };
  }, [seed]);
  return <canvas ref={canvas} aria-hidden className={cn("pointer-events-none absolute inset-0 size-full text-amber", className)} />;
}
