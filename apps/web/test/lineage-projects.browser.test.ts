// SPDX-License-Identifier: AGPL-3.0-only
// The Lineage section's project goldens in a real Chromium: each sits under the
// version it stands on, newest first, the one this workspace forks from wears
// the word, the live disk row offers the snapshot, every row a fork, the dot
// and the button sit on the title line, and the rows keep inside the tab, in
// both themes, photographed for review. Like the creation layout test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`lineage project goldens render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the lineage's project goldens laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/lineage-projects/index.html");
    base = `${vite.base}/test/lineage-projects/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the project goldens sit under their versions newest first, the fork carries its word, snapshot and fork are offered, and every row ends inside the tab", async theme => {
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
    expect(await page!.locator("[data-k=pg-snap_project-spoo-2]").textContent()).toBe("spoo");
    expect(await page!.locator("[data-k=pg-snap_project-spoo-2]").locator("xpath=ancestor::li[1]").locator(":scope > span [data-mark]").allTextContents()).toEqual(["this one"]);
    expect(await page!.locator("[data-k=v12]").textContent()).toBe("v12");
    // The version stands on its snapshot alone, no template recorded, so it wears the volatile word beside head.
    expect(await page!.locator("[data-k=v12]").locator("xpath=ancestor::li[1]").locator(":scope > span [data-mark]").allTextContents()).toEqual(["head", "volatile"]);
    expect(await page!.locator("[data-slot=badge]").count()).toBe(0);
    // The snapshot is the PROJECTS section's, which lists what is on the disk; the Live disk row carries neither the
    // button nor the project's word any more.
    expect(await page!.getByRole("button", { name: "snapshot spoo-fork as a project golden" }).count()).toBe(1);
    expect(await page!.getByRole("button", { name: "snapshot spoo-fork as a project golden" }).textContent()).toBe("Snapshot as image");
    expect(await page!.locator("text=Live disk").locator("xpath=ancestor::li[1]").getByRole("button").count()).toBe(0);
    expect(await page!.locator("[data-k=project-spoo] [data-cell=imported]").textContent()).toBe("2026-09-06");
    expect(await page!.getByRole("button", { name: /^fork / }).count()).toBe(3);
    for (const button of await page!.getByRole("button", { name: /^fork / }).all()) {
      const box = await button.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(tab!.x + tab!.width);
    }
    expect(await page!.locator("text=forked 2026-09-06").count()).toBe(1);
    expect(await page!.locator("text=spoo imported 2026-09-06").count()).toBe(0);
    const middle = (box: { y: number; height: number }): number => box.y + box.height / 2;
    for (const [title, button] of [
      ["[data-k=pg-snap_project-spoo-2]", "fork spoo from snap_project-spoo-2"],
      ["[data-k=pg-snap_project-wsp-1]", "fork wsp from snap_project-wsp-1"],
    ] as const) {
      const row = page!.locator(title).locator("xpath=ancestor::li[1]");
      const heading = await row.locator(title).boundingBox();
      const dot = await row.locator("xpath=span[1]").boundingBox();
      const act = await page!.getByRole("button", { name: button }).boundingBox();
      const detail = await row.locator("xpath=span[last()]").boundingBox();
      expect(Math.abs(middle(dot!) - middle(heading!)), `${title} dot`).toBeLessThanOrEqual(1);
      expect(Math.abs(middle(act!) - middle(heading!)), `${title} button`).toBeLessThanOrEqual(1);
      expect(detail!.y, `${title} detail`).toBeGreaterThanOrEqual(heading!.y + heading!.height - 1);
    }
    // The marks are one column for the whole section: the live disk's, the version's and the nested fork's words start
    // at the same x, and so do the buttons after them.
    // The version wears two words, head and volatile; the column is where the first begins.
    const wordAt = async (title: string): Promise<number> => (await page!.locator(title).locator("xpath=ancestor::li[1]").locator(":scope > span [data-mark]").first().boundingBox())!.x;
    const nowX = await wordAt("text=Live disk");
    expect(await wordAt("[data-k=v12]")).toBe(nowX);
    expect(await wordAt("[data-k=pg-snap_project-spoo-2]")).toBe(nowX);
    const forkX = (await page!.getByRole("button", { name: "fork spoo from snap_project-spoo-2" }).boundingBox())!.x;
    expect((await page!.getByRole("button", { name: "fork wsp from snap_project-wsp-1" }).boundingBox())!.x).toBe(forkX);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `lineage-projects-${theme}.png`) });
    expect(existsSync(join(SHOTS, `lineage-projects-${theme}.png`))).toBe(true);
  }, 30_000);
});
