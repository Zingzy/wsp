// SPDX-License-Identifier: AGPL-3.0-only
// The three rules of round three, measured in a real Chromium at both allowed
// windows and in both themes, since jsdom lays nothing out: Settings takes the
// whole region right of the sidebar and hands the right panel back as it was;
// the Where agents run table gives its name column away rather than scrolling
// sideways; every value in the workspace pane ends 20 px from the panel's edge,
// clear of the scroll bar; and a side sheet is as tall as what it holds, top
// edge 16 px in, never past the window less 32 px. Runs only when asked for
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
const SHOTS = join(tmpdir(), "wsp-render");
/** The window's default and its smallest, the two the spec allows a judge to photograph. */
const WINDOWS = [
  { name: "1280 by 800", width: 1280, height: 800 },
  { name: "1024 by 700", width: 1024, height: 700 },
] as const;
/** The inset every pane row leaves at the right, which the 6 px scroll bar rides inside. */
const PANE_RIGHT_INSET = 20;

if (renderSkipped !== undefined) console.info(`settings region render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the settings region, the table and the pane", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    mkdirSync(SHOTS, { recursive: true });
  }, 60_000);
  afterAll(() => stopRender(browser, vite?.child));

  const open = async (window: { width: number; height: number }, query: string): Promise<Page> => {
    await page?.close();
    page = await browser!.newPage({ viewport: { width: window.width, height: window.height } });
    await page.goto(`${base}?${query}`);
    return page;
  };
  const box = async (selector: string) => page!.locator(selector).first().evaluate(el => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) };
  });
  /** Waits until a thing has stopped moving: a sheet slides in over 200 ms, and a rect read mid-slide is a race. */
  const settled = async (selector: string): Promise<void> => {
    // The last read is dropped first, so a fresh popup is never taken as settled on one poll.
    await page!.evaluate(() => delete (window as unknown as { __rect?: string }).__rect);
    await page!.waitForFunction(
      sel => {
        const el = document.querySelector(sel);
        if (el === null) return false;
        const held = window as unknown as { __rect?: string };
        const now = JSON.stringify(el.getBoundingClientRect());
        const same = held.__rect === now;
        held.__rect = now;
        return same;
      },
      selector,
      { polling: 100 },
    );
  };

  it.each(WINDOWS)("at $name Settings is the whole region right of the sidebar, and the panel comes back as it was", async window => {
    // The panel is open on the Machine tab before Settings is, which is the state the testers met.
    await open(window, "theme=dark&ws=ws_a&panel=machine&places=1&settings=1");
    await page!.waitForSelector("[data-k=places-table]");
    expect(await page!.locator("[data-preview-panel-mode]").count()).toBe(0);
    expect(await page!.locator("[data-right-panel-tabbar]").count()).toBe(0);
    const region = await page!.evaluate(() => {
      const centre = document.querySelector("[data-shell-center]")!.getBoundingClientRect();
      const sidebar = document.querySelector("[data-slot=sidebar-inner]")!.getBoundingClientRect();
      return { gap: Math.round(centre.x - sidebar.right), right: Math.round(centre.right), width: Math.round(centre.width), sidebar: Math.round(sidebar.width) };
    });
    // The centre starts where the sidebar ends, the sidebar's own hairline between them, and runs to the window's
    // edge: there is nothing else in the row.
    expect(region.gap).toBeLessThanOrEqual(1);
    expect(region.right).toBe(window.width);
    console.info(`settings region at ${window.name}: sidebar ${region.sidebar}, region ${region.width}`);
    // The chord closes Settings, and the panel is back on the tab it was on.
    await page!.keyboard.press("Meta+Comma");
    await page!.waitForSelector("[data-right-panel-tabbar]");
    expect(await page!.locator("[data-k=state]").count()).toBe(1);
  }, 60_000);

  it.each(WINDOWS.flatMap(w => (["dark", "light"] as const).map(theme => ({ ...w, theme }))))(
    "at $name in the $theme theme the table gives its name column away rather than scrolling sideways",
    async window => {
      await open(window, `theme=${window.theme}&ws=ws_a&panel=machine&places=1&settings=1`);
      await page!.waitForSelector("[data-k=places-table]");
      const scroll = await page!.locator("[data-k=places-table]").evaluate(el => {
        const container = el.closest("[data-slot=table-container]")!;
        return { scrollWidth: container.scrollWidth, clientWidth: container.clientWidth, table: Math.round(el.getBoundingClientRect().width) };
      });
      console.info(`table at ${window.name} ${window.theme}: ${scroll.table} px wide, scroll ${scroll.scrollWidth} in ${scroll.clientWidth}`);
      expect(scroll.scrollWidth).toBe(scroll.clientWidth);
      // The three fact columns and the menu stand at their content's width; the name column takes what is left.
      const columns = await page!.locator("[data-k=places-table] th").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().width)));
      const facts = columns.slice(1);
      // Squeezed to 480 px, the width the centre column used to be beside the panel, the fact columns do not move.
      await page!.locator("[data-settings-page]").evaluate(el => ((el as HTMLElement).style.maxWidth = "528px"));
      const narrowed = await page!.locator("[data-k=places-table] th").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().width)));
      const narrowScroll = await page!.locator("[data-k=places-table]").evaluate(el => {
        const container = el.closest("[data-slot=table-container]")!;
        const name = el.querySelector("tbody tr td span span")!;
        return { scrollWidth: container.scrollWidth, clientWidth: container.clientWidth, card: Math.round(container.parentElement!.getBoundingClientRect().width), table: Math.round(el.getBoundingClientRect().width), cut: name.scrollWidth > name.clientWidth };
      });
      console.info(`table squeezed: card ${narrowScroll.card} px, table ${narrowScroll.table} px, columns ${narrowed.join(", ")}`);
      // The card is the 480 px the centre column used to be beside the panel; the table is that less its hairlines.
      expect(narrowScroll.card).toBe(480);
      expect(narrowScroll.scrollWidth).toBe(narrowScroll.clientWidth);
      expect(narrowScroll.cut).toBe(true);
      expect(narrowed.slice(1)).toEqual(facts);
      expect(narrowed[0]!).toBeLessThan(columns[0]!);
      await page!.screenshot({ path: join(SHOTS, `settings-table-${window.width}-${window.theme}.png`) });
    },
    60_000,
  );

  it.each(["dark", "light"] as const)(
    "in the %s theme every row of the table is one height and the note behind a count is the muted ink",
    async theme => {
      // A row with a menu button used to stand 6 px taller than the row without one, which is the first thing a
      // person reads as wrong in a table of four rows.
      await open(WINDOWS[0], `theme=${theme}&ws=ws_a&panel=machine&places=1&settings=1`);
      await page!.waitForSelector("[data-k=places-table]");
      const rows = await page!.locator("[data-k=places-table] tbody tr").evaluateAll(els => els.map(el => ({ id: el.getAttribute("data-place-row"), height: el.getBoundingClientRect().height, cells: el.children.length })));
      console.info(`places rows in the ${theme} theme: ${rows.map(r => `${r.id} ${r.height} px in ${r.cells} cells`).join(", ")}`);
      expect(rows.length).toBeGreaterThan(2);
      expect(new Set(rows.map(r => Math.round(r.height))).size).toBe(1);
      // The head's own height, and every row carries the menu column whether or not it has a menu in it.
      expect(Math.round(rows[0]!.height)).toBe(Math.round(await page!.locator("[data-k=places-table] thead tr").evaluate(el => el.getBoundingClientRect().height)));
      expect(new Set(rows.map(r => r.cells)).size).toBe(1);
      // The count stands in the row's own ink and the clause behind it is muted, as the mock draws it.
      const inks = await page!.locator("[data-k=places-table] tbody [data-k=workspaces-note]").evaluateAll(els =>
        els.map(el => ({ note: getComputedStyle(el).color, count: getComputedStyle(el.parentElement!).color })),
      );
      console.info(`the note behind a count in the ${theme} theme: ${inks.map(i => `${i.note} on ${i.count}`).join(", ")}`);
      expect(inks.length).toBeGreaterThan(0);
      for (const ink of inks) expect(ink.note).not.toBe(ink.count);
      await page!.screenshot({ path: join(SHOTS, `settings-table-rows-${theme}.png`) });
    },
    60_000,
  );

  it.each(WINDOWS.flatMap(w => (["dark", "light"] as const).map(theme => ({ ...w, theme }))))(
    "at $name in the $theme theme every pane value ends 20 px from the panel's edge",
    async window => {
      await open(window, `theme=${window.theme}&ws=ws_a&panel=machine&places=1`);
      await page!.waitForSelector("[data-k=state]");
      const panel = await box("[data-preview-panel-mode]");
      const values = await page!.locator("[data-k=state], [data-k=where], [data-k=size], [data-k=machine-id]").evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().right)));
      console.info(`pane at ${window.name} ${window.theme}: panel right ${panel.right}, values end ${values.join(", ")}`);
      expect(values.length).toBeGreaterThan(2);
      for (const right of values) expect(panel.right - right).toBeGreaterThanOrEqual(PANE_RIGHT_INSET);
      // The rows' own box stops at the inset; the hairlines under them still run edge to edge.
      const section = await page!.locator("[data-k=state]").evaluate(el => {
        const row = el.closest("section")!;
        const b = row.getBoundingClientRect();
        return { right: Math.round(b.right), padding: getComputedStyle(row).paddingRight, left: getComputedStyle(row).paddingLeft };
      });
      expect(section.padding).toBe("20px");
      expect(section.left).toBe("12px");
      expect(section.right).toBe(panel.right);
      await page!.screenshot({ path: join(SHOTS, `pane-inset-${window.width}-${window.theme}.png`) });
    },
    60_000,
  );

  it("at a window too short for it the sheet stops at the cap and its body scrolls under a standing footer", async () => {
    // Shorter than the app allows, on purpose: it is the one window where the cap is reached at all, and the rule
    // is what happens there.
    const short = { name: "1024 by 420", width: 1024, height: 420 } as const;
    await open(short, "theme=dark&ws=ws_a&places=1&settings=1");
    await page!.waitForSelector("[data-k=add-computer-button]");
    await page!.click("[data-k=add-computer-button]");
    await page!.waitForSelector("[data-k=add-computer]");
    await page!.click("[data-segment=ssh]");
    await page!.waitForSelector("[data-k=login-field]");
    await settled("[data-slot=sheet-popup]");
    const popup = await box("[data-slot=sheet-popup]");
    const footer = await box("[data-slot=sheet-popup] [data-slot=sheet-footer]");
    console.info(`the ssh sheet at ${short.name}: ${popup.w} by ${popup.h}, cap ${short.height - 32}, footer ends ${footer.bottom}`);
    expect(popup.h).toBe(short.height - 32);
    // The footer is in view, not past the window's floor.
    expect(footer.bottom).toBeLessThanOrEqual(short.height);
    const body = await page!.locator("[data-slot=sheet-popup] [data-slot=scroll-area-viewport]").evaluate(el => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    console.info(`its body: ${body.scrollHeight} of content in ${body.clientHeight}`);
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
    // The last line of the plan is reachable: scrolled to the end, it stands inside the body's own box.
    const reached = await page!.locator("[data-slot=sheet-popup] [data-slot=scroll-area-viewport]").evaluate(el => {
      el.scrollTop = el.scrollHeight;
      const lines = el.querySelectorAll("[data-k=plan] [data-k=line]");
      const last = lines[lines.length - 1]!.getBoundingClientRect();
      const view = el.getBoundingClientRect();
      return { lines: lines.length, inside: last.top >= view.top - 1 && last.bottom <= view.bottom + 1, word: lines[lines.length - 1]!.textContent };
    });
    console.info(`scrolled to the end: ${reached.lines} lines, the last one ${reached.word}`);
    expect(reached.lines).toBe(5);
    expect(reached.inside).toBe(true);
    await page!.screenshot({ path: join(SHOTS, "sheet-capped-1024x420.png") });
  }, 60_000);

  it.each(WINDOWS)("at $name a side sheet is as tall as what it holds, inset 16 px, and never past the window less 32", async window => {
    await open(window, "theme=dark&ws=ws_a&places=1&settings=1");
    const measure = async (name: string) => {
      await settled("[data-slot=sheet-popup]");
      const popup = await box("[data-slot=sheet-popup]");
      const footer = await box("[data-slot=sheet-popup] [data-slot=sheet-footer]");
      console.info(`${name} at ${window.name}: ${popup.w} by ${popup.h}, top ${popup.y}, right inset ${window.width - popup.right}`);
      expect(popup.w).toBe(448);
      expect(popup.y).toBe(16);
      expect(window.width - popup.right).toBe(16);
      // The footer's own bottom is the sheet's, less the popup's hairline: no stretch under it.
      expect(popup.bottom - footer.bottom).toBeLessThanOrEqual(1);
      expect(popup.h).toBeLessThanOrEqual(window.height - 32);
      return popup.h;
    };
    await page!.waitForSelector("[data-k=add-computer-button]");
    await page!.click("[data-k=add-computer-button]");
    await page!.waitForSelector("[data-k=add-computer]");
    await measure("add a computer, the app road");
    await page!.click("[data-segment=ssh]");
    await page!.waitForSelector("[data-k=login-field]");
    const ssh = await measure("add a computer, the ssh road with its plan");
    // The plan stands before Add is pressed, so the space holds the answer to what this does to that box.
    expect(await page!.locator("[data-k=plan] [data-k=line]").count()).toBe(5);
    await page!.screenshot({ path: join(SHOTS, `sheet-ssh-${window.width}.png`) });
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[data-k=add-computer]", { state: "detached" });
    await page!.click("[data-k=connect-provider]");
    await page!.waitForSelector("[data-connect-provider-sheet]");
    await measure("connect a provider, the pick");
    await page!.click("[data-k=continue]");
    await page!.waitForSelector("#connect-provider-key");
    const key = await measure("connect a provider, the key");
    await page!.screenshot({ path: join(SHOTS, `sheet-key-${window.width}.png`) });
    // A sheet of one field is nowhere near the cap: the height is the content's, not the window's, and it is the
    // shortest of them, where the old rule made every one of them the window's height.
    expect(key).toBeLessThan(ssh);
    expect(key).toBeLessThan(400);
  }, 90_000);
});
