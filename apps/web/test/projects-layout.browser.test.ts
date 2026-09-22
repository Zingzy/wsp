// SPDX-License-Identifier: AGPL-3.0-only
// The composer's project pick in a real Chromium: the pick sits in the footer
// beside the access pick at the same height, reads the record's last project
// for the workspace in muted mono, its menu lists the workspace's projects and
// other folder, and the line under the box names the folder that project
// lands in; photographed in both themes. Then the Machine tab's PROJECTS
// section with two projects and with none, its rows one height in mono with no
// chip. The thread rows carry no project word: the tree over them names it.
// Vite serves test/shell to Playwright's browser, so like the shell layout
// test it runs only when asked for (WSP_RENDER=1) and skips without
// Playwright's Chromium on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (renderSkipped !== undefined) console.info(`projects layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the project pick laid out in Chromium", () => {
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

  const box = async (selector: string): Promise<Box> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };

  it("the pick sits beside the access pick at one height, reads spoo in muted mono, its menu lists both projects and other folder, and the line under the box names spoo's folder, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&projects=1&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='project']");
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      const pick = await box("[data-composer-picker='project']");
      const access = await box("[data-composer-picker='permissionMode']");
      expect(Math.abs(pick.height - access.height)).toBeLessThan(1);
      expect(Math.abs(pick.y - access.y)).toBeLessThan(1);
      // The pick follows the access pick in the footer's left group: harness, model, effort, access, project.
      const order = await page!.locator("[data-chat-composer-footer]").evaluate(el => [...el.querySelectorAll("[data-composer-picker]")].map(b => b.getAttribute("data-composer-picker")));
      expect(order.indexOf("project")).toBe(order.indexOf("permissionMode") + 1);
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const trigger = el.querySelector<HTMLElement>("[data-composer-picker='project']")!;
        const name = trigger.querySelector<HTMLElement>("[data-composer-project-name]")!;
        const access = el.querySelector<HTMLElement>("[data-composer-picker='permissionMode']")!;
        const folder = el.querySelector<HTMLElement>("[data-composer-folder]")!;
        const n = getComputedStyle(name);
        const t = getComputedStyle(trigger);
        const a = getComputedStyle(access);
        const skin = (s: CSSStyleDeclaration) => ({ color: s.color, background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopColor}`, font: s.fontSize, height: s.height });
        return {
          value: trigger.getAttribute("data-value"),
          name: name.textContent,
          mono: /mono/i.test(n.fontFamily),
          skin: skin(t),
          accessSkin: skin(a),
          nameBackground: n.backgroundColor,
          folder: folder.getAttribute("data-composer-folder"),
          folderMono: /mono/i.test(getComputedStyle(folder.querySelector(".font-mono") ?? folder).fontFamily),
        };
      });
      expect(read.value).toBe("spoo");
      expect(read.name).toBe("spoo");
      expect(read.mono).toBe(true);
      // The same skin as the access pick, on nothing: one muted label, no fill, no chip around the name.
      expect(read.skin).toEqual(read.accessSkin);
      expect(read.skin.background).toBe("rgba(0, 0, 0, 0)");
      expect(read.nameBackground).toBe("rgba(0, 0, 0, 0)");
      expect(read.folder).toBe("/root/spoo");
      expect(read.folderMono).toBe(true);
      const closed = join(SHOTS_DIR, `composer-project-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path: closed });
      console.info(`composer project pick screenshot: ${closed}`);

      await page!.locator("[data-composer-picker='project']").click();
      await page!.waitForSelector("[data-composer-project='wsp']");
      const rows = await page!.locator("[role=menu]").first().evaluate(menu => ({
        projects: [...menu.querySelectorAll<HTMLElement>("[data-composer-project]")].map(el => el.getAttribute("data-composer-project")),
        other: menu.querySelector<HTMLElement>("[data-composer-project-other]")?.textContent ?? null,
        heights: [...menu.querySelectorAll<HTMLElement>("[data-composer-project], [data-composer-project-other]")].map(el => el.getBoundingClientRect().height),
      }));
      expect(rows.projects).toEqual(["spoo", "wsp"]);
      expect(rows.other).toBe("other folder");
      expect(new Set(rows.heights.map(h => Math.round(h))).size).toBe(1);
      const menu = join(SHOTS_DIR, `composer-project-menu-${theme}.png`);
      await page!.locator("[role=menu]").first().screenshot({ path: menu });
      console.info(`composer project menu screenshot: ${menu}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[role=menu]", { state: "detached" });
    }
  }, 60_000);

  it("the Machine tab's PROJECTS section lists two projects as one-height mono rows with no chip, name, folder, size and day, with import a folder and snapshot as image under them; a workspace with none says so, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&projects=1&ws=ws_a&panel=machine`);
      await page!.waitForSelector("[data-k='project-wsp']");
      const read = await page!.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("[data-k^='project-']")];
        const section = rows[0]!.closest("section")!;
        return {
          names: rows.map(r => r.querySelector("[data-cell='name']")?.textContent),
          heights: rows.map(r => Math.round(r.getBoundingClientRect().height)),
          mono: rows.map(r => /mono/i.test(getComputedStyle(r).fontFamily)),
          badges: section.querySelectorAll("[data-slot='badge']").length,
          cellBackgrounds: [...section.querySelectorAll<HTMLElement>("[data-cell]")].map(c => getComputedStyle(c).backgroundColor),
          buttons: [...section.querySelectorAll<HTMLButtonElement>("button")].map(b => ({ text: b.textContent?.trim(), height: Math.round(b.getBoundingClientRect().height), disabled: b.disabled })),
          heading: section.querySelector("div > span")?.textContent,
        };
      });
      expect(read.heading).toBe("Projects");
      expect(read.names).toEqual(["spoo", "wsp"]);
      expect(new Set(read.heights).size).toBe(1);
      expect(read.mono).toEqual([true, true]);
      expect(read.badges).toBe(0);
      for (const bg of read.cellBackgrounds) expect(bg).toBe("rgba(0, 0, 0, 0)");
      expect(read.buttons).toEqual([
        { text: "Import a folder", height: read.buttons[0]!.height, disabled: false },
        { text: "Snapshot as image", height: read.buttons[0]!.height, disabled: false },
      ]);
      const two = join(SHOTS_DIR, `projects-section-two-${theme}.png`);
      await page!.locator("[data-k='project-spoo']").locator("xpath=ancestor::section").screenshot({ path: two });
      console.info(`projects section screenshot: ${two}`);

      await page!.goto(`${base}?theme=${theme}&ws=ws_b&panel=machine`);
      await page!.waitForSelector("[data-k='projects-none']");
      const none = await page!.evaluate(() => {
        const line = document.querySelector<HTMLElement>("[data-k='projects-none']")!;
        const section = line.closest("section")!;
        return { line: line.textContent, buttons: [...section.querySelectorAll<HTMLButtonElement>("button")].map(b => ({ text: b.textContent?.trim(), disabled: b.disabled })) };
      });
      expect(none.line).toBe("No projects yet. Import a folder.");
      expect(none.buttons).toEqual([
        { text: "Import a folder", disabled: false },
        { text: "Snapshot as image", disabled: true },
      ]);
      const empty = join(SHOTS_DIR, `projects-section-none-${theme}.png`);
      await page!.locator("[data-k='projects-none']").locator("xpath=ancestor::section").screenshot({ path: empty });
      console.info(`projects section (none) screenshot: ${empty}`);
    }
  }, 60_000);
});
