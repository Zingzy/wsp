// SPDX-License-Identifier: AGPL-3.0-only
// The Lineage section in a real Chromium: the forked version lists every tool
// missing from its golden with the cause and reason under a micro-label, a
// long reason wraps inside the row, in both themes, and the machine tab is
// photographed for review. Like the creation layout test it runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");
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
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`vite did not serve ${url} in time`);
}

if (skipped !== undefined) console.info(`lineage missing-tools render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the lineage's missing tools laid out in Chromium", () => {
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    const port = await freePort();
    vite = spawn(join(WEB_DIR, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort", "--logLevel", "silent"], { cwd: WEB_DIR, stdio: "ignore" });
    base = `http://127.0.0.1:${port}/test/lineage/index.html`;
    await waitFor(base, vite);
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    // Only the process this file spawned, by the handle it kept.
    vite?.kill();
  });

  it.each(["dark", "light"] as const)("in the %s theme every missing tool is a visible row under the forked version's label, a long reason wraps inside the tab, and nothing sits under the others", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=missing-tools] li");
    expect(await page!.locator("[data-k=missing-tools]").count()).toBe(1);
    expect(await page!.locator("[data-k=missing-tools] p").textContent()).toBe("not on this image");
    const names = await page!.locator("[data-k=missing-tool]").allTextContents();
    const notes = await page!.locator("[data-k=missing-note]").allTextContents();
    expect(names).toEqual(["gopls", "diskbloom", "Homebrew"]);
    expect(notes[0]).toBe("skipped: no Linux bottle");
    expect(notes[2]).toMatch(/^failed: exit 1: git: not found/);
    const tab = await page!.locator("[data-testid=machine-tab]").boundingBox();
    const v12 = await page!.locator("[data-k=v12]").boundingBox();
    const v11 = await page!.locator("[data-k=v11]").boundingBox();
    const label = await page!.locator("[data-k=missing-tools] p").boundingBox();
    const short = await page!.locator("[data-k=missing-note]").first().boundingBox();
    const long = await page!.locator("[data-k=missing-note]").last().boundingBox();
    expect(label!.y).toBeGreaterThan(v12!.y + v12!.height);
    expect(long!.y + long!.height).toBeLessThanOrEqual(v11!.y);
    // Height is the wrap proof: the grid clamps the span's box whether or not its glyphs overflow it.
    expect(long!.height).toBeGreaterThan(short!.height * 1.8);
    expect(long!.x + long!.width).toBeLessThanOrEqual(tab!.x + tab!.width);
    expect(await page!.locator("text=Raycast").count()).toBe(0);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `lineage-missing-${theme}.png`) });
    expect(existsSync(join(SHOTS, `lineage-missing-${theme}.png`))).toBe(true);
  }, 30_000);
});
