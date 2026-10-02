// SPDX-License-Identifier: AGPL-3.0-only
// The mark over a fresh thread's headline: the project's own glyph in its hue, and behind the page an ASCII dither in
// the theme's --hero-field, a slow noise field drawn as mono characters by brightness, clear in the middle where the
// stack stands. Each theme picks that ink for its own ground, since a project hue can clash with a tinted theme.
import { useEffect, useRef } from "react";
import { useStore } from "../../protocol/store.js";
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
  ctx.clearRect(0, 0, w, h);
  const style = getComputedStyle(canvas);
  ctx.fillStyle = style.color;
  ctx.font = `11px ${style.getPropertyValue("--font-mono") || "ui-monospace, monospace"}`;
  ctx.textBaseline = "top";
  const cols = Math.ceil(w / CELL_W);
  const rows = Math.ceil(h / CELL_H);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = (c * CELL_W + CELL_W / 2 - w / 2) / (w * 0.42);
      const dy = (r * CELL_H + CELL_H / 2 - h * 0.46) / (h * 0.5);
      const clear = Math.min(1, Math.max(0, (Math.hypot(dx, dy) - 0.55) / 0.5));
      if (clear === 0) continue;
      const v = (field(c * 0.07 + t * 0.018, r * 0.12 - t * 0.006) - 0.42) * 2.4 * clear;
      if (v <= 0) continue;
      const level = Math.min(RAMP.length - 1, Math.floor(v * RAMP.length));
      if (level === 0) continue;
      ctx.globalAlpha = 0.14 + 0.3 * (level / (RAMP.length - 1));
      ctx.fillText(RAMP[level]!, c * CELL_W, r * CELL_H);
    }
  }
}

/** Painted behind the whole page, never over it; a frame every 120 ms while the window shows, one still frame under
 * reduced motion. */
export function HeroField() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (el === null) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const born = performance.now();
    let frame = 0;
    let last = -FRAME_MS;
    const loop = (now: number): void => {
      if (now - last >= FRAME_MS && !document.hidden) {
        last = now;
        paint(el, (now - born) / 1000);
      }
      frame = requestAnimationFrame(loop);
    };
    paint(el, 0);
    if (!still) frame = requestAnimationFrame(loop);
    const sized = new ResizeObserver(() => paint(el, (performance.now() - born) / 1000));
    sized.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      sized.disconnect();
    };
  }, []);
  return <canvas ref={canvas} aria-hidden className="pointer-events-none absolute inset-0 -z-10 size-full text-(--hero-field)" />;
}

/** The project's glyph over the headline. */
export function HeroMark({ projectId }: { projectId?: string }) {
  const { Glyph, text } = useLook(projectId);
  return <Glyph aria-hidden strokeWidth={1.5} className={cn("mx-auto size-10", text)} />;
}
