// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar's brand lockup starts
// where the search box does, and collapsing the sidebar leaves the page
// header's left padding alone. Vite serves test/shell to Playwright's
// browser, so like the glyph test it runs only when asked for (WSP_RENDER=1)
// and skips without Playwright's Chromium on the machine.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stopVite } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
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

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (skipped !== undefined) console.info(`shell layout render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the shell's chrome laid out in Chromium", () => {
  let vite: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    const port = await freePort();
    vite = spawn(join(WEB_DIR, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(port), "--strictPort", "--logLevel", "silent"], { cwd: WEB_DIR, stdio: "ignore" });
    base = `http://127.0.0.1:${port}/test/shell/index.html`;
    await waitFor(base, vite);
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await stopVite(vite);
  });

  async function open(theme: "dark" | "light"): Promise<void> {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-sidebar-row]");
  }
  const box = async (selector: string): Promise<Box> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };
  const paddingLeft = (selector: string): Promise<string> => page!.locator(selector).first().evaluate(el => getComputedStyle(el).paddingLeft);

  it("the brand lockup starts where the search box does, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const lockup = await box("[data-slot=sidebar-header] [role=img][aria-label=wsp]");
      const search = await box("[data-slot=input-control]:has(input[aria-label='Search threads'])");
      expect(Math.abs(lockup.x - search.x)).toBeLessThan(1);
      const path = join(SHOTS_DIR, `sidebar-header-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar header screenshot: ${path}`);
    }
  }, 30_000);

  it("collapsing the sidebar leaves the page header's left padding alone", async () => {
    await open("dark");
    const before = await paddingLeft("header");
    await page!.locator("header button[aria-label='Toggle main sidebar']").click();
    await page!.waitForSelector("[data-sidebar-state=collapsed]");
    // The header animates padding-left; let a 200 ms transition run out.
    await page!.waitForTimeout(400);
    expect(await paddingLeft("header")).toBe(before);
  }, 30_000);
});
