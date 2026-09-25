// SPDX-License-Identifier: AGPL-3.0-only
// The Agents, Skills and Servers list in a real Chromium, since jsdom lays
// nothing out, at the widths the design measured: the page's card (696), the
// switch's edge (675), a phone's page (358), the panel (380) and its floor
// (360). Above a 672 px container every row of every segment stands at 96 px
// on one chip line; under it at 80 px, the chip line the container less its
// padding (324, 348, 328) and never a second line, the slot clear of the
// title, and the disclosure a real box that Tab reaches row by row with its
// ring drawn. Open lines stand at 44 and 56. Then the real right panel on the
// task on the box, and both photographed in both themes. Vite serves
// test/wireframe, so like the other render tests it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
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
/** Each width with the row height it takes and, under the switch, the chip line's width the design measured. */
const WIDTHS = [
  { width: 696, row: 96, chipLine: null },
  { width: 675, row: 96, chipLine: null },
  { width: 358, row: 80, chipLine: 324 },
  { width: 380, row: 80, chipLine: 348 },
  { width: 360, row: 80, chipLine: 328 },
] as const;
const SEGMENTS = ["Agents", "Skills", "Servers"] as const;

interface RowRead {
  id: string;
  row: number;
  chipsHeight: number;
  chipsWidth: number;
  chipsTop: number;
  chipTops: number[];
  trigger: { w: number; h: number };
  titleRight: number;
  slotLeft: number;
  slotTop: number;
  slotBottom: number;
  titleTop: number;
  titleBottom: number;
}

