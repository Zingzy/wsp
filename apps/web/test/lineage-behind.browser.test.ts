// SPDX-License-Identifier: AGPL-3.0-only
// The Lineage section in a real Chromium for a workspace still on an older
// version: its row carries the state in words, the button that moves it and
// the rollback that moves the golden's head, the version's retired rows sit
// under it, and none of it pushes the tab wide, in both themes. Like the missing-tools render test it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGE_MOVE_CONFIRM, imageKeptLine } from "@wsp/protocol";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`lineage behind-head render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the offer to a workspace behind the head, laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/lineage-behind/index.html");
    base = `${vite.base}/test/lineage-behind/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  it.each(["dark", "light"] as const)("in the %s theme the forked version says what it is on and what is available, its button sits on that row, the retired rows sit under it, and nothing leaves the tab", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=retired-rows] li");
    const v11 = await page!.locator("[data-k=v11]").boundingBox();
    const v12 = await page!.locator("[data-k=v12]").boundingBox();
    const row = page!.locator("[data-k=v11]").locator("xpath=ancestor::li[1]");
    expect(await row.textContent()).toContain("on image v11, v12 available");
    // Both actions sit on that row and neither evicts the other: Update moves this workspace, Roll back moves the
    // golden's head for every fork after it.
    const button = page!.getByRole("button", { name: "update api to v12" });
    const rollback = page!.getByRole("button", { name: "roll back to v11" });
    const box = (await button.boundingBox())!;
    const backBox = (await rollback.boundingBox())!;
    expect(box.y).toBeGreaterThan(v12!.y);
    for (const b of [box, backBox]) expect(Math.abs(b.y + b.height / 2 - (v11!.y + v11!.height / 2))).toBeLessThan(b.height);
    // Side by side, in that order, and they do not overlap.
    expect(box.x + box.width).toBeLessThanOrEqual(backBox.x);

    const label = await page!.locator("[data-k=retired-rows] p").boundingBox();
    expect(await page!.locator("[data-k=retired-rows] p").textContent()).toBe("retired, still on this image");
    expect(label!.y).toBeGreaterThan(v11!.y);
    expect(await page!.locator("[data-k=retired-row]").allTextContents()).toEqual(["yq", "~/.zshrc", "diskbloom"]);

    const tab = (await page!.locator("[data-testid=machine-tab]").boundingBox())!;
    for (const el of [box, backBox, label!, (await page!.locator("[data-k=retired-row]").last().boundingBox())!]) {
      expect(el.x + el.width).toBeLessThanOrEqual(tab.x + tab.width);
    }
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `lineage-behind-${theme}.png`) });
    expect(existsSync(join(SHOTS, `lineage-behind-${theme}.png`))).toBe(true);
  }, 30_000);

  it.each(["dark", "light"] as const)("in the %s theme the move asks first, in one sentence about the files, and the note it leaves names what stayed this workspace's without leaving the tab", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-k=v11]");
    await page!.getByRole("button", { name: "update api to v12" }).click();
    const dialog = page!.getByRole("alertdialog");
    await dialog.waitFor();
    const asked = (await dialog.textContent()) ?? "";
    expect(asked).toContain("Move api to v12?");
    expect(asked).toContain(IMAGE_MOVE_CONFIRM);
    // The popup fades in; the shot is taken once it is fully there, not while it is arriving.
    await page!.waitForFunction(() => {
      const el = document.querySelector("[role=alertdialog]");
      return el !== null && getComputedStyle(el).opacity === "1";
    });
    await page!.screenshot({ path: join(SHOTS, `image-move-confirm-${theme}.png`) });
    expect(existsSync(join(SHOTS, `image-move-confirm-${theme}.png`))).toBe(true);

    await page!.getByRole("button", { name: "Move" }).click();
    const kept = imageKeptLine([".zshrc"]);
    await page!.waitForFunction(text => document.querySelector("[data-k=lineage-note]")?.textContent?.includes(text) === true, kept);
    const note = (await page!.locator("[data-k=lineage-note]").boundingBox())!;
    const tab = (await page!.locator("[data-testid=machine-tab]").boundingBox())!;
    expect(note.x + note.width).toBeLessThanOrEqual(tab.x + tab.width);
    await page!.locator("[data-testid=machine-tab]").screenshot({ path: join(SHOTS, `image-move-kept-${theme}.png`) });
    expect(existsSync(join(SHOTS, `image-move-kept-${theme}.png`))).toBe(true);
  }, 30_000);
});
