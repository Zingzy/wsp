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

  // A workspace's theme is painted by one formatter's custom properties; the stylesheet keys on the mark the
  // formatter's caller sets and nothing else, so no colour id lives in CSS and no old hue rule lingers.
  describe("the workspace theme", () => {
    it("keys the gradient and the grain on the theme mark alone, with one pre-rendered tile and no per-hue rule", () => {
      expect(css).not.toMatch(/data-space-tint/);
      expect(css).not.toMatch(/--space-tint-[a-z]+:/);
      expect(css.match(/--space-grain-tile: url\("data:image\/svg\+xml,/g)).toHaveLength(1);
      expect(css).toContain("feTurbulence");
      expect(css).toMatch(/\[data-app-sidebar\]\[data-space-theme\] > \[data-slot="sidebar-inner"\] \{[^}]*background-image: var\(--space-gradient\);/);
      expect(css).toMatch(/\[data-app-sidebar\]\[data-space-theme\] > \[data-slot="sidebar-inner"\]::before \{[^}]*opacity: var\(--space-grain, 0\);/);
      // The grain layer never filters the surface: it is a tile laid at an opacity, under the rows.
      const grain = /::before \{([^}]*)\}/.exec(css.slice(css.indexOf("[data-space-theme]")))![1]!;
      expect(grain).not.toMatch(/filter:/);
      expect(grain).toContain("z-index: -1");
    });

    it("a theme pinned to one side takes that side's sidebar tokens whatever the app draws, with one copy of each set", () => {
      expect(css).toContain(':is(:where(.dark, .dark *):not([data-space-scheme="light"]), [data-space-scheme="dark"])');
      expect(css.match(/--sidebar-row-selected: color-mix\(in srgb, var\(--contrast-foreground\) 7%, transparent\);/g)).toHaveLength(1);
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

      /* The counts in the top rows: the sidebar's quiet text at part opacity.
         Declared where the contrast tokens are, so the sidebar's own step-ups
         reach it. Two surfaces read it, the sidebar's rows and the workspace
         switcher's cards, and the switcher is portaled outside [data-app-sidebar]:
         it takes the root's copy, which is why this token is declared on both and
         cannot be scoped to the sidebar alone. */
      :root,
      [data-app-sidebar] {
        --top-row-meta: color-mix(in srgb, var(--contrast-sidebar-whisper) var(--top-row-meta-alpha), transparent);
        /* A meta line that carries a sentence rather than a figure: the line for a provider out of
           reach, what the runtime is doing to a machine's daemon, a drop with memory near full. The
           whisper the counts take reads at 2.90:1 in light and 3.00:1 in dark, which is right for a
           number the eye lands on and wrong for a sentence someone has to read through, so prose takes
           a higher part of the same ink and clears AA on both surfaces. */
        --sidebar-prose: color-mix(in srgb, var(--contrast-sidebar-whisper) 75%, transparent);
        /* The word a sidebar row at rest carries, the search row's included. The dark sidebar holds it
           at 80 percent of its quiet ink and still reads at 5.43:1; on a light surface that same 80
           percent lands at 4.47:1, and at 4.14:1 over the search row's tint, so light takes the ink
           whole. Zinc-600 whole still reads a step behind the zinc-800 a selected row's name takes. */
        --sidebar-row-rest: var(--contrast-sidebar-muted-foreground);
        /* The glyphs' quiet ink, mixed from the sidebar's own tokens; declared here beside the tiers for the same
           reason, so a sidebar whose theme pins its side mixes it from that side's tokens. */
        --sidebar-icon-color: color-mix(
          in srgb,
          var(--contrast-sidebar-muted-foreground) 60%,
          var(--sidebar)
        );
      }

      /* oklab, not srgb: this is the space the utility's own 80 percent mixed in, and the dark side
         is meant to come out of this pass with the pixels it went in with. The sidebar takes the dark
         step on the app's dark side unless its theme pins light, and wherever its theme pins dark. */
      :root:where(.dark, .dark *),
      [data-app-sidebar]:is(:where(.dark, .dark *):not([data-space-scheme="light"]), [data-space-scheme="dark"]) {
        --sidebar-row-rest: color-mix(in oklab, var(--contrast-sidebar-muted-foreground) 80%, transparent);
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

      /* One workspace's theme, in Spaces mode, on the sidebar's own surface. The
         theme object is read by one formatter, which writes these custom
         properties onto the sidebar element: the gradient, the grain and the ink.
         The inner layer is the one both the glass recipe and the macOS vibrancy
         leave to the app, so the gradient lies over the glass or the window's
         material rather than replacing it; its stops carry the theme's opacity as
         their alpha. The grain is one tile, an SVG turbulence filter the browser
         rasterises once and repeats, laid under the rows at the slider's opacity:
         never a filter over the whole surface, so the rows scroll over a still
         layer. The inner isolates its stacking so the tile sits above the gradient
         and under everything the sidebar draws. */
      :root {
        --space-grain-tile: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E");
      }

      [data-app-sidebar][data-space-theme] > [data-slot="sidebar-inner"] {
        position: relative;
        isolation: isolate;
        background-image: var(--space-gradient);
        background-repeat: no-repeat;
        background-size: 100% 100%;
      }

      [data-app-sidebar][data-space-theme] > [data-slot="sidebar-inner"]::before {
        content: "";
        position: absolute;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        background-image: var(--space-grain-tile);
        background-size: 160px 160px;
        opacity: var(--space-grain, 0);
        mix-blend-mode: soft-light;
      }
      "
    `);
  });
});
