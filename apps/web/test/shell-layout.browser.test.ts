// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar's brand lockup starts
// where the search row does, the two top rows are one height and start
// where the workspace rows do, the search row opens the palette without
// moving a row, a thread row's title keeps its room at the
// default width, a status toast holds a long token inside its box, the
// line for a provider out of reach is one muted mono line under the
// search row, the line the runtime puts on a machine's row takes that row's second line whole,
// uncut and without growing the row, collapsing the sidebar leaves the
// page header's left padding alone, a send refusal above the composer is
// one muted mono line in a slot the composer keeps at one height whether or
// not a line is in it, images pasted into the composer are one row of square
// thumbnails above the text inside the box, each with its own remove,
// a right-click on a workspace row opens the in-app menu
// at the pointer in the tooltip skin, inside the viewport, Rename turns a
// thread row's title and a workspace row's name into one field in the same
// slot at the same row height, and the switch
// chord held down puts the workspace switcher up, its cards three parts
// each, without moving the shell under it, and at three sidebar widths the
// workspace and thread rows keep one grammar: one height per row kind, the
// state word in its slot at the right edge only off running, the meta line
// in one order cut from the right, no import or export glyph, the thread
// title up to a fixed time column, the Spaces body draws one workspace
// under its header with a dot per workspace at the sidebar's bottom, and the
// move to another space travels that body out the way it was pushed and the
// next one in from the other side while the header and the dots row hold
// still, or swaps it with no travel for a reader who asked for less motion. Vite
// serves test/shell to Playwright's browser, so like the glyph test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium
// on the machine.
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_UNREACHED_LINE, sendRefusal, stillWorkingRefusal } from "@wsp/protocol";
import { LOCKUP_OPTICAL_CENTRE } from "../src/brand/optical";
import { SPACE_SLIDE_MS } from "../src/sidebar/SpaceSlide";
import { startVite, stopRender, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const browserPath = ((): string | undefined => {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
})();
const hasBrowser = browserPath !== undefined && existsSync(browserPath);
const skipped = process.env["WSP_RENDER"] !== "1" ? "WSP_RENDER is not 1" : !hasBrowser ? "Playwright's Chromium is not installed" : undefined;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

if (skipped !== undefined) console.info(`shell layout render test skipped: ${skipped}`);

describe.skipIf(skipped !== undefined)("the shell's chrome laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/shell/index.html");
    base = `${vite.base}/test/shell/index.html`;
    browser = await chromium.launch();
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

  it("the search row and the Workspaces row are one height, start where the workspace rows do, the search row alone wears a tint that deepens on hover, they carry one glyph each at the right edge and no chord on their faces, and open the palette without moving anything", async () => {
    const shot = async (name: string, theme: string): Promise<void> => {
      const path = join(SHOTS_DIR, `sidebar-top-${name}-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar ${name} screenshot: ${path}`);
    };
    const transparent = (selector: string): Promise<boolean> =>
      page!.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el);
        return s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderTopWidth === "0px" && s.boxShadow === "none";
      });
    // The alpha of a computed black tint: color(srgb 0 0 0 / a), or rgba(0, 0, 0, a).
    const tintAlpha = (selector: string): Promise<number> =>
      page!.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el);
        if (s.borderTopWidth !== "0px" || s.boxShadow !== "none") return Number.NaN;
        const m = /^(?:color\(srgb 0 0 0|rgba\(0, 0, 0,?) ?\/? ?([\d.]+)\)$/.exec(s.backgroundColor);
        return m === null ? Number.NaN : Number(m[1]);
      });
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const search = await box("button[aria-label='Search']");
      const section = await box("button[aria-label='Workspaces']");
      const workspace = await box("[data-row-id='ws:ws_a']");
      const firstThread = await box("[data-row-id^='thread:']");
      expect(search.height).toBe(section.height);
      expect(Math.abs(search.x - section.x)).toBeLessThan(1);
      expect(Math.abs(search.x - workspace.x)).toBeLessThan(1);
      const rest = await tintAlpha("button[aria-label='Search']");
      expect(rest).toBeGreaterThan(0.01);
      expect(rest).toBeLessThan(0.1);
      await page!.locator("button[aria-label='Search']").hover();
      await page!.waitForTimeout(250);
      const hovered = await tintAlpha("button[aria-label='Search']");
      expect(hovered).toBeGreaterThan(rest);
      await page!.mouse.move(600, 400);
      await page!.waitForTimeout(250);
      expect(await transparent("button[aria-label='Workspaces']")).toBe(true);
      expect(await page!.locator("[data-slot=sidebar] input").count()).toBe(0);
      expect(await page!.locator("button[aria-label='Search'] kbd").count()).toBe(0);
      const compose = await box("button[aria-label='New thread']");
      expect(compose.x + compose.width).toBeLessThanOrEqual(search.x + search.width);
      expect(compose.x).toBeGreaterThan(search.x + search.width / 2);
      expect(Math.abs(compose.y + compose.height / 2 - (search.y + search.height / 2))).toBeLessThan(1);
      const glyph = await box("button[aria-label='New workspace']");
      expect(glyph.x + glyph.width).toBeLessThanOrEqual(section.x + section.width);
      expect(Math.abs(glyph.y + glyph.height / 2 - (section.y + section.height / 2))).toBeLessThan(1);
      await shot("rest", theme);

      await page!.locator("button[aria-label='Search']").click();
      await page!.waitForSelector("[data-command-palette]");
      expect(await page!.locator("[data-command-palette] input[placeholder]").first().evaluate(el => document.activeElement === el)).toBe(true);
      expect(await page!.locator("[data-slot=sidebar] input").count()).toBe(0);
      expect(await box("button[aria-label='Search']")).toEqual(search);
      expect(await box("[data-row-id='ws:ws_a']")).toEqual(workspace);
      expect(await box("[data-row-id^='thread:']")).toEqual(firstThread);
      // The dialog fades in; the shot waits for the popup to be drawn at full opacity.
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-command-palette]")!).opacity === "1");
      await page!.screenshot({ path: join(SHOTS_DIR, `sidebar-top-palette-${theme}.png`) });
      console.info(`sidebar palette screenshot: ${join(SHOTS_DIR, `sidebar-top-palette-${theme}.png`)}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-command-palette]", { state: "detached" });
      await page!.waitForTimeout(300);
      expect(await page!.locator("[data-command-palette]").count()).toBe(0);
      // Keyboard: focus alone opens nothing; Enter and Space, the button's own activation, do.
      await page!.locator("button[aria-label='Search']").focus();
      await page!.waitForTimeout(300);
      expect(await page!.locator("[data-command-palette]").count()).toBe(0);
      expect(await page!.locator("button[aria-label='Search']").evaluate(el => document.activeElement === el)).toBe(true);
      for (const key of ["Enter", "Space"]) {
        await page!.keyboard.press(key);
        await page!.waitForSelector("[data-command-palette]");
        await page!.keyboard.press("Escape");
        await page!.waitForSelector("[data-command-palette]", { state: "detached" });
        await page!.locator("button[aria-label='Search']").focus();
      }
      await page!.waitForTimeout(300);
      expect(await page!.locator("[data-command-palette]").count()).toBe(0);

      await page!.locator("button[aria-label='Workspaces']").click();
      await page!.waitForSelector("[data-sidebar-row]", { state: "detached" });
      expect(await box("button[aria-label='Workspaces']")).toEqual(section);
      // The chevron turns over 150 ms; the shot waits for it.
      await page!.waitForTimeout(300);
      await shot("collapsed", theme);
      await page!.locator("button[aria-label='Workspaces']").click();
      await page!.waitForSelector("[data-sidebar-row]");
    }
  }, 60_000);

  it("in the desktop window a translucent Ghostty config opens a hole under the terminal canvas alone: the tab strip and the column beside keep the Browser tab's backgrounds, every layer under the canvas is clear and the canvas backing carries the file's alpha, in both themes", async () => {
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
        return { strip: on("[data-right-panel-tabbar]"), centre: on("[data-shell-center]"), canvas: on("[data-terminal-viewport] canvas") };
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
      expect(browser.strip).toBe(browser.centre);
      expect(terminal.strip).toBe(browser.strip);
      expect(terminal.centre).toBe(browser.centre);
      await page!.locator("[data-right-panel-tab-list] [data-active-tab='false'] button:has(> span.truncate)").click();
      await page!.waitForSelector("[data-terminal-viewport] canvas");
      const path = join(SHOTS_DIR, `terminal-pane-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`terminal pane screenshot: ${path}`);
    }
  }, 60_000);

  it("in the desktop window the terminal draws at the Ghostty file's font-size: a file saying 16 gives cells a 16 px monospace line fits, not the app's 11 px mono", async () => {
    await page!.goto(`${base}?theme=dark&ws=ws_a&mac=1&panel=terminal`);
    await page!.waitForSelector("[data-terminal-translucent] canvas");
    await page!.waitForFunction(() => (window as unknown as { surfaces: unknown[] }).surfaces.length > 0);
    const read = await page!.evaluate(() => {
      const [surface] = (window as unknown as { surfaces: { textSize: number; cellHeight: number }[] }).surfaces;
      // A monospace line at the file's size and at the app's mono size, as the page lays them out.
      const lineOf = (px: number): number => {
        const span = document.createElement("span");
        span.style.cssText = `position:absolute;font:400 ${px}px monospace;line-height:normal;white-space:pre`;
        span.textContent = "Mg";
        document.body.append(span);
        const height = span.getBoundingClientRect().height;
        span.remove();
        return height;
      };
      return { textSize: surface!.textSize, cellHeight: surface!.cellHeight, line16: lineOf(16), line11: lineOf(11) };
    });
    console.info(`terminal size from a font-size 16 file: ${JSON.stringify(read)}`);
    expect(read.textSize).toBe(16);
    expect(read.cellHeight).toBeGreaterThanOrEqual(read.line16);
    expect(read.cellHeight).toBeLessThan(read.line16 + 5);
    expect(read.cellHeight).toBeGreaterThan(read.line11 + 4);
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

  it("a thread row keeps twelve characters of a long title at the default width, the agent's bare mark and opener whole under it, rows one height", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const rows = await page!.locator("[data-row-id^='thread:']").evaluateAll(els =>
        els.map(el => {
          const title = el.querySelector<HTMLElement>("[data-thread-title]");
          const meta = el.querySelector<HTMLElement>("[data-thread-meta]");
          const mark = el.querySelector<HTMLElement>("[data-harness-mark]");
          const opener = mark?.nextElementSibling;
          if (!title || !meta || !mark || !opener) return null;
          const font = getComputedStyle(title);
          const ctx = document.createElement("canvas").getContext("2d")!;
          ctx.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
          const markBox = mark.getBoundingClientRect();
          const openerBox = opener.getBoundingClientRect();
          const paint = getComputedStyle(mark);
          return {
            height: el.getBoundingClientRect().height,
            titleWidth: title.clientWidth,
            twelveChars: ctx.measureText((title.textContent ?? "").slice(0, 12)).width,
            metaClipped: [meta, ...meta.querySelectorAll("*")].some(e => e.scrollWidth > e.clientWidth),
            meta: `${meta.textContent ?? ""} (${meta.querySelector("[data-thread-provenance]")?.getAttribute("aria-label")})`,
            mark: mark.getAttribute("data-harness-mark"),
            markSize: [markBox.width, markBox.height],
            // The mark's centre against the opener word's centre: optically on the line, not hanging above it.
            markOffset: markBox.y + markBox.height / 2 - (openerBox.y + openerBox.height / 2),
            markColor: paint.color,
            openerColor: getComputedStyle(opener).color,
            bare: paint.backgroundColor === "rgba(0, 0, 0, 0)" && paint.borderTopWidth === "0px" && paint.boxShadow === "none",
          };
        }),
      );
      console.info(`thread rows at ${theme}: ${JSON.stringify(rows)}`);
      expect(rows.map(r => r?.meta)).toEqual([
        "Working·you (Claude Code · you)",
        "cli (Claude Code · cli)",
        "cli (Codex · cli)",
        "you (Claude Code · you)",
      ]);
      for (const row of rows) {
        expect(row!.titleWidth).toBeGreaterThanOrEqual(row!.twelveChars);
        expect(row!.metaClipped).toBe(false);
        // Bare marks of 13 to 16 px, centred on the words beside them, in a colour of their own, on nothing.
        for (const side of row!.markSize) {
          expect(side).toBeGreaterThanOrEqual(13);
          expect(side).toBeLessThanOrEqual(16);
        }
        expect(Math.abs(row!.markOffset)).toBeLessThan(1.5);
        expect(row!.markColor).not.toBe(row!.openerColor);
        expect(row!.bare).toBe(true);
      }
      // Claude's mark is its terracotta; OpenAI's is monochrome by design, so it takes the row's foreground.
      const colours = new Map(rows.map(r => [r!.mark, r!.markColor]));
      expect(colours.size).toBe(2);
      expect(colours.get("claude")).not.toBe(colours.get("codex"));
      expect(new Set(rows.map(r => r!.height)).size).toBe(1);
      const path = join(SHOTS_DIR, `sidebar-threads-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar thread rows screenshot: ${path}`);
    }
  }, 30_000);

  it("a workspace with no working thread still carries its Idle header, and an idle title sits closer to the background than a working one, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      expect(await page!.locator("[data-row-id='settled:ws_b']").count()).toBe(1);
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
            // Which row is the working one comes from the row's own pill, not from where it sits in the list.
            working: row.querySelector("[data-thread-meta] [aria-label=Working]") !== null,
            color,
            opaque: bytes(color)[3] === 255,
            gap: Math.abs(luminance(color) - luminance(backdrop(el))),
          };
        });
      });
      console.info(`thread titles at ${theme}: ${JSON.stringify(titles)}`);
      const [working, ...idles] = [...titles].sort((a, b) => Number(b.working) - Number(a.working));
      expect(titles.filter(t => t.working)).toHaveLength(1);
      expect(idles).toHaveLength(3);
      expect(titles.map(t => t.opaque)).toEqual([true, true, true, true]);
      for (const idle of idles) {
        expect(idle.color).not.toBe(working!.color);
        expect(idle.gap).toBeLessThan(working!.gap);
      }
      const path = join(SHOTS_DIR, `sidebar-idle-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar idle group screenshot: ${path}`);
    }
  }, 30_000);

  it("at 240, 300 and 360 px the rows keep one grammar: heights per kind, the state slot at the edge, the meta line in order, no trip glyphs, the thread title up to the time column, in both themes", async () => {
    interface WorkspaceRead {
      id: string | null;
      height: number;
      state: string;
      /** The state slot's right edge against the name line's right edge, and the slot's own box. */
      slotFlush: number;
      slotRight: number;
      slotWidth: number;
      nameX: number;
      meta: string;
      title: string | null;
      metaClipped: boolean;
      metaRight: number;
      glyphs: string[];
    }
    interface ThreadRead {
      height: number;
      titleX: number;
      titleRight: number;
      timeX: number;
      timeRight: number;
      timeWidth: number;
      rowX: number;
      rowRight: number;
      /** The row's own right edge, before its padding. */
      rowEdge: number;
      mono: boolean;
    }
    const readRows = () =>
      page!.evaluate(() => {
        const workspaces = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='ws:']")).map(row => {
          const slot = row.querySelector<HTMLElement>("[data-workspace-state]")!;
          const meta = row.querySelector<HTMLElement>("[data-workspace-meta]")!;
          const name = row.querySelector<HTMLElement>("[data-workspace-name]")!;
          const line = slot.parentElement!.getBoundingClientRect();
          const slotBox = slot.getBoundingClientRect();
          return {
            id: row.getAttribute("data-row-id"),
            height: row.getBoundingClientRect().height,
            state: slot.textContent ?? "",
            slotFlush: line.right - slotBox.right,
            slotRight: slotBox.right,
            slotWidth: slotBox.width,
            nameX: name.getBoundingClientRect().x,
            meta: meta.textContent ?? "",
            title: meta.getAttribute("title"),
            metaClipped: meta.scrollWidth > meta.clientWidth,
            metaRight: meta.getBoundingClientRect().right,
            glyphs: Array.from(row.parentElement!.querySelectorAll<HTMLElement>("[data-sidebar=menu-action]")).map(b => b.getAttribute("aria-label") ?? ""),
          } satisfies WorkspaceRead;
        });
        const threads = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='thread:']")).map(row => {
          const title = row.querySelector<HTMLElement>("[data-thread-title]")!;
          const time = title.nextElementSibling as HTMLElement;
          const box = row.getBoundingClientRect();
          const padding = getComputedStyle(row);
          return {
            height: box.height,
            titleX: title.getBoundingClientRect().x,
            titleRight: title.getBoundingClientRect().right,
            timeX: time.getBoundingClientRect().x,
            timeRight: time.getBoundingClientRect().right,
            timeWidth: time.getBoundingClientRect().width,
            rowX: box.x + parseFloat(padding.paddingLeft),
            rowRight: box.right - parseFloat(padding.paddingRight),
            rowEdge: box.right,
            mono: /mono/i.test(getComputedStyle(time).fontFamily),
          } satisfies ThreadRead;
        });
        const plus = document.querySelector<HTMLElement>("[data-row-id='ws:ws_a'] ~ [data-sidebar=menu-action][aria-label='New thread in api']")!;
        const plusRight = plus.getBoundingClientRect().right;
        const idle = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='settled:']")).map(row => row.getBoundingClientRect().height);
        const trips = document.querySelectorAll("[data-slot=sidebar] svg.lucide-folder-input, [data-slot=sidebar] svg.lucide-folder-output").length;
        return { workspaces, threads, idle, trips, plusRight };
      });
    // Three remembered widths and the width the shell opens at with nothing remembered.
    for (const width of [240, 300, 360, null]) {
      for (const theme of ["dark", "light"] as const) {
        await page!.goto(`${base}?theme=${theme}${width === null ? "" : `&sidebar=${width}`}`);
        await page!.waitForSelector("[data-sidebar-row]");
        if (width !== null) await page!.waitForFunction(w => Math.abs(document.querySelector("[data-slot=sidebar]")!.getBoundingClientRect().width - w) < 1, width);
        const rows = await readRows();
        console.info(`rows at ${width ?? "default"} ${theme}: ${JSON.stringify(rows)}`);
        expect(rows.workspaces.map(r => r.id)).toEqual(["ws:ws_a", "ws:ws_b", "ws:ws_c"]);
        // Two-line rows are 44 px, the Idle rows the kit's 32 px row, whatever the state or the width.
        expect(rows.workspaces.map(r => r.height)).toEqual([44, 44, 44]);
        expect(rows.threads.map(r => r.height)).toEqual([44, 44, 44, 44]);
        expect(rows.idle).toEqual([32, 32]);
        // The state slot: empty for running, the word for the rest, flush with the line's right edge on every row, two
        // glyphs wide at least; a live row's line runs to the row's own inset, a dead row's stops before its two glyphs.
        expect(rows.workspaces.map(r => r.state)).toEqual(["", "Paused", "Gone"]);
        for (const row of rows.workspaces) expect(Math.abs(row.slotFlush)).toBeLessThan(1);
        for (const row of rows.workspaces) expect(row.slotWidth).toBeGreaterThanOrEqual(44);
        const [live, paused, gone] = rows.workspaces as [WorkspaceRead, WorkspaceRead, WorkspaceRead];
        const rowBox = await box("[data-row-id='ws:ws_a']");
        expect(Math.abs(live.slotRight - (rowBox.x + rowBox.width - 8))).toBeLessThan(1);
        expect(Math.round(paused.slotRight)).toBe(Math.round(live.slotRight));
        expect(Math.round(gone.slotRight)).toBe(Math.round(live.slotRight) - 48);
        expect(new Set(rows.workspaces.map(r => Math.round(r.nameX))).size).toBe(1);
        // On hover the word yields and the glyphs take the slot; the name and the line under it stay put.
        const before = await box("[data-row-id='ws:ws_b'] [data-workspace-state]");
        const nameBefore = await box("[data-row-id='ws:ws_b'] [data-workspace-name]");
        await page!.locator("[data-row-id='ws:ws_b']").hover();
        await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-row-id='ws:ws_b'] [data-workspace-state]")!).opacity === "0");
        expect(await box("[data-row-id='ws:ws_b'] [data-workspace-state]")).toEqual(before);
        expect(await box("[data-row-id='ws:ws_b'] [data-workspace-name]")).toEqual(nameBefore);
        const hovered = await page!.locator("[data-row-id='ws:ws_b'] ~ [data-sidebar=menu-action]").evaluateAll((els, slot) => els.map(el => {
          const b = el.getBoundingClientRect();
          return { opacity: getComputedStyle(el).opacity, inside: b.x >= slot.x - 1 && b.right <= slot.right + 1 && b.y >= slot.y - 8 && b.bottom <= slot.bottom + 8, box: b.toJSON() as unknown };
        }), { x: before.x, right: before.x + before.width, y: before.y, bottom: before.y + before.height });
        console.info(`hovered glyphs at ${width ?? "default"} ${theme}: ${JSON.stringify({ hovered, slot: before })}`);
        expect(hovered.map(g => ({ opacity: g.opacity, inside: g.inside }))).toEqual([{ opacity: "1", inside: true }, { opacity: "1", inside: true }]);
        await page!.mouse.move(600, 700);
        // The meta line in its one order, whole in the title, cut from the right when the width asks.
        expect(rows.workspaces[0]!.meta).toBe("$0.29 today · $0.110/hr · naps in 15m");
        expect(rows.workspaces[0]!.title).toBe(rows.workspaces[0]!.meta);
        if (width === 240) expect(rows.workspaces[0]!.metaClipped).toBe(true);
        // The rows without a tick lead with an honest zero: no second line is ever blank.
        expect(rows.workspaces[1]!.meta).toBe("$0.00 today");
        expect(rows.workspaces[2]!.meta).toBe("$0.00 today");
        expect(Math.round(live.metaRight)).toBe(Math.round(live.slotRight));
        // No import or export glyph anywhere; a live row's glyphs are its chevron and plus, a gone row's forget and rebuild.
        expect(rows.trips).toBe(0);
        expect(rows.workspaces.map(r => r.glyphs)).toEqual([["Collapse api", "New thread in api"], ["Collapse web", "New thread in web"], ["Forget old", "Rebuild old"]]);
        // The thread row ends where the workspace row ends, and its mono time column, three characters wide, ends where the
        // workspace row's plus glyph does; the title runs to one row gap before the column.
        expect(Math.abs(rows.plusRight - live.slotRight)).toBeLessThan(1);
        for (const row of rows.threads) {
          expect(row.mono).toBe(true);
          expect(Math.abs(row.rowEdge - (rowBox.x + rowBox.width))).toBeLessThan(1);
          expect(Math.abs(row.timeRight - rows.plusRight)).toBeLessThan(1);
          expect(Math.abs(row.timeRight - row.rowRight)).toBeLessThan(1);
          expect(Math.abs(row.titleRight + 8 - row.timeX)).toBeLessThan(1);
          expect(row.timeWidth).toBeGreaterThanOrEqual(3 * 6);
          expect(row.timeWidth).toBeLessThan(3 * 8);
          expect(row.titleRight - row.titleX).toBeGreaterThan((row.rowRight - row.rowX) * 0.6);
        }
        expect(new Set(rows.threads.map(r => Math.round(r.timeWidth))).size).toBe(1);
        // A short title starts where a long one does: the text is left-aligned, not centred in its box.
        if (width === 360) {
          const short = await page!.locator("[data-thread-title]").evaluateAll(els => els.filter(el => el.scrollWidth <= el.clientWidth).map(el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getBoundingClientRect().x - el.getBoundingClientRect().x;
          }));
          expect(short.length).toBeGreaterThan(0);
          for (const gap of short) expect(Math.abs(gap)).toBeLessThan(1);
        }
        // The thread title sits at the same inset from its row's edge as the workspace name from its own.
        const inset = rows.workspaces[0]!.nameX - (await box("[data-row-id='ws:ws_a']")).x;
        for (const row of rows.threads) expect(Math.abs(row.titleX - row.rowX - (inset - 8))).toBeLessThan(1);
        const path = join(SHOTS_DIR, `sidebar-rows-${width ?? "default"}-${theme}.png`);
        await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
        console.info(`sidebar rows screenshot: ${path}`);
      }
    }
  }, 120_000);

  it("the Spaces body is one workspace under its header with a dot per workspace at the bottom, at three widths in both themes", async () => {
    const readSpaces = () =>
      page!.evaluate(() => {
        const header = document.querySelector<HTMLElement>("[data-space-header]")!;
        const name = header.querySelector<HTMLElement>("[data-space-name]")!;
        const row = document.querySelector<HTMLElement>("[data-space-dots]")!;
        const sidebar = document.querySelector<HTMLElement>("[data-slot=sidebar]")!.getBoundingClientRect();
        const thread = document.querySelector<HTMLElement>("[data-row-id^='thread:']")!.getBoundingClientRect();
        return {
          workspaceRows: document.querySelectorAll("[data-row-id^='ws:']").length,
          threads: Array.from(document.querySelectorAll<HTMLElement>("[data-row-id^='thread:']")).map(r => r.getAttribute("data-row-id")),
          name: name.textContent ?? "",
          nameX: name.getBoundingClientRect().x,
          state: header.querySelector<HTMLElement>("[data-space-state]")!.textContent ?? "",
          lines: Array.from(header.querySelectorAll<HTMLElement>("[data-space-meta]")).map(line => {
            const b = line.getBoundingClientRect();
            const style = getComputedStyle(line);
            return { text: line.textContent ?? "", mono: /mono/i.test(style.fontFamily), size: style.fontSize, right: b.right, overflow: line.scrollWidth > line.clientWidth };
          }),
          headerBottom: header.getBoundingClientRect().bottom,
          threadTop: thread.top,
          dots: Array.from(row.querySelectorAll<HTMLElement>("[data-space-dot]")).map(dot => {
            const b = dot.getBoundingClientRect();
            return { label: dot.getAttribute("aria-label") ?? "", current: dot.hasAttribute("data-space-dot-current"), text: dot.textContent ?? "", x: b.x, right: b.right, y: b.y, width: b.width, height: b.height };
          }),
          rowBox: { y: row.getBoundingClientRect().y, bottom: row.getBoundingClientRect().bottom, right: row.getBoundingClientRect().right, height: row.getBoundingClientRect().height },
          sidebar: { x: sidebar.x, right: sidebar.right, bottom: sidebar.bottom },
        };
      });
    for (const width of [240, 300, 360]) {
      for (const theme of ["dark", "light"] as const) {
        await page!.goto(`${base}?theme=${theme}&spaces=1&sidebar=${width}`);
        await page!.waitForSelector("[data-space-header]");
        await page!.waitForFunction(w => Math.abs(document.querySelector("[data-slot=sidebar]")!.getBoundingClientRect().width - w) < 1, width);
        const read = await readSpaces();
        console.info(`spaces at ${width} ${theme}: ${JSON.stringify(read)}`);
        // One workspace on screen: the one id under ws: is the header's, which wears the row's id so the arrow
        // walk stops there, and under it only that workspace's threads.
        expect(read.workspaceRows).toBe(1);
        expect(read.threads).toEqual(["thread:s1", "thread:s2"]);
        expect(read.name).toBe("api");
        expect(read.state).toBe("");
        expect(read.lines.map(line => line.text)).toEqual(["2 vCPU · 4 GB · Linux", "$0.29 today · $0.110/hr", "naps in 15m"]);
        // The meta lines are the rows' own muted mono, and every one of them stays inside the sidebar at every width.
        for (const line of read.lines) {
          expect(line.mono).toBe(true);
          expect(line.size).toBe("11px");
          expect(line.right).toBeLessThanOrEqual(read.sidebar.right);
          expect(line.overflow).toBe(false);
        }
        expect(read.headerBottom).toBeLessThanOrEqual(read.threadTop);
        // One dot per workspace, on one line at the sidebar's bottom, inside its width.
        expect(read.dots.map(dot => dot.label)).toEqual(["api", "web", "old"]);
        expect(read.dots.map(dot => dot.current)).toEqual([true, false, false]);
        expect(read.dots.map(dot => dot.text)).toEqual(["api", "", ""]);
        expect(new Set(read.dots.map(dot => Math.round(dot.y))).size).toBe(1);
        expect(new Set(read.dots.map(dot => Math.round(dot.height))).size).toBe(1);
        const [current, ...rest] = read.dots as [(typeof read.dots)[number], ...(typeof read.dots)[number][]];
        for (const dot of rest) expect(current.width).toBeGreaterThan(dot.width);
        expect(read.rowBox.right).toBeLessThanOrEqual(read.sidebar.right);
        expect(read.rowBox.bottom).toBeLessThanOrEqual(read.sidebar.bottom);
        expect(read.rowBox.y).toBeGreaterThan(read.headerBottom);
        expect(read.dots.at(-1)!.right).toBeLessThanOrEqual(read.sidebar.right);
        // A click on another workspace's dot moves the body to it and the name onto that dot.
        await page!.locator("[data-space-dot][aria-label=web]").click();
        await page!.waitForFunction(() => document.querySelector("[data-space-header] [data-space-name]")?.textContent === "web");
        const moved = await readSpaces();
        expect(moved.dots.map(dot => dot.text)).toEqual(["", "web", ""]);
        expect(moved.state).toBe("Paused");
        expect(moved.lines.map(line => line.text)).toEqual(["2 vCPU · 4 GB · Linux", "$0.00 today"]);
        await page!.locator("[data-space-dot][aria-label=api]").click();
        await page!.waitForFunction(() => document.querySelector("[data-space-header] [data-space-name]")?.textContent === "api");
        // The pointer leaves the row and its hover fades out before the shot, so what is saved is the rest state:
        // no dot carries a fill of its own. Every dot is waited on, not the first: the case hovers two of them, and
        // their fades run on their own clocks.
        await page!.mouse.move(600, 700);
        await page!.waitForFunction(() =>
          [...document.querySelectorAll("[data-space-dot]")].every(el => getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)"),
        );
        const atRest = await page!.locator("[data-space-dot]").evaluateAll(els => els.map(el => getComputedStyle(el).backgroundColor));
        expect(atRest).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
        const path = join(SHOTS_DIR, `sidebar-spaces-${width}-${theme}.png`);
        await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
        console.info(`sidebar spaces screenshot: ${path}`);
      }
    }
  }, 120_000);

  it("moving to another space travels the body out the way it was pushed and the next one in, over a still header and dots row, and reduced motion swaps it at once, in both themes", async () => {
    // The travel is read off the animation itself, seeked rather than raced: a frame sampled on a loaded machine
    // says nothing about where the body was at the halfway mark.
    const travel = (label: string) =>
      page!.evaluate(async ({ name, ms }) => {
        const track = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-space-track]");
        const still = (): { dots: DOMRect; section: DOMRect } => ({
          dots: document.querySelector<HTMLElement>("[data-space-dots]")!.getBoundingClientRect(),
          section: document.querySelector<HTMLElement>("button[aria-label='Workspaces']")!.getBoundingClientRect(),
        });
        const before = still();
        document.querySelector<HTMLElement>(`[data-space-dot][aria-label=${name}]`)!.click();
        // React runs the travel's effect a task after the click, so the animation is waited for rather than assumed;
        // it is seeked below, so the few milliseconds spent here do not reach the readings.
        for (let i = 0; i < 100 && (track()?.getAnimations().length ?? 0) === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
        const el = track();
        const [animation] = el?.getAnimations() ?? [];
        if (el === null || animation === undefined) return null;
        const x = (): number => {
          const shape = getComputedStyle(el).transform;
          return shape === "none" ? 0 : new DOMMatrixReadOnly(shape).m41;
        };
        const at = (time: number): number => {
          animation.currentTime = time;
          return x();
        };
        animation.pause();
        const style = getComputedStyle(el);
        const read = {
          width: el.getBoundingClientRect().width,
          start: at(0),
          mid: at(ms / 2),
          end: at(ms),
          duration: style.animationDuration,
          easing: style.animationTimingFunction,
          panes: document.querySelectorAll("[data-space-pane]").length,
          leaving: document.querySelector<HTMLElement>("[data-space-leaving] [data-space-name]")?.textContent ?? "",
          staying: document.querySelector<HTMLElement>("[data-space-pane]:not([data-space-leaving]) [data-space-name]")?.textContent ?? "",
          moved: (() => {
            const now = still();
            return { dots: Math.abs(now.dots.x - before.dots.x) + Math.abs(now.dots.y - before.dots.y), section: Math.abs(now.section.x - before.section.x) + Math.abs(now.section.y - before.section.y) };
          })(),
        };
        animation.play();
        return read;
      }, { name: label, ms: SPACE_SLIDE_MS });
    const settled = () =>
      page!.evaluate(() => ({
        panes: document.querySelectorAll("[data-space-pane]").length,
        transform: getComputedStyle(document.querySelector<HTMLElement>("[data-space-track]")!).transform,
        name: document.querySelector<HTMLElement>("[data-space-name]")?.textContent ?? "",
      }));

    for (const theme of ["dark", "light"] as const) {
      // Headless Chromium asks for less motion unless it is told otherwise, and that is the other half of this case.
      await page!.emulateMedia({ reducedMotion: "no-preference" });
      await page!.goto(`${base}?theme=${theme}&spaces=1`);
      await page!.waitForSelector("[data-space-header]");
      // Pushed forward: the body that was on screen travels left and the next one follows it in from the right.
      const forward = await travel("web");
      console.info(`space travel forward ${theme}: ${JSON.stringify(forward)}`);
      expect(forward).not.toBeNull();
      expect(forward!.duration).toBe(`${SPACE_SLIDE_MS / 1000}s`);
      expect(forward!.easing).toBe("ease-out");
      expect(forward!.panes).toBe(2);
      expect(forward!.leaving).toBe("api");
      expect(forward!.staying).toBe("web");
      // The track holds both bodies, so it is twice the sidebar's body and the travel is half of it.
      expect(Math.abs(forward!.start)).toBeLessThan(1);
      expect(Math.abs(forward!.end + forward!.width / 2)).toBeLessThan(1);
      // Halfway through the clock it is between the two, and never past the body it is going to: no bounce.
      expect(forward!.mid).toBeLessThan(-1);
      expect(forward!.mid).toBeGreaterThan(forward!.end + 1);
      // The sidebar's own header row and the dots row do not move under it.
      expect(forward!.moved.dots).toBeLessThan(1);
      expect(forward!.moved.section).toBeLessThan(1);
      await page!.waitForFunction(() => document.querySelectorAll("[data-space-pane]").length === 1);
      const rested = await settled();
      expect(rested).toEqual({ panes: 1, transform: "none", name: "web" });

      // Pushed the other way: the travel runs in reverse, ending on the body that has come back.
      const back = await travel("api");
      console.info(`space travel back ${theme}: ${JSON.stringify(back)}`);
      expect(back).not.toBeNull();
      expect(back!.leaving).toBe("web");
      expect(back!.staying).toBe("api");
      expect(Math.abs(back!.start + back!.width / 2)).toBeLessThan(1);
      expect(Math.abs(back!.end)).toBeLessThan(1);
      expect(back!.mid).toBeGreaterThan(back!.start + 1);
      expect(back!.mid).toBeLessThan(-1);
      await page!.waitForFunction(() => document.querySelectorAll("[data-space-pane]").length === 1);
      expect(await settled()).toEqual({ panes: 1, transform: "none", name: "api" });

      // Asked for less motion, the body swaps with nothing moving: one pane, no animation, no transform.
      await page!.emulateMedia({ reducedMotion: "reduce" });
      await page!.goto(`${base}?theme=${theme}&spaces=1`);
      await page!.waitForSelector("[data-space-header]");
      const swap = await page!.evaluate(async () => {
        const track = (): HTMLElement => document.querySelector<HTMLElement>("[data-space-track]")!;
        document.querySelector<HTMLElement>("[data-space-dot][aria-label=web]")!.click();
        // Watched over the window a travel would have opened in: no second body ever comes up, and nothing animates.
        let mostPanes = 0;
        let animations = 0;
        for (let i = 0; i < 60; i++) {
          await new Promise(resolve => setTimeout(resolve, 1));
          mostPanes = Math.max(mostPanes, document.querySelectorAll("[data-space-pane]").length);
          animations = Math.max(animations, track().getAnimations().length);
        }
        return { mostPanes, animations, transform: getComputedStyle(track()).transform, name: document.querySelector<HTMLElement>("[data-space-name]")?.textContent ?? "" };
      });
      console.info(`space swap with reduced motion ${theme}: ${JSON.stringify(swap)}`);
      expect(swap).toEqual({ mostPanes: 1, animations: 0, transform: "none", name: "web" });
      await page!.emulateMedia({ reducedMotion: null });
    }
  }, 60_000);

  it("a space asked for mid-travel turns the body around from where it is, draws no body twice, and the track clips sideways only, in both themes", async () => {
    const TURN_AFTER_MS = 80;
    for (const theme of ["dark", "light"] as const) {
      await page!.emulateMedia({ reducedMotion: "no-preference" });
      await page!.goto(`${base}?theme=${theme}&spaces=1`);
      await page!.waitForSelector("[data-space-header]");
      const errors: string[] = [];
      const listen = (message: ConsoleMessage): void => {
        if (message.type() === "error") errors.push(message.text());
      };
      page!.on("console", listen);
      // Every frame of a travel turned around after 80 ms: where the track is, and which bodies are on screen.
      const run = await page!.evaluate(async turnAfter => {
        const track = (): HTMLElement => document.querySelector<HTMLElement>("[data-space-track]")!;
        const readX = (): number => {
          const shape = getComputedStyle(track()).transform;
          const matrix = /^matrix\(([^)]*)\)$/.exec(shape);
          return matrix === null ? 0 : Number(matrix[1]!.split(",")[4]);
        };
        const frame = () => ({ at: performance.now(), x: readX(), names: Array.from(document.querySelectorAll<HTMLElement>("[data-space-pane] [data-space-name]")).map(name => name.textContent ?? "") });
        const click = (name: string): void => document.querySelector<HTMLElement>(`[data-space-dot][aria-label=${name}]`)!.click();
        const paint = (): Promise<unknown> => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
        const frames: ReturnType<typeof frame>[] = [];
        click("web");
        // The travel comes up in the click's own render, but a browser under load can hold that render back, and two
        // clicks landing in one render would be no travel at all rather than a travel turned around.
        for (let i = 0; i < 200 && document.querySelectorAll("[data-space-pane]").length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
        const started = performance.now();
        while (performance.now() - started < turnAfter) {
          await paint();
          frames.push(frame());
        }
        click("api");
        while (performance.now() - started < turnAfter + 400) {
          await paint();
          frames.push(frame());
        }
        const wrapper = document.querySelector<HTMLElement>("[data-space-slide]")!;
        const clip = getComputedStyle(wrapper);
        return {
          frames,
          width: track().getBoundingClientRect().width,
          leftOver: track().style.getPropertyValue("--space-slide-from"),
          clip: { x: clip.overflowX, y: clip.overflowY, scrolls: wrapper.scrollHeight > wrapper.clientHeight },
        };
      }, TURN_AFTER_MS);
      page!.off("console", listen);

      const deepest = Math.max(...run.frames.map(read => -read.x));
      const steps = run.frames.slice(1).map((read, i) => ({ px: Math.abs(read.x - run.frames[i]!.x), ms: read.at - run.frames[i]!.at }));
      const fastest = Math.max(...steps.filter(step => step.ms > 0).map(step => step.px / step.ms));
      console.info(`space turn ${theme}: ${JSON.stringify({ deepest, fastest, frames: run.frames.length, width: run.width, leftOver: run.leftOver, clip: run.clip, last: run.frames.at(-1) })}`);
      // The page keeps its own counsel: a body drawn twice under one key is a React error in the console.
      expect(errors).toEqual([]);
      // No frame ever draws one workspace as both bodies.
      expect(run.frames.filter(read => read.names.length === 2 && read.names[0] === read.names[1])).toEqual([]);
      // The body turned around where it had got to: it never reaches the far side it was heading for.
      expect(deepest).toBeGreaterThan(20);
      expect(deepest).toBeLessThan(run.width / 2 - 20);
      // And it never jumps: five times the travel's own average speed is far under a teleport and far over a frame.
      expect(fastest).toBeLessThan((5 * (run.width / 2)) / SPACE_SLIDE_MS);
      // It settles on the space asked for, at rest, with the offset it was handed dropped again.
      expect(run.frames.at(-1)).toMatchObject({ x: 0, names: ["api"] });
      expect(run.leftOver).toBe("");
      // The track clips sideways only, so the wrapper is no scroll container of its own.
      expect(run.clip).toEqual({ x: "clip", y: "visible", scrolls: false });
    }
  }, 60_000);

  it("a status toast with a 200-character token stays inside the sidebar's width, in both themes", async () => {
    const token = "ZGVza3RvcC1wb29s".repeat(13).slice(0, 200);
    const toast = encodeURIComponent(`Stopped the builder ${token} to make room at the machine cap.`);
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&toast=${toast}`);
      const status = page!.locator("[data-slot=sidebar-footer] [role=status]").first();
      await status.waitFor();
      const sidebar = await box("[data-slot=sidebar]");
      const b = await box("[data-slot=sidebar-footer] [role=status]");
      expect(b.x).toBeGreaterThanOrEqual(sidebar.x);
      expect(b.x + b.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
      expect(await status.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      const path = join(SHOTS_DIR, `sidebar-toast-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar toast screenshot: ${path}`);
    }
  }, 30_000);

  it("Solari out of reach is one muted mono line under the search row, above Workspaces, with no box, badge or colour of its own, and the rows keep their words, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&offline=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const line = page!.locator("[data-sidebar-offline]").first();
      await line.waitFor();
      expect((await line.textContent())?.trim()).toBe(PROVIDER_UNREACHED_LINE);
      const b = await box("[data-sidebar-offline]");
      const search = await box("button[aria-label='Search']");
      const section = await box("button[aria-label='Workspaces']");
      expect(b.y).toBeGreaterThanOrEqual(search.y + search.height);
      expect(b.y + b.height).toBeLessThanOrEqual(section.y + 0.5);
      expect(Math.abs(b.x - search.x)).toBeLessThan(1);
      expect(await line.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      const style = await line.evaluate(el => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, border: s.borderTopWidth, shadow: s.boxShadow, font: s.fontFamily, size: s.fontSize };
      });
      expect(style.background).toBe("rgba(0, 0, 0, 0)");
      expect(style.border).toBe("0px");
      expect(style.shadow).toBe("none");
      expect(style.font.toLowerCase()).toMatch(/mono/);
      // The line's ink is the muted foreground beside it, not a colour of its own.
      const [lineColor, metaColor] = await Promise.all([
        line.evaluate(el => getComputedStyle(el).color),
        page!.locator("[data-row-id='ws:ws_a'] [data-workspace-meta]").first().evaluate(el => getComputedStyle(el).color),
      ]);
      expect(lineColor).toBe(metaColor);
      expect((await page!.locator("[data-row-id='ws:ws_a'] [data-workspace-state]").textContent())?.trim()).toBe("");
      expect((await page!.locator("[data-row-id='ws:ws_b'] [data-workspace-state]").textContent())?.trim()).toBe("Paused");
      const path = join(SHOTS_DIR, `sidebar-offline-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar offline screenshot: ${path}`);
    }
  }, 30_000);

  it("the line the runtime puts on a machine's row is the whole second line, drawn whole and at the row's own height, in both themes", async () => {
    const metaOf = (): Promise<{ text: string; clipped: boolean; height: number }[]> =>
      page!.locator("[data-row-id^='ws:']").evaluateAll(rows =>
        rows.map(row => {
          const meta = row.querySelector<HTMLElement>("[data-workspace-meta]");
          // textContent is the whole string whatever CSS does to it, so what the person sees is scroll against client.
          return { text: meta?.textContent ?? "", clipped: meta !== null && meta.scrollWidth > meta.clientWidth, height: row.getBoundingClientRect().height, widths: [meta?.clientWidth, meta?.scrollWidth, document.querySelector("[data-slot=sidebar]")!.getBoundingClientRect().width] };
        }),
      );
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const plain = await metaOf();
      expect(plain[0]!.text).toContain("$0.110/hr");
      expect(plain[0]!.text).not.toContain("helper");

      await page!.goto(`${base}?theme=${theme}&helper=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const updating = await metaOf();
      console.info(`helper line at ${theme}: ${JSON.stringify(updating[0])}`);
      // The whole line, nothing beside it, drawn whole rather than cut, and the row is the height it always was.
      // The slot is about 159px at the default width, so a line that outgrows it goes red here.
      expect(updating[0]!.text).toBe("updating the helper");
      expect(updating[0]!.clipped).toBe(false);
      expect(updating[0]!.height).toBe(plain[0]!.height);
      expect(updating.slice(1).map(m => m.text)).toEqual(plain.slice(1).map(m => m.text));
      const path = join(SHOTS_DIR, `sidebar-helper-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar helper line screenshot: ${path}`);

      // The same slot when the link dropped after a near-full sample: the row form of the words, whole.
      await page!.goto(`${base}?theme=${theme}&oom=1`);
      await page!.waitForSelector("[data-sidebar-row]");
      const oom = await metaOf();
      expect(oom[0]!.text).toBe("out of memory, 3.6 of 3.9 GB");
      expect(oom[0]!.clipped).toBe(false);
      expect(oom[0]!.height).toBe(plain[0]!.height);
      const oomPath = join(SHOTS_DIR, `sidebar-oom-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: oomPath });
      console.info(`sidebar out-of-memory line screenshot: ${oomPath}`);
    }
  }, 30_000);

  it("a send refusal is one muted mono line, no panel, in a slot the composer keeps at one height, in both themes", async () => {
    interface Composer {
      shell: Box;
      slot: Box;
      box: Box;
      text: string;
      /** The line's paint, or null when the slot is empty. */
      line: { mono: boolean; background: string; border: string; icons: number } | null;
      panels: number;
    }
    const composerAt = async (query: string, theme: string, name: string): Promise<Composer> => {
      await page!.goto(`${base}?theme=${theme}&${query}`);
      await page!.waitForSelector("[data-composer-refusal]");
      // The transcript is fetched after mount; the line for a lingering turn exists only once it is in.
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const line = el.querySelector<HTMLElement>("[data-composer-refusal] [role=status]");
        const s = line === null ? null : getComputedStyle(line);
        return {
          text: el.querySelector("[data-composer-refusal]")?.textContent ?? "",
          line: s === null || line === null ? null : { mono: /mono/i.test(s.fontFamily), background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderLeftWidth}`, icons: line.getElementsByTagName("svg").length },
          panels: el.querySelectorAll("[data-composer-banner-surface]").length,
        };
      });
      const path = join(SHOTS_DIR, `composer-${name}-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path });
      console.info(`composer ${name} screenshot: ${path}`);
      return { shell: await box("[data-chat-composer]"), slot: await box("[data-composer-refusal]"), box: await box("[data-slot=composer-shell]"), ...read };
    };
    for (const theme of ["dark", "light"] as const) {
      const idle = await composerAt("ws=ws_a", theme, "idle");
      expect(idle.text).toBe("");
      expect(idle.line).toBeNull();
      const paused = await composerAt("ws=ws_b", theme, "paused");
      const gone = await composerAt("ws=ws_c", theme, "gone");
      const working = await composerAt("ws=ws_a&linger=1", theme, "working");
      expect(paused.text).toBe(sendRefusal("paused"));
      expect(gone.text).toBe(sendRefusal("gone"));
      expect(working.text).toBe(stillWorkingRefusal("thr_linger"));
      for (const state of [paused, gone, working]) {
        // The words in mono, painted on nothing: no fill, no border, no icon, no panel anywhere in the composer.
        expect(state.line).toEqual({ mono: true, background: "rgba(0, 0, 0, 0)", border: "0px 0px", icons: 0 });
        expect(state.panels).toBe(0);
        // The slot and the box sit where they sit for the idle composer: the line moves nothing.
        expect(state.slot).toEqual(idle.slot);
        expect(state.box).toEqual(idle.box);
        expect(state.shell).toEqual(idle.shell);
      }
    }
  }, 60_000);

  it("the composer's images are a row of square thumbnails above the text, each with its own remove, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-image-picker]");
      const empty = await box("[data-chat-composer]");
      // The picker sits in the footer's left group, first, before the model and access pickers.
      const order = await page!.locator("[data-chat-composer-footer]").evaluate(el =>
        [...el.querySelectorAll("button")].map(b => b.getAttribute("aria-label") ?? b.textContent?.trim() ?? ""),
      );
      expect(order[0]).toBe("Add an image");
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
      const row = await box("[data-composer-images]");
      const editor = await box("[data-chat-composer-form] [contenteditable]");
      const shell = await box("[data-slot=composer-shell]");
      expect(row.y + row.height).toBeLessThanOrEqual(editor.y);
      expect(row.y).toBeGreaterThan(shell.y);
      expect(row.x + row.width).toBeLessThanOrEqual(shell.x + shell.width);
      const grown = await box("[data-chat-composer]");
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
    const expectBare = (marks: MarkRead[]) => {
      for (const mark of marks) {
        for (const side of mark.size) {
          expect(side).toBeGreaterThanOrEqual(13);
          expect(side).toBeLessThanOrEqual(16);
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
      expectBare(rail);
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
      const label = await page!.locator("[data-composer-picker='effort']").evaluate(el => el.textContent ?? "");
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
      await page!.waitForSelector("[data-composer-picker='effort'][data-value='low']");
      await page!.locator("[data-composer-picker='effort']").click();
      await page!.waitForSelector("[data-slot=menu-popup] [data-composer-option='medium']");
      const sol = await read();
      await page!.keyboard.press("Escape");
      await page!.locator("[data-composer-picker='model']").click();
      await page!.locator("[data-composer-option='gpt-5.5']").click();
      await page!.waitForSelector("[data-composer-picker='effort'][data-value='medium']");
      await page!.locator("[data-composer-picker='effort']").click();
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
      // The word is muted mono on nothing, the same caption the model menu marks its default with.
      expect(picked.badge).toEqual({ mono: true, bare: true, muted: true });
      const path = join(SHOTS_DIR, `composer-effort-${theme}.png`);
      await page!.screenshot({ path });
      console.info(`composer effort screenshot: ${path}`);
      await page!.keyboard.press("Escape");
    }
  }, 60_000);

  it("each tab's footer is one muted mono line naming that agent's own binary and pin, at the popup's width, in both themes", async () => {
    interface Footer {
      text: string;
      title: string;
      mono: boolean;
      bare: boolean;
      muted: boolean;
      height: number;
      /** Wider than the box it draws in, which is what a line the slot had to cut looks like. */
      cut: boolean;
    }
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&ws=ws_a`);
      await page!.waitForSelector("[data-composer-picker='model']");
      await page!.locator("[data-composer-picker='model']").click();
      await page!.waitForSelector("[data-composer-model-menu]");
      await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-slot=popover-popup]")!).opacity === "1");
      const read = async (): Promise<Footer> =>
        page!.locator("[data-composer-catalog-source]").evaluate(el => {
          const s = getComputedStyle(el);
          return {
            text: el.textContent ?? "",
            title: el.getAttribute("title") ?? "",
            mono: s.fontFamily.toLowerCase().includes("mono"),
            bare: s.backgroundColor === "rgba(0, 0, 0, 0)" && s.borderRadius === "0px" && s.boxShadow === "none",
            muted: s.color !== getComputedStyle(el.closest("[data-composer-model-menu]")!.querySelector("[role=option]")!).color,
            height: el.getBoundingClientRect().height,
            cut: el.scrollWidth > el.clientWidth,
          };
        });
      // The composer remembers the last agent picked for the workspace, so the tab to read from is chosen, not assumed.
      await page!.locator("[data-composer-harness='claude']").click();
      await page!.waitForFunction(() => document.querySelector("[data-composer-catalog-source]")?.textContent?.endsWith("on this machine") === true);
      const claude = await read();
      expect(claude.text).toBe("Claude Code 2.1.257 on this machine");
      await page!.locator("[data-composer-harness='codex']").click();
      await page!.waitForFunction(() => document.querySelector("[data-composer-catalog-source]")?.textContent?.includes(" table · ") === true);
      const codex = await read();
      expect(codex.text).toBe("codex table · app-server 0.153.0, 2026-09-07");
      // The words are the pinned table's own; a badge or a fill behind them would make a state out of a caption.
      for (const line of [claude, codex]) {
        expect([line.mono, line.bare, line.muted]).toEqual([true, true, true]);
        // One line at this width, uncut, and the same height on either tab: switching tabs must not move the popup.
        expect(line.cut).toBe(false);
        expect(line.title).toBe(line.text);
      }
      expect(codex.height).toBe(claude.height);
      const popup = await box("[data-slot=popover-popup]");
      const footer = await box("[data-composer-catalog-source]");
      expect(footer.width).toBeLessThanOrEqual(popup.width);
      expect(footer.y + footer.height).toBeLessThanOrEqual(popup.y + popup.height + 1);
      const path = join(SHOTS_DIR, `composer-catalog-source-${theme}.png`);
      await page!.locator("[data-slot=popover-popup]").screenshot({ path });
      console.info(`composer catalog source screenshot: ${path} (${JSON.stringify({ claude, codex })})`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-composer-model-menu]", { state: "detached" });
    }
  }, 60_000);

  it("collapsing the sidebar puts the page header's toggle where the sidebar's was, and the breadcrumb after it", async () => {
    await open("dark");
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
    expect(await page!.locator("header [data-thread-breadcrumb]").evaluate(el => el.textContent)).toBe("api/Reply with exactly the word hi.");
    const path = join(SHOTS_DIR, "header-collapsed-dark.png");
    await page!.screenshot({ path, clip: { x: 0, y: 0, width: 600, height: 120 } });
    console.info(`collapsed header screenshot: ${path}`);
  }, 30_000);
  /** One row's name slot: the row's height, where the name starts, where the slot at the right edge ends, and the
   * name's own font, read the same way whether the slot holds the text or the one name box. `selector` picks the row
   * and `nameSelector` the text it wears, so a workspace row and a thread row are read by the same rule. */
  const nameSlot = async (
    selector: string,
    nameSelector: string,
  ): Promise<{ rowHeight: number; nameX: number; slotRight: number; font: string; size: string; text: string; value: string; focused: boolean }> =>
    page!.locator(selector).first().evaluate((row: HTMLElement, of: string) => {
      const input = row.querySelector<HTMLInputElement>("[data-row-name-input]");
      const name = input ?? row.querySelector<HTMLElement>(of)!;
      const slot = row.querySelector<HTMLElement>(`${of} ~ span, [data-row-name-input] ~ span`)!;
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

  it("a right-click on a workspace row opens the in-app menu at the pointer in the tooltip skin, kept inside the viewport, and Escape closes it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const row = await box("[data-row-id='ws:ws_a']");
      // On the row's hover buttons too: the whole row is the workspace's.
      const at = { x: row.x + row.width - 12, y: row.y + row.height / 2 };
      await page!.mouse.click(at.x, at.y, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      const menu = await box("[data-context-menu]");
      expect(Math.abs(menu.x - at.x)).toBeLessThan(1);
      expect(Math.abs(menu.y - at.y)).toBeLessThan(1);
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
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(12);
      // Rebuild, the two project trips (this fake host has no folder ops), fork and forget.
      expect(await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").count()).toBe(5);
      // The first row that can run holds focus, so the keyboard is already in the menu.
      expect(await page!.locator("[data-context-menu] [role=menuitem]").first().evaluate(el => document.activeElement === el)).toBe(true);
      const path = join(SHOTS_DIR, `sidebar-context-menu-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 520 } });
      console.info(`sidebar context menu screenshot: ${path}`);
      // The refusal rides the tooltip skin: hovering a dimmed row shows it.
      await page!.locator("[data-context-menu] [role=menuitem][aria-disabled=true]").first().hover();
      await page!.waitForSelector("[data-slot=tooltip-popup]");
      expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toBe("Rebuild replaces a gone or zombie machine; this one answers");
      const tipPath = join(SHOTS_DIR, `sidebar-context-menu-refusal-${theme}.png`);
      await page!.screenshot({ path: tipPath, clip: { x: 0, y: 0, width: 640, height: 520 } });
      console.info(`sidebar context menu refusal screenshot: ${tipPath}`);
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-context-menu]", { state: "detached" });
      // Focus goes back where it was: the row's own button under the pointer, which Chromium focused on the press.
      expect(await page!.evaluate(() => document.activeElement?.closest("[data-sidebar='menu-item']")?.querySelector("[data-row-id='ws:ws_a']") !== null)).toBe(true);
      const thread = await box("[data-row-id^='thread:']");
      await page!.mouse.click(thread.x + 20, thread.y + thread.height / 2, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(4);
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

  it("Rename turns a workspace row's name into the same field in the same slot, from the menu and from a double-click, in both themes", async () => {
    const wsSlot = () => nameSlot("[data-row-id='ws:ws_a']", "[data-workspace-name]");
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const plain = await wsSlot();
      const row = await box("[data-row-id='ws:ws_a']");
      await page!.mouse.click(row.x + 40, row.y + row.height / 4, { button: "right" });
      await page!.waitForSelector("[data-context-menu]");
      await page!.locator("[data-context-menu] [role=menuitem]", { hasText: "Rename workspace" }).click();
      await page!.waitForSelector("[data-row-name-input]");

      // The field takes the name's place: the row keeps its height, the name starts where it started, the state slot
      // at the right edge keeps its place, and the field wears the name's own font and size.
      const named = await wsSlot();
      expect(named.rowHeight).toBe(plain.rowHeight);
      expect(named.nameX).toBe(plain.nameX);
      expect(named.slotRight).toBe(plain.slotRight);
      expect(named.font).toBe(plain.font);
      expect(named.size).toBe(plain.size);
      expect(named.value).toBe(plain.text);
      expect(named.focused).toBe(true);
      await page!.keyboard.type("the name he typed");
      const typed = await wsSlot();
      expect(typed.value).toBe("the name he typed");
      expect(typed.rowHeight).toBe(plain.rowHeight);
      expect(typed.slotRight).toBe(plain.slotRight);
      const path = join(SHOTS_DIR, `workspace-row-renaming-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 300 } });
      console.info(`workspace row renaming screenshot: ${path}`);

      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[data-row-name-input]", { state: "detached" });
      expect((await wsSlot()).text).toBe(plain.text);

      // A double-click on the name opens the same box, and Enter names the workspace: the row reads the new name.
      await page!.locator("[data-row-id='ws:ws_a'] [data-workspace-name]").dblclick();
      await page!.waitForSelector("[data-row-name-input]");
      await page!.keyboard.type("the name he typed");
      await page!.keyboard.press("Enter");
      await page!.waitForSelector("[data-row-name-input]", { state: "detached" });
      expect((await wsSlot()).text).toBe("the name he typed");
      expect((await wsSlot()).rowHeight).toBe(plain.rowHeight);
    }
  }, 60_000);
});
