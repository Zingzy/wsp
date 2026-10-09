// SPDX-License-Identifier: AGPL-3.0-only
// The mark over a fresh thread's headline: the project's own glyph in its hue, and behind the page an ASCII dither in
// the theme's --hero-field, a slow noise field drawn as mono characters by brightness, clear in the middle where the
// stack stands. Each theme picks that ink for its own ground, since a project hue can clash with a tinted theme.
import { useEffect, useRef } from "react";
import { useStore } from "../../protocol/store.js";
import { onFrame } from "../../lib/frames.js";
import { cn } from "../../lib/utils.js";
import { PROJECT_GLYPHS, PROJECT_HUES } from "../../projects/look.js";

function useLook(projectId: string | undefined) {
  const look = useStore(s => (projectId === undefined ? undefined : s.preferences.projectLook[projectId]));
  const hue = look?.hue ?? "neutral";
  return { Glyph: PROJECT_GLYPHS[look?.icon ?? "folder"], text: hue === "neutral" ? "text-foreground/70" : PROJECT_HUES[hue].text };
}

const RAMP = " .:~>x*#";
const CELL_W = 10;
const CELL_H = 17;
const FRAME_MS = 120;

const hash = (x: number, y: number): number => {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
};
const smooth = (t: number): number => t * t * (3 - 2 * t);
/** One octave of value noise; it keeps the four corner hashes of the last lattice square it read, which the cells
 * along a row mostly share. */
function octave(): (x: number, y: number) => number {
  let xk = NaN;
  let yk = NaN;
  let a = 0, b = 0, c = 0, d = 0;
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi !== xk || yi !== yk) {
      xk = xi;
      yk = yi;
      a = hash(xi, yi);
      b = hash(xi + 1, yi);
      c = hash(xi, yi + 1);
      d = hash(xi + 1, yi + 1);
    }
    const u = smooth(x - xi);
    const v = smooth(y - yi);
    const top = a * (1 - u) + b * u;
    const bottom = c * (1 - u) + d * u;
    return top * (1 - v) + bottom * v;
  };
}
const [low, mid, high] = [octave(), octave(), octave()];
const field = (x: number, y: number): number => low(x, y) * 0.6 + mid(x * 2.1 + 5.2, y * 2.1 + 1.3) * 0.3 + high(x * 4.3 + 9.1, y * 4.3 + 7.7) * 0.1;

/** The level each cell of a canvas was last painted at, so a frame repaints only the few cells the field moved. */
const painted = new WeakMap<HTMLCanvasElement, { key: string; levels: Uint8Array }>();

function paint(canvas: HTMLCanvasElement, t: number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (ctx === null || w === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const style = getComputedStyle(canvas);
  ctx.fillStyle = style.color;
  ctx.font = `11px ${style.getPropertyValue("--font-mono") || "ui-monospace, monospace"}`;
  ctx.textBaseline = "top";
  const cols = Math.ceil(w / CELL_W);
  const rows = Math.ceil(h / CELL_H);
  const key = `${w} ${h} ${dpr} ${ctx.font} ${ctx.fillStyle}`;
  let held = painted.get(canvas);
  const fresh = held?.key !== key;
  if (held === undefined || fresh) {
    ctx.clearRect(0, 0, w, h);
    held = { key, levels: new Uint8Array(cols * rows) };
    painted.set(canvas, held);
  }
  const { levels } = held;
  const glyph = (i: number): void => {
    const level = levels[i] ?? 0;
    if (level === 0) return;
    ctx.globalAlpha = 0.14 + 0.3 * (level / (RAMP.length - 1));
    ctx.fillText(RAMP[level]!, (i % cols) * CELL_W, Math.floor(i / cols) * CELL_H);
  };
  const moved: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = (c * CELL_W + CELL_W / 2 - w / 2) / (w * 0.42);
      const dy = (r * CELL_H + CELL_H / 2 - h * 0.46) / (h * 0.5);
      const clear = Math.min(1, Math.max(0, (Math.hypot(dx, dy) - 0.55) / 0.5));
      if (clear === 0) continue;
      const v = (field(c * 0.07 + t * 0.018, r * 0.12 - t * 0.006) - 0.42) * 2.4 * clear;
      const level = v <= 0 ? 0 : Math.min(RAMP.length - 1, Math.floor(v * RAMP.length));
      const i = r * cols + c;
      if (level === levels[i]) continue;
      levels[i] = level;
      if (fresh) glyph(i);
      else moved.push(i);
    }
  }
  // A glyph's edge can reach a pixel up into the cell above (measured at dpr 1), so a moved cell repaints that one
  // too. Each box is snapped to whole device pixels so boxes tile at any dpr, and holds its own glyph and the edge of
  // the one below, drawn in the order a full paint draws them.
  const boxes = new Set(moved.flatMap(i => [i - cols, i]).filter(i => i >= 0));
  for (const i of boxes) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = Math.floor(c * CELL_W * dpr);
    const y = Math.floor(r * CELL_H * dpr);
    const width = Math.floor((c + 1) * CELL_W * dpr) - x;
    const height = Math.floor((r + 1) * CELL_H * dpr) - y;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.clearRect(x, y, width, height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glyph(i);
    glyph(i + cols);
    ctx.restore();
  }
}

/** Painted behind the whole page, never over it; a frame every 120 ms while it is on screen, one still frame under
 * reduced motion. */
export function HeroField() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const born = performance.now();
    let last = -FRAME_MS;
    paint(el, 0);
    const stop = still
      ? undefined
      : onFrame(el, now => {
          if (now - last < FRAME_MS) return;
          last = now;
          paint(el, (now - born) / 1000);
        });
    const again = () => paint(el, (performance.now() - born) / 1000);
    const sized = new ResizeObserver(again);
    sized.observe(el);
    // A restored context comes back blank, so every cell is painted again rather than only the ones that moved.
    const restored = () => {
      painted.delete(el);
      again();
    };
    el.addEventListener("contextrestored", restored);
    return () => {
      stop?.();
      sized.disconnect();
      el.removeEventListener("contextrestored", restored);
    };
  }, []);
  return <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 -z-10 size-full text-(--hero-field)" />;
}

/** The project's glyph over the headline. */
export function HeroMark({ projectId }: { projectId?: string }) {
  const { Glyph, text } = useLook(projectId);
  return <Glyph aria-hidden strokeWidth={1.5} className={cn("mx-auto size-10", text)} />;
}
