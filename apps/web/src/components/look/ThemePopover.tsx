// SPDX-License-Identifier: AGPL-3.0-only
// The theme picker the workspace's menu opens, in the shape of the Zen
// browser's: the mode at the top, a round pad the first colour dot is dragged
// over (hue by angle, lightness by distance from the centre) with the dots a
// harmony places following it, controls for how many dots and which harmony,
// a preset row, then the grain and the opacity as sliders. The opacity slider
// ends where the side's words would stop reading on the colour, so the wash
// can never drown the sidebar's own text. The sidebar is the preview: every
// move paints the record locally as it happens and the host hears the value
// once the pointer lets go, so a drag never floods the wire.
import { MinusIcon, PlusIcon, RotateCwIcon } from "lucide-react";
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  DEFAULT_THEME,
  THEME_GRAIN_STEPS,
  THEME_MAX_DOTS,
  THEME_MIN_OPACITY,
  THEME_PRESETS,
  ThemeMode,
  applyPreset,
  cycleHarmony,
  dotColour,
  effectiveOpacity,
  fmtPercent,
  fmtRgb,
  fmtThemeVars,
  isPreset,
  opacityCap,
  moveFirstDot,
  resizeDots,
  snapGrain,
  type ThemeDot,
  type WorkspaceTheme,
  type WorkspaceView,
} from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import { useAppDark } from "../../settings/theme.js";
import { cn } from "../../lib/utils.js";
import { Button } from "../ui/button.js";
import { SegmentedControl } from "../ui/segmented-control.js";
import { Slider } from "../ui/slider.js";
import { LOOK_WORDS } from "../workspaceLook.js";
import { LookPopup } from "./LookPopup.js";

export const THEME_WORDS = {
  mode: { auto: "Auto", light: "Light", dark: "Dark" } satisfies Record<ThemeMode, string>,
  fewerDots: "One colour fewer",
  moreDots: "One colour more",
  harmony: "Next harmony",
  presets: "Presets",
  grain: "Grain",
  opacity: "Opacity",
  remove: "Remove theme",
  dot: "Colour dot",
  wheel: "Colour wheel",
} as const;

const MODES = ThemeMode.options.map(mode => ({ value: mode, label: THEME_WORDS.mode[mode] }));
const SLIDER_LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";
const SLIDER_VALUE = "font-mono text-[11px] tabular-nums text-muted-foreground";
const rgb = (dot: ThemeDot): string => fmtRgb(dotColour(dot));

/** Where a pointer over the pad puts a dot: the angle around the centre and the distance to it, held inside the rim. */
export function dotAt(pad: DOMRect, clientX: number, clientY: number): ThemeDot {
  const dx = clientX - (pad.left + pad.width / 2);
  const dy = clientY - (pad.top + pad.height / 2);
  const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return { angle, radius: Math.min(1, Math.hypot(dx, dy) / (pad.width / 2)) };
}

/** Where a dot sits on the pad, as percentages of its box. */
const placeDot = (dot: ThemeDot): { left: string; top: string } => ({
  left: `${50 + 50 * dot.radius * Math.cos((dot.angle * Math.PI) / 180)}%`,
  top: `${50 + 50 * dot.radius * Math.sin((dot.angle * Math.PI) / 180)}%`,
});

