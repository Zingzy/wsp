// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
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

  it("registers each thread status ink as a colour utility off the theme's own token", () => {
    const inline = /@theme inline \{([\s\S]*?)\n\}/.exec(css)![1]!;
    for (const tone of ["input", "working", "failed", "done"]) expect(inline).toContain(`--color-status-${tone}: var(--status-${tone});`);
  });

  it("carries no second theme system: no contrast layer, no inherited theme ids, no workspace theme on the sidebar", () => {
    expect(css).not.toMatch(/--contrast-|--appearance-contrast|--app-theme-|data-theme-id|theme-inspector|data-space-|--space-grain|--toolbar-/);
    expect(css).not.toContain('[data-theme="dark"]');
  });

  it("the Mac's dark material takes its grounds from the theme, so a dark theme's window stands on its own ground", () => {
    const material = css.slice(css.indexOf(".desktop-mac.dark [data-slot=\"sidebar-inset\"]"), css.indexOf("/* The window paints the glass behind the page"));
    expect(material.length).toBeGreaterThan(0);
    expect(material).not.toMatch(/rgb\((6 6 6|24 24 26|31 31 33)/);
    expect(material).toContain("var(--material-ground)");
    expect(material).toContain("var(--material-raised)");
    expect(material).toContain("var(--material-edge)");
  });

  it("the sidebar's scope names no colour of its own: it maps the page's roles onto the theme's sidebar tokens, on both sides", () => {
    const scope = /\n\[data-app-sidebar\] \{([^}]*)\}/.exec(css)![1]!;
    expect(scope).not.toMatch(/#|rgb|oklch|--color-/);
    expect(scope).toContain("--background: var(--sidebar-canvas);");
    expect(scope).toContain("--muted-foreground: var(--sidebar-quiet);");
  });

  it("draws no blur of the page's own on the Mac, where the window's glass is macOS's: each pane's blur is written for the other platforms alone, the composer's excepted, and no rule turns one off", () => {
    // Each blur declaration with the blocks it sits in, outermost first. A block's head is the text before its brace.
    const blurs: string[][] = [];
    const heads: string[] = [];
    let head = "";
    for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
      if (ch === "{") {
        heads.push(head.trim());
        head = "";
      } else if (ch === "}") {
        heads.pop();
        head = "";
      } else if (ch === ";") {
        if (/^(-webkit-)?backdrop-filter:\s*blur\(/.test(head.trim())) blurs.push([...heads]);
        head = "";
      } else head += ch;
    }
    expect(blurs.length).toBeGreaterThan(0);
    // A dialog's scrim is the one blur the window's glass cannot stand in for: it blurs the page under the dialog. The
    // frost utility carries its blur bare, and every use of it names the condition.
    const onMac = blurs.filter(within => !within.includes("@variant off-mac") && !within.includes("@utility dialog-backdrop") && within.join() !== "@utility glass-backdrop");
    expect(onMac).toEqual([]);
    expect(css).not.toMatch(/backdrop-filter:\s*none/);
    const applied = [...css.matchAll(/@variant off-mac \{\s*@apply glass-backdrop;/g)].length;
    expect(applied).toBe([...css.matchAll(/@apply glass-backdrop;/g)].length);
    const uses = execFileSync("git", ["grep", "-hoE", "[^ \"'`]*glass-backdrop", "--", "src", ":!*.css", ":!*.test.*"], { cwd: join(__dirname, ".."), encoding: "utf8" }).trim().split("\n");
    expect(uses.length).toBeGreaterThan(0);
    // The composer and the rows attached to it frost on the Mac too: the owner wants the page under them to show.
    expect(uses.filter(use => !use.startsWith("off-mac:")).sort()).toEqual(
      ["before:glass-backdrop", "before:glass-backdrop", "glass-backdrop", "glass-backdrop", "group-has-data-[composer-banner-surface=attached]/composer-surface:glass-backdrop"].sort(),
    );
  });

  it("pins the sidebar glass utility added after the upstream set", () => {
    const additions = css.slice(css.indexOf("/* wsp additions below this line. */"));
    expect(additions).toMatchInlineSnapshot(`
      "/* wsp additions below this line. */

      /* The page's own frost, taken only off the Mac (off-mac: in markup, @variant off-mac here): the Mac's glass is
         macOS's, which the window draws once for the whole window, and a pane there stands on its material whole. The
         condition sits at each use, since a variant inside this utility cannot follow a ::before it is used under. */
      @utility glass-backdrop {
        -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) var(--glass-ground,);
        backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturation)) var(--glass-ground,);
      }

      /* The shell's sidebar floats over the app background, so it takes the same
         glass recipe as the other floating surfaces, tinted with the sidebar
         palette instead of the popover, and its border joins the sidebar tokens. */
      @utility sidebar-glass {
        background: color-mix(in srgb, var(--sidebar) var(--glass-opacity), transparent);
        @variant off-mac {
          @apply glass-backdrop;
        }
        border-color: var(--sidebar-border);

        @supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
          background: var(--sidebar) !important;
        }
      }

      /* On macOS the desktop window frosts the sidebar's column with the system's
         own glass, so nothing in the sidebar paints a background over it; in dark
         mode each region lays its own share of the ground over that glass (below). */
      @utility sidebar-vibrancy {
        background: transparent;
        border-color: var(--sidebar-border);

        & > [data-slot="sidebar-inner"] {
          background-color: transparent;
        }
      }

      /* Dark mode on the Mac: the whole window stands on the glass, each region the theme's material ground at its own
         share over it. The dev build's Material panel moves these same variables, so a share changes here and there
         together. Inside the panel and on the settings page every edge is a hairline and cards a faint tint, on the line
         tokens every border utility reads. Light mode keeps its solid ground. */
      .desktop-mac.dark [data-slot="sidebar-inset"] {
        background: transparent;
      }

      .desktop-mac.dark {
        /* Over a white desktop the glass reads as mid grey and the page's muted ink falls under AA on every share of it;
           this step clears it under a hover fill and stays a step behind the body. */
        --muted-foreground: color-mix(in oklab, var(--glass-ink) 85%, var(--material-ground));
        --material-centre: 67%;
        --material-panel: 74%;
        --material-sidebar: 40%;
        --material-line: 10%;
        --material-card: 2%;
      }

      .desktop-mac.dark [data-slot="sidebar-inner"] {
        background: color-mix(in srgb, var(--material-ground) var(--material-sidebar), transparent);
      }

      .desktop-mac.dark [data-shell-center] {
        background: color-mix(in srgb, var(--material-ground) var(--material-centre), transparent);
      }

      /* A translucent terminal shows the window's glass through its canvas, so with one open the centre's share moves off
         the whole column onto the thread and the header, and the drawer's own ground stays clear. */
      html.desktop-mac.dark:has([data-terminal-translucent]) [data-shell-center] {
        background: transparent;
      }

      html.desktop-mac.dark:has([data-terminal-translucent]) :is([data-shell-center] > header, [data-terminal-beside], [data-shell-center] [data-terminal-tabs]) {
        background: color-mix(in srgb, var(--material-ground) var(--material-centre), transparent);
      }

      /* The same in the right panel: holding a translucent terminal, its share moves onto the tab strip. */
      html.desktop-mac.dark [data-preview-panel-mode="inline"]:has([data-terminal-translucent]) {
        background: transparent;
        /* The hairline read against the share; over the bare glass it takes the grey it shows there, as a solid line. */
        border-color: var(--material-edge);
      }

      html.desktop-mac.dark [data-preview-panel-mode="inline"]:has([data-terminal-translucent]) [data-right-panel-tabbar] {
        background: color-mix(in srgb, var(--material-ground) var(--material-panel), transparent);
      }

      .desktop-mac.dark [data-preview-panel-mode="inline"] {
        background: color-mix(in srgb, var(--material-ground) var(--material-panel), transparent);
        border-color: var(--border);
      }

      .desktop-mac.dark :is([data-preview-panel-mode="inline"], [data-settings-page]) {
        --background: transparent;
        --card: rgb(255 255 255 / var(--material-card));
        --muted: rgb(255 255 255 / calc(var(--material-card) + 1%));
        --border: rgb(255 255 255 / var(--material-line));
        --input: rgb(255 255 255 / calc(var(--material-line) + 6%));
        /* A picture's panes stand on the chrome's ground, which over the glass is the raised material the composer takes. */
        --app-chrome-background: var(--material-raised);
      }

      /* Light mode on the Mac: the sidebar alone stands on the glass, under a veil of its own ground. Over a dark desktop
         the glass reads as mid grey, and Linen's prose, the thinnest of the light sidebar inks, holds AA there only at 99
         percent. */
      .desktop-mac:not(.dark) {
        --sidebar-veil: 100%;
      }

      .desktop-mac:not(.dark) [data-slot="sidebar-inner"] {
        background-color: color-mix(in srgb, var(--sidebar) var(--sidebar-veil), transparent);
      }

      /* The Mac's glass shows what is behind the window, never the page under a pane, so a pane that frosts what scrolls
         under it elsewhere (a pill, a banner) stands on its material whole here; the composer alone keeps its frost. A dialog's and a sheet's
         scrim keep their blur: they stand only while open, and a sharp page under a dim scrim reads busier. */
      .desktop-mac {
        --glass-opacity: 100%;
        /* A blur on the Mac's transparent page lays its copy over the page it sampled, so the sharp text shows through
           unless the copy stands on the page's own ground: the filter GlassGround renders. The composer is its one user. */
        --glass-ground: url(#glass-ground);
        /* The ground matches what the window's glass reads as behind the page, not the theme's background, so the
           composer keeps the look of the glass (solved 2026-10-01 against the owner's screenshot: this ground under the centre pane's material paints rgb(22 24 24)). */
        --glass-ground-color: rgb(236 237 236);
      }

      .desktop-mac.dark {
        --glass-ground-color: rgb(35 41 41);
      }

      /* The page drawing no glass (Transparency off in Appearance, or the computer's Reduce transparency on, read in
         settings/theme.ts): every glass takes its solid ground, each region its theme's material at full share. The
         doubled root outweighs the Mac's dark block above. */
      :root:root.solid {
        --glass-opacity: 100%;
        --material-centre: 100%;
        --material-panel: 100%;
        --material-sidebar: 100%;
        --sidebar-veil: 100%;
      }

      /* The composer sets its glass on itself, so its solid ground is set there too: the theme's card, whole. */
      :root:root.solid [data-slot="composer-shell"] {
        --chat-composer-glass-surface: var(--card);
        --chat-composer-glass-opacity: 100%;
      }

      /* The window paints the glass behind the page, so the page's own canvas is
         clear and only the main column paints a background. The frame row's toggle
         sits one header gap after the third traffic light, centre to centre: with
         the lights at x 16 the third light's centre measures 69px at 1x. */
      .desktop-mac,
      .desktop-mac body {
        background: transparent;
      }

      /* A solid page takes the window's glass away with it, so the page paints the ground the glass stood in for. */
      :root:root.solid.desktop-mac,
      :root:root.solid.desktop-mac body {
        background: var(--background);
      }

      .desktop-mac {
        --header-frame-inset: calc(69px + var(--header-gap) - var(--workspace-titlebar-control-size) / 2);
      }

      /* The counts in the top rows: the sidebar's quiet text at part opacity.
         Declared on the sidebar as well as the root, so the sidebar's own step-ups
         reach it. Two surfaces read it, the sidebar's rows and the workspace
         switcher's cards, and the switcher is portaled outside [data-app-sidebar]:
         it takes the root's copy, which is why this token is declared on both and
         cannot be scoped to the sidebar alone. */
      :root,
      [data-app-sidebar] {
        --top-row-meta: color-mix(in srgb, var(--sidebar-whisper) var(--top-row-meta-alpha), transparent);
        /* A meta line that carries a sentence rather than a figure: the line for a provider out of
           reach, what the runtime is doing to a machine's daemon, a drop with memory near full. The
           whisper the counts take reads at 2.90:1 in light and 3.00:1 in dark, which is right for a
           number the eye lands on and wrong for a sentence someone has to read through, so prose takes
           a higher part of the same ink and clears AA on both surfaces. */
        --sidebar-prose: color-mix(in srgb, var(--sidebar-whisper) 75%, transparent);
        /* The word a sidebar row at rest carries, the search row's included. The dark sidebar holds it
           at 80 percent of its quiet ink and still reads at 5.43:1; on a light surface that same 80
           percent lands at 4.47:1, and at 4.14:1 over the search row's tint, so light takes the ink
           whole. Zinc-600 whole still reads a step behind the zinc-800 a selected row's name takes. */
        --sidebar-row-rest: var(--sidebar-muted-foreground);
        /* The glyphs' quiet ink, mixed from the sidebar's own tokens; declared here beside the tiers for the same
           reason. */
        --sidebar-icon-color: color-mix(
          in srgb,
          var(--sidebar-muted-foreground) 60%,
          var(--sidebar)
        );
      }

      /* oklab, not srgb: this is the space the utility's own 80 percent mixed in, and the dark side
         is meant to come out of this pass with the pixels it went in with. */
      :root:where(.dark, .dark *),
      [data-app-sidebar]:where(.dark, .dark *) {
        --sidebar-row-rest: color-mix(in oklab, var(--sidebar-muted-foreground) 80%, transparent);
      }

      /* Over the glass the sidebar's quiet text and glyphs have no solid card
         behind them: one step up, the rows' words and the prose whole, and the
         counts nearly opaque, keep them at AA over a white desktop, where the
         glass reads as mid grey. */
      .desktop-mac [data-app-sidebar] {
        @variant dark {
          --muted-foreground: var(--glass-ink);
          --sidebar-muted-foreground: var(--glass-ink);
          --sidebar-icon-color: var(--glass-ink);
          --sidebar-whisper: var(--glass-ink);
          --sidebar-row-rest: var(--glass-ink);
          --sidebar-prose: var(--glass-ink);
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
         a drawer, and every column and banner that does not hold the canvas. In dark
         mode every region already paints its own share over the glass, so only light
         mode repaints the chrome. In a browser tab there is no material, and the
         canvas blends over the pane's token. */
      html.desktop-mac:has([data-terminal-translucent]),
      html.desktop-mac :has([data-terminal-translucent]) {
        background: transparent;
      }

      html.desktop-mac:not(.dark):has([data-terminal-translucent]) :is([data-right-panel-tabbar], [data-terminal-tabs], [data-shell-center] > header, [data-terminal-beside], [data-slot="sidebar-inset"] > :not(:has([data-terminal-translucent])), [data-slot="sidebar-inset"] > div > :not(:has([data-terminal-translucent]))) {
        background: var(--background);
      }

      @keyframes road-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
      }

      /* A rolling digit's column, 0 to 9 one a line, drawn as content so the element's own text stays the digit. */
      .digit-strip::before {
        content: "0\\A 1\\A 2\\A 3\\A 4\\A 5\\A 6\\A 7\\A 8\\A 9";
        white-space: pre;
      }
      "
    `);
  });
});
