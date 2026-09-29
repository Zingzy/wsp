// SPDX-License-Identifier: AGPL-3.0-only
// The composer's slash menu and the flyout a screen command raises, in a real
// Chromium, both themes, on a thread whose init announced the CLI's own screens
// beside the commands that run: the menu lists the ones that run and none of
// the screens, and Enter on a typed screen command starts nothing, the draft
// stays, and a flyout names wsp's own control for it, with nothing above the
// box. Both states are photographed. Runs only when asked for (WSP_RENDER=1) and skips
// without Playwright's Chromium.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { screenCommandLine } from "@wsp/protocol";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(tmpdir(), "wsp-render");

/** What the fixture's init announced and what its catalog calls a screen; the two lists it draws from live in test/shell/main.tsx. */
const RUNS = ["compact", "context", "cost", "init", "review", "unslop"];
const SCREENS = ["login", "logout", "model", "permissions", "config", "help"];
const LOGIN_LINE = screenCommandLine({ name: "login", control: "sign-in" }, { label: "Claude Code" }, { kind: "cloud" });

if (renderSkipped !== undefined) console.info(`composer slash menu render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the composer's slash menu and its flyout laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    // The centre column at the composer's full width.
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const EDITOR = "[data-testid=composer-editor]";
  const ITEM = "[data-composer-command-drawer] [data-composer-item-id]";
  const NOTICE = "[data-notice]";

  it.each(["dark", "light"] as const)("in the %s theme the menu lists what runs and no screen, and a typed screen command raises a flyout and starts no turn", async theme => {
    await page!.goto(`${base}?theme=${theme}&ws=ws_a&chat=1`);
    await page!.waitForSelector(".chat-markdown");
    await page!.locator(EDITOR).click();
    await page!.keyboard.type("/");
    await page!.waitForSelector(ITEM);
    const names = await page!.locator(ITEM).evaluateAll(els => els.map(el => (el.getAttribute("data-composer-item-id") ?? "").split(":").pop()));
    expect(names).toEqual(RUNS);
    for (const screen of SCREENS) expect(names, `${screen} in the menu in ${theme}`).not.toContain(screen);
    // The menu is a layer over the box; the centre column holds both.
    const menuShot = join(SHOTS, `composer-slash-menu-${theme}.png`);
    await page!.locator("[data-shell-center]").screenshot({ path: menuShot });
    console.info(`composer slash menu screenshot: ${menuShot}`);

    await page!.keyboard.type("login");
    await page!.waitForSelector(ITEM, { state: "detached" });
    const turns = await page!.locator(".chat-markdown").count();
    await page!.keyboard.press("Enter");
    // A flyout names the road, and nothing stands above the box.
    await page!.waitForSelector(NOTICE);
    expect(await page!.locator(`${NOTICE} [data-notice-title]`).first().textContent()).toBe(LOGIN_LINE);
    expect(await page!.locator("[data-composer-refusal]").count()).toBe(0);
    // Nothing went: the transcript holds what it held, the draft is still in the box, and the menu is gone.
    expect(await page!.locator(".chat-markdown").count()).toBe(turns);
    expect((await page!.locator(EDITOR).textContent()) ?? "").toBe("/login");
    expect(await page!.locator("[data-composer-command-drawer]").count()).toBe(0);
    const lineShot = join(SHOTS, `composer-screen-command-${theme}.png`);
    await page!.screenshot({ path: lineShot });
    console.info(`composer screen command screenshot: ${lineShot}`);
    const [ratio] = await textContrast(page!, `${NOTICE} [data-notice-title]`);
    console.info(`${theme}: the flyout reads at ${ratio} to 1`);
    expect(ratio!, `the flyout reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
  }, 60_000);
});
