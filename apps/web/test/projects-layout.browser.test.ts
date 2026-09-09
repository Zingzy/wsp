// SPDX-License-Identifier: AGPL-3.0-only
// The composer's project pick and the thread rows' project word in a real
// Chromium: the pick sits in the footer beside the access pick at the same
// height, reads the record's last project for the workspace in muted mono,
// its menu lists the workspace's projects and other folder, the line under
// the box names the folder that project lands in, and each thread row's
// second line carries the project its folder sits in beside the agent's
// mark, in the meta line's muted mono, every row one height whether or not
// it has one; photographed in both themes. Vite serves test/shell to
// Playwright's browser, so like the shell layout test it runs only when asked
// for (WSP_RENDER=1) and skips without Playwright's Chromium on the machine.
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

describe.skipIf(renderSkipped !== undefined)("the project pick and the thread rows' project word laid out in Chromium", () => {
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

  it("each thread row's second line carries its project beside the agent's mark in the meta line's muted mono, and rows with and without one are one height, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&projects=1`);
      await page!.waitForSelector("[data-thread-project]");
      const read = await page!.locator("[data-slot=sidebar]").first().evaluate(el => {
        const rows = [...el.querySelectorAll<HTMLElement>("[data-thread-item] [data-sidebar-row]")];
        return rows.map(row => {
          const word = row.querySelector<HTMLElement>("[data-thread-project]");
          const meta = row.querySelector<HTMLElement>("[data-thread-meta]")!;
          const opener = row.querySelector<HTMLElement>("[data-thread-provenance] > span:last-child")!;
          const w = word === null ? null : getComputedStyle(word);
          return {
            title: row.querySelector("[data-thread-title]")?.textContent ?? "",
            height: row.getBoundingClientRect().height,
            project: word?.textContent ?? null,
            text: row.querySelector("[data-thread-provenance]")?.textContent ?? "",
            mono: w === null ? null : /mono/i.test(w.fontFamily),
            size: w?.fontSize ?? null,
            metaSize: getComputedStyle(meta).fontSize,
            color: w?.color ?? null,
            openerColor: getComputedStyle(opener).color,
            background: w?.backgroundColor ?? null,
            cut: word === null ? false : word.scrollWidth > word.clientWidth,
          };
        });
      });
      const [pong, hi, ...rest] = read;
      expect(pong).toMatchObject({ project: "spoo", text: "·spoo·you", mono: true, cut: false, background: "rgba(0, 0, 0, 0)" });
      expect(hi).toMatchObject({ project: "wsp", text: "·wsp·cli", mono: true, cut: false });
      // The word wears the meta line's own size and colour: the grey the opener word wears, not a tone of its own.
      expect(pong!.size).toBe(pong!.metaSize);
      expect(pong!.color).toBe(pong!.openerColor);
      // Rows on the other workspaces carry no project and stand at the same height.
      expect(rest.some(r => r.project === null)).toBe(true);
      expect(new Set(read.map(r => Math.round(r.height))).size).toBe(1);
      const shot = join(SHOTS_DIR, `thread-rows-project-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: shot });
      console.info(`thread rows project word screenshot: ${shot}`);
    }
  }, 60_000);
});
