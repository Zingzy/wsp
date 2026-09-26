// SPDX-License-Identifier: AGPL-3.0-only
// The crab loader from Whimsy Loaders (https://www.whimsically.app/loaders), made by Sasha (x.com/aleksksaa),
// transcribed from the site's own export with its pixel tables and timings kept as they are; credited in
// THIRD_PARTY_NOTICES. A 15 by 7 pixel crab drawn in one colour at varying alpha: the claws bob, eight legs walk,
// the eyes blink once every sixth cycle. Every crab on the page is drawn by one animation frame loop, and under
// reduced motion each draws one still frame and the loop never starts.
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils.js";

const BODY = [
  [-4, 0], [-3, 0], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0],
  [-4, -1], [-3, -1], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [3, -1], [4, -1],
  [-4, 1], [-3, 1], [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1], [3, 1], [4, 1],
  [-3, -2], [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2], [3, -2],
  [-3, 2], [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2], [3, 2],
] as const;
const LEFT_CLAW = [[-5, -2], [-6, -2], [-6, -1], [-5, -1], [-6, -3], [-7, -2]] as const;
const RIGHT_CLAW = [[5, -2], [6, -2], [6, -1], [5, -1], [6, -3], [7, -2]] as const;
const LEGS = [[-4, 0], [-3, 0.5], [-2, 1], [-1, 1.5], [1, 0], [2, 0.5], [3, 1], [4, 1.5]] as const;

/** One frame of the crab at `t` milliseconds into its walk, in the colour `rgb` names as "r,g,b". */
export function drawCrab(ctx: CanvasRenderingContext2D, w: number, hgt: number, t: number, rgb: string): void {
  ctx.clearRect(0, 0, w, hgt);
  const h = w > 30 ? 2 : 1, cx = Math.round(w / 2), cy = Math.round(hgt / 2);
  const c = (x: number, y: number, a: number) => { ctx.fillStyle = `rgba(${rgb},${a})`; ctx.fillRect(Math.round(cx + x * h), Math.round(cy + y * h), h, h); };
  BODY.forEach(([x, y]) => c(x, y, 0.62));
  c(-1, -3, 0.72); c(1, -3, 0.72); c(-1, -2, 0.58); c(1, -2, 0.58);
  const blink = Math.floor(t / 2800) % 6 === 0 && t % 2800 < 160;
  if (blink) { ctx.fillStyle = `rgba(${rgb},0.5)`; ctx.fillRect(Math.round(cx - 1.5 * h), Math.round(cy - 3 * h), 2 * h, Math.max(1, Math.round(0.4 * h))); }
  else { c(-1, -3, 0.92); c(1, -3, 0.92); }
  const bob = Math.round(1.5 * Math.sin(0.0018 * t));
  LEFT_CLAW.forEach(([x, y]) => c(x, y, 0.65)); c(-7, -1 + bob, 0.55); c(-7, -3 - bob, 0.45);
  RIGHT_CLAW.forEach(([x, y]) => c(x, y, 0.65)); c(7, -1 + bob, 0.55); c(7, -3 - bob, 0.45);
  ([[-5, 0], [-4, -1], [5, 0], [4, -1]] as const).forEach(([x, y]) => c(x, y, 0.58));
  const u = 0.003 * t;
  LEGS.forEach(([bx, ph]) => {
    const phase = u + ph * Math.PI, r = Math.abs(Math.sin(phase)), o = bx < 0 ? -1 : 1;
    const nx = bx + o * Math.round(1 + r), ny = 2 + Math.round(1.2 * Math.sin(phase));
    c(bx, 2, 0.52); c(nx, ny, 0.42 + 0.2 * r);
    if (r > 0.5) c(nx + o, ny + 1, 0.28);
  });
}

/** The css box every crab is drawn in. */
const W = 16;
const H = 14;

const rgbOf = (el: Element): string => {
  const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color);
  return m ? `${m[1]},${m[2]},${m[3]}` : "128,128,128";
};

const stillQuery = () => window.matchMedia("(prefers-reduced-motion: reduce)");

const crabs = new Set<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; rgb: string }>();
let frameId = 0;
let startedAt: number | undefined;
let watching: (() => void) | undefined;

function draw(): void {
  const still = stillQuery().matches;
  startedAt ??= performance.now();
  const t = still ? 0 : performance.now() - startedAt;
  for (const { ctx, rgb } of crabs) drawCrab(ctx, W, H, t, rgb);
  frameId = crabs.size > 0 && !still ? requestAnimationFrame(draw) : 0;
}

/** A theme switch moves the tint, so every crab reads its colour again and a still one is drawn again in it. */
function retint(): void {
  for (const crab of crabs) crab.rgb = rgbOf(crab.canvas);
  if (frameId === 0) draw();
}

/** Watches what moves a crab: the theme on the root and the motion preference, for as long as any crab is drawn. */
function watch(): () => void {
  const themes = new MutationObserver(retint);
  themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  const still = stillQuery();
  const motion = () => frameId === 0 && crabs.size > 0 && draw();
  still.addEventListener("change", motion);
  return () => {
    themes.disconnect();
    still.removeEventListener("change", motion);
  };
}

function add(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return () => {};
  const dpr = window.devicePixelRatio || 2;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  const crab = { canvas, ctx, rgb: rgbOf(canvas) };
  crabs.add(crab);
  watching ??= watch();
  if (frameId === 0) draw();
  return () => {
    crabs.delete(crab);
    if (crabs.size > 0) return;
    if (frameId !== 0) cancelAnimationFrame(frameId);
    frameId = 0;
    watching?.();
    watching = undefined;
  };
}

/** The walking crab beside a working thread, tinted with the colour it inherits. */
export function Crab({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => add(ref.current!), []);
  return <canvas ref={ref} aria-hidden data-crab className={cn("block h-[14px] w-4 shrink-0", className)} />;
}
