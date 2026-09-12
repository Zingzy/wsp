// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog in a real Chromium, both themes: the size rows
// share one height with each other, read in the muted mono voice the Where
// caption uses, carry no border or fill of their own, and the rates read at AA;
// and with nothing to fork yet, the Create keycap is held with the reason as
// its tooltip. Photographed in each state and theme. Runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLOUD_SETUP_WORDS } from "@wsp/protocol";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(WEB_DIR, "artifacts", "render");

if (renderSkipped !== undefined) console.info(`new workspace layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the new-workspace dialog laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/new-workspace/index.html");
    base = `${vite.base}/test/new-workspace/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const SIZE_ROWS = "[aria-label=Size] label";
  const styles = (selector: string) =>
    page!.locator(selector).evaluateAll(els =>
      els.map(el => {
        const s = getComputedStyle(el);
        return { height: Math.round(el.getBoundingClientRect().height), color: s.color, font: s.fontFamily, border: s.borderTopWidth, background: s.backgroundColor };
      }),
    );

  it.each(["dark", "light"] as const)("in the %s theme the size rows are uniform muted mono text with nothing loud, the image's own checked", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector(SIZE_ROWS);
    const rows = await styles(SIZE_ROWS);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(r => r.height)).size).toBe(1);
    expect(new Set(rows.map(r => r.color)).size).toBe(1);
    for (const r of rows) {
      expect(r.font.toLowerCase()).toMatch(/mono/);
      expect(r.border).toBe("0px");
      expect(r.background).toBe("rgba(0, 0, 0, 0)");
    }
    // The same muted voice as the caption over them.
    const [caption] = await styles("[data-k=where-caption]");
    expect(rows[0]!.color).toBe(caption!.color);
    expect(await page!.locator(`${SIZE_ROWS} [role=radio]`).evaluateAll(els => els.map(el => el.getAttribute("aria-checked")))).toEqual(["true", "false"]);
    expect(await page!.locator(SIZE_ROWS).allTextContents()).toEqual(["2 vCPU · 4 GB$0.11/hr", "2 vCPU · 8 GB$0.15/hr"]);
    const ratios = await textContrast(page!, `${SIZE_ROWS} > span`);
    console.info(`${theme}: size rows read at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `new-workspace-open-${theme}.png`) });
  });

  it.each(["dark", "light"] as const)("in the %s theme a computer that answers says its room, and the caption wraps inside the dialog", async theme => {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.locator("[data-k=where-caption]").waitFor();
    // The provider is the checked row on this page, so its sizes are drawn; the computer beside it is the row that
    // reports how much room it has, which is the sentence mock 08a carries.
    await page!.locator("[data-segment=p_1]").click();
    const caption = page!.locator("[data-k=where-caption]");
    expect(await caption.textContent()).toBe("free · room for 3 workspaces · builds your image there first, about 4 min");
    const box = await caption.evaluate(el => ({ width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) }));
    console.info(`${theme}: the caption reads at ${box.width} by ${box.height}`);
    // Two lines of 11 px mono inside the dialog's own 334 px column, and nothing spills out of it.
    expect(box.width).toBeLessThanOrEqual(334);
    expect(box.height).toBeGreaterThan(16);
    expect(await caption.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page!.locator("[role=dialog]").screenshot({ path: join(SHOTS, `new-workspace-room-${theme}.png`) });
  });

  it("at a phone's width the held keycap takes the same width as the live one, which the footer stacks full width", async () => {
    const phone = await browser!.newPage({ viewport: { width: 390, height: 844 } });
    try {
      const rect = async (url: string): Promise<{ width: number; left: number }> => {
        await phone.goto(url);
        const create = phone.locator("[role=dialog] button", { hasText: "Create" });
        await create.waitFor();
        return create.evaluate(el => ({ width: Math.round(el.getBoundingClientRect().width), left: Math.round(el.getBoundingClientRect().left) }));
      };
      const live = await rect(`${base}?theme=dark`);
      const held = await rect(`${base}?theme=dark&refusal=${encodeURIComponent("the image is still building")}`);
      console.info(`390: live Create ${live.width} px at ${live.left}, held ${held.width} px at ${held.left}`);
      expect(held).toEqual(live);
      expect(live.width).toBeGreaterThan(300);
      // And the nowhere state, whose Create is held for another reason and stands beside a second outline button.
      const nowhere = await rect(`${base}?theme=dark&places=none`);
      expect(nowhere).toEqual(live);
    } finally {
      await phone.close();
    }
  });

  it.each(["dark", "light"] as const)("in the %s theme a build still running holds the Create keycap and puts its reason in the tooltip", async theme => {
    const line = `${CLOUD_SETUP_WORDS.create.building} · 5 of 13`;
    await page!.goto(`${base}?theme=${theme}&refusal=${encodeURIComponent(line)}`);
    const create = page!.locator("[role=dialog] button", { hasText: "Create" });
    await create.waitFor();
    expect(await create.isDisabled()).toBe(true);
    // The reason hangs on the wrapper, since a disabled button takes no hover of its own.
    await page!.locator("[data-k=create-reason]").hover();
    const popup = page!.locator("[data-slot=tooltip-popup]");
    await popup.waitFor();
    expect(await popup.textContent()).toBe(line);
    const ratios = await textContrast(page!, "[data-slot=tooltip-popup]");
    console.info(`${theme}: the held keycap's reason reads at ${ratios.map(r => r.toFixed(2)).join(", ")} to 1`);
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    // The whole window, since the tooltip is a popup beside the card and a shot of the card alone would cut it.
    await page!.screenshot({ path: join(SHOTS, `new-workspace-building-${theme}.png`) });
  });
});
