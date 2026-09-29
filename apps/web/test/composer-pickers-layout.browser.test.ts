// SPDX-License-Identifier: AGPL-3.0-only
// The composer's picker row in a real Chromium, on a kept machine that holds
// projects and whose harness takes an effort, so the box's footer carries the
// model and the reasoning and the strip under the box the access. At the 1200 px viewport
// with the right panel open, as it opens by default, and at the narrowest
// centre the shell hands the row (an 1100 px viewport with the sidebar at its
// widest and the right panel open inline, where the sidebar gives way and the
// column sits at the shell's floor), every trigger reads
// whole, none is cut by its own box or by the row's, and a pick of the access
// mode whose label names the machine moves no trigger in the box: the access
// trigger wears the mode's short form, and its menu row the long one.
// Photographed in both themes. Runs only when
// asked for (WSP_RENDER=1) and skips without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THIS_COMPUTER } from "@wsp/protocol";
import { accessLabel } from "../src/components/chat/format";
import { SIDEBAR_MAX_WIDTH } from "../src/shell/sidebarWidth";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");

interface Trigger {
  picker: string;
  text: string;
  /** The label span is wider than the room the trigger gives it: what a truncate cut looks like. */
  cut: boolean;
  left: number;
  right: number;
  /** From the footer's top edge, so a composer the empty view settles into place does not read as the pick moving it. */
  top: number;
  height: number;
}

interface Row {
  /** The visible edges of the footer, whose own children are the triggers and which they must sit inside. */
  group: { left: number; right: number; width: number; height: number; overflow: number };
  footer: { height: number; width: number };
  triggers: Trigger[];
}

if (renderSkipped !== undefined) console.info(`composer pickers layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the composer's picker row laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const readRow = (): Promise<Row> =>
    page!.locator("[data-chat-composer-footer]").evaluate(footer => {
      const group = footer;
      const g = group.getBoundingClientRect();
      const f = footer.getBoundingClientRect();
      const triggers = [...footer.querySelectorAll<HTMLElement>("[data-composer-picker]")].map(el => {
        const label = [...el.querySelectorAll<HTMLElement>("span")].find(s => s.classList.contains("truncate"))!;
        const b = el.getBoundingClientRect();
        return {
          picker: el.getAttribute("data-composer-picker") ?? "",
          text: el.textContent ?? "",
          cut: label.scrollWidth > label.clientWidth,
          left: b.left,
          right: b.right,
          top: b.top - f.top,
          height: b.height,
        };
      });
      return {
        group: { left: g.left, right: g.right, width: g.width, height: g.height, overflow: group.scrollWidth - group.clientWidth },
        footer: { height: f.height, width: f.width },
        triggers,
      };
    });

  /** The pick that names the machine, made from the menu as a person makes it. */
  const pickBypass = async (): Promise<string> => {
    const trigger = "[data-composer-picker='access']";
    await page!.locator(trigger).click();
    await page!.waitForSelector("[data-composer-option='bypassPermissions']");
    const row = (await page!.locator("[data-composer-option='bypassPermissions']").textContent()) ?? "";
    await page!.locator("[data-composer-option='bypassPermissions']").click();
    await page!.waitForSelector(`${trigger}[data-access='bypassPermissions']`);
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[role=menu]", { state: "detached" });
    return row;
  };

  const expectWhole = (row: Row, where: string): void => {
    expect(row.triggers.map(t => t.picker), `the pickers at ${where}`).toEqual(["model", "reasoning"]);
    for (const t of row.triggers) {
      expect(t.cut, `${t.picker} reads "${t.text}" cut at ${where}`).toBe(false);
      expect(t.left, `${t.picker} starts before the row at ${where}`).toBeGreaterThanOrEqual(row.group.left - 0.5);
      expect(t.right, `${t.picker} runs past the row at ${where}`).toBeLessThanOrEqual(row.group.right + 0.5);
    }
    expect(row.group.overflow, `the row scrolls at ${where}`).toBe(0);
  };

  const widths = [
    { name: "1200", viewport: 1200, query: "", label: "the 1200 px viewport with the panel open" },
    { name: "narrowest", viewport: 1100, query: `&sidebar=${SIDEBAR_MAX_WIDTH}&panel=preview`, label: "the narrowest centre the shell hands the row, an 1100 px viewport with the sidebar at its widest and the panel inline" },
  ] as const;

  for (const width of widths) {
    it(`at ${width.label} every trigger reads whole before and after bypass is picked, the access trigger wears the short form and its menu row the long one, and nothing else moves, in both themes`, async () => {
      await page!.setViewportSize({ width: width.viewport, height: 800 });
      for (const theme of ["dark", "light"] as const) {
        await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&projects=1&efforts=1${width.query}`);
        await page!.waitForSelector("[data-composer-picker='access']");
        await page!.waitForSelector("text=loading transcript", { state: "detached" });
        const before = await readRow();
        console.info(`${width.name} ${theme} before: ${JSON.stringify(before)}`);
        const menuRow = await pickBypass();
        const after = await readRow();
        console.info(`${width.name} ${theme} after: ${JSON.stringify(after)} menu row "${menuRow}"`);
        const shot = join(SHOTS_DIR, `composer-pickers-${width.name}-${theme}.png`);
        await page!.locator("[data-chat-composer]").screenshot({ path: shot });
        console.info(`composer pickers screenshot: ${shot}`);

        expectWhole(before, `${width.label} before the pick in ${theme}`);
        expectWhole(after, `${width.label} after the pick in ${theme}`);
        const access = (await page!.locator("[data-composer-checkout] [data-composer-picker='access']").textContent()) ?? "";
        expect(access).toBe(accessLabel({ value: "bypassPermissions", label: `Bypass on ${THIS_COMPUTER}`, short: "Bypass" }));
        expect(menuRow).toContain(`Bypass on ${THIS_COMPUTER}`);
        // The pick moves nothing in the box: every trigger keeps its box and the footer keeps its height.
        expect(after.triggers).toEqual(before.triggers);
        expect(after.footer.height).toBe(before.footer.height);
        expect(new Set(after.triggers.map(t => t.height))).toEqual(new Set([32]));
      }
    }, 60_000);
  }
});
