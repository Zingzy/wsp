// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

      /* A Ghostty config with background-opacity under 1: the viewport marks itself
         translucent, and the pane around it stops painting so the canvas sits on the
         app background in a browser tab. In the macOS desktop window, whose html
         carries the class the desktop preload sets, every element between the window
         and the pane stops painting too, so the window's own material shows through
         the terminal; the header row, the thread beside the pane and the column that
         does not hold it paint the app background themselves, so text never sits on
         the desktop. */
      .thread-terminal-drawer:has([data-terminal-translucent]),
      .thread-terminal-drawer :has([data-terminal-translucent]) {
        background: transparent;
      }

      html.desktop-mac:has([data-terminal-translucent]),
      html.desktop-mac :has([data-terminal-translucent]) {
        background: transparent;
      }

      html.desktop-mac:has([data-terminal-translucent]) :is([data-shell-center] > header, [data-terminal-beside], [data-slot="sidebar-inset"] > div > :not(:has([data-terminal-translucent]))) {
        background: var(--background);
      }
      "
    `);
  });
});
