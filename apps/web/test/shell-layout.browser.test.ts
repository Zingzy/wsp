// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar toggle starts where the
// search row does and the brand lockup one gap after it, the search row is a
// plain row that opens the palette without moving a row, a thread tile's
// title keeps its room at the default width with the agent's 12 px mark on
// row two and the status on row one, every tile 52 px, a working title
// recedes behind the rows that call for the person, the Settled fold sits shut
// at the foot of the bare list and opens to slim rows, a toast holds a
// long token inside its box off the sidebar, the line for a provider out of
// reach is one muted mono line under the search row at AA, collapsing the
// sidebar leaves the page header's left padding alone, a send refusal above
// the composer is one muted mono line in a slot the composer keeps at one
// height whether or not a line is in it, images pasted into the composer are
// one row of square thumbnails above the text inside the box, each with its
// own remove, a right-click on a tile opens the in-app menu at the pointer in
// the tooltip skin, inside the viewport, Rename turns a thread tile's title
// into a field in the same row at the same tile height, and the switch chord
// held down puts the workspace switcher up, its cards three parts each,
// without moving the shell under it. Vite serves test/shell to Playwright's
// browser, so like the glyph test it runs only when asked for (WSP_RENDER=1)
// and skips without Playwright's Chromium on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, ConsoleMessage, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCESS_REFUSED_LINE, accessReachLine, contrastRatio, DEFAULT_THEME, dotColour, effectiveOpacity, FREE_WORD, INK_FLOOR, sendRefusal, SIDE_INK, THEME_PRESETS, themeInk, themeScheme, type Rgb } from "@wsp/protocol";
import { WAKE_AND_SEND_LABEL } from "../src/components/chat/ComposerPrimaryActions";
import { LOCKUP_OPTICAL_CENTRE } from "../src/brand/optical";
import { textContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
/** What React says when one body is drawn as both panes. The case that watches for it wants this line and not
 * whatever else a browser puts on the console. */
const DUPLICATE_KEY = "two children with the same key";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (renderSkipped !== undefined) console.info(`shell layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the shell's chrome laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    // Each case starts the page as a first visit: what one case selects or opens is not the next one's memory.
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  async function open(theme: "dark" | "light"): Promise<void> {
    await page!.goto(`${base}?theme=${theme}`);
    await page!.waitForSelector("[data-sidebar-row]");
  }
  const rowGap = (selector: string): Promise<number> => page!.locator(selector).first().evaluate(el => parseFloat(getComputedStyle(el).columnGap));
  const box = async (selector: string): Promise<Box> => {
    const b = await page!.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} has no box`);
    return b;
  };
  /** Several boxes read in one frame once every finite animation on the page has run out, so a glide in flight
   * between two reads cannot put them out of step. Spinners run forever and are left out. */
  const settledBoxes = <const S extends readonly string[]>(selectors: S): Promise<{ [K in keyof S]: Box }> =>
    page!.evaluate(async (sels: readonly string[]) => {
      const frame = (): Promise<unknown> => new Promise(done => requestAnimationFrame(done));
      for (;;) {
        await frame();
        await frame();
        const running = document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity);
        if (running.length === 0) break;
        await Promise.all(running.map(a => a.finished.catch(() => undefined)));
      }
      return sels.map(sel => {
        const el = document.querySelector(sel);
        if (el === null) throw new Error(`${sel} has no box`);
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    }, selectors) as Promise<{ [K in keyof S]: Box }>;

  it("the sidebar toggle starts where the search row does and the brand lockup one gap after it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const toggle = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
      const lockup = await box("[data-slot=sidebar-header] [role=img][aria-label=wsp]");
      const search = await box("button[aria-label='Search']");
      expect(Math.abs(toggle.x - search.x)).toBeLessThan(1);
      expect(Math.abs(lockup.x - (toggle.x + toggle.width + (await rowGap("[data-slot=sidebar-header]"))))).toBeLessThan(1);
      // One vertical centre: the toggle glyph's ink (its icon box, whose panel fills it edge to edge) and the wordmark's optical centre.
      const glyph = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger] svg");
      expect(Math.abs(glyph.y + glyph.height / 2 - (lockup.y + lockup.height * LOCKUP_OPTICAL_CENTRE))).toBeLessThan(0.5);
      const path = join(SHOTS_DIR, `sidebar-header-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar header screenshot: ${path}`);
    }
  }, 30_000);

  it("in the desktop window a translucent Ghostty config opens a hole under the terminal canvas alone: the tab strip keeps the Browser tab's background, in dark the centre's share moves off the column onto the thread and its header, every layer under the canvas is clear and the canvas backing carries the file's alpha, in both themes", async () => {
    // What an element sits on: the first painted background walking up from it, or "none" when the window shows through.
    const backdrops = () =>
      page!.evaluate(() => {
        const on = (selector: string): string => {
          for (let n: Element | null = document.querySelector(selector)!; n !== null; n = n.parentElement) {
            const c = getComputedStyle(n).backgroundColor;
            if (c !== "rgba(0, 0, 0, 0)") return c;
          }
          return "none";
        };
        return {
          strip: on("[data-right-panel-tabbar]"),
          centre: on("[data-shell-center]"),
          header: on("[data-shell-center] > header"),
          beside: on("[data-terminal-beside]"),
          canvas: on("[data-terminal-viewport] canvas"),
        };
      });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a&mac=1&panel=terminal`);
      await page!.waitForSelector("[data-terminal-translucent] canvas");
      const terminal = await backdrops();
      // The corner pixel of the canvas backing: the theme's background at the file's alpha, so the material behind shows through it.
      const alpha = await page!.locator("[data-terminal-viewport] canvas").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(2, 2, 1, 1).data[3]!);
      expect(Math.abs(alpha - Math.round(0.85 * 255))).toBeLessThanOrEqual(2);
      expect(terminal.canvas).toBe("none");
      expect(await page!.locator("[data-right-panel-tab-list] [data-active-tab]").count()).toBe(2);
      await page!.locator("[data-right-panel-tab-list] [data-active-tab='false'] button:has(> span.truncate)").click();
      await page!.waitForSelector("[data-terminal-viewport]", { state: "detached" });
      const browser = await backdrops();
      expect(browser.strip).not.toBe("none");
      // The strip wears the panel's share and the centre its own; in dark mode on the Mac those differ on purpose.
      expect(terminal.strip).toBe(browser.strip);
      if (theme === "dark") {
        // In dark the glass shows through the canvas, so the centre column paints nothing and the thread and its header carry its share.
        expect(terminal.centre).toBe("none");
        expect(browser.centre).not.toBe("none");
        expect(terminal.header).toBe(browser.centre);
        expect(terminal.beside).toBe(browser.centre);
      } else {
        expect(terminal.centre).toBe(browser.centre);
      }
      await page!.locator("[data-right-panel-tab-list] [data-active-tab='false'] button:has(> span.truncate)").click();
      await page!.waitForSelector("[data-terminal-viewport] canvas");
      const path = join(SHOTS_DIR, `terminal-pane-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`terminal pane screenshot: ${path}`);
    }
  }, 60_000);

  it("in the desktop window the terminal draws at the app's own text size over a file saying 16, and at the file's 16 once the record says the size comes from the file", async () => {
    const read = async (query: string) => {
      await page!.goto(`${base}?theme=dark&ws=ws_a&mac=1&panel=terminal${query}`);
      await page!.waitForSelector("[data-terminal-translucent] canvas");
      await page!.waitForFunction(() => (window as unknown as { surfaces: unknown[] }).surfaces.length > 0);
      return page!.evaluate(() => {
        const [surface] = (window as unknown as { surfaces: { textSize: number; cellHeight: number }[] }).surfaces;
        const app = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--font-size-terminal"));
        return { textSize: surface!.textSize, cellHeight: surface!.cellHeight, app };
      });
    };
    const fromApp = await read("");
    console.info(`terminal size with the app as the source: ${JSON.stringify(fromApp)}`);
    expect(fromApp.textSize).toBe(fromApp.app);
    const fromFile = await read("&size=file");
    console.info(`terminal size with the file as the source: ${JSON.stringify(fromFile)}`);
    expect(fromFile.textSize).toBe(16);
    // The cells grow with the text: the file's 16 over the app's 14 is two pixels of text and at least that of cell.
    expect(fromFile.cellHeight - fromApp.cellHeight).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("holding the switch chord puts the switcher up over the shell, one card per workspace of three parts, and the highlight moves nothing", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&shell=desktop`);
      await page!.waitForSelector("[data-sidebar-row]");
      const sidebar = await box("[data-slot=sidebar]");
      await page!.keyboard.down("Control");
      await page!.keyboard.press("Tab");
      await page!.waitForSelector("[data-workspace-switcher]");
      const cards = page!.locator("[data-workspace-card]");
      expect(await cards.count()).toBe(3);
      const boxes = await cards.evaluateAll(els => els.map(el => JSON.stringify(el.getBoundingClientRect().toJSON())));
      expect(new Set(await cards.evaluateAll(els => els.map(el => el.getBoundingClientRect().height))).size).toBe(1);
      // Three parts, in one order, on every card: the well, the name in sans, the thread's title in muted mono.
      const parts = await cards.evaluateAll(els =>
        els.map(el =>
          [...el.children].map(child => child.getAttributeNames().find(name => name.startsWith("data-card-"))?.slice("data-card-".length) ?? "?").join(","),
        ),
      );
      expect(parts).toEqual(["preview,name,thread", "preview,name,thread", "preview,name,thread"]);
      const fonts = await cards.evaluateAll(els =>
        els.map(el => {
          const mono = (part: string): boolean => /mono/i.test(getComputedStyle(el.querySelector(`[data-card-${part}]`)!).fontFamily);
          return { name: mono("name"), thread: mono("thread") };
        }),
      );
      expect(fonts).toEqual([...Array(3)].map(() => ({ name: false, thread: true })));
      // No cost, no state word and no open word on any card: the state is read off the preview and the sidebar.
      for (const text of await cards.evaluateAll(els => els.map(el => el.textContent ?? ""))) expect(text).not.toMatch(/\$|Running|Paused|Gone|open/);
      expect(await page!.locator("[data-workspace-card][aria-selected=true]").getAttribute("data-workspace-card")).toBe("ws_b");
      // No card here has a picture yet, so every well is the empty one. Its fill cannot hold an edge on a
      // light card (1.02 against the white under it), so the hairline is what says where the box is, and
      // it has to be there on both surfaces.
      const wells = await page!.locator("[data-card-preview]").evaluateAll(els =>
        els.map(el => {
          const shadows = getComputedStyle(el).boxShadow.match(/((?:rgba?|color|oklch|oklab)\([^)]*\))/g) ?? [];
          return { empty: el.hasAttribute("data-card-preview-empty"), rings: shadows.filter(c => !/[,/]\s*0\)$/.test(c)).length };
        }),
      );
      expect(wells).toHaveLength(3);
      for (const well of wells) {
        expect(well.empty, `a card's well is not the empty one in ${theme}`).toBe(true);
        expect(well.rings, `the empty well carries no hairline in ${theme}`).toBeGreaterThan(0);
      }
      await page!.screenshot({ path: join(SHOTS_DIR, `workspace-switcher-${theme}.png`) });
      console.info(`workspace switcher screenshot: ${join(SHOTS_DIR, `workspace-switcher-${theme}.png`)}`);
      await page!.keyboard.press("Tab");
      await page!.waitForFunction(() => document.querySelector("[data-workspace-card][aria-selected=true]")?.getAttribute("data-workspace-card") === "ws_c");
      expect(await cards.evaluateAll(els => els.map(el => JSON.stringify(el.getBoundingClientRect().toJSON())))).toEqual(boxes);
      expect(await box("[data-slot=sidebar]")).toEqual(sidebar);
      await page!.keyboard.up("Control");
      await page!.waitForSelector("[data-workspace-switcher]", { state: "detached" });
    }
  }, 60_000);

  it("a thread tile keeps twelve characters of a long title at the default width, the agent's 12 px mark on row two and the status on row one, every tile 52 px", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const rows = await page!.locator("[data-row-id^='thread:']").evaluateAll(els =>
        els.map(el => {
          const title = el.querySelector<HTMLElement>("[data-thread-title]")!;
          const mark = el.querySelector<HTMLElement>("[data-harness-mark]")!;
          const slot = el.querySelector<HTMLElement>("[data-thread-status]")!;
          const font = getComputedStyle(title);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          const markBox = mark.getBoundingClientRect();
          const paint = getComputedStyle(mark);
          return {
            height: el.getBoundingClientRect().height,
            titleWidth: title.clientWidth,
            twelveChars: ctx.measureText((title.textContent ?? "").slice(0, 12)).width,
            titleSize: font.fontSize,
            slot: slot.textContent ?? "",
            slotClipped: slot.scrollWidth > slot.clientWidth,
            slotRow: slot.parentElement === el.children[0],
            markRow: mark.closest("[data-sidebar-row] > span") === el.children[1],
            hover: el.hasAttribute("title"),
            mark: mark.getAttribute("data-harness-mark"),
            markSize: [markBox.width, markBox.height],
            markColor: paint.color,
            bare: paint.backgroundColor === "rgba(0, 0, 0, 0)" && paint.borderTopWidth === "0px" && paint.boxShadow === "none",
          };
        }),
      );
      console.info(`thread tiles at ${theme}: ${JSON.stringify(rows)}`);
      expect(rows.map(r => r.mark)).toEqual(["claude", "claude", "codex", "claude"]);
      for (const row of rows) {
        // The card to the right says what the tile does not; the tile keeps no native hover text.
        expect(row.hover).toBe(false);
        expect(row.height).toBe(52);
        expect(row.titleSize).toBe("14px");
        expect(row.titleWidth).toBeGreaterThanOrEqual(row.twelveChars);
        expect(row.slotClipped).toBe(false);
        expect(row.slotRow).toBe(true);
        expect(row.markRow).toBe(true);
        expect(row.markSize).toEqual([12, 12]);
        expect(row.bare).toBe(true);
      }
      expect(rows.some(row => /^\d+[smh]/.test(row.slot))).toBe(true);
      // Claude's mark is its terracotta; OpenAI's is monochrome by design, so it takes the row's ink.
      const colours = new Map(rows.map(r => [r.mark, r.markColor]));
      expect(colours.size).toBe(2);
      expect(colours.get("claude")).not.toBe(colours.get("codex"));
      const path = join(SHOTS_DIR, `sidebar-threads-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar thread tiles screenshot: ${path}`);
    }
  }, 30_000);

  it("a working title recedes behind the rows that call for the person, as T3 Code's shouldRecede, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const titles = await page!.locator("[data-row-id^='thread:']").evaluateAll(rows => {
        // The tokens compute to oklab(), which no regex reads as channels: rasterize each one and read the sRGB bytes back.
        const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")!;
        const bytes = (color: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = "#000000";
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        const luminance = (color: string): number => {
          const [r = 0, g = 0, b = 0] = bytes(color).slice(0, 3).map(c => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const backdrop = (el: Element): string => {
          for (let node: Element | null = el; node !== null; node = node.parentElement) {
            const painted = getComputedStyle(node).backgroundColor;
            if (bytes(painted)[3] === 255) return painted;
          }
          return getComputedStyle(document.documentElement).backgroundColor;
        };
        return rows.map(row => {
          const el = row.querySelector<HTMLElement>("[data-thread-title]")!;
          const color = getComputedStyle(el).color;
          return {
            text: el.textContent ?? "",
            // Which row is the working one comes from the row's own slot, not from where it sits in the list.
            working: row.querySelector("[data-thread-status]")?.getAttribute("data-thread-status") === "working",
            color,
            opaque: bytes(color)[3] === 255,
            gap: Math.abs(luminance(color) - luminance(backdrop(el))),
          };
        });
      });
      console.info(`thread titles at ${theme}: ${JSON.stringify(titles)}`);
      // The resting rows here are finishes nobody has opened yet, which stay bright; the working one steps back.
      const [working, ...unseen] = [...titles].sort((a, b) => Number(b.working) - Number(a.working));
      expect(titles.filter(t => t.working)).toHaveLength(1);
      expect(unseen).toHaveLength(3);
      for (const done of unseen) {
        expect(done.color).not.toBe(working!.color);
        expect(working!.gap).toBeLessThan(done.gap);
      }
      const path = join(SHOTS_DIR, `sidebar-idle-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar idle group screenshot: ${path}`);
    }
  }, 30_000);

  it("the Settled fold sits shut at the foot of the list, 28 px like every section head, no fill and no border, and opens to slim one-line rows under it, and the list above it stands bare, in both themes", async () => {
    const read = () =>
      page!.evaluate(() => {
        const fold = document.querySelector<HTMLElement>("[data-row-id='settled']")!;
        const box = fold.getBoundingClientRect();
        const style = getComputedStyle(fold);
        return {
          fold: { text: fold.getAttribute("aria-label"), expanded: fold.getAttribute("aria-expanded"), y: box.y, height: box.height, right: box.right, background: style.backgroundColor, border: style.borderBottomWidth, above: box.y - fold.closest("li")!.previousElementSibling!.getBoundingClientRect().bottom },
          tiles: Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='thread:'], [data-row-id^='ws:']")).map(row => ({ id: row.getAttribute("data-row-id"), y: row.getBoundingClientRect().y, height: row.getBoundingClientRect().height })),
          sidebar: document.querySelector<HTMLElement>("[data-slot=sidebar]")!.getBoundingClientRect().right,
        };
      });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&archived=1&sidebar=300`);
      await page!.waitForSelector("[data-row-id='settled']");
      const shut = await read();
      console.info(`settled fold ${theme} shut: ${JSON.stringify(shut)}`);
      expect(shut.fold.expanded).toBe("false");
      expect(shut.fold.text).toBe("Settled 2");
      expect(shut.tiles.map(t => t.id)).toEqual(["thread:s2", "thread:s1", "thread:s3", "thread:s4", "ws:ws_c"]);
      for (const tile of shut.tiles) expect(tile.y).toBeLessThan(shut.fold.y);
      expect(shut.fold.height).toBe(28);
      expect(Math.round(shut.fold.above)).toBe(12);
      expect(shut.fold.background).toBe("rgba(0, 0, 0, 0)");
      expect(shut.fold.border).toBe("0px");
      expect(shut.fold.right).toBeLessThanOrEqual(shut.sidebar);
      const path = join(SHOTS_DIR, `sidebar-settled-shut-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar settled shut screenshot: ${path}`);
      await page!.locator("[data-row-id='settled']").click();
      await page!.waitForFunction(() => document.querySelectorAll("[data-row-id^='thread:']").length === 6);
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-row-id='settled'] svg")!).transform === "none");
      await page!.mouse.move(640, 760);
      await page!.waitForTimeout(200);
      const open = await read();
      console.info(`settled fold ${theme} open: ${JSON.stringify(open)}`);
      expect(open.fold.expanded).toBe("true");
      expect(open.fold.text).toBe("Settled 2");
      const settledIds = ["thread:s5", "thread:s6"];
      expect(new Set(open.tiles.filter(t => !settledIds.includes(t.id!)).map(t => Math.round(t.height)))).toEqual(new Set([52]));
      expect(new Set(open.tiles.filter(t => settledIds.includes(t.id!)).map(t => Math.round(t.height)))).toEqual(new Set([36]));
      for (const id of settledIds) expect(open.tiles.find(t => t.id === id)!.y).toBeGreaterThan(open.fold.y);
      const openPath = join(SHOTS_DIR, `sidebar-settled-open-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: openPath });
      console.info(`sidebar settled open screenshot: ${openPath}`);
      const heads = () =>
        page!.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>("[data-section-head]")).map(head => {
            const box = head.getBoundingClientRect();
            const rule = head.querySelector<HTMLElement>("[data-section-rule]")!.getBoundingClientRect();
            return { id: head.dataset["sectionHead"], y: box.y, height: box.height, rule: rule.height, ruleWidth: rule.width, tiles: head.parentElement!.querySelectorAll("[data-row-id^='thread:'], [data-row-id^='ws:']").length };
          }),
        );
      // The live list here is the one bare list: no head stands over it, so nothing of it folds.
      expect(await heads()).toEqual([]);
    }
  }, 60_000);

  it("on the Mac's dark glass the centre and the sidebar let the glass through, and turn solid with Transparency off or the computer's Reduce transparency on", async () => {
    await page!.goto(`${base}?theme=dark`);
    await page!.waitForSelector("[data-shell-center]");
    const read = () =>
      page!.evaluate(() => {
        const alpha = (sel: string): number => {
          const bg = getComputedStyle(document.querySelector<HTMLElement>(sel)!).backgroundColor;
          // rgba(r, g, b, a), or color(srgb r g b / a) for a mix; no alpha written is opaque.
          const slash = /\/\s*([\d.]+)\s*\)$/.exec(bg);
          const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(bg);
          return Number(slash?.[1] ?? rgba?.[1] ?? 1);
        };
        return { centre: alpha("[data-shell-center]"), sidebar: alpha("[data-slot=sidebar-inner]") };
      });
    await page!.evaluate(() => document.documentElement.classList.add("desktop-mac", "dark"));
    const glass = await read();
    await page!.evaluate(() => document.documentElement.classList.add("solid"));
    const off = await read();
    await page!.evaluate(() => document.documentElement.classList.remove("solid"));
    const cdp = await page!.context().newCDPSession(page!);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    await page!.waitForFunction(() => document.documentElement.classList.contains("solid"));
    const reduced = await read();
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.detach();
    await page!.evaluate(() => document.documentElement.classList.remove("desktop-mac"));
    console.info(`glass alphas: ${JSON.stringify({ glass, off, reduced })}`);
    expect(glass.centre).toBeLessThan(1);
    expect(glass.sidebar).toBeLessThan(1);
    expect(off).toEqual({ centre: 1, sidebar: 1 });
    expect(reduced).toEqual({ centre: 1, sidebar: 1 });
  });

  it("the composer's glass lets the page through in both themes, and turns solid with Transparency off or the computer's Reduce transparency on", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-slot=composer-shell]");
      // The tint fades its colour in 200 ms; read it once no animation is left on the page.
      const read = async () => {
        await page!.waitForFunction(() => document.getAnimations().length === 0);
        return page!.evaluate(() => {
          const bg = getComputedStyle(document.querySelector<HTMLElement>("[data-slot=composer-shell]")!, "::before").backgroundColor;
          const slash = /\/\s*([\d.]+)\s*\)$/.exec(bg);
          const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(bg);
          return Number(slash?.[1] ?? rgba?.[1] ?? 1);
        });
      };
      const glass = await read();
      await page!.evaluate(() => document.documentElement.classList.add("solid"));
      const off = await read();
      await page!.evaluate(() => document.documentElement.classList.remove("solid"));
      const cdp = await page!.context().newCDPSession(page!);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
      await page!.waitForFunction(() => document.documentElement.classList.contains("solid"));
      const reduced = await read();
      await cdp.send("Emulation.setEmulatedMedia", { features: [] });
      await cdp.detach();
      console.info(`composer glass alpha ${theme}: ${JSON.stringify({ glass, off, reduced })}`);
      expect(glass, theme).toBeLessThan(1);
      expect({ off, reduced }, theme).toEqual({ off: 1, reduced: 1 });
    }
  });

  it("a toast with a 200-character token stands top right of the centre pane, inside its box and off the sidebar, its where one line and no clock, at every width, in both themes", async () => {
    const token = "ZGVza3RvcC1wb29s".repeat(13).slice(0, 200);
    const toast = `${encodeURIComponent(`Stopped the builder ${token} to make room at the machine cap.`)}&where=${"spoo-".repeat(40)}`;
    for (const theme of ["dark", "light"] as const) {
      for (const width of [1200, 390]) {
        await page!.setViewportSize({ width, height: 800 });
        await page!.goto(`${base}?theme=${theme}&toast=${toast}`);
        const notice = page!.locator("[data-notice]").first();
        await notice.waitFor();
        await page!.waitForTimeout(500);
        const centre = await box("[data-shell-center]");
        const header = await box("[data-shell-center] header");
        const b = await box("[data-sonner-toast]");
        expect(b.x).toBeGreaterThanOrEqual(centre.x);
        expect(b.x + b.width).toBeLessThanOrEqual(centre.x + centre.width);
        expect(b.y).toBeGreaterThanOrEqual(header.y + header.height);
        expect(await notice.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
        expect(await notice.evaluate(el => el.closest("[data-app-sidebar]"))).toBeNull();
        const where = notice.locator("[data-notice-where]");
        expect((await where.boundingBox())!.height).toBeLessThan(20);
        expect(await notice.textContent()).not.toMatch(/\d{2}:\d{2}/);
        const path = join(SHOTS_DIR, `notice-${theme}-${width}.png`);
        await page!.screenshot({ path });
        console.info(`notice screenshot: ${path}`);
      }
    }
    await page!.setViewportSize({ width: 1200, height: 800 });
  }, 60_000);

  it("each kind of notice is its glyph in its tone at AA over the glass, the sentence and the quieter where, in both themes", async () => {
    const kinds = [
      { kind: "error", text: "api was not woken: the provider refused", icon: "--status-failed" },
      { kind: "done", text: "agent/pricing-page pushed, pull request #212 opened", icon: "--status-done", action: "Open" },
      { kind: "waiting", text: "Bash wants to run wsp --version", icon: "--status-input", action: "Open" },
      { kind: "note", text: "wsp 0.2.1 is out", icon: "--muted-foreground", action: "Get the app" },
    ];
    for (const theme of ["dark", "light"] as const) {
      for (const k of kinds) {
        await page!.goto(`${base}?theme=${theme}&toast=${encodeURIComponent(k.text)}&kind=${k.kind}&where=${encodeURIComponent("api @ Solari")}${k.action === undefined ? "" : `&action=${encodeURIComponent(k.action)}`}`);
        const notice = page!.locator(`[data-notice][data-kind=${k.kind}]`).first();
        await notice.waitFor();
        await page!.waitForTimeout(500);
        const tone = await notice.evaluate((el, token) => {
          const probe = document.createElement("span");
          probe.style.color = `var(${token})`;
          el.append(probe);
          const want = getComputedStyle(probe).color;
          probe.remove();
          return [getComputedStyle(el.querySelector("svg[role=img]")!).color, want];
        }, k.icon);
        expect(tone[0]).toBe(tone[1]);
        const scope = `[data-notice][data-kind=${k.kind}]`;
        const [icon] = await textContrast(page!, `${scope} svg[role=img]`);
        const [title] = await textContrast(page!, `${scope} [data-notice-title]`);
        const [where] = await textContrast(page!, `${scope} [data-notice-where]`);
        console.info(`${k.kind} at ${theme}: icon ${icon}, title ${title}, where ${where}`);
        expect(icon).toBeGreaterThanOrEqual(3);
        expect(title).toBeGreaterThanOrEqual(4.5);
        expect(where).toBeGreaterThanOrEqual(4.5);
        const path = join(SHOTS_DIR, `notice-kind-${k.kind}-${theme}.png`);
        await page!.screenshot({ path, clip: { x: 0, y: 0, width: 1200, height: 260 } });
        console.info(`notice kind screenshot: ${path}`);
      }
    }
  }, 60_000);

  it("a running machine that does not answer pops no notice, nor does the napping one beside it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&silent=1`);
      await page!.locator("[data-sidebar-row]").first().waitFor();
      await page!.waitForTimeout(800);
      expect(await page!.locator("[data-notice]").count()).toBe(0);
      const path = join(SHOTS_DIR, `notice-silent-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`silent machine screenshot: ${path}`);
    }
  }, 30_000);

  it("a prompt and a dead thread on a workspace not open stand as a waiting and an error notice, each with an Open, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&host=1`);
      await page!.locator("[data-notice]").nth(1).waitFor();
      const notices = await page!.locator("[data-notice]").evaluateAll(els => els.map(el => [el.getAttribute("data-kind"), el.textContent ?? ""]));
      console.info(`host notices at ${theme}: ${JSON.stringify(notices)}`);
      expect(notices.map(([kind]) => kind)).toEqual(["waiting", "error"]);
      expect(notices[1]![1]).toContain("stopped before it replied: exit 1");
      expect(await page!.locator("[data-notice-action]").allTextContents()).toEqual(["Open", "Open"]);
      await page!.waitForTimeout(500);
      await page!.screenshot({ path: join(SHOTS_DIR, `notice-host-stacked-${theme}.png`), clip: { x: 0, y: 0, width: 1200, height: 300 } });
      await page!.locator("[data-sonner-toast]").first().hover();
      await page!.waitForTimeout(600);
      const path = join(SHOTS_DIR, `notice-host-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 1200, height: 300 } });
      console.info(`host notices screenshot: ${path}`);
    }
  }, 30_000);

  it("a shell older than the host that served the page says so in a toast, with the releases page behind its button, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&version=behind`);
      const notice = page!.locator("[data-notice]").first();
      await notice.waitFor();
      expect(await notice.textContent()).toContain("this app is 0.1.3, the host is 0.1.5: get the new app");
      expect(await page!.locator("[data-notice-action]").textContent()).toBe("Get");
      const path = join(SHOTS_DIR, `notice-version-behind-${theme}.png`);
      await notice.screenshot({ path });
      console.info(`notice version screenshot: ${path}`);
    }
  }, 30_000);

  it("the composer has no line above its box: a gone workspace holds its send in the held tier with the reason on its hover, a lingering turn says nothing, a paused one reads Wake and send, and the box is glass the page shows through, in both themes", async () => {
    interface Composer {
      box: Box;
      lines: number;
      panels: number;
      held: string | null;
      glass: { fill: string; blur: string };
      send: { label: string | null; box: Box | null; fill: string; ink: string; border: string; opacity: string };
      editable: boolean;
      placeholder: string;
    }
    const composerAt = async (query: string, theme: string, name: string): Promise<Composer> => {
      await page!.goto(`${base}?theme=${theme}&${query}`);
      await page!.waitForSelector("[data-chat-composer]");
      await page!.waitForSelector("text=Loading transcript", { state: "detached" });
      // The send fades between its held tier and its disc over 150 ms, so a computed style read at mount catches the
      // fade rather than either tier.
      await page!.waitForTimeout(400);
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const send = el.querySelector<HTMLButtonElement>("[data-chat-composer-actions] button[type=submit]");
        const sendStyle = send === null ? null : getComputedStyle(send);
        const editor = el.querySelector<HTMLElement>("[data-testid=composer-editor]");
        const shell = getComputedStyle(el.querySelector<HTMLElement>("[data-slot=composer-shell]")!, "::before");
        const b = send?.getBoundingClientRect();
        return {
          lines: el.querySelectorAll("[data-composer-refusal], span[role=status]").length,
          panels: el.querySelectorAll("[data-composer-banner-surface]").length,
          held: el.querySelector("[data-send-held]")?.getAttribute("data-send-held") ?? null,
          glass: { fill: shell.backgroundColor, blur: shell.backdropFilter || shell.getPropertyValue("-webkit-backdrop-filter") },
          send: {
            label: send?.getAttribute("aria-label") ?? null,
            box: b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height },
            fill: sendStyle?.backgroundColor ?? "",
            ink: sendStyle?.color ?? "",
            border: `${sendStyle?.borderTopWidth} ${sendStyle?.borderTopColor}`,
            opacity: sendStyle?.opacity ?? "",
          },
          editable: editor?.getAttribute("contenteditable") !== "false",
          placeholder: editor?.getAttribute("aria-placeholder") ?? el.querySelector("[data-placeholder]")?.textContent ?? "",
        };
      });
      const path = join(SHOTS_DIR, `composer-${name}-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path });
      console.info(`composer ${name} screenshot: ${path} (glass ${read.glass.fill}, ${read.glass.blur})`);
      return { box: await box("[data-slot=composer-shell]"), ...read };
    };
    /** A computed colour's alpha, whichever syntax the engine serialises it in. */
    const alpha = (colour: string): number => {
      const parts = (/\(([^)]+)\)/.exec(colour)?.[1] ?? "").replace(/^srgb\s+/, "").split(/[\s,/]+/).filter(Boolean);
      return parts.length === 4 ? Number(parts[3]) : 1;
    };
    const sendInBox = (c: Composer) => ({ x: c.send.box!.x - c.box.x, y: c.send.box!.y - c.box.y, width: c.send.box!.width, height: c.send.box!.height });
    // A paused workspace's row carries fewer picks; wide enough that no row wraps, the boxes compare as boxes.
    await page!.setViewportSize({ width: 1600, height: 800 });
    for (const theme of ["dark", "light"] as const) {
      const idle = await composerAt("ws=ws_a", theme, "idle");
      expect(idle.held).toBeNull();
      expect(idle.send.label).toBe("Send message");
      expect(idle.editable).toBe(true);
      // Glass: a faint tint over a blur, so what is behind the box shows through it.
      expect(alpha(idle.glass.fill)).toBeLessThan(theme === "dark" ? 0.1 : 0.6);
      expect(idle.glass.blur).toMatch(/blur/);
      const paused = await composerAt("ws=ws_b", theme, "paused");
      const gone = await composerAt("ws=ws_c", theme, "gone");
      const working = await composerAt("ws=ws_a&linger=1", theme, "working");
      for (const state of [idle, paused, gone, working]) {
        expect(state.lines).toBe(0);
        expect(state.panels).toBe(0);
      }
      // A paused workspace: no sentence anywhere, the box takes words, the same button in the same place says it wakes first.
      expect(paused.editable).toBe(true);
      expect(paused.placeholder).toBe(idle.placeholder);
      expect(paused.placeholder).not.toMatch(/paus|wake/i);
      expect(paused.send.label).toBe(WAKE_AND_SEND_LABEL);
      expect(sendInBox(paused)).toEqual(sendInBox(idle));
      expect([paused.box.width, paused.box.height]).toEqual([idle.box.width, idle.box.height]);
      // A gone workspace says why on the held send's hover and nowhere else, in the held tier where the live send stands.
      expect(gone.held).toBe(sendRefusal("gone"));
      expect(sendInBox(gone)).toEqual(sendInBox(idle));
      expect(gone.send.fill).not.toBe(idle.send.fill);
      expect(gone.send.border.startsWith("1px ")).toBe(true);
      expect(gone.send.border).not.toBe(idle.send.border);
      expect(gone.send.opacity).toBe("1");
      // The live send is a solid disc, and a send that wakes first is a send that can be pressed.
      expect(alpha(idle.send.fill)).toBe(1);
      expect(paused.send.fill).toBe(idle.send.fill);
      expect([gone.box.width, gone.box.height]).toEqual([idle.box.width, idle.box.height]);
    }
    await page!.setViewportSize({ width: 1200, height: 800 });
  }, 60_000);

  it("a pick closes the option menu, so the click after it lands on the prompt the menu was covering", async () => {
    // A turn running on this computer with a prompt open under the composer, which is the page the menu covered.
    await page!.goto(`${base}?theme=dark&local=1&ws=ws_m&perm=1`);
    await page!.waitForSelector("[data-composer-picker='access']");
    await page!.waitForSelector("text=Loading transcript", { state: "detached" });
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='true']");
    await page!.locator("[data-composer-picker='access']").click();
    await page!.waitForSelector("[data-composer-option='plan']");
    // What the pick will do to the turn running now, read over the list before anything is picked.
    expect(await page!.locator("[data-composer-access-reach]").textContent()).toBe(accessReachLine(true));

    await page!.locator("[data-composer-option='plan']").click();
    await page!.waitForSelector(`[data-composer-picker='access'][data-access='plan']`);
    // The menu is gone on the pick: nothing of it is left over the page, visible or not.
    await page!.waitForSelector("[role=menu]", { state: "detached" });

    // Plan says nothing about the write in front of the person, so the prompt stands and their click on it lands
    // rather than being eaten by a menu that stayed up.
    const allow = page!.locator("[data-permission-prompt='ask_open'] [data-permission-option='allow']");
    await allow.click({ timeout: 5_000 });
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='false']");
  }, 60_000);

  it("an access that answers the open prompt closes it without a click, and says nothing about a next message", async () => {
    await page!.goto(`${base}?theme=dark&local=1&ws=ws_m&perm=1`);
    await page!.waitForSelector("[data-composer-picker='access']");
    await page!.waitForSelector("text=Loading transcript", { state: "detached" });
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='true']");
    await page!.locator("[data-composer-picker='access']").click();
    await page!.waitForSelector("[data-composer-option='bypassPermissions']");
    await page!.locator("[data-composer-option='bypassPermissions']").click();

    // The prompt the turn was stopped on is answered by the pick itself: the person clicks nothing.
    await page!.waitForSelector("[data-permission-prompt='ask_open'][data-permission-open='false']");
    await page!.waitForSelector(`[data-composer-picker='access'][data-access='bypassPermissions']`);
    expect(await page!.locator("[data-composer-picker='access']").getAttribute("data-access-refused")).toBeNull();
    expect(await page!.locator("[data-composer-refusal]").count()).toBe(0);
  }, 60_000);

  it("an access picked while a turn runs reads back on the picker, and a refusal the harness answered with stands on the picker in the refusal's ink with the sentence on its hover, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&perm=1&access=refused`);
      await page!.waitForSelector("[data-composer-picker='access']");
      await page!.waitForSelector("text=Loading transcript", { state: "detached" });
      const trigger = "[data-composer-picker='access']";
      expect(await page!.locator(trigger).getAttribute("data-access")).toBe("bypassPermissions");
      const before = await box("[data-slot=composer-shell]");
      await page!.locator(trigger).click();
      await page!.waitForSelector("[data-composer-option='acceptEdits']");
      expect(await page!.locator("[data-composer-access-reach]").textContent()).toBe(accessReachLine(true));
      const menu = join(SHOTS_DIR, `composer-access-menu-${theme}.png`);
      await page!.locator("[role=menu]").first().screenshot({ path: menu });
      console.info(`composer access menu screenshot: ${menu}`);
      await page!.locator("[data-composer-option='acceptEdits']").click();
      await page!.waitForSelector(`${trigger}[data-access='acceptEdits']`);
      await page!.waitForSelector("[role=menu]", { state: "detached" });
      await page!.waitForSelector(`${trigger}[data-access-refused]`);
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const label = el.querySelector<HTMLElement>("[data-composer-picker='access']")!;
        const quiet = el.querySelector<HTMLElement>("[data-composer-picker='reasoning']") ?? el.querySelector<HTMLElement>("[data-composer-picker='model']")!;
        return {
          refused: label.getAttribute("data-access-refused"),
          hover: label.getAttribute("title"),
          ink: getComputedStyle(label).color,
          quiet: getComputedStyle(quiet).color,
          trigger: label.textContent ?? "",
          lines: el.querySelectorAll("[data-composer-refusal], span[role=status]").length,
        };
      });
      const shot = join(SHOTS_DIR, `composer-access-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path: shot });
      console.info(`composer access refusal screenshot: ${shot}`);
      expect(read.refused).toBe(ACCESS_REFUSED_LINE);
      expect(read.hover).toBe(ACCESS_REFUSED_LINE);
      expect(read.trigger).toBe("Accept edits");
      expect(read.ink).not.toBe(read.quiet);
      expect(read.lines).toBe(0);
      // Nothing moves: the refusal takes no room of its own.
      expect(await box("[data-slot=composer-shell]")).toEqual(before);
    }
  }, 60_000);

  it("the composer's images are a row of square thumbnails above the text, each with its own remove, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-image-picker]");
      const [empty] = await settledBoxes(["[data-chat-composer]"]);
      // The picker sits with the send at the right, first, before the send.
      const order = await page!.locator("[data-chat-composer-actions]").evaluate(el =>
        [...el.querySelectorAll("button")].map(b => (b.hasAttribute("data-composer-image-picker") ? "picker" : b.getAttribute("type") === "submit" ? "send" : "?")),
      );
      expect(order).toEqual(["picker", "send"]);
      expect(await page!.locator("[data-composer-images]").count()).toBe(0);

      await page!.goto(`${base}?theme=${theme}&ws=ws_a&images=3`);
      await page!.waitForSelector("[data-composer-images] [data-chat-image]");
      await page!.waitForFunction(() => document.querySelectorAll("[data-composer-images] [data-chat-image]").length === 3);
      const thumbs = await page!.locator("[data-composer-images] [data-chat-image]").evaluateAll(els =>
        els.map(el => {
          const r = el.getBoundingClientRect();
          const button = el.querySelector("button")!;
          const s = getComputedStyle(button);
          return { width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top), radius: s.borderTopLeftRadius, removes: el.querySelectorAll("[aria-label^=Remove]").length };
        }),
      );
      expect(thumbs).toHaveLength(3);
      // One square per image, all on one line, each with its own remove: a uniform row, not three shapes.
      expect(new Set(thumbs.map(t => `${t.width}x${t.height}`)).size).toBe(1);
      expect(thumbs[0]!.width).toBe(thumbs[0]!.height);
      expect(new Set(thumbs.map(t => t.top)).size).toBe(1);
      expect(new Set(thumbs.map(t => t.radius)).size).toBe(1);
      expect(thumbs.map(t => t.removes)).toEqual([1, 1, 1]);
      // The row is above the text, inside the box, and the box grew by the row rather than the row escaping it.
      const [row, editor, shell, grown] = await settledBoxes(["[data-composer-images]", "[data-chat-composer-form] [contenteditable]", "[data-slot=composer-shell]", "[data-chat-composer]"]);
      expect(row.y + row.height).toBeLessThanOrEqual(editor.y);
      expect(row.y).toBeGreaterThan(shell.y);
      expect(row.x + row.width).toBeLessThanOrEqual(shell.x + shell.width);
      expect(grown.height).toBeGreaterThan(empty.height);
      const path = join(SHOTS_DIR, `composer-images-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path });
      console.info(`composer images screenshot: ${path}`);
    }
  }, 60_000);

  it("the composer's model picker carries the agent's bare mark on its button and one per agent on its rail, in both themes", async () => {
    interface MarkRead {
      harness: string | null;
      size: number[];
      /** The mark's centre against its neighbour's centre. */
      offset: number;
      color: string;
      bare: boolean;
    }
    const readMarks = (selector: string): Promise<MarkRead[]> =>
      page!.locator(selector).evaluateAll(els =>
        els.map(el => {
          const box = el.getBoundingClientRect();
          const beside = (el.nextElementSibling ?? el.parentElement!).getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            harness: el.getAttribute("data-harness-mark"),
            size: [box.width, box.height],
            offset: box.y + box.height / 2 - (beside.y + beside.height / 2),
            color: s.color,
            bare: s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderTopWidth === "0px" && s.boxShadow === "none",
          };
        }),
      );
    const expectBare = (marks: MarkRead[], low = 13, high = 16) => {
      for (const mark of marks) {
        for (const side of mark.size) {
          expect(side).toBeGreaterThanOrEqual(low);
          expect(side).toBeLessThanOrEqual(high);
        }
        expect(Math.abs(mark.offset)).toBeLessThan(1.5);
        expect(mark.bare).toBe(true);
      }
    };
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='model'] svg[data-harness-mark]");
      const [trigger] = await readMarks("[data-composer-picker='model'] svg[data-harness-mark]");
      expect(trigger!.harness).toBe("claude");
      expectBare([trigger!]);
      expect(trigger!.color).not.toBe(await page!.locator("[data-composer-picker='model']").evaluate(el => getComputedStyle(el).color));
      await page!.locator("[data-composer-picker='model']").click();
      await page!.waitForSelector("[data-composer-model-menu]");
      // The popup fades and scales in; the shot waits for it to be drawn whole and on the page.
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-slot=popover-popup]")!).opacity === "1");
      await page!.waitForTimeout(300);
      const popup = await box("[data-slot=popover-popup]");
      expect(popup.width).toBeGreaterThan(200);
      expect(popup.y).toBeGreaterThanOrEqual(0);
      const rail = await readMarks("[data-composer-harness] svg[data-harness-mark]");
      console.info(`picker marks at ${theme}: ${JSON.stringify({ trigger, rail })}`);
      expect(rail.map(m => m.harness)).toEqual(["claude", "codex"]);
      // The rail's tabs are square buttons of their own, so their marks stand a step larger than the button's.
      expectBare(rail, 20, 20);
      expect(rail[0]!.color).toBe(trigger!.color);
      expect(rail[1]!.color).not.toBe(rail[0]!.color);
      const path = join(SHOTS_DIR, `composer-picker-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`composer picker screenshot: ${path}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-composer-model-menu]", { state: "detached" });
    }
  }, 60_000);

  it("the effort picker marks the default of the model picked, not of the agent, in both themes", async () => {
    const read = async (): Promise<{ label: string; marked: string[]; checked: string[]; badge: { mono: boolean; bare: boolean; muted: boolean } }> => {
      const label = await page!.locator("[data-composer-picker='reasoning']").evaluate(el => el.textContent ?? "");
      return page!.locator("[data-slot=menu-popup] [data-composer-option]").evaluateAll(
        (els, buttonLabel) => {
          const badgeOf = (el: Element) => [...el.querySelectorAll("span")].find(s => s.textContent === "default");
          const marked = els.filter(el => badgeOf(el) !== undefined).map(el => el.getAttribute("data-composer-option") ?? "");
          const badge = badgeOf(els.find(el => badgeOf(el) !== undefined)!)!;
          const s = getComputedStyle(badge);
          const row = getComputedStyle(els[0]!);
          return {
            label: buttonLabel,
            marked,
            checked: els.filter(el => el.getAttribute("aria-checked") === "true").map(el => el.getAttribute("data-composer-option") ?? ""),
            badge: { mono: s.fontFamily.toLowerCase().includes("mono"), bare: s.boxShadow === "none", muted: s.color !== row.color },
          };
        },
        label,
      );
    };
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='model']");
      await page!.locator("[data-composer-picker='model']").click();
      await page!.waitForSelector("[data-composer-model-menu]");
      await page!.locator("[data-composer-harness='codex']").click();
      await page!.waitForSelector("[data-composer-picker='reasoning'][data-effort='low']");
      await page!.locator("[data-composer-picker='reasoning']").click();
      await page!.waitForSelector("[data-slot=menu-popup] [data-composer-option='medium']");
      const sol = await read();
      await page!.keyboard.press("Escape");
      await page!.locator("[data-composer-picker='model']").click();
      await page!.locator("[data-composer-option='gpt-5.5']").click();
      await page!.waitForSelector("[data-composer-picker='reasoning'][data-effort='medium']");
      await page!.locator("[data-composer-picker='reasoning']").click();
      await page!.waitForSelector("[data-slot=menu-popup] [data-composer-option='medium']");
      const picked = await read();
      console.info(`effort default at ${theme}: ${JSON.stringify({ sol, picked })}`);
      // The app-server reports low for GPT-5.6-Sol and medium for GPT-5.5, so the mark moves with the pick.
      expect(sol.label).toBe("Low");
      expect(sol.marked).toEqual(["low"]);
      expect(sol.checked).toEqual(["low"]);
      expect(picked.label).toBe("Medium");
      expect(picked.marked).toEqual(["medium"]);
      expect(picked.checked).toEqual(["medium"]);
      // The word is a quiet sans tag on nothing, as the model menu marks its default: a word a person reads, never mono.
      expect(picked.badge).toEqual({ mono: false, bare: true, muted: true });
      const path = join(SHOTS_DIR, `composer-effort-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`composer effort screenshot: ${path}`);
      await page!.keyboard.press("Escape");
    }
  }, 60_000);

  it("collapsing the sidebar puts the page header's toggle where the sidebar's was, and the breadcrumb after it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      // A workspace opens on its composer; the crumb names a thread once one is open.
      await page!.locator("[data-row-id='thread:s2']").click();
      await page!.waitForSelector("header [data-breadcrumb-thread]");
      const before = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
      expect(await page!.locator("header [data-slot=sidebar-trigger]").count()).toBe(0);
      await page!.locator("[data-slot=sidebar-header] [data-slot=sidebar-trigger]").click();
      await page!.waitForSelector("[data-sidebar-state=collapsed]");
      // The row animates padding-left over 200 ms; the read waits for the toggle to land.
      await page!.waitForFunction(x => Math.abs(document.querySelector("header [data-slot=sidebar-trigger]")!.getBoundingClientRect().x - x) < 1, before.x);
      const after = await box("header [data-slot=sidebar-trigger]");
      expect(Math.abs(after.x - before.x)).toBeLessThan(1);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1);
      const crumb = await box("header [data-thread-breadcrumb]");
      expect(Math.abs(crumb.x - (after.x + after.width + (await rowGap("header [data-header-row]"))))).toBeLessThan(1);
      expect(await page!.locator("header [data-thread-breadcrumb]").evaluate(el => el.textContent)).toBe("Reply with exactly the word hi.");
      const ratios = await textContrast(page!, "header [data-thread-breadcrumb] .text-muted-foreground");
      for (const ratio of ratios) expect(ratio, `the collapsed header's quiet crumb reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      const path = join(SHOTS_DIR, `header-collapsed-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 600, height: 120 } });
      console.info(`collapsed header screenshot: ${path}`);
    }
  }, 60_000);
  /** One tile's name slot: the tile's height, where the name starts, where the status slot on row one ends, and the
   * name's own font, read the same way whether row two holds the text or the one name box. */
  const nameSlot = async (
    selector: string,
    nameSelector: string,
  ): Promise<{ rowHeight: number; nameX: number; slotRight: number; font: string; size: string; text: string; value: string; focused: boolean }> =>
    page!.locator(selector).first().evaluate((row: HTMLElement, of: string) => {
      const input = row.querySelector<HTMLInputElement>("[data-row-name-input]");
      const name = input ?? row.querySelector<HTMLElement>(of)!;
      const slot = row.querySelector<HTMLElement>("[data-thread-status]")!;
      const s = getComputedStyle(name);
      return {
        rowHeight: row.getBoundingClientRect().height,
        nameX: name.getBoundingClientRect().x,
        slotRight: slot.getBoundingClientRect().right,
        font: s.fontFamily,
        size: s.fontSize,
        text: name.textContent ?? "",
        value: input?.value ?? "",
        focused: document.activeElement === input,
      };
    }, nameSelector);
  const titleSlot = () => nameSlot("[data-row-id^='thread:']", "[data-thread-title]");

  it("a right-click on a tile opens the in-app menu at the pointer in the tooltip skin, kept inside the viewport, and Escape closes it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      // The gone copy with no thread on it: its tile's menu is the copy's own verbs.
      const row = await box("[data-row-id='ws:ws_c']");
      const at = { x: row.x + row.width - 12, y: row.y + row.height / 2 };
      await page!.mouse.click(at.x, at.y, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      const menu = await box("[data-context-menu]");
      expect(Math.abs(menu.x - at.x)).toBeLessThan(1);
      // The tile sits low in the list and its menu is tall, so the menu rises from the pointer to stay on screen.
      expect(menu.y).toBeLessThanOrEqual(at.y + 1);
      const viewport = page!.viewportSize()!;
      expect(menu.x + menu.width).toBeLessThanOrEqual(viewport.width - 8);
      expect(menu.y + menu.height).toBeLessThanOrEqual(viewport.height - 8);
      const skin = await page!.locator("[data-context-menu]").evaluate(el => {
        const s = getComputedStyle(el);
        return { border: s.borderTopWidth, background: s.backgroundColor, radius: s.borderTopLeftRadius, z: s.zIndex, arrows: el.querySelectorAll("[data-arrow], svg").length };
      });
      expect(skin.border).toBe("1px");
      expect(skin.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(skin.z).toBe("130");
      expect(skin.arrows).toBe(0);
      // Every one of the gone copy's verbs, the eight a gone machine or this fake host holds back dimmed.
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(11);
      expect(await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").count()).toBe(8);
      // The first row that can run holds focus, so the keyboard is already in the menu.
      expect(await page!.locator("[data-context-menu] [role=menuitem]").nth(7).evaluate(el => document.activeElement === el)).toBe(true);
      const path = join(SHOTS_DIR, `sidebar-context-menu-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 520 } });
      console.info(`sidebar context menu screenshot: ${path}`);
      // The refusal rides the tooltip skin: hovering a dimmed row shows it.
      await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").first().hover();
      await page!.waitForSelector("[data-slot=tooltip-popup]");
      expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toBe("This workspace's machine is gone with its disk, so work that was not pushed is lost; rebuild it to wake, which brings back its home folder from the last saved nap");
      const tipPath = join(SHOTS_DIR, `sidebar-context-menu-refusal-${theme}.png`);
      await page!.screenshot({ path: tipPath, clip: { x: 0, y: 0, width: 640, height: 520 } });
      console.info(`sidebar context menu refusal screenshot: ${tipPath}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-context-menu]", { state: "detached" });
      // Focus goes back where it was: the row's own button under the pointer, which Chromium focused on the press.
      expect(await page!.evaluate(() => document.activeElement?.closest("[data-row-id='ws:ws_c']") !== null)).toBe(true);
      // A root thread's tile carries its four verbs and then every one of its copy's.
      const thread = await box("[data-row-id^='thread:']");
      await page!.mouse.click(thread.x + 20, thread.y + thread.height / 2, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(14);
      await page!.screenshot({ path: join(SHOTS_DIR, `thread-context-menu-${theme}.png`), clip: { x: 0, y: 0, width: 520, height: 520 } });
      console.info(`thread context menu screenshot: ${join(SHOTS_DIR, `thread-context-menu-${theme}.png`)}`);

      // Rename turns that row's title into a field in the same slot: the row keeps its height and the time column
      // keeps its place, and the field wears the title's own font and size.
      const titled = await titleSlot();
      await page!.locator("[data-context-menu] [role=menuitem]", { hasText: "Rename thread" }).click();
      await page!.waitForSelector("[data-row-name-input]");
      const named = await titleSlot();
      expect(named.rowHeight).toBe(titled.rowHeight);
      expect(named.nameX).toBe(titled.nameX);
      expect(named.slotRight).toBe(titled.slotRight);
      expect(named.font).toBe(titled.font);
      expect(named.size).toBe(titled.size);
      expect(named.value).toBe(titled.text);
      expect(named.focused).toBe(true);
      // The name a person types: the selection goes, the field keeps the row's height and the time column's place.
      await page!.keyboard.type("the name he typed");
      const typed = await titleSlot();
      expect(typed.value).toBe("the name he typed");
      expect(typed.rowHeight).toBe(titled.rowHeight);
      expect(typed.slotRight).toBe(titled.slotRight);
      const namePath = join(SHOTS_DIR, `thread-row-renaming-${theme}.png`);
      await page!.screenshot({ path: namePath, clip: { x: 0, y: 0, width: 520, height: 300 } });
      console.info(`thread row renaming screenshot: ${namePath}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-row-name-input]", { state: "detached" });
      expect((await titleSlot()).text).toBe(titled.text);
      await page!.waitForSelector("[data-context-menu]", { state: "detached" });
    }
  }, 60_000);

  it("the sidebar's ink reads the same in light as in dark: every tier that carries words at AA", async () => {
    // A tile draws no words in the whisper ink since its branch moved onto the card, so no tier measures it.
    const TIERS = {
      "a thread's title once it is idle": "[data-app-sidebar] .text-sidebar-muted-foreground",
      "the word on a row at rest": "[data-app-sidebar] [data-slot=sidebar-menu-button]:not([data-active=true])",
      "the state word beside a thread": "[data-sidebar-row] [data-thread-status][data-tone]",
    } as const;
    const read: Record<"dark" | "light", Record<string, number>> = { dark: {}, light: {} };
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      for (const [tier, selector] of Object.entries(TIERS)) {
        const ratios = await textContrast(page!, selector);
        expect(ratios.length, `${tier} drew nothing to measure in ${theme}`).toBeGreaterThan(0);
        read[theme][tier] = Math.min(...ratios);
      }
      console.info(`${theme}: ${Object.entries(read[theme]).map(([tier, ratio]) => `${tier} ${ratio.toFixed(2)}`).join(", ")} to 1`);
    }
    for (const tier of Object.keys(TIERS)) expect(read.light[tier], `${tier} reads at ${read.light[tier]} in light`).toBeGreaterThanOrEqual(4.5);
  }, 60_000);
});
