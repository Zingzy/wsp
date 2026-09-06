// SPDX-License-Identifier: AGPL-3.0-only
// The Lineage section's project goldens in a real Chromium: each sits under the
// version it stands on, newest first, the one this workspace forks from wears
// the badge, the live disk row offers the snapshot, every row a fork, the dot
// and the button sit on the title line, and the rows keep inside the tab, in
// both themes, photographed for review. Like the creation layout test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startVite, stopRender, type ViteChild } from "./vite-child";

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

if (skipped !== undefined) console.info(`lineage project goldens render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the lineage's project goldens laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/lineage-projects/index.html");
    base = `${vite.base}/test/lineage-projects/index.html`;
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the project goldens sit under their versions newest first, the fork wears its badge, snapshot and fork are offered, and every row ends inside the tab", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=pg-snap_project-wsp-1]");
    const tab = await page!.locator("[data-testid=machine-tab]").boundingBox();
    const v12 = await page!.locator("[data-k=v12]").boundingBox();
    const v11 = await page!.locator("[data-k=v11]").boundingBox();
    const p2 = await page!.locator("[data-k=pg-snap_project-spoo-2]").boundingBox();
    const p1 = await page!.locator("[data-k=pg-snap_project-spoo-1]").boundingBox();
    const wsp = await page!.locator("[data-k=pg-snap_project-wsp-1]").boundingBox();
    expect(p2!.y).toBeGreaterThan(v12!.y + v12!.height);
    expect(p1!.y).toBeGreaterThan(p2!.y + p2!.height);
    expect(v11!.y).toBeGreaterThan(p1!.y + p1!.height);
    expect(wsp!.y).toBeGreaterThan(v11!.y + v11!.height);
    expect(await page!.locator("[data-k=pg-snap_project-spoo-2]").textContent()).toBe("spoothis fork");
    expect(await page!.locator("[data-k=v12]").textContent()).toBe("v12head");
    expect(await page!.getByRole("button", { name: "snapshot spoo-fork as a project golden" }).count()).toBe(1);
    expect(await page!.getByRole("button", { name: /^fork / }).count()).toBe(3);
    for (const button of await page!.getByRole("button", { name: /^fork / }).all()) {
      const box = await button.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(tab!.x + tab!.width);
    }
    expect(await page!.locator("text=forked 2026-09-06 · spoo imported 2026-09-06").count()).toBe(1);
    const middle = (box: { y: number; height: number }): number => box.y + box.height / 2;
    for (const [title, button] of [
      ["text=Live disk", "snapshot spoo-fork as a project golden"],
      ["[data-k=pg-snap_project-spoo-2]", "fork spoo from snap_project-spoo-2"],
      ["[data-k=pg-snap_project-wsp-1]", "fork wsp from snap_project-wsp-1"],
    ] as const) {
      const row = page!.locator(title).locator("xpath=ancestor::li[1]");
      const heading = await row.locator(title).boundingBox();
      const dot = await row.locator("xpath=div[1]/span[1]").boundingBox();
      const act = await page!.getByRole("button", { name: button }).boundingBox();
      const detail = await row.locator("xpath=div[1]/span[last()]").boundingBox();
      expect(Math.abs(middle(dot!) - middle(heading!)), `${title} dot`).toBeLessThanOrEqual(1);
      expect(Math.abs(middle(act!) - middle(heading!)), `${title} button`).toBeLessThanOrEqual(1);
      expect(detail!.y, `${title} detail`).toBeGreaterThanOrEqual(heading!.y + heading!.height - 1);
    }
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `lineage-projects-${theme}.png`) });
    expect(existsSync(join(SHOTS, `lineage-projects-${theme}.png`))).toBe(true);
  }, 30_000);
});
