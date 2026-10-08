// SPDX-License-Identifier: AGPL-3.0-only
// Opening Settings leaves nothing of the thread or the sidebar over it. Settings keeps both trees mounted and hidden,
// and a popup portaled to body sat outside that hiding: the model picker, the access menu or the project switcher open
// when Settings opened stayed drawn over its page until Back. Each is opened in the real shell, then Settings by the
// gear and by the chord, and no popup may stand; Escape still closes Settings, back on the thread nothing of the
// popup is left in the page, and a popup that comes back gives focus back to its own button when it closes. In a
// window narrower than the sidebar's breakpoint the sidebar is a sheet, and what opens from it (the project switcher,
// Add project, Snooze, Export) stands over the sheet and stays readable to a screen reader. Vite serves test/shell to
// Playwright's browser, so it runs only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium on the
// machine.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPEN_LAYERS } from "../src/keyOwners";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (renderSkipped !== undefined) console.info(`settings popups render test skipped: ${renderSkipped}`);

const THEMES = ["dark", "light"] as const;
const POPUPS = [
  { name: "the model picker", trigger: "[data-composer-picker='model']" },
  { name: "the access menu", trigger: "[data-composer-picker='access']" },
  { name: "the project switcher", trigger: "[data-k='project-switcher']" },
] as const;
const OPENERS = ["the gear", "the chord"] as const;

interface Reach {
  /** The element at the popup's centre is the popup's own: nothing stands over it. */
  onTop: boolean;
  /** An ancestor hides it from a screen reader. */
  hidden: boolean;
}