if (renderSkipped !== undefined) console.info(`agents layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the agents list laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const open = async (query: string, viewport = { width: 900, height: 4200 }): Promise<Page> => {
    await page?.close();
    // The system's side matches the one the query names, since a settings screen follows the system's.
    page = await browser!.newPage({ viewport, colorScheme: query.includes("theme=light") ? "light" : "dark" });
    await page.addInitScript(() => window.localStorage.clear());
    await page.goto(`${base}?${query}`);
    return page;
  };

  const readRows = (width: number): Promise<RowRead[]> =>
    page!.locator(`[data-agents-width="${width}"] [data-agents-row]`).evaluateAll(rows =>
      rows.map(row => {
        const box = (el: Element | null) => el?.getBoundingClientRect() ?? new DOMRect();
        const chips = row.querySelector("[data-row-chips]")!;
        const title = row.querySelector("[data-row-title]")!;
        const slot = row.querySelector("[data-row-slot]")!;
        const trigger = row.querySelector("[data-row-trigger]")!;
        const visible = [...chips.querySelectorAll("[data-chip]")].filter(c => getComputedStyle(c).display !== "none");
        return {
          id: (row as HTMLElement).dataset["agentsRow"] ?? "",
          row: Math.round(box(row.querySelector("[data-row-box]")).height * 10) / 10,
          chipsHeight: Math.round(box(chips).height),
          chipsWidth: Math.round(box(chips).width),
          chipsTop: Math.round(box(chips).top),
          chipTops: visible.map(c => Math.round(box(c).top)),
          trigger: { w: Math.round(box(trigger).width), h: Math.round(box(trigger).height) },
          titleRight: Math.round(box(title).right),
          slotLeft: Math.round(box(slot).left),
          slotTop: Math.round(box(slot).top),
          slotBottom: Math.round(box(slot).bottom),
          titleTop: Math.round(box(title).top),
          titleBottom: Math.round(box(title).bottom),
        };
      }),
    );

  it("stands every row of every segment at one height per width, the chips on one line, the slot clear of the title", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const w of WIDTHS) {
      for (const segment of SEGMENTS) {
        await page!.locator(`[data-agents-width="${w.width}"] [data-segment]`).filter({ hasText: new RegExp(`^${segment}`) }).click();
        const rows = await readRows(w.width);
        console.info(`agents ${w.width} ${segment}: ${rows.map(r => `${r.id} ${r.row}/${r.chipsWidth}`).join(", ")}`);
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          expect(r.row, `${w.width} ${r.id}`).toBe(w.row);
          // One chip line: 24 px tall, every chip on it.
          expect(r.chipsHeight, `${w.width} ${r.id}`).toBe(24);
          for (const top of r.chipTops) expect(top).toBe(r.chipsTop);
          if (w.chipLine !== null) {
            expect(r.chipsWidth, `${w.width} ${r.id}`).toBe(w.chipLine);
            // The slot stands on the title line, centred on it, and the title stops short of it.
            expect(r.titleRight).toBeLessThanOrEqual(r.slotLeft);
            expect(Math.abs((r.slotTop + r.slotBottom) / 2 - (r.titleTop + r.titleBottom) / 2)).toBeLessThanOrEqual(1);
            // A real box for the disclosure, the title line over the chip line.
            expect(r.trigger.w).toBe(w.chipLine);
            expect(r.trigger.h).toBe(52);
          } else {
            expect(r.titleRight).toBeLessThanOrEqual(r.slotLeft);
            expect(r.trigger.h).toBeGreaterThan(40);
          }
        }
      }
    }
  }, 120_000);

  it("draws the two chips of each kind at two lines and three on the page, in their order", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    const chipsAt = (width: number, id: string) =>
      page!.locator(`[data-agents-width="${width}"] [data-agents-row="${id}"] [data-chip]`).evaluateAll(els => els.filter(el => getComputedStyle(el).display !== "none").map(el => el.textContent));
    expect(await chipsAt(696, "agent-claude")).toEqual(["2.1.281", "wsp tools", "recipe"]);
    expect(await chipsAt(360, "agent-claude")).toEqual(["2.1.281", "wsp tools"]);
  });

  it("lets Tab reach every row's disclosure at the panel's floor with its ring drawn, and opens the row on Enter", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    const triggers = page!.locator('[data-agents-width="360"] [data-row-trigger]');
    const count = await triggers.count();
    await page!.locator('[data-agents-width="360"] [data-k=agents-read-again]').focus();
    const reached: string[] = [];
    for (let i = 0; i < count + 2 && reached.length < count; i++) {
      await page!.keyboard.press("Tab");
      const focused = await page!.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (el?.dataset["rowTrigger"] === undefined) return null;
        const b = el.getBoundingClientRect();
        const ring = getComputedStyle(el, "::before").boxShadow;
        return { id: el.closest<HTMLElement>("[data-agents-row]")?.dataset["agentsRow"] ?? "", w: b.width, h: b.height, ring, visible: el.matches(":focus-visible") };
      });
      if (focused === null) continue;
      expect(focused.w).toBeGreaterThan(0);
      expect(focused.h).toBeGreaterThan(0);
      expect(focused.visible).toBe(true);
      expect(focused.ring).not.toBe("none");
      reached.push(focused.id);
    }
    expect(reached).toHaveLength(count);
    await page!.keyboard.press("Enter");
    const opened = page!.locator('[data-agents-width="360"] [data-agents-row][data-open="true"]');
    expect(await opened.count()).toBe(1);
  });

  it("opens a row from its chevron, which lets the pointer through to the disclosure, and not from the slot's button", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const width of [696, 360]) {
      const row = page!.locator(`[data-agents-width="${width}"] [data-agents-row="agent-opencode"]`);
      const chevron = (await row.locator("[data-row-slot] svg").boundingBox())!;
      await page!.mouse.click(chevron.x + chevron.width / 2, chevron.y + chevron.height / 2);
      expect(await row.getAttribute("data-open")).toBe("true");
      const codex = page!.locator(`[data-agents-width="${width}"] [data-agents-row="agent-codex"]`);
      await codex.locator("[data-row-slot] [data-k=act-sign-in]").click({ force: true });
      expect(await codex.getAttribute("data-open")).toBe("false");
    }
  });

  it("stands the open row's lines at 44 on the page and 56 at two lines", async () => {
    await open("screen=agents-widths&theme=dark");
    await page!.waitForSelector("[data-agents-row]");
    for (const [width, height] of [
      [696, 44],
      [360, 56],
    ] as const) {
      await page!.locator(`[data-agents-width="${width}"] [data-agents-row="agent-claude"] [data-row-trigger]`).click();
      const heights = await page!.locator(`[data-agents-width="${width}"] [data-agents-row="agent-claude"] [data-open-line]`).evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
      expect(heights.length).toBe(4);
      for (const h of heights) expect(h).toBe(height);
    }
  });

  it("lists a server's tools under its open row on the page and at the panel's floor, the lines held to two, and photographs both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=settings-computer&theme=${theme}`, { width: 1280, height: 1800 });
      const card = page!.locator("[data-settings-card='agents']");
      await card.locator("[data-agents-row]").first().waitFor();
      await card.locator("[data-segment]").filter({ hasText: /^Servers/ }).click();
      for (const name of ["airtable", "github"]) {
        const row = card.locator(`[data-agents-row$="-${name}"]`);
        await row.locator("[data-row-trigger]").click();
        await row.locator("[data-k=act-list-tools]").click();
        await row.locator("[data-k=server-tools]").waitFor();
      }
      const airtable = card.locator('[data-agents-row$="-airtable"]');
      expect(await airtable.locator("[data-k=server-tools-count]").textContent()).toBe("3 tools");
      // A description clamps at two 16 px lines; a name stands on one.
      const heights = await airtable.locator("[data-tool] > span").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
      expect(Math.max(...heights)).toBeLessThanOrEqual(32);
      expect(await card.locator('[data-agents-row$="-github"] [data-k=server-tools-refused]').textContent()).toBe("Did not answer in 20 s.");
      expect(await card.locator('[data-agents-row$="-github"] [data-row-word]').textContent()).toBe("failed");
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      await card.screenshot({ path: join(SHOTS_DIR, `agents-tools-page-${theme}.png`) });
      // The panel's floor: the tools stand inside the row at 360.
      await open(`screen=agents-widths&theme=${theme}`);
      const panel = page!.locator('[data-agents-width="360"]');
      await panel.locator("[data-agents-row]").first().waitFor();
      await panel.locator("[data-segment]").filter({ hasText: /^Servers/ }).click();
      const row = panel.locator('[data-agents-row$="-airtable"]');
      await row.locator("[data-row-trigger]").click();
      await row.locator("[data-k=act-list-tools]").click();
      await row.locator("[data-tool]").first().waitFor();
      const within = await row.evaluate(el => {
        const r = el.getBoundingClientRect();
        return [...el.querySelectorAll("[data-tool] span")].every(s => s.getBoundingClientRect().right <= r.right + 0.5);
      });
      expect(within).toBe(true);
      await panel.screenshot({ path: join(SHOTS_DIR, `agents-tools-panel-${theme}.png`) });
    }
  }, 120_000);

  it("draws a device sign-in, a pasted answer and a token's paste inside their rows on the page, and photographs both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=settings-computer&theme=${theme}`, { width: 1280, height: 2400 });
      const card = page!.locator("[data-settings-card='agents']");
      await card.locator("[data-agents-row]").first().waitFor();
      const codex = card.locator('[data-agents-row="agent-codex"]');
      await codex.locator("[data-row-slot] [data-k=act-sign-in]").click();
      await codex.locator("[data-k=sign-in-code]").waitFor();
      expect(await codex.locator("[data-row-word]").textContent()).toBe("waiting on you");
      // The two lines stand at 40 px each, reserved from the press.
      const lines = await codex.locator("[data-sign-in-line]").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
      expect(lines).toEqual([40, 40]);
      const claude = card.locator('[data-agents-row="agent-claude"]');
      await claude.locator("[data-row-trigger]").click();
      await claude.locator("[data-row-region] [data-k=act-sign-in]").click();
      await claude.locator("[data-k=sign-in-key]").fill("sk-ant-api03-nope");
      await claude.locator("[data-k=sign-in-save]").click();
      await claude.locator("[data-k=sign-in-refused]").filter({ hasText: "That is not a Claude Code token." }).waitFor();
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      await card.screenshot({ path: join(SHOTS_DIR, `agents-signin-page-${theme}.png`) });
      await card.locator("[data-segment]").filter({ hasText: /^Servers/ }).click();
      const linear = card.locator('[data-agents-row$="-linear"]');
      await linear.locator("[data-row-slot] [data-k=act-sign-in]").click();
      await linear.locator("[data-k=code-field]").waitFor();
      await card.screenshot({ path: join(SHOTS_DIR, `agents-signin-server-${theme}.png`) });
    }
  }, 120_000);

  it("photographs the list at every width and the task's panel on Agents, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(`screen=agents-widths&theme=${theme}`);
      await page!.waitForSelector("[data-agents-row]");
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-widths-${theme}.png`), fullPage: true });
      await open(`screen=panel-agents&theme=${theme}`, { width: 1280, height: 800 });
      await page!.waitForSelector("[data-k=agents-surface] [data-agents-row]");
      const list = await page!.locator("[data-k=agents-surface] [data-agents-list]").evaluate(el => Math.round(el.getBoundingClientRect().width));
      const rows = await page!.locator("[data-k=agents-surface] [data-row-box]").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
      console.info(`panel agents ${theme}: list ${list}, rows ${rows.join(", ")}`);
      expect(list).toBeLessThan(672);
      for (const h of rows) expect(h).toBe(80);
      expect(await page!.locator("[data-k=agents-computer]").textContent()).toBe("spoo");
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-panel-${theme}.png`) });
      await open(`screen=settings-computer&theme=${theme}`, { width: 1280, height: 1800 });
      await page!.waitForSelector("[data-settings-card='agents'] [data-agents-row]");
      // The settings screens follow the system's side, so the shot is only of the theme it names once asserted.
      expect(await page!.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(theme === "dark");
      const pageRows = await page!.locator("[data-settings-card='agents'] [data-row-box]").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().height)));
      for (const h of pageRows) expect(h).toBe(96);
      await page!.screenshot({ path: join(SHOTS_DIR, `agents-page-${theme}.png`), fullPage: true });
    }
  }, 120_000);
});
