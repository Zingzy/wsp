// SPDX-License-Identifier: AGPL-3.0-only
// The composer's project pick and the thread rows' project word in a real
// Chromium: the pick sits in the footer beside the access pick at the same
// height, reads the record's last project for the workspace in muted mono,
// its menu lists the workspace's projects and other folder, the line under
// the box names the folder that project lands in, and each thread row's
// second line carries the project its folder sits in beside the agent's
// mark, in the meta line's muted mono, every row one height whether or not
// it has one; photographed in both themes. Then the roads a project takes onto
// a workspace: every workspace row a dotted drop tile in the row's muted mono
// while a folder is dragged over the window, the import dialog a drop on a box
// opens with the plan read and one Import button, and the Machine tab's
// PROJECTS section with two projects and with none, its rows one height in
// mono with no chip. Vite serves test/shell to
// Playwright's browser, so like the shell layout test it runs only when asked
// for (WSP_RENDER=1) and skips without Playwright's Chromium on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { fmtBytes } from "@wsp/protocol";
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

  it("while a folder is dragged over the window every workspace row is a dotted drop tile at the row's height in the meta line's mono, a box saying import to it and this computer saying register, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&local=1&drop=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      // The drag is a window event the page holds as one flag; the fixture puts the bridge on the page and the test drags.
      await page!.evaluate(() => {
        const transfer = { types: ["Files"], items: [{ kind: "file", type: "" }] };
        window.dispatchEvent(Object.assign(new Event("dragenter", { bubbles: true, cancelable: true }), { dataTransfer: transfer }));
      });
      await page!.waitForSelector("[data-drop-tile]");
      const read = await page!.locator("[data-slot=sidebar]").first().evaluate(el => {
        const tiles = [...el.querySelectorAll<HTMLElement>("[data-drop-tile]")];
        const meta = el.querySelector<HTMLElement>("[data-thread-meta]");
        return {
          words: tiles.map(t => t.textContent),
          heights: tiles.map(t => Math.round(t.getBoundingClientRect().height)),
          skins: tiles.map(t => {
            const s = getComputedStyle(t);
            return { border: s.borderTopStyle, mono: /mono/i.test(s.fontFamily), size: s.fontSize, color: s.color, background: s.backgroundColor };
          }),
          metaSize: meta === null ? null : getComputedStyle(meta).fontSize,
          metaColor: meta === null ? null : getComputedStyle(meta).color,
          rows: [...el.querySelectorAll<HTMLElement>("[data-sidebar-row]:not([data-drop-tile])")].filter(r => (r.dataset["rowId"] ?? "").startsWith("ws:")).length,
        };
      });
      // The gone workspace's import is refused, so its row stays a row rather than offering a drop that cannot land.
      expect(read.words).toEqual(["import to api", "register on this computer", "import to web"]);
      expect(new Set(read.heights).size).toBe(1);
      expect(read.heights[0]).toBe(60);
      for (const skin of read.skins) {
        expect(skin.border).toBe("dashed");
        expect(skin.mono).toBe(true);
        expect(skin.size).toBe(read.metaSize);
        expect(skin.color).toBe(read.metaColor);
        expect(skin.background).toBe("rgba(0, 0, 0, 0)");
      }
      // The tile is the row while the drag lasts; the one row left is the gone workspace's.
      expect(read.rows).toBe(1);
      const shot = join(SHOTS_DIR, `drop-tiles-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: shot });
      console.info(`drop tiles screenshot: ${shot}`);
    }
  }, 60_000);

  it("a drop on a box opens the import dialog on that folder with the plan read, size, files, caches left behind and the secret-shaped rows, and one Import button, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&import=1`);
      const dialog = page!.locator("[role=dialog]");
      await dialog.waitFor();
      await page!.waitForSelector("[data-k='files']:not(:empty)");
      const read = await dialog.evaluate(el => ({
        title: el.querySelector("h2")?.textContent ?? "",
        folder: el.querySelector<HTMLElement>("[data-k='folder'] [data-k='path'], [data-k='folder'] input")?.textContent || (el.querySelector<HTMLInputElement>("input")?.value ?? ""),
        files: el.querySelector("[data-k='files']")?.textContent ?? "",
        caches: el.querySelector("[data-k='caches']")?.textContent ?? "",
        secrets: [...el.querySelectorAll<HTMLElement>("[data-k='offer']")].map(o => o.textContent),
        buttons: [...el.querySelectorAll<HTMLButtonElement>("button")].map(b => b.textContent?.trim()).filter(t => t !== "" && t !== undefined),
      }));
      expect(read.title).toBe("Import a project");
      expect(read.folder).toContain("/Users/dev/spoo");
      expect(read.files).toBe(`412 files · ${fmtBytes(48_200_000)}`);
      expect(read.caches).toContain("2 folders");
      expect(read.secrets).toEqual(["left out", "rewritten without keys"]);
      expect(read.buttons.filter(b => b === "Import")).toHaveLength(1);
      const shot = join(SHOTS_DIR, `import-dialog-${theme}.png`);
      await dialog.screenshot({ path: shot });
      console.info(`import dialog screenshot: ${shot}`);
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