describe.skipIf(renderSkipped !== undefined)("Settings opened over an open popup", () => {
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
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  /** Every popup, menu or listbox a person could see: on the page, not display none, not transparent. */
  const standing = (): Promise<string[]> =>
    page!.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[role=menu], [role=listbox], [role=dialog], [data-slot$='-popup'], [data-slot$='-positioner']")]
        .filter(el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
        .map(el => el.getAttribute("data-slot") ?? el.getAttribute("role") ?? el.tagName),
    );

  const reach = (selector: string): Promise<Reach> =>
    page!.locator(selector).first().evaluate(el => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { onTop: hit !== null && el.contains(hit), hidden: el.closest("[aria-hidden=true], [inert]") !== null };
    });

  for (const theme of THEMES) {
    for (const popup of POPUPS) {
      for (const opener of OPENERS) {
        it(`${popup.name} open when Settings opens by ${opener} leaves nothing over Settings, and Escape closes Settings, in ${theme}`, async () => {
          await page!.setViewportSize({ width: 1200, height: 800 });
          await page!.goto(`${base}?theme=${theme}&ws=ws_a&chat=1`);
          await page!.waitForSelector("text=Loading transcript", { state: "detached" });
          await page!.locator(popup.trigger).first().click();
          await page!.waitForFunction(() => document.querySelector("[role=menu], [role=listbox], [role=dialog], [data-slot='popover-popup']") !== null);
          expect((await standing()).length).toBeGreaterThan(0);

          if (opener === "the gear") await page!.locator("[data-k='settings-row']").click();
          else await page!.keyboard.press("Control+Comma");
          await page!.waitForSelector("[data-settings-page]");
          // Long enough for any exit transition to have run out.
          await page!.waitForTimeout(600);
          expect(await standing()).toEqual([]);

          await page!.keyboard.press("Escape");
          await page!.waitForSelector("[data-settings-page]", { state: "detached" });
          await page!.waitForSelector("[data-chat-composer]");
          await page!.waitForTimeout(600);
          if (opener === "the chord") {
            // Nothing pressed outside the popup, so it was never closed: it stands again where it was left, takes its
            // own Escape, and hands focus back to the button that opened it, so a typed letter goes nowhere else.
            expect((await standing()).length).toBeGreaterThan(0);
            await page!.keyboard.press("Escape");
            await page!.waitForTimeout(600);
            expect(await page!.locator(popup.trigger).first().evaluate(el => el === document.activeElement || el.contains(document.activeElement))).toBe(true);
          }
          expect(await standing()).toEqual([]);
          // Gone from the page too, not only from sight: a popup element left in it would read as an open layer to
          // keyBelongsElsewhere and keep the composer's type-to-focus off.
          expect(await page!.evaluate(layers => document.querySelector(layers) === null, OPEN_LAYERS)).toBe(true);
          // Back on the thread its popups open and show as before.
          await page!.locator(popup.trigger).first().click();
          await page!.waitForFunction(() => document.querySelector("[role=menu], [role=listbox], [data-slot='popover-popup']") !== null);
          expect((await standing()).length).toBeGreaterThan(0);
        }, 60_000);
      }
    }

    describe(`at 390 in ${theme}, what opens from the sidebar sheet`, () => {
      const openSheet = async (): Promise<void> => {
        await page!.setViewportSize({ width: 390, height: 844 });
        await page!.goto(`${base}?theme=${theme}&ws=ws_a&chat=1&panel=closed&marks=1`);
        await page!.waitForSelector("text=Loading transcript", { state: "detached" });
        await page!.locator("[data-slot=sidebar-trigger]").first().click();
        await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-k=project-switcher]");
        await page!.waitForTimeout(400);
      };
      const fromTileMenu = async (item: string): Promise<void> => {
        await page!.locator("[data-slot=sidebar][data-mobile=true] [data-sidebar-row]").filter({ hasText: "Reply with" }).first().click({ button: "right" });
        await page!.getByRole("menuitem", { name: item }).click();
      };
      const DIALOG = "[data-slot=dialog-popup]";

      it("the project switcher and the Add project dialog it opens stand over the sheet, readable", async () => {
        await openSheet();
        await page!.locator("[data-slot=sidebar][data-mobile=true] [data-k=project-switcher]").click();
        await page!.waitForSelector("[data-project-switcher-menu]");
        await page!.waitForTimeout(300);
        expect(await reach("[data-project-switcher-menu]")).toEqual({ onTop: true, hidden: false });
        await page!.locator("[data-k=add-project-row]").click();
        await page!.waitForSelector(DIALOG);
        await page!.waitForTimeout(400);
        expect(await reach(DIALOG)).toEqual({ onTop: true, hidden: false });
        // Focus is in the dialog, and Escape takes the dialog down while the sheet stays.
        expect(await page!.locator(DIALOG).evaluate(el => el.contains(document.activeElement))).toBe(true);
        await page!.keyboard.press("Escape");
        await page!.waitForSelector(DIALOG, { state: "detached" });
        expect(await page!.locator("[data-slot=sidebar][data-mobile=true]").count()).toBe(1);
      }, 60_000);

      it("the project switcher open in the sheet when Settings opens from the sheet's gear is hidden with the workspace sidebar", async () => {
        await openSheet();
        await page!.locator("[data-slot=sidebar][data-mobile=true] [data-k=project-switcher]").click();
        await page!.waitForSelector("[data-project-switcher-menu]");
        await page!.locator("[data-slot=sidebar][data-mobile=true] [data-k=settings-row]").click();
        await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-settings-groups]");
        await page!.waitForTimeout(600);
        expect(await page!.locator("[data-project-switcher-menu]:visible").count()).toBe(0);
      }, 60_000);

      for (const [item, name] of [
        ["Snooze thread", "Snooze"],
        ["Export project", "Export"],
      ] as const) {
        it(`the ${name} dialog opened from a tile in the sheet stands over the sheet, readable`, async () => {
          await openSheet();
          await fromTileMenu(item);
          await page!.waitForSelector(DIALOG);
          await page!.waitForTimeout(400);
          expect(await reach(DIALOG)).toEqual({ onTop: true, hidden: false });
        }, 60_000);
      }
    });
  }
});
