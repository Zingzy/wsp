// SPDX-License-Identifier: AGPL-3.0-only
// The shell's chrome in a real Chromium: the sidebar's brand lockup starts
// where the search row does and the sidebar toggle ends where the rows end,
// the two top rows are one height and start where the workspace rows do, the
// search row sits on the selected row's surface with a hairline and opens the
// palette without moving a row, a thread row's title keeps its room at the
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
// under its header with a dot per workspace at the sidebar's bottom, a
// workspace's own hue paints the sidebar's surface and its glyph in Spaces
// and its threads' rail alone in the list, the
// move to another space travels that body out the way it was pushed and the
// next one in from the other side while the header and the dots row hold
// still, or swaps it with no travel for a reader who asked for less motion,
// a mixed list of a local machine and two cloud ones keeps that one
// grammar with the kind's glyph in the local lead, and the threads quiet for
// over a day sit in an Archived group shut inside that workspace's idle
// shelf, in the shelf header's own row grammar. Vite
// serves test/shell to Playwright's browser, so like the glyph test it runs
// only when asked for (WSP_RENDER=1) and skips without Playwright's Chromium
// on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, ConsoleMessage, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accessFromNextMessage, FREE_WORD, PROVIDER_UNREACHED_LINE, sendRefusal, stillWorkingRefusal, THIS_COMPUTER } from "@wsp/protocol";
import { WAKE_AND_SEND_LABEL } from "../src/components/chat/ComposerPrimaryActions";
import { LOCKUP_OPTICAL_CENTRE } from "../src/brand/optical";
import { SPACE_SLIDE_MS } from "../src/sidebar/SpaceSlide";
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

  it("the brand lockup starts where the search row does and the sidebar toggle ends where the rows end, on one centre line, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const toggle = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
      const lockup = await box("[data-slot=sidebar-header] [role=img][aria-label=wsp]");
      const search = await box("button[aria-label='Search']");
      expect(Math.abs(lockup.x - search.x)).toBeLessThan(1);
      expect(Math.abs(toggle.x + toggle.width - (search.x + search.width))).toBeLessThan(1);
      expect(toggle.x).toBeGreaterThan(lockup.x + lockup.width);
      // One vertical centre: the toggle glyph's ink (its icon box, whose panel fills it edge to edge) and the wordmark's optical centre.
      const glyph = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger] svg");
      expect(Math.abs(glyph.y + glyph.height / 2 - (lockup.y + lockup.height * LOCKUP_OPTICAL_CENTRE))).toBeLessThan(0.5);
      const path = join(SHOTS_DIR, `sidebar-header-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar header screenshot: ${path}`);
    }
  }, 30_000);

  it("the search row and the Workspaces row are one height, start where the workspace rows do, the search row alone sits on the selected row's surface inside a hairline and takes the rows' hover, they carry one glyph each at the right edge and no chord on their faces, and open the palette without moving anything", async () => {
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
    /** What a utility class paints beside the search row, read off a probe in the row's own scope (the glass
     * re-declares the row tokens), so the row is held to the token and not to a colour written here. */
    const tokenPaint = (utility: string): Promise<string> =>
      page!.locator("[data-sidebar-search]").first().evaluate((host, cls) => {
        const probe = document.createElement("span");
        probe.className = cls;
        host.append(probe);
        const paint = cls.startsWith("border") ? getComputedStyle(probe).borderTopColor : getComputedStyle(probe).backgroundColor;
        probe.remove();
        return paint;
      }, utility);
    const skin = (selector: string): Promise<{ background: string; border: string; borderColor: string; shadow: string }> =>
      page!.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el);
        return { background: s.backgroundColor, border: s.borderTopWidth, borderColor: s.borderTopColor, shadow: s.boxShadow };
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
      // The field's surface is the selected row's token and its edge the sidebar's hairline: two rows on one tier.
      const rest = await skin("button[aria-label='Search']");
      expect(rest.background).toBe(await tokenPaint("bg-sidebar-row-selected"));
      expect(rest.border).toBe("1px");
      expect(rest.borderColor).toBe(await tokenPaint("border border-sidebar-border"));
      expect(rest.shadow).toBe("none");
      await page!.locator("button[aria-label='Search']").hover();
      await page!.waitForTimeout(250);
      const hovered = await skin("button[aria-label='Search']");
      expect(hovered.background).toBe(await tokenPaint("bg-sidebar-row-hover"));
      expect(hovered.border).toBe("1px");
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
          const shadows = getComputedStyle(el).boxShadow.match(/(rgba?\([^)]*\)|color\([^)]*\))/g) ?? [];
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

  it("at 240, 300 and 360 px the rows keep one grammar: three lines and one height for every workspace row, two for every thread row, the state slot at the edge yielding to the glyphs on hover on every row, the machine on line two and the cost in order on line three, no trip glyphs, the thread title from the row's inset up to the time column, in both themes", async () => {
    interface WorkspaceRead {
      id: string | null;
      height: number;
      state: string;
      /** The state slot's right edge against the name line's right edge, and the slot's own box. */
      slotFlush: number;
      slotRight: number;
      slotWidth: number;
      nameX: number;
      machine: string;
      /** The three lines' tops, in order: the name, the machine, the cost. */
      lineTops: number[];
      lead: { x: number; width: number; svg: boolean; dot: boolean; color: string; opacity: string };
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
          const machine = row.querySelector<HTMLElement>("[data-workspace-machine]")!;
          const name = row.querySelector<HTMLElement>("[data-workspace-name]")!;
          const lead = row.querySelector<HTMLElement>("[data-workspace-lead]")!;
          const glyph = lead.querySelector<SVGElement>("svg");
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
            machine: machine.textContent ?? "",
            lineTops: [name, machine, meta].map(el => el.getBoundingClientRect().top),
            lead: {
              x: lead.getBoundingClientRect().x,
              width: lead.getBoundingClientRect().width,
              svg: glyph !== null,
              dot: lead.querySelector(".rounded-full") !== null,
              color: glyph === null ? "" : getComputedStyle(glyph).color,
              opacity: glyph === null ? "" : getComputedStyle(glyph).opacity,
            },
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
        // Three-line workspace rows are 60 px, running, paused or gone; two-line thread rows 44 px; the Idle rows the
        // kit's 32 px row, whatever the state or the width.
        expect(rows.workspaces.map(r => r.height)).toEqual([60, 60, 60]);
        expect(rows.threads.map(r => r.height)).toEqual([44, 44, 44, 44]);
        expect(rows.idle).toEqual([32, 32]);
        // Three lines stacked in one order on every row: the name, the machine, the cost.
        for (const row of rows.workspaces) {
          expect(row.lineTops[0]!).toBeLessThan(row.lineTops[1]!);
          expect(row.lineTops[1]!).toBeLessThan(row.lineTops[2]!);
        }
        expect(rows.workspaces.map(r => r.machine)).toEqual(["2 vCPU · 4 GB", "2 vCPU · 4 GB", "2 vCPU · 4 GB"]);
        // The lead is the kind's glyph on every row, the cloud here, in one ink whatever the state; no dot beside it,
        // and the paused row's glyph alone dims.
        for (const row of rows.workspaces) {
          expect(row.lead.svg).toBe(true);
          expect(row.lead.dot).toBe(false);
          expect(row.lead.color).toBe(rows.workspaces[0]!.lead.color);
          expect(Math.abs(row.lead.x - rows.workspaces[0]!.lead.x)).toBeLessThan(0.5);
        }
        expect(rows.workspaces.map(r => r.lead.opacity)).toEqual(["1", "0.5", "1"]);
        // The state slot: empty for running, the word for the rest, flush with the line's right edge on every row, two
        // glyphs wide at least; every row's line runs to the row's own inset, since the glyphs come only on hover.
        expect(rows.workspaces.map(r => r.state)).toEqual(["", "Paused", "Gone"]);
        for (const row of rows.workspaces) expect(Math.abs(row.slotFlush)).toBeLessThan(1);
        for (const row of rows.workspaces) expect(row.slotWidth).toBeGreaterThanOrEqual(44);
        const [live, paused, gone] = rows.workspaces as [WorkspaceRead, WorkspaceRead, WorkspaceRead];
        const rowBox = await box("[data-row-id='ws:ws_a']");
        expect(Math.abs(live.slotRight - (rowBox.x + rowBox.width - 8))).toBeLessThan(1);
        expect(Math.round(paused.slotRight)).toBe(Math.round(live.slotRight));
        expect(Math.round(gone.slotRight)).toBe(Math.round(live.slotRight));
        expect(new Set(rows.workspaces.map(r => Math.round(r.nameX))).size).toBe(1);
        // At rest no row shows a glyph, the gone row included: its forget and rebuild wait for the hover like every row's actions.
        const resting = await page!.locator("[data-row-id^='ws:'] ~ [data-sidebar=menu-action]").evaluateAll(els => els.map(el => getComputedStyle(el).opacity));
        expect(resting).toEqual(["0", "0", "0", "0", "0", "0"]);
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
        // The gone row's two recovery glyphs take its slot the same way, and its word yields to them.
        const goneSlot = await box("[data-row-id='ws:ws_c'] [data-workspace-state]");
        await page!.locator("[data-row-id='ws:ws_c']").hover();
        await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-row-id='ws:ws_c'] [data-workspace-state]")!).opacity === "0");
        expect(await box("[data-row-id='ws:ws_c'] [data-workspace-state]")).toEqual(goneSlot);
        const goneHovered = await page!.locator("[data-row-id='ws:ws_c'] ~ [data-sidebar=menu-action]").evaluateAll((els, slot) => els.map(el => {
          const b = el.getBoundingClientRect();
          return { label: el.getAttribute("aria-label"), opacity: getComputedStyle(el).opacity, inside: b.x >= slot.x - 1 && b.right <= slot.right + 1 && b.y >= slot.y - 8 && b.bottom <= slot.bottom + 8 };
        }), { x: goneSlot.x, right: goneSlot.x + goneSlot.width, y: goneSlot.y, bottom: goneSlot.y + goneSlot.height });
        expect(goneHovered).toEqual([{ label: "Forget old", opacity: "1", inside: true }, { label: "Rebuild old", opacity: "1", inside: true }]);
        if (theme === "dark") {
          const path = join(SHOTS_DIR, `sidebar-rows-gone-hover-${width ?? "default"}.png`);
          await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
          console.info(`gone row hover screenshot: ${path}`);
        }
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
        // Every row in the list is a thread, so no glyph leads one: the title starts at its row's own inset.
        for (const row of rows.threads) expect(Math.abs(row.titleX - row.rowX)).toBeLessThan(1);
        expect(await page!.locator("[data-row-id^='thread:'] svg.lucide-message-square").count()).toBe(0);
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
        expect(read.lines.map(line => line.text)).toEqual(["2 vCPU · 4 GB", "$0.29 today · $0.110/hr", "naps in 15m"]);
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
        expect(moved.lines.map(line => line.text)).toEqual(["2 vCPU · 4 GB", "$0.00 today"]);
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

  // The hue is ink: it draws the header's glyph, the current dot's name and a thread rail. The floor it has to clear
  // is the one the sidebar's own meta text clears, on the surface the hue itself has just washed, in both themes.
  it("every workspace hue clears the sidebar's own readable floor on the surface it washes, in both themes", async () => {
    const AA = 4.5;
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&spaces=1&tint=1`);
      await page!.waitForSelector("[data-space-header][data-space-tint]");
      const measured = await page!.evaluate(() => {
        // Every colour goes through a canvas so it is read as the sRGB bytes the screen paints, gamut clamping and
        // all; getComputedStyle hands back the oklch it was written in, which no contrast formula can take.
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        const bytes = (css: string): [number, number, number] => {
          ctx.fillStyle = "#000";
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0]!, d[1]!, d[2]!];
        };
        const luminance = (c: [number, number, number]): number => {
          const [r, g, b] = c.map(v => { const u = v / 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const ratio = (a: string, b: string): number => {
          const [la, lb] = [luminance(bytes(a)), luminance(bytes(b))];
          return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
        };
        const read = (el: Element, prop: string): string => getComputedStyle(el).getPropertyValue(prop).trim();
        const washed = getComputedStyle(document.querySelector<HTMLElement>("[data-app-sidebar] > [data-slot='sidebar-inner']")!).backgroundColor;
        const plain = read(document.documentElement, "--sidebar");
        const ids = Array.from(document.styleSheets)
          .flatMap(sheet => Array.from(sheet.cssRules ?? []))
          .flatMap(rule => Array.from(rule.cssText.matchAll(/--space-tint-([a-z]+):/g)).map(m => m[1]!));
        const hues: Record<string, { onWashed: number; onPlain: number }> = {};
        for (const id of [...new Set(ids)]) {
          const el = document.createElement("div");
          el.setAttribute("data-space-tint", id);
          document.body.appendChild(el);
          const colour = read(el, "--space-tint");
          hues[id] = { onWashed: ratio(colour, washed), onPlain: ratio(colour, plain) };
          el.remove();
        }
        return { washed, meta: ratio(read(document.documentElement, "--sidebar-muted-foreground"), washed), hues };
      });
      console.info(`hue contrast ${theme}: ${JSON.stringify(measured)}`);
      // Six hues, not five: a hue dropped from the stylesheet and left in the protocol would show up here.
      expect(Object.keys(measured.hues)).toHaveLength(6);
      for (const [id, { onWashed, onPlain }] of Object.entries(measured.hues)) {
        expect({ theme, id, onWashed: onWashed >= AA, onPlain: onPlain >= AA }).toEqual({ theme, id, onWashed: true, onPlain: true });
      }
      // The wash itself stays inside sRGB, so the screen paints it rather than clamping it. Mixing in sRGB left the
      // dark theme's surface at a negative red channel; the oklab mix is what keeps it in range.
      const [L, a, b] = (/oklab\((-?[\d.]+) (-?[\d.]+) (-?[\d.]+)\)/.exec(measured.washed) ?? []).slice(1).map(Number) as [number, number, number];
      const [l, m, o] = [
        (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
        (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
        (L - 0.0894841775 * a - 1.291485548 * b) ** 3,
      ];
      const linear = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * o,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * o,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * o,
      ];
      console.info(`wash ${theme} in linear sRGB: ${JSON.stringify(linear.map(v => Math.round(v * 10000) / 10000))}`);
      for (const channel of linear) expect({ theme, inGamut: channel >= -0.001 && channel <= 1.001 }).toEqual({ theme, inGamut: true });
    }
  }, 120_000);

  it("two tinted spaces: the hue paints the sidebar's surface, the dot and the glyph, and in the list body the rail alone, in both themes", async () => {
    const settled = async (): Promise<void> => {
      // The body travels between spaces with both mounted, so until it settles the first header in the page is
      // still the space being left.
      await page!.waitForFunction(selector => document.querySelector(selector) === null, "[data-space-leaving]");
    };
    const readLook = () =>
      page!.evaluate(() => {
        const glyphColour = (el: Element | null | undefined): string | null => {
          const glyph = el?.querySelector("[data-space-glyph]");
          return glyph === null || glyph === undefined ? null : getComputedStyle(glyph).color;
        };
        const header = document.querySelector<HTMLElement>("[data-space-header]");
        return {
          surface: getComputedStyle(document.querySelector<HTMLElement>("[data-app-sidebar] > [data-slot='sidebar-inner']")!).backgroundColor,
          sidebarTint: document.querySelector<HTMLElement>("[data-app-sidebar]")!.getAttribute("data-space-tint"),
          headerTint: header?.getAttribute("data-space-tint") ?? null,
          headerGlyph: glyphColour(header?.querySelector("span[aria-hidden]")),
          dots: Array.from(document.querySelectorAll<HTMLElement>("[data-space-dot]")).map(dot => {
            const name = dot.querySelector<HTMLElement>("[data-space-tint]");
            return {
              label: dot.getAttribute("aria-label") ?? "",
              fill: getComputedStyle(dot.querySelector<HTMLElement>("span[aria-hidden]")!).backgroundColor,
              // A napping dot is a ring, so its state colour is the border; the hue must be off both.
              ring: getComputedStyle(dot.querySelector<HTMLElement>("span[aria-hidden]")!).borderColor,
              glyph: glyphColour(dot),
              nameTint: name?.getAttribute("data-space-tint") ?? null,
              nameColour: name === null ? null : getComputedStyle(name).color,
            };
          }),
        };
      });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&spaces=1`);
      await page!.waitForSelector("[data-space-header]");
      const plain = await readLook();
      expect(plain.sidebarTint).toBeNull();

      await page!.goto(`${base}?theme=${theme}&spaces=1&tint=1`);
      await page!.waitForSelector("[data-space-header][data-space-tint]");
      const tinted = await readLook();
      console.info(`tinted spaces ${theme}: ${JSON.stringify(tinted)}`);
      // The hue reaches the sidebar's own surface, so the whole column reads as this space and not only its rows.
      expect(tinted.sidebarTint).toBe("cyan");
      expect(tinted.headerTint).toBe("cyan");
      expect(tinted.surface).not.toBe(plain.surface);
      // Giving the workspaces hues moves no dot's fill at all: the running one is still the green that means running,
      // the napping one still hollow, the gone one still muted. This row is the only place the state of the
      // workspaces that are not on screen shows, so it stays a state row.
      const [first, second, third] = tinted.dots as [(typeof tinted.dots)[number], (typeof tinted.dots)[number], (typeof tinted.dots)[number]];
      expect(tinted.dots.map(dot => [dot.fill, dot.ring])).toEqual(plain.dots.map(dot => [dot.fill, dot.ring]));
      expect(new Set([first.fill, second.fill, third.fill]).size).toBe(3);
      expect([first.fill, second.fill, third.fill, first.ring, second.ring, third.ring]).not.toContain(tinted.headerGlyph);
      // The hue reaches the current dot's name and stops there; the other dots carry no hue at all.
      expect([first.nameTint, second.nameTint, third.nameTint]).toEqual(["cyan", null, null]);
      expect(first.nameColour).toBe(tinted.headerGlyph);
      // Only the current dot carries a glyph, and it takes the row's own ink, not the hue the sidebar is washed in.
      expect([second.glyph, third.glyph]).toEqual([null, null]);
      expect(first.glyph).not.toBe(tinted.headerGlyph);

      await page!.locator("[data-space-dot][aria-label=web]").click();
      await page!.waitForFunction(() => document.querySelector("[data-app-sidebar]")?.getAttribute("data-space-tint") === "violet");
      await settled();
      const violet = await readLook();
      expect(violet.surface).not.toBe(tinted.surface);
      expect(violet.dots[1]!.nameColour).toBe(violet.headerGlyph);
      expect(violet.headerGlyph).not.toBe(tinted.headerGlyph);
      // The workspace with no hue takes the sidebar back to its plain surface.
      await page!.locator("[data-space-dot][aria-label=old]").click();
      await page!.waitForFunction(() => document.querySelector("[data-app-sidebar]")?.getAttribute("data-space-tint") === null);
      await settled();
      expect((await readLook()).surface).toBe(plain.surface);

      await page!.locator("[data-space-dot][aria-label=api]").click();
      await page!.waitForFunction(() => document.querySelector("[data-app-sidebar]")?.getAttribute("data-space-tint") === "cyan");
      await settled();
      await page!.mouse.move(600, 700);
      const spacesShot = join(SHOTS_DIR, `sidebar-tinted-spaces-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: spacesShot });
      console.info(`tinted spaces screenshot: ${spacesShot}`);

      // In the list body the hue draws in one place: the rail the tinted workspace's threads hang from.
      await page!.goto(`${base}?theme=${theme}&tint=1`);
      await page!.waitForSelector("[data-row-id='ws:ws_a']");
      const rails = await page!.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-slot='sidebar-menu-sub']")).map(sub => ({
          tint: sub.getAttribute("data-space-tint"),
          border: getComputedStyle(sub).borderLeftColor,
          threads: Array.from(sub.querySelectorAll("[data-row-id^='thread:']")).map(row => row.getAttribute("data-row-id")),
        })),
      );
      console.info(`tinted rails ${theme}: ${JSON.stringify(rails)}`);
      expect(rails.map(rail => rail.tint)).toEqual(["cyan", "violet"]);
      expect(rails[0]!.threads).toEqual(["thread:s1", "thread:s2"]);
      expect(rails[0]!.border).not.toBe(rails[1]!.border);
      // Nothing else in the list body wears the hue, and the surface stays the plain one.
      expect(await page!.locator("[data-space-tint]").count()).toBe(2);
      expect((await readLook()).surface).toBe(plain.surface);
      // On macOS the window's own material is the surface, so the hue goes over it and never seals it behind a token.
      await page!.goto(`${base}?theme=${theme}&spaces=1&tint=1&mac=1`);
      await page!.waitForSelector("[data-space-header][data-space-tint]");
      const mac = await readLook();
      expect(mac.sidebarTint).toBe("cyan");
      expect(mac.surface).toMatch(/\/ 0\.\d+\)$|, 0\.\d+\)$/);

      await page!.goto(`${base}?theme=${theme}&tint=1`);
      await page!.waitForSelector("[data-row-id='ws:ws_a']");
      const listShot = join(SHOTS_DIR, `sidebar-tinted-list-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: listShot });
      console.info(`tinted list screenshot: ${listShot}`);

      // The picker the row's menu opens: one row of swatches, the picked one ringed, and the way back to none first.
      await page!.locator("[data-row-id='ws:ws_a']").click({ button: "right" });
      await page!.locator("[data-context-menu] [role=menuitem]", { hasText: "Colour" }).click();
      const picker = page!.locator("[data-workspace-look]");
      await picker.waitFor();
      const swatches = await picker.locator("button").evaluateAll(els =>
        els.map(el => ({ label: el.getAttribute("aria-label") ?? "", pressed: el.getAttribute("aria-pressed"), box: el.getBoundingClientRect().height })),
      );
      console.info(`colour picker ${theme}: ${JSON.stringify(swatches)}`);
      expect(swatches).toHaveLength(7);
      expect(swatches.filter(s => s.pressed === "true").map(s => s.label)).toEqual(["Colour: Cyan"]);
      // One height for every cell, so the row reads as one control and not a ladder.
      expect(new Set(swatches.map(s => Math.round(s.box))).size).toBe(1);
      const pickerShot = join(SHOTS_DIR, `workspace-colour-picker-${theme}.png`);
      await page!.locator("[data-slot=dialog-popup]").first().screenshot({ path: pickerShot });
      console.info(`colour picker screenshot: ${pickerShot}`);
    }
  }, 120_000);

  it("a mixed list keeps one row grammar: every row leads with its kind's glyph in one ink, the laptop on this computer and the cloud on a fork, line two says what each machine is, line three what it costs, free on this computer, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&local=1`);
      await page!.waitForSelector("[data-row-id='ws:ws_m']");
      const local = page!.locator("[data-row-id='ws:ws_m']");
      const cloud = page!.locator("[data-row-id='ws:ws_a']");
      const paused = page!.locator("[data-row-id='ws:ws_b']");
      // One glyph in every lead, the kind's own: no dot, no chip and no badge anywhere.
      expect(await local.locator("[data-workspace-lead] svg.lucide-laptop").count()).toBe(1);
      expect(await cloud.locator("[data-workspace-lead] svg.lucide-cloud").count()).toBe(1);
      expect(await page!.locator("[data-workspace-lead] .rounded-full").count()).toBe(0);
      expect(await page!.locator("[data-slot=badge]").count()).toBe(0);
      expect((await local.locator("[data-workspace-machine]").textContent())?.trim()).toBe(THIS_COMPUTER);
      expect((await local.locator("[data-workspace-meta]").textContent())?.trim()).toBe(FREE_WORD);
      expect((await local.locator("[data-workspace-state]").textContent())?.trim()).toBe("");
      expect((await cloud.locator("[data-workspace-machine]").textContent())?.trim()).toBe("2 vCPU · 4 GB");
      expect((await cloud.locator("[data-workspace-meta]").textContent())?.trim()).toContain("$0.110/hr");
      expect((await paused.locator("[data-workspace-state]").textContent())?.trim()).toBe("Paused");
      // Uniform rows: one height for every kind and state, the lead slots and the names in one column.
      const rows = await page!.locator("[data-row-id^='ws:']").evaluateAll(list =>
        list.map(row => {
          const lead = row.querySelector<HTMLElement>("[data-workspace-lead]")!;
          const name = row.querySelector<HTMLElement>("[data-workspace-name]")!;
          return { height: row.getBoundingClientRect().height, lead: lead.getBoundingClientRect(), nameX: name.getBoundingClientRect().x, color: getComputedStyle(lead.querySelector("svg")!).color };
        }),
      );
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.height).toBe(60);
        expect(Math.abs(row.lead.x - rows[0]!.lead.x)).toBeLessThan(0.5);
        expect(Math.abs(row.lead.width - rows[0]!.lead.width)).toBeLessThan(0.5);
        expect(Math.abs(row.nameX - rows[0]!.nameX)).toBeLessThan(0.5);
        // One ink for every glyph: colour is not a status channel on the lead.
        expect(row.color).toBe(rows[0]!.color);
      }
      // This computer's lines are short enough to be drawn whole at the default width.
      for (const line of ["[data-workspace-machine]", "[data-workspace-meta]"]) expect(await local.locator(line).evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
      const path = join(SHOTS_DIR, `sidebar-mixed-kinds-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`mixed-kind sidebar screenshot: ${path}`);
    }
  }, 30_000);

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
        if (message.type() === "error" && message.text().includes(DUPLICATE_KEY)) errors.push(message.text());
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

  it("a third space asked for mid-travel runs its own full travel from where the body is, in both themes", async () => {
    const TURN_AFTER_MS = 80;
    for (const theme of ["dark", "light"] as const) {
      await page!.emulateMedia({ reducedMotion: "no-preference" });
      await page!.goto(`${base}?theme=${theme}&spaces=1`);
      await page!.waitForSelector("[data-space-header]");
      // Every frame of a travel to web that is asked for old 80 ms in: where each body sits across the sidebar's
      // body, and the clock of the animation drawing the track. A body's own edge is the reading that counts, since
      // the track moves a pane's width under a travel that changes which pane holds a body, and the track's
      // transform alone cannot tell that apart from the body jumping.
      const run = await page!.evaluate(async turnAfter => {
        const track = (): HTMLElement => document.querySelector<HTMLElement>("[data-space-track]")!;
        const frame = () => {
          const across = document.querySelector<HTMLElement>("[data-space-slide]")!.getBoundingClientRect().left;
          return {
            at: performance.now(),
            bodies: Array.from(document.querySelectorAll<HTMLElement>("[data-space-pane]")).map(pane => ({ name: pane.querySelector<HTMLElement>("[data-space-name]")?.textContent ?? "", x: pane.getBoundingClientRect().left - across })),
            clocks: track()
              .getAnimations()
              .map(animation => Number(animation.currentTime ?? 0)),
          };
        };
        const click = (name: string): void => document.querySelector<HTMLElement>(`[data-space-dot][aria-label=${name}]`)!.click();
        const paint = (): Promise<unknown> => new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
        const frames: ReturnType<typeof frame>[] = [];
        click("web");
        // The travel comes up in the click's own render, but a browser under load can hold that render back, and two
        // clicks landing in one render would be one travel rather than a travel taken over.
        for (let i = 0; i < 200 && document.querySelectorAll("[data-space-pane]").length < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
        const started = performance.now();
        while (performance.now() - started < turnAfter) {
          await paint();
          frames.push(frame());
        }
        click("old");
        while (performance.now() - started < turnAfter + 500) {
          await paint();
          frames.push(frame());
        }
        return { frames, width: track().getBoundingClientRect().width };
      }, TURN_AFTER_MS);

      const pane = run.width / 2;
      const took = run.frames.findIndex(read => read.bodies.some(body => body.name === "old"));
      const swap = run.frames[took]!;
      const arrived = run.frames.findIndex((read, i) => i >= took && read.bodies.some(body => body.name === "old" && Math.abs(body.x) < 1));
      const tookMs = arrived < 0 ? null : run.frames[arrived]!.at - swap.at;
      console.info(`space third ${theme}: ${JSON.stringify({ pane, clockAtSwap: swap.clocks, enteredAt: swap.bodies.find(body => body.name === "old")?.x, tookMs, frames: run.frames.length, last: run.frames.at(-1) })}`);
      // The travel taken over is drawn by an animation of its own, on its own clock, not by the one already running.
      expect(swap.clocks).toHaveLength(1);
      expect(swap.clocks[0]).toBeLessThan(40);
      // The space asked for comes in from off the sidebar's edge, not from part of the way across it.
      expect(swap.bodies.find(body => body.name === "old")!.x).toBeGreaterThan(0.75 * pane);
      // And it takes a whole travel to arrive, rather than finishing early on a clock it inherited.
      expect(tookMs).toBeGreaterThan(0.85 * SPACE_SLIDE_MS);
      expect(tookMs).toBeLessThan(1.4 * SPACE_SLIDE_MS);
      // It settles on that space alone, at rest at the sidebar's edge.
      expect(run.frames.at(-1)!.bodies).toEqual([{ name: "old", x: 0 }]);
    }
  }, 60_000);

  it("the Archived group sits shut under the idle shelf, one row grammar with the Idle header and no colour of its own, and opens to rows of the same height, in both themes", async () => {
    const readGroups = () =>
      page!.evaluate(() => {
        const read = (rowId: string) => {
          const row = document.querySelector<HTMLElement>(`[data-row-id='${rowId}']`)!;
          const word = row.querySelector<HTMLElement>("span")!;
          const box = row.getBoundingClientRect();
          const style = getComputedStyle(word);
          const rowStyle = getComputedStyle(row);
          return {
            text: (row.textContent ?? "").trim(),
            expanded: row.getAttribute("aria-expanded"),
            y: box.y,
            height: box.height,
            x: box.x,
            right: box.right,
            color: style.color,
            size: style.fontSize,
            weight: style.fontWeight,
            background: rowStyle.backgroundColor,
            border: rowStyle.borderBottomWidth,
            radius: rowStyle.borderBottomRightRadius,
          };
        };
        // Only the first workspace's own block: the other two draw their own thread rows further down the list.
        const block = document.querySelector<HTMLElement>("[data-row-id='ws:ws_a']")!.closest<HTMLElement>("[data-sidebar='menu-item']")!;
        return {
          idle: read("settled:ws_a"),
          archived: read("archived:ws_a"),
          threads: Array.from(block.querySelectorAll<HTMLElement>("[data-row-id^='thread:']")).map(row => ({
            id: row.getAttribute("data-row-id"),
            y: row.getBoundingClientRect().y,
            height: row.getBoundingClientRect().height,
          })),
          sidebar: document.querySelector<HTMLElement>("[data-slot=sidebar]")!.getBoundingClientRect().right,
        };
      });
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&archived=1&sidebar=300`);
      await page!.waitForSelector("[data-row-id='archived:ws_a']");
      const shut = await readGroups();
      console.info(`archived group ${theme} shut: ${JSON.stringify(shut)}`);
      // Shut, carrying its count, and under the idle shelf it belongs to rather than above it.
      expect(shut.archived.expanded).toBe("false");
      expect(shut.archived.text).toBe("Archived (2)");
      expect(shut.idle.text).toBe("Idle");
      expect(shut.archived.y).toBeGreaterThan(shut.idle.y);
      // The two threads it holds are not drawn; the working row and the one idle row are.
      expect(shut.threads.map(t => t.id)).toEqual(["thread:s1", "thread:s2"]);
      for (const thread of shut.threads) expect(thread.y).toBeLessThan(shut.archived.y);
      // One row grammar with the header above it: same height, same left edge, same muted word, same rounding, and
      // the group header is a plain row, not a chip or a badge, so it carries no fill and no border of its own.
      expect(shut.archived.height).toBe(32);
      expect(shut.archived.height).toBe(shut.idle.height);
      expect(shut.archived.x).toBe(shut.idle.x);
      expect(shut.archived.color).toBe(shut.idle.color);
      expect(shut.archived.size).toBe(shut.idle.size);
      expect(shut.archived.weight).toBe(shut.idle.weight);
      expect(shut.archived.radius).toBe(shut.idle.radius);
      expect(shut.archived.background).toBe("rgba(0, 0, 0, 0)");
      expect(shut.archived.border).toBe("0px");
      expect(shut.archived.right).toBeLessThanOrEqual(shut.sidebar);
      const path = join(SHOTS_DIR, `sidebar-archived-shut-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path });
      console.info(`sidebar archived shut screenshot: ${path}`);
      // One click opens it, and what it holds are ordinary thread rows at the ordinary thread-row height.
      await page!.locator("[data-row-id='archived:ws_a']").click();
      await page!.waitForFunction(
        () => document.querySelector("[data-row-id='ws:ws_a']")!.closest("[data-sidebar='menu-item']")!.querySelectorAll("[data-row-id^='thread:']").length === 4,
      );
      const open = await readGroups();
      console.info(`archived group ${theme} open: ${JSON.stringify(open)}`);
      expect(open.archived.expanded).toBe("true");
      expect(open.archived.text).toBe("Archived");
      expect(open.threads.map(t => t.id)).toEqual(["thread:s1", "thread:s2", "thread:s5", "thread:s6"]);
      expect(new Set(open.threads.map(t => Math.round(t.height))).size).toBe(1);
      for (const id of ["thread:s5", "thread:s6"]) {
        expect(open.threads.find(t => t.id === id)!.y).toBeGreaterThan(open.archived.y);
      }
      const openPath = join(SHOTS_DIR, `sidebar-archived-open-${theme}.png`);
      await page!.locator("[data-slot=sidebar]").first().screenshot({ path: openPath });
      console.info(`sidebar archived open screenshot: ${openPath}`);
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
      // The line's ink is the muted foreground beside it, not a colour of its own: the same grey the
      // counts on the rows are mixed from, and only the part of it differs, since a sentence is read
      // through where a count is glanced at and the whisper the counts take sits under AA on purpose.
      const [lineColor, metaColor] = await Promise.all([
        line.evaluate(el => getComputedStyle(el).color),
        page!.locator("[data-row-id='ws:ws_a'] [data-workspace-meta]").first().evaluate(el => getComputedStyle(el).color),
      ]);
      const hueOf = (color: string): string => color.replace(/\s*\/\s*[\d.]+\s*\)$/, ")");
      expect(hueOf(lineColor)).toBe(hueOf(metaColor));
      expect(lineColor).not.toBe(metaColor);
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

  it("a send refusal is one muted mono line, no panel, in a slot the composer keeps at one height; a paused workspace has no line, its box takes words, and its send button reads Wake and send, in both themes", async () => {
    interface Composer {
      shell: Box;
      slot: Box;
      box: Box;
      text: string;
      /** The line's paint, or null when the slot is empty. */
      line: { mono: boolean; background: string; border: string; icons: number } | null;
      panels: number;
      send: { label: string | null; title: string | null; box: Box | null };
      editable: boolean;
      placeholder: string;
    }
    const composerAt = async (query: string, theme: string, name: string): Promise<Composer> => {
      await page!.goto(`${base}?theme=${theme}&${query}`);
      await page!.waitForSelector("[data-composer-refusal]");
      // The transcript is fetched after mount; the line for a lingering turn exists only once it is in.
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const line = el.querySelector<HTMLElement>("[data-composer-refusal] [role=status]");
        const s = line === null ? null : getComputedStyle(line);
        const send = el.querySelector<HTMLButtonElement>("[data-chat-composer-actions] button[type=submit]");
        const editor = el.querySelector<HTMLElement>("[data-testid=composer-editor]");
        const b = send?.getBoundingClientRect();
        return {
          text: el.querySelector("[data-composer-refusal]")?.textContent ?? "",
          line: s === null || line === null ? null : { mono: /mono/i.test(s.fontFamily), background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderLeftWidth}`, icons: line.getElementsByTagName("svg").length },
          panels: el.querySelectorAll("[data-composer-banner-surface]").length,
          send: { label: send?.getAttribute("aria-label") ?? null, title: send?.getAttribute("title") ?? null, box: b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height } },
          editable: editor?.getAttribute("contenteditable") !== "false",
          placeholder: editor?.getAttribute("aria-placeholder") ?? el.querySelector("[data-placeholder]")?.textContent ?? "",
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
      expect(idle.send.label).toBe("Send message");
      expect(idle.editable).toBe(true);
      const paused = await composerAt("ws=ws_b", theme, "paused");
      const gone = await composerAt("ws=ws_c", theme, "gone");
      const working = await composerAt("ws=ws_a&linger=1", theme, "working");
      // A paused workspace: no sentence anywhere, the box takes words, the same button in the same place says it wakes first.
      expect(paused.text).toBe("");
      expect(paused.line).toBeNull();
      expect(paused.editable).toBe(true);
      expect(paused.placeholder).toBe(idle.placeholder);
      expect(paused.placeholder).not.toMatch(/paus|wake/i);
      expect(paused.send.label).toBe(WAKE_AND_SEND_LABEL);
      expect(paused.send.title).toBe(WAKE_AND_SEND_LABEL);
      expect(paused.send.box).toEqual(idle.send.box);
      expect(paused.slot).toEqual(idle.slot);
      expect(paused.box).toEqual(idle.box);
      expect(paused.shell).toEqual(idle.shell);
      expect(gone.text).toBe(sendRefusal("gone"));
      expect(working.text).toBe(stillWorkingRefusal("thr_linger"));
      for (const state of [gone, working]) {
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

  it("an access picked while a turn runs reads back on the picker, and the line saying when it lands is one uncut muted mono line, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      // A turn running on this computer, which is where a pick made mid-turn has somewhere to go.
      await page!.goto(`${base}?theme=${theme}&local=1&ws=ws_m&perm=1`);
      await page!.waitForSelector("[data-composer-picker='permissionMode']");
      await page!.waitForSelector("text=loading transcript", { state: "detached" });
      const trigger = "[data-composer-picker='permissionMode']";
      // The picker opens on the mode the harness asks in, which is what a thread on this computer starts at.
      expect(await page!.locator(trigger).getAttribute("data-value")).toBe("default");
      const before = await box("[data-slot=composer-shell]");
      await page!.locator(trigger).click();
      await page!.waitForSelector("[data-composer-option='bypassPermissions']");
      const menu = join(SHOTS_DIR, `composer-access-menu-${theme}.png`);
      await page!.locator("[role=menu]").first().screenshot({ path: menu });
      console.info(`composer access menu screenshot: ${menu}`);
      await page!.locator("[data-composer-option='bypassPermissions']").click();

      // The pick reads back on the trigger whatever the running turn did with it, and the line says when it lands.
      await page!.waitForSelector(`${trigger}[data-value='bypassPermissions']`);
      // A radio pick leaves the menu up, as it does for the model and the effort; it is dismissed so the line is
      // photographed with nothing over it.
      await page!.keyboard.press("Escape");
      await page!.waitForSelector("[role=menu]", { state: "detached" });
      await page!.waitForSelector("[data-composer-refusal] [role=status]");
      const read = await page!.locator("[data-chat-composer]").evaluate(el => {
        const line = el.querySelector<HTMLElement>("[data-composer-refusal] [role=status]")!;
        const s = getComputedStyle(line);
        const label = el.querySelector<HTMLElement>("[data-composer-picker='permissionMode']")!;
        return {
          text: line.textContent ?? "",
          skin: { mono: /mono/i.test(s.fontFamily), background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderLeftWidth}`, icons: line.getElementsByTagName("svg").length },
          // The slot truncates from the right; a line wider than its box loses its own tail.
          cut: line.scrollWidth > line.clientWidth,
          width: line.scrollWidth,
          slot: (line.parentElement as HTMLElement).clientWidth,
          trigger: label.textContent ?? "",
          panels: el.querySelectorAll("[data-composer-banner-surface]").length,
        };
      });
      const shot = join(SHOTS_DIR, `composer-access-${theme}.png`);
      await page!.locator("[data-chat-composer]").screenshot({ path: shot });
      console.info(`composer access line screenshot: ${shot} (${read.width} px of line in ${read.slot} px of slot)`);

      expect(read.text).toBe(accessFromNextMessage(`Bypass on ${THIS_COMPUTER}`));
      expect(read.trigger).toContain(`Bypass on ${THIS_COMPUTER}`);
      // Whole at the width this app is smallest in: the clause that says when the pick lands is the point of it.
      expect(read.cut).toBe(false);
      expect(read.width).toBeLessThan(read.slot);
      // Drawn like every other line in that slot: mono words on nothing, no fill, no border, no icon, no panel.
      expect(read.skin).toEqual({ mono: true, background: "rgba(0, 0, 0, 0)", border: "0px 0px", icons: 0 });
      expect(read.panels).toBe(0);
      // The line moves nothing: the slot is there whether or not a line is in it.
      expect(await box("[data-slot=composer-shell]")).toEqual(before);
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

  it("collapsing the sidebar puts the page header's toggle at the frame inset where the wordmark was, on the boundary it toggles, and the breadcrumb after it, in both themes", async () => {
    for (const theme of ["dark", "light"] as const) {
      await open(theme);
      const before = await box("[data-slot=sidebar-header] [data-slot=sidebar-trigger]");
      const lockup = await box("[data-slot=sidebar-header] [role=img][aria-label=wsp]");
      expect(await page!.locator("header [data-slot=sidebar-trigger]").count()).toBe(0);
      await page!.locator("[data-slot=sidebar-header] [data-slot=sidebar-trigger]").click();
      await page!.waitForSelector("[data-sidebar-state=collapsed]");
      // The row animates padding-left over 200 ms; the read waits for the toggle to land.
      await page!.waitForFunction(x => Math.abs(document.querySelector("header [data-slot=sidebar-trigger]")!.getBoundingClientRect().x - x) < 1, lockup.x);
      const after = await box("header [data-slot=sidebar-trigger]");
      expect(Math.abs(after.x - lockup.x)).toBeLessThan(1);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1);
      const crumb = await box("header [data-thread-breadcrumb]");
      expect(Math.abs(crumb.x - (after.x + after.width + (await rowGap("header [data-header-row]"))))).toBeLessThan(1);
      expect(await page!.locator("header [data-thread-breadcrumb]").evaluate(el => el.textContent)).toBe("api/Reply with exactly the word hi.");
      const ratios = await textContrast(page!, "header [data-thread-breadcrumb] .text-muted-foreground");
      for (const ratio of ratios) expect(ratio, `the collapsed header's quiet crumb reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      const path = join(SHOTS_DIR, `header-collapsed-${theme}.png`);
      await page!.screenshot({ path, clip: { x: 0, y: 0, width: 600, height: 120 } });
      console.info(`collapsed header screenshot: ${path}`);
    }
  }, 60_000);
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
      expect(await page!.locator("[data-context-menu] [role=menuitem]").count()).toBe(14);
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

  // The sidebar paints its quiet text in four tiers, three of them at part opacity. An alpha buys
  // less contrast over a light surface than over a dark one, so the two themes have to be measured
  // against each other and not only against a floor: with one light token behind them the tiers
  // read 4.62, 4.47, 2.68 and 2.10 to 1 where the dark side's read 8.33, 5.43, 4.35 and 3.00.
  // A sentence drawn in the whisper tier is not a count: the offline line is one, and so are the line
  // for what the runtime is doing to a daemon and the one for a drop with memory near full. They take
  // the prose ink, which clears AA on both surfaces, while the counts beside them keep the whisper.
  it("a sentence in a row's meta line takes the prose ink and reads at AA in both themes, and the counts beside it keep the whisper", async () => {
    for (const theme of ["dark", "light"] as const) {
      await page!.goto(`${base}?theme=${theme}&offline=1`);
      await page!.waitForSelector("[data-sidebar-offline]");
      const prose = await textContrast(page!, "[data-sidebar-offline]");
      const counts = await textContrast(page!, "[data-app-sidebar] [data-workspace-meta]");
      console.info(`${theme}: the offline sentence reads at ${prose.map(r => r.toFixed(2)).join(", ")}, the counts beside it at ${counts.map(r => r.toFixed(2)).join(", ")} to 1`);
      expect(prose.length).toBeGreaterThan(0);
      for (const ratio of prose) expect(ratio, `the offline sentence reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      // The counts stay the whisper they were: this raises the sentences, not the tier.
      expect(counts.length).toBeGreaterThan(0);
      for (const ratio of counts) expect(ratio, `a count reads at ${ratio} in ${theme}`).toBeLessThan(4.5);
    }
  }, 60_000);

  it("the sidebar's ink reads the same in light as in dark: the two tiers that carry words at AA, the whispered ones on the dark side's ink", async () => {
    const TIERS = {
      "a thread's title once it is idle": "[data-app-sidebar] .text-sidebar-muted-foreground",
      "the word on a row at rest": "[data-app-sidebar] [data-slot=sidebar-menu-button]:not([data-active=true])",
      "the state word beside a thread": "[data-sidebar-row] .hidden.md\\:inline",
      "the row's meta line": "[data-app-sidebar] .text-\\[var\\(--top-row-meta\\)\\]",
    } as const;
    // The first two carry words a person reads, so their bar is AA. The last two are the whisper the
    // rows are designed around and sit under AA in both themes on purpose, so their bar is the ink
    // their dark twin already ships: they are the tiers an alpha over a light surface loses.
    const AT_AA = ["a thread's title once it is idle", "the word on a row at rest"];
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
    for (const tier of Object.keys(TIERS)) {
      if (AT_AA.includes(tier)) expect(read.light[tier], `${tier} reads at ${read.light[tier]} in light`).toBeGreaterThanOrEqual(4.5);
      else expect(read.light[tier], `${tier} reads at ${read.light[tier]} in light against ${read.dark[tier]} in dark`).toBeGreaterThanOrEqual(read.dark[tier]! - 0.2);
    }
  }, 60_000);
});
