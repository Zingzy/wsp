// SPDX-License-Identifier: AGPL-3.0-only
// The pane in a real Chromium: Nerd Font codepoints draw as glyphs from the
// bundled symbols face when the chosen text face has none, never as the
// notdef box. Vite serves the surface to Playwright's browser, so like the
// live tests it runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium on the machine.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopVite } from "../../../test/vite-child";
import type { CellSignature } from "../../../test/glyphs/probe";
import { DEFAULT_TERMINAL_TEXT_FACES, TERMINAL_SYMBOLS_FACE } from "./fontChain";

// jsdom's URL resolves relative references against the page origin, so the path is built with node:path.
const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`vite did not serve ${url} in time`);
}

const NOTDEF = "\u{10FFFD}";
// nf-fa folder, nf-custom folder, nf-md file, nf-oct git-branch: none of them in any platform text face
// (Menlo and SF Mono carry the powerline arrows themselves, so those would prove nothing here).
const ICONS = ["\uF07B", "\uE5FF", "\u{F0219}", "\uF418"];

// The default reporter prints nothing for a skipped suite but its arrow; this line is what a gate log shows.
if (skipped !== undefined) console.info(`glyph render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("Nerd Font glyphs through the pane in Chromium", () => {
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    const port = await freePort();
    vite = spawn(join(WEB_DIR, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort", "--logLevel", "silent"], { cwd: WEB_DIR, stdio: "ignore" });
    const url = `http://127.0.0.1:${port}/test/glyphs/index.html`;
    await waitFor(url, vite);
    browser = await chromium.launch();
    page = await browser.newPage();
    await page.goto(url);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await stopVite(vite);
  });

  /** Each glyph drawn alone on the one surface, in the given family's chain. */
  async function glyphs(texts: readonly string[], family?: string): Promise<CellSignature[]> {
    const out: CellSignature[] = [];
    for (const text of texts) {
      out.push(
        await page!.evaluate(
          ([t, f]) => (window as unknown as { drawGlyph: (text: string, family?: string) => Promise<CellSignature> }).drawGlyph(t!, f),
          [text, family] as [string, string | undefined],
        ),
      );
    }
    return out;
  }

  /** The icons as the bundled face draws them on the default text metrics: the face first in the list so no other
   * face, installed or fallen back to, can supply them; the text faces after it so the cell grid measures the same. */
  const reference = (): Promise<CellSignature[]> => glyphs([...ICONS, NOTDEF], `${TERMINAL_SYMBOLS_FACE}, ${DEFAULT_TERMINAL_TEXT_FACES}`);

  it("with the default stack every icon draws the bundled face's glyph, neither empty nor the notdef box nor a system fallback's", async () => {
    const cells = await glyphs([...ICONS, NOTDEF, "A"]);
    const bundled = await reference();
    const notdef = cells[ICONS.length]!;
    expect(notdef.lit).toBeGreaterThan(0);
    for (const [i, icon] of ICONS.entries()) {
      const name = `U+${icon.codePointAt(0)!.toString(16)}`;
      expect(cells[i]!.lit, `${name} drew nothing`).toBeGreaterThan(0);
      expect(cells[i]!.hash, `${name} drew the notdef box`).not.toBe(notdef.hash);
      expect(cells[i]!.hash, `${name} did not come from the bundled face`).toBe(bundled[i]!.hash);
    }
    expect(new Set(cells.slice(0, ICONS.length).map((c) => c.hash)).size).toBe(ICONS.length);
  }, 30_000);

  it("a chosen text face without icons still draws them from the bundled face", async () => {
    const chosen = await glyphs([...ICONS, NOTDEF], "Menlo");
    const bundled = await reference();
    for (const i of ICONS.keys()) {
      expect(chosen[i]!.lit).toBeGreaterThan(0);
      expect(chosen[i]!.hash).not.toBe(chosen[ICONS.length]!.hash);
      expect(chosen[i]!.hash).toBe(bundled[i]!.hash);
    }
  }, 30_000);
});
