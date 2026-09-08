// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appTerminalFontSize } from "../src/terminal/ghostty/surface.js";

const css = readFileSync(join(__dirname, "../src/index.css"), "utf8");

describe("index.css", () => {
  it("carries the upstream token set with no brand strings", () => {
    const body = css.split("\n").slice(1).join("\n");
    expect(css.split("\n")[0]).toBe(
      "/* Adapted from pingdotgg/t3code apps/web/src/index.css at 57a66608 (MIT). */",
    );
    expect(body).not.toMatch(/t3|T3/);
    expect(body).toContain('@import "tailwindcss";');
    expect(body).toContain("@theme inline {");
  });

  it("the mono size token is the 11px the sidebar and composer set their code and meta text in", () => {
    expect(css).toMatch(/^\s*--font-size-mono: 11px;$/m);
  });

  it("the terminal size token beside it is the app's text size, and the pane's default is the number that token names", () => {
    expect(css).toMatch(/^\s*--font-size-terminal: 14px;$/m);
    // A page with no stylesheet yet falls back to the number in the code; the two must be the same size.
    expect(appTerminalFontSize()).toBe(14);
  });

  it("the search row's tint is one token, a few percent of black", () => {
    expect(css).toMatch(/^\s*--search-row-tint: [2-8]%;$/m);
  });

  // The hues are the one palette a person paints a workspace with, so they must never say what a state says and
  // must not read alike in a picker. The two colours they have to stay clear of are the app's own tokens, read
  // from the ramp rather than written down here, so a palette change on either side is what moves these numbers.
  describe("the workspace hues", () => {
    const ramp = readFileSync(join(__dirname, "../node_modules/tailwindcss/theme.css"), "utf8");
    const hueOfRamp = (name: string): number => Number(/oklch\([\d.]+% [\d.]+ ([\d.]+)\)/.exec(new RegExp(`--color-${name}:\\s*(oklch\\([^)]*\\))`).exec(ramp)![1]!)![1]);
    const STATE_GREEN = hueOfRamp("emerald-500");
    const DANGER_RED = hueOfRamp("red-500");
    const apart = (a: number, b: number): number => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
    /** Every --space-tint-<id> the stylesheet declares, light theme and dark, as [id, hue]. */
    const declared = (): Array<[string, number]> =>
      Array.from(css.matchAll(/--space-tint-([a-z]+): oklch\([\d.]+ [\d.]+ ([\d.]+)\);/g)).map(m => [m[1]!, Number(m[2]!)]);

    it("are declared twice each, one step for the light theme and one for the dark", () => {
      const ids = declared().map(([id]) => id);
      const once = [...new Set(ids)];
      expect(once).toEqual(["cyan", "azure", "blue", "violet", "purple", "magenta"]);
      expect(ids).toHaveLength(once.length * 2);
      // The dark step is the lighter one: no single lightness clears the readable floor on both a near-white and a
      // near-black sidebar, which is the whole reason there are two.
      const lightness = Array.from(css.matchAll(/--space-tint-([a-z]+): oklch\(([\d.]+) /g)).map(m => [m[1]!, Number(m[2]!)] as const);
      for (const id of once) {
        const [light, dark] = lightness.filter(([name]) => name === id).map(([, l]) => l) as [number, number];
        expect(dark).toBeGreaterThan(light);
      }
    });

    it("keep 30 degrees from the green that means running and the red that means danger, in both steps", () => {
      for (const [id, hue] of declared()) {
        expect({ id, toGreen: apart(hue, STATE_GREEN) >= 30 }).toEqual({ id, toGreen: true });
        expect({ id, toRed: apart(hue, DANGER_RED) >= 30 }).toEqual({ id, toRed: true });
      }
    });

    it("keep 25 degrees from each other, so no two read alike in the picker", () => {
      const hues = declared();
      for (const [a, aHue] of hues) {
        for (const [b, bHue] of hues) {
          if (a === b) continue;
          expect({ a, b, apart: apart(aHue, bHue) >= 25 }).toEqual({ a, b, apart: true });
        }
      }
    });
  });

  it("pins the sidebar glass utility added after the upstream set", () => {
    const additions = css.slice(css.indexOf("/* wsp additions below this line. */"));
    expect(additions).toMatchInlineSnapshot(`
      "/* wsp additions below this line. */

      /* The shell's sidebar floats over the app background, so it takes the same
         glass recipe as the other floating surfaces, tinted with the sidebar
         palette instead of the popover, and its border joins the sidebar tokens. */
      @utility sidebar-glass {
        background: color-mix(in srgb, var(--sidebar) var(--glass-opacity), transparent);
        -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
        backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation));
        border-color: var(--sidebar-border);

        @supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
          background: var(--sidebar) !important;
        }
      }

      /* On macOS the desktop window frosts the sidebar's column with the system's
         own glass, so nothing in the sidebar paints a background over it. The main
         column keeps its solid background, so text never sits on the desktop. */
      @utility sidebar-vibrancy {
        background: transparent;
        border-color: var(--sidebar-border);

        & > [data-slot="sidebar-inner"] {
          background: transparent;
        }
      }

      /* The window paints the glass behind the page, so the page's own canvas is
         clear and only the main column paints a background. The frame row's toggle
         sits one header gap after the third traffic light, centre to centre: with
         the lights at x 16 the third light's centre measures 69px at 1x. */
      .desktop-mac,
      .desktop-mac body {
        background: transparent;
      }

      .desktop-mac {
        --header-frame-inset: calc(69px + var(--header-gap) - var(--workspace-titlebar-control-size) / 2);
      }

      /* The counts in the top rows: the muted text at part opacity.
         Declared where the contrast tokens are, so the sidebar's own step-ups
         reach it. */
      :root,
      [data-app-sidebar] {
        --top-row-meta: color-mix(in srgb, var(--contrast-muted-foreground) var(--top-row-meta-alpha), transparent);
      }

      /* Over the glass the sidebar's quiet text and glyphs have no solid card
         behind them: one step up, and the counts nearly opaque, keep
         them at AA over a white desktop, where the glass reads as mid grey. */
      .desktop-mac [data-app-sidebar] {
        @variant dark {
          --muted-foreground: var(--color-neutral-300);
          --sidebar-muted-foreground: var(--color-neutral-300);
          --sidebar-icon-color: var(--color-neutral-300);
          --top-row-meta-alpha: 90%;
        }
      }

      /* The search row's word paints at the kit's 80 percent; over the glass it
         takes the muted token whole, the step that keeps it AA over a white desktop. */
      .desktop-mac [data-app-sidebar] [data-search-row] {
        color: var(--sidebar-muted-foreground);
      }

      /* The search row at rest: a few percent of black over the sidebar surface,
         so over the glass it reads as a field and not loose text; hover one step
         darker. The section rows beside it stay clear. */
      [data-search-row] {
        background: color-mix(in srgb, black var(--search-row-tint), transparent);

        &:hover {
          background: color-mix(in srgb, black calc(var(--search-row-tint) * 2), transparent);
        }
      }

      /* A Ghostty config with background-opacity under 1: the viewport marks itself
         translucent. In the macOS desktop window, whose html carries the class the
         desktop preload sets, every element between the window and the canvas stops
         painting so the window's own material shows through the canvas alone, and
         the chrome around it paints the app background itself: the right pane's tab
         strip, the terminal tabs beside a split, the header row and the thread above
         a drawer, and every column and banner that does not hold the canvas. In a
         browser tab there is no material, and the canvas blends over the pane's token. */
      html.desktop-mac:has([data-terminal-translucent]),
      html.desktop-mac :has([data-terminal-translucent]) {
        background: transparent;
      }

      html.desktop-mac:has([data-terminal-translucent]) :is([data-right-panel-tabbar], [data-terminal-tabs], [data-shell-center] > header, [data-terminal-beside], [data-slot="sidebar-inset"] > :not(:has([data-terminal-translucent])), [data-slot="sidebar-inset"] > div > :not(:has([data-terminal-translucent]))) {
        background: var(--background);
      }

      /* One workspace's own hue, by the id its record carries. Six one-word ids, each
         a token with a step per theme: no one lightness clears the readable floor
         against both a near-white and a near-black sidebar, so the light theme takes
         the darker step and the dark theme the lighter one. The six sit 27 degrees
         apart and none comes within 43 of the green that means running or 44 of the
         red that means danger, so a workspace's colour never speaks the state
         language. Every surface drawn in a workspace's colour reads --space-tint, so
         a component names no colour and the hue has one home. */
      :root {
        --space-tint-cyan: oklch(0.501 0.077 206);
        --space-tint-azure: oklch(0.504 0.094 233);
        --space-tint-blue: oklch(0.517 0.19 260);
        --space-tint-violet: oklch(0.537 0.246 287);
        --space-tint-purple: oklch(0.541 0.241 314);
        --space-tint-magenta: oklch(0.537 0.209 341);
        /* How much of the hue goes into the sidebar's own colour in Spaces mode:
           enough to tell two spaces apart, quiet enough to leave the rows their
           contrast. The dark theme takes far more because its sidebar is black and
           the mix runs in oklab, where a few percent off black paints nothing. The
           second number is the alpha the hue lies at over the macOS window material,
           which has no colour to mix into. */
        --space-wash: 10%;
        --space-wash-material: 7%;

        @variant dark {
          --space-tint-cyan: oklch(0.625 0.096 206);
          --space-tint-azure: oklch(0.629 0.117 233);
          --space-tint-blue: oklch(0.64 0.174 260);
          --space-tint-violet: oklch(0.65 0.178 287);
          --space-tint-purple: oklch(0.664 0.234 314);
          --space-tint-magenta: oklch(0.67 0.261 341);
          --space-wash: 30%;
          --space-wash-material: 11%;
        }
      }

      [data-space-tint="cyan"] {
        --space-tint: var(--space-tint-cyan);
      }

      [data-space-tint="azure"] {
        --space-tint: var(--space-tint-azure);
      }

      [data-space-tint="blue"] {
        --space-tint: var(--space-tint-blue);
      }

      [data-space-tint="violet"] {
        --space-tint: var(--space-tint-violet);
      }

      [data-space-tint="purple"] {
        --space-tint: var(--space-tint-purple);
      }

      [data-space-tint="magenta"] {
        --space-tint: var(--space-tint-magenta);
      }

      /* Spaces mode tints the sidebar's own surface. The inner layer is the one both
         the glass recipe and the macOS vibrancy leave to the app, so the mix happens
         in one place; over the window's own material there is no token to mix into,
         only the material behind it. The mix runs in oklab, which keeps the paint
         inside sRGB where a mix in sRGB leaves it and the screen clamps. */
      [data-app-sidebar][data-space-tint] > [data-slot="sidebar-inner"] {
        background: color-mix(in oklab, var(--space-tint) var(--space-wash), var(--sidebar));
      }

      .desktop-mac [data-app-sidebar][data-space-tint] > [data-slot="sidebar-inner"] {
        background: color-mix(in oklab, var(--space-tint) var(--space-wash-material), transparent);
      }

      /* In the list body the hue draws in one place only: the rail the thread rows of
         a tinted workspace hang from. */
      [data-slot="sidebar-menu-sub"][data-space-tint] {
        border-color: var(--space-tint);
      }
      "
    `);
  });
});