export function ThemePopover({ workspace, anchor, onClose }: { workspace: WorkspaceView; anchor: HTMLElement | null; onClose: () => void }) {
  const setLook = useStore(s => s.setWorkspaceLook);
  const applyEvent = useStore(s => s.applyEvent);
  const appDark = useAppDark();
  const theme = workspace.theme ?? DEFAULT_THEME;
  const pad = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // The record on this client follows the hand; the host hears it when the hand lets go.
  const preview = (next: WorkspaceTheme): void => applyEvent({ type: "workspace.look", workspaceId: workspace.id, theme: next, glyph: workspace.glyph ?? null });
  const commit = (next: WorkspaceTheme | null): void => void setLook({ workspaceId: workspace.id, look: { theme: next } });

  const onPadPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || pad.current === null) return;
    event.preventDefault();
    dragging.current = true;
    pad.current.setPointerCapture?.(event.pointerId);
    preview(moveFirstDot(theme, dotAt(pad.current.getBoundingClientRect(), event.clientX, event.clientY)));
  };
  const onPadPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current || pad.current === null) return;
    preview(moveFirstDot(theme, dotAt(pad.current.getBoundingClientRect(), event.clientX, event.clientY)));
  };
  const onPadPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current || pad.current === null) return;
    dragging.current = false;
    pad.current.releasePointerCapture?.(event.pointerId);
    commit(moveFirstDot(theme, dotAt(pad.current.getBoundingClientRect(), event.clientX, event.clientY)));
  };
  /** The first dot from the keyboard: the arrows turn it around the wheel and move it in and out. */
  const onDotKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const first = theme.dots[0]!;
    const moved: Record<string, ThemeDot> = {
      ArrowRight: { ...first, angle: (first.angle + 5) % 360 },
      ArrowLeft: { ...first, angle: (first.angle + 355) % 360 },
      ArrowUp: { ...first, radius: Math.min(1, first.radius + 0.05) },
      ArrowDown: { ...first, radius: Math.max(0, first.radius - 0.05) },
    };
    const next = moved[event.key];
    if (next === undefined) return;
    event.preventDefault();
    commit(moveFirstDot(theme, next));
  };

  const fewer = resizeDots(theme, -1);
  const more = resizeDots(theme, 1);
  return (
    <LookPopup title={LOOK_WORDS.theme} name={workspace.name} anchor={anchor} onClose={onClose} data-theme-picker="">
      <SegmentedControl aria-label="Mode" value={theme.mode} segments={MODES} onChange={mode => commit({ ...theme, mode })} className="self-start" data-theme-mode="" />
      <div
        ref={pad}
        data-theme-wheel
        aria-label={THEME_WORDS.wheel}
        className="relative mx-auto size-44 touch-none rounded-full border border-border bg-[radial-gradient(var(--border)_1px,transparent_0)] bg-[size:6px_6px] bg-center"
        onPointerDown={onPadPointerDown}
        onPointerMove={onPadPointerMove}
        onPointerUp={onPadPointerUp}
        onPointerCancel={onPadPointerUp}
      >
        {theme.dots.map((dot, index) =>
          index === 0 ? (
            <button
              key={index}
              type="button"
              data-theme-dot={index}
              aria-label={THEME_WORDS.dot}
              style={{ ...placeDot(dot), background: rgb(dot) }}
              className="absolute size-6 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-[3px] border-background shadow-sm outline-none ring-ring focus-visible:ring-2"
              onKeyDown={onDotKeyDown}
            />
          ) : (
            <span key={index} aria-hidden data-theme-dot={index} style={{ ...placeDot(dot), background: rgb(dot) }} className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background shadow-sm" />
          ),
        )}
      </div>
      <div className="flex items-center justify-center gap-1">
        <Button size="icon-xs" variant="ghost-muted" aria-label={THEME_WORDS.fewerDots} disabled={fewer === null} onClick={() => fewer !== null && commit(fewer)}>
          <MinusIcon />
        </Button>
        <span className={cn(SLIDER_VALUE, "w-8 text-center")} data-theme-count>
          {theme.dots.length}/{THEME_MAX_DOTS}
        </span>
        <Button size="icon-xs" variant="ghost-muted" aria-label={THEME_WORDS.moreDots} disabled={more === null} onClick={() => more !== null && commit(more)}>
          <PlusIcon />
        </Button>
        <Button size="icon-xs" variant="ghost-muted" aria-label={THEME_WORDS.harmony} disabled={theme.dots.length < 2} onClick={() => commit(cycleHarmony(theme))}>
          <RotateCwIcon />
        </Button>
      </div>
      <div role="group" aria-label={THEME_WORDS.presets} className="flex items-center justify-between">
        {THEME_PRESETS.map(chosen => (
          <button
            key={chosen.id}
            type="button"
            data-theme-preset={chosen.id}
            aria-label={`${THEME_WORDS.presets}: ${chosen.id}`}
            aria-pressed={isPreset(theme, chosen)}
            style={{ backgroundImage: fmtThemeVars({ ...theme, ...chosen, dots: [...chosen.dots], opacity: 1 }, appDark)["--space-gradient"] }}
            className={cn("size-6 cursor-pointer rounded-full border border-border bg-background outline-none ring-ring focus-visible:ring-2", isPreset(theme, chosen) && "ring-1 ring-foreground/60")}
            onClick={() => commit(applyPreset(theme, chosen))}
          />
        ))}
      </div>
      <SliderRow label={THEME_WORDS.grain} value={theme.grain} min={0} max={1} step={1 / THEME_GRAIN_STEPS} onPreview={grain => preview({ ...theme, grain: snapGrain(grain) })} onCommit={grain => commit({ ...theme, grain: snapGrain(grain) })} />
      <SliderRow label={THEME_WORDS.opacity} value={effectiveOpacity(theme, appDark)} min={THEME_MIN_OPACITY} max={opacityCap(theme, appDark)} step={0.05} onPreview={opacity => preview({ ...theme, opacity })} onCommit={opacity => commit({ ...theme, opacity })} />
      <Button size="xs" variant="ghost-muted" className="self-end" disabled={workspace.theme === undefined} onClick={() => commit(null)}>
        {THEME_WORDS.remove}
      </Button>
    </LookPopup>
  );
}

/** One slider with its caps mono label and its value in the meta voice at the right edge. */
function SliderRow({ label, value, min, max, step, onPreview, onCommit }: { label: string; value: number; min: number; max: number; step: number; onPreview: (value: number) => void; onCommit: (value: number) => void }) {
  return (
    <div className="flex flex-col gap-1" data-theme-slider={label.toLowerCase()}>
      <div className="flex items-baseline justify-between">
        <span className={SLIDER_LABEL}>{label}</span>
        <span className={SLIDER_VALUE}>{fmtPercent(value)}</span>
      </div>
      <Slider aria-label={label} value={value} min={min} max={max} step={step} onValueChange={onPreview} onValueCommitted={onCommit} />
    </div>
  );
}
