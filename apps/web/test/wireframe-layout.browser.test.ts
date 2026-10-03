// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar of thread tiles in a real Chromium, on the wireframe page's
// fixed store: every tile is 52 px, every one-line row (search, head) 36 and
// every section head 28 at three sidebar widths and in the 390 px sheet; every row
// and every status slot ends at one right edge; each child list steps 16 px in
// and draws its rail the height of its item, stopping at the 15 px tick on the
// last one; nothing wears caps; the head sits in the
// fixed header over the scrolling tiles; the state words read at AA on a flat
// tile and on the lifted one; the one lifted tile stands off the ground on
// both sides, on light by a darker fill with a hairline edge; no plus stands
// in the list and no hover glyph takes a tap on the phone's sheet; every row
// fades its fill and ink in 150 ms; the held compose glyph still answers a
// hover with its tooltip; the switcher's menu is the head's width, its rows 36
// px, at rest with no transform once open; the desktop foot names this
// computer; and the
// whole is photographed on every screen in both themes for a judge. The
// settings page follows, on the same page: every row 64 px and every line 44,
// the settings sidebar's rows 36 with one lifted, at 390 a card whose rows
// hold a value standing them at 96 with the slot under the description and
// every other card at 72, every line 56 with its right side under its label,
// a row of chips growing until no chip is cut at either width, no label,
// word, sentence or value cut or spilling its box at that width, no caps but
// the small mono labels, no cut segment, no sideways scroll, the muted words
// at AA, a held control further down the opacity ramp than a live one, no group row lifted
// while the results stand and a dimmed row standing back by opacity on both
// sides, one group's sub-rows open at a time right under it, the Light pick drawing the page light, Restore defaults only off the
// defaults, the region right of the sidebar whole with the panel back on the
// chord, and Add a computer's dialog over Computers. A computer's page
// stands on one left edge and is photographed to its foot at both widths, in a window tall enough to hold
// it, since Remove stands at its foot. Vite serves test/wireframe to Playwright's
// browser, so like the shell layout test it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { CARD_SURFACE } from "../src/settings/rows.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast, wcagContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const THEMES = ["dark", "light"] as const;
const WIDTHS = [220, 256, 480] as const;
const ONE_LINE = 36;
/** A thread tile: two rows of 14 and 18 px with 4 px between, 8 px in. */
const TILE = 52;
/** A section's head over its tiles, Needs you or the Settled fold: its name, a hairline and a chevron. */
const SECTION_HEAD = 28;
const HEIGHT = { one: ONE_LINE, tile: TILE, section: SECTION_HEAD } as const;

/** Every row of the sidebar by what it is, with its box and the box of the status slot on its first row. */
interface RowRead {
  id: string;
  kind: keyof typeof HEIGHT;
  height: number;
  left: number;
  right: number;
  slotRight: number | null;
}

if (renderSkipped !== undefined) console.info(`wireframe layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the sidebar of thread tiles laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Each case starts the page as a first visit: a pick one case stored is not the next one's.
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const url = (screen: string, theme: (typeof THEMES)[number], extra = ""): string => `${base}?screen=${screen}&theme=${theme}${extra}`;
  const open = async (screen: string, theme: (typeof THEMES)[number], extra = "", waitFor = "[data-sidebar-row]"): Promise<void> => {
    await page!.setViewportSize({ width: 1280, height: 800 });
    await page!.goto(url(screen, theme, extra));
    await page!.waitForSelector(waitFor);
  };
  const shot = async (name: string, selector?: string): Promise<string> => {
    const path = join(SHOTS_DIR, `wireframe-${name}.png`);
    if (selector === undefined) await page!.screenshot({ path });
    else await page!.locator(selector).first().screenshot({ path });
    console.info(`wireframe screenshot: ${path}`);
    return path;
  };

  /** Every row in the sidebar's list and its fixed header, read once. */
  const rows = (): Promise<RowRead[]> =>
    page!.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-search-row], [data-slot=sidebar] [data-k=project-switcher], [data-slot=sidebar] [data-sidebar-row], [data-slot=sidebar] [data-thread-launch], [data-slot=sidebar] [data-k=new-project]")];
      return els.map(el => {
        const id = el.dataset["rowId"] ?? el.dataset["k"] ?? (el.hasAttribute("data-search-row") ? "search" : el.hasAttribute("data-thread-launch") ? "launch" : "?");
        const box = el.getBoundingClientRect();
        const slot = el.querySelector<HTMLElement>("[data-thread-status]");
        const kind = el.querySelector("[data-tile-where]") !== null ? "tile" : el.querySelector("[data-section-rule]") !== null ? "section" : "one";
        return { id, kind, height: box.height, left: box.left, right: box.right, slotRight: slot === null ? null : slot.getBoundingClientRect().right } as const;
      });
    });

  const expectOneGrammar = (read: RowRead[], where: string): void => {
    expect(read.length, where).toBeGreaterThan(2);
    for (const row of read) expect(row.height, `${row.id} at ${where}`).toBe(HEIGHT[row.kind]);
    // Every row ends at one x whatever its depth: the tree takes its room from the left alone.
    const rights = new Set(read.filter(row => row.id !== "search" && row.id !== "project-switcher").map(row => Math.round(row.right)));
    expect([...rights], `right edges at ${where}`).toHaveLength(1);
    const slots = new Set(read.flatMap(row => (row.slotRight === null ? [] : [Math.round(row.slotRight)])));
    expect(slots.size, `slot edges at ${where}`).toBeLessThanOrEqual(1);
  };

  it("every tile is 52 px, every one-line row 36 and every section head 28 at 220, 256 and 480, every row and every slot ending at one x, each child 16 px in, in both themes", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        await open("sidebar", theme, `&sidebar=${width}`);
        const sidebar = await page!.locator("[data-slot=sidebar]").first().boundingBox();
        expect(Math.round(sidebar!.width)).toBe(width);
        const read = await rows();
        console.info(`rows at ${width} ${theme}: ${JSON.stringify(read.map(r => [r.id, r.height, Math.round(r.left)]))}`);
        expectOneGrammar(read, `${width} ${theme}`);
        // The tree holding the thread that asks stands under Needs you, over the bare list; nothing here is settled yet.
        expect(read.filter(row => row.kind === "section").map(row => row.id)).toEqual(["section:needs-you"]);
        expect(read.filter(row => row.kind === "tile").map(row => row.id)).toEqual(["thread:th_lead", "thread:th_build", "thread:th_review", "thread:th_child", "thread:th_box", "thread:th_quiet"]);
        // The depth reads in the left edge: 16 px a level, 12 of indent and 4 past the rail.
        const at = (id: string) => read.find(row => row.id === id)!.left;
        expect(Math.round(at("thread:th_build") - at("thread:th_lead"))).toBe(16);
        expect(Math.round(at("thread:th_review") - at("thread:th_build"))).toBe(16);
        expect(Math.round(at("thread:th_child") - at("thread:th_lead"))).toBe(16);
        expect(Math.round(at("thread:th_box") - at("thread:th_lead"))).toBe(0);
        // Nothing in a tile is cut or spills its box but the spans that truncate on purpose, and no row of it is
        // taller than its line.
        const cut = await page!.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-sidebar-row] *")]
            .filter(el => el.closest("[data-tile-where]") !== null || el.closest("[data-sidebar-row]")!.querySelector("[data-tile-where]") !== null)
            .filter(el => !(el instanceof SVGElement) && el.tagName !== "CANVAS")
            .filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
            .filter(el => !el.classList.contains("truncate") && !el.classList.contains("sr-only"))
            .map(el => `${el.closest<HTMLElement>("[data-sidebar-row]")!.dataset["rowId"]} ${el.tagName} ${el.className}`),
        );
        expect(cut, `cut at ${width} ${theme}`).toEqual([]);
        await shot(`sidebar-${width}-${theme}`, "[data-slot=sidebar]");
      }
      await open("sidebar", theme);
      await shot(`sidebar-1280-${theme}`);
    }
  }, 120_000);

  it("under one picked project the list holds its tiles alone, the head names the project, and the lifted tile is the one selected two deep, in both themes", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        await open("sidebar-picked", theme, `&sidebar=${width}&pick=pr_spoo`, "[data-sidebar-row][data-active=true]");
        const read = await rows();
        expectOneGrammar(read, `picked ${width} ${theme}`);
        expect(read.some(row => row.id === "thread:th_box")).toBe(false);
        expect(await page!.locator("[data-k=project-switcher] [data-switcher-name]").textContent()).toBe("spoo");
        const lifted = await page!.locator("[data-sidebar-row][data-active=true]").evaluateAll(els => els.map(el => [el.dataset["rowId"], el.dataset["depth"]]));
        expect(lifted).toEqual([["thread:th_review", "2"]]);
        // The head carries the plus while it stands in for the project, at nothing until hovered, and in the room
        // the head keeps for it before the chevron.
        expect(await page!.locator("[data-sidebar-search] [data-k=new-workspace]").evaluate(el => getComputedStyle(el).opacity)).toBe("0");
        const plusBox = await page!.locator("[data-sidebar-search] [data-k=new-workspace]").boundingBox();
        const roomBox = await page!.locator("[data-sidebar-search] [data-switcher-plus-room]").boundingBox();
        expect(Math.abs(plusBox!.x - roomBox!.x), `the head's plus at ${width} ${theme}`).toBeLessThan(1);
        expect(Math.abs(plusBox!.width - roomBox!.width)).toBeLessThan(1);
        await shot(`sidebar-picked-${width}-${theme}`, "[data-slot=sidebar]");
      }
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      await shot(`sidebar-picked-1280-${theme}`);
    }
  }, 120_000);

  it("the empty wsp holds the head, held, and one row pointing at the first run; one project alone still sits under All projects, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar-empty", theme, "", "[data-k=new-project]");
      const empty = await rows();
      expect(empty.map(row => row.id)).toEqual(["search", "project-switcher", "new-project"]);
      for (const row of empty) expect(row.height, row.id).toBe(ONE_LINE);
      expect(await page!.locator("[data-k=project-switcher]").isDisabled()).toBe(true);
      expect(await page!.locator("[data-slot=sidebar] button[aria-label='New thread']").isDisabled()).toBe(true);
      expect(await page!.locator("[data-k=first-run]").count()).toBe(1);
      expect(await page!.locator("[data-slot=sidebar]").first().textContent()).not.toMatch(/No projects yet|A project is a folder|Add a project/);
      await shot(`sidebar-empty-1280-${theme}`);
      // The held compose glyph still takes the pointer, so its tooltip can say what it is in the one state a
      // person might ask why it is held.
      await page!.locator("[data-slot=sidebar] button[aria-label='New thread']").hover();
      await page!.waitForSelector("[data-slot=tooltip-popup]");
      expect(await page!.locator("[data-slot=tooltip-popup]").textContent()).toMatch(/^New thread/);
      await page!.mouse.move(640, 400);

      await open("sidebar-one-project", theme);
      const one = await rows();
      expectOneGrammar(one, `one project ${theme}`);
      expect(await page!.locator("[data-k=project-switcher] [data-switcher-name]").textContent()).toBe("All projects");
      await shot(`sidebar-one-project-1280-${theme}`);
    }
  }, 90_000);

  it("every row fades its fill and its ink in 150 ms on hover", async () => {
    await open("sidebar", "dark");
    const read = await rows();
    const fades = await page!.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-search-row], [data-slot=sidebar] [data-k=project-switcher], [data-slot=sidebar] [data-sidebar-row]")].map(el => ({
        id: el.dataset["rowId"] ?? el.dataset["k"] ?? "search",
        property: getComputedStyle(el).transitionProperty,
        duration: getComputedStyle(el).transitionDuration,
      })),
    );
    expect(fades.length).toBe(read.length);
    for (const fade of fades) {
      expect(fade.property.split(", "), fade.id).toContain("color");
      expect(fade.duration.split(", ")[0], fade.id).toBe("0.15s");
    }
    expect(fades.some(f => f.id.startsWith("thread:"))).toBe(true);
    expect(fades.some(f => f.id === "section:needs-you")).toBe(true);
  }, 30_000);

  it("the one lifted tile stands off the ground on both sides: on light a fill one step darker with a hairline edge at 1.2 to 1 or better, on dark the fill alone", async () => {
    for (const theme of THEMES) {
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      // The fill fades in over 150 ms once the tile is selected; it is read once it has landed.
      await page!.waitForTimeout(400);
      const lifted = await page!.evaluate(() => {
        const ctx = document.createElement("canvas").getContext("2d")!;
        const parse = (c: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          return [r!, g!, b!, a! / 255];
        };
        const over = (top: number[], under: number[]): number[] => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
        const row = document.querySelector<HTMLElement>("[data-sidebar-row][data-active=true]")!;
        const layers: number[][] = [];
        for (let n: Element | null = row.parentElement; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c[3]! > 0) layers.push(c);
        }
        const ground = layers.reverse().reduce((below, top) => over(top, below), [255, 255, 255]);
        const fill = over(parse(getComputedStyle(row).backgroundColor), ground);
        // The edge is the inset layer of the tile's box shadow, painted over its fill; its colour leads the layer.
        const shadow = getComputedStyle(row).boxShadow;
        const inset = shadow.split(/,\s(?=(?:rgba?|color|oklch)\()/).find(layer => layer.includes("inset")) ?? "";
        const colour = /^(rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\))/.exec(inset)?.[1] ?? "rgba(0, 0, 0, 0)";
        const edge = over(parse(colour), fill);
        return { ground: ground.map(Math.round), fill: fill.map(Math.round), edge: edge.map(Math.round), shadow };
      });
      const fillRatio = wcagContrast(lifted.fill, lifted.ground);
      const edgeRatio = wcagContrast(lifted.edge, lifted.ground);
      console.info(`${theme} lifted tile: ground ${lifted.ground}, fill ${lifted.fill} at ${fillRatio} to 1, edge ${lifted.edge} at ${edgeRatio} to 1 (${lifted.shadow})`);
      if (theme === "light") {
        expect(lifted.fill[0]!).toBeLessThan(lifted.ground[0]!);
        expect(fillRatio).toBeGreaterThan(1.03);
        expect(edgeRatio).toBeGreaterThanOrEqual(1.2);
      } else {
        expect(fillRatio).toBeGreaterThanOrEqual(1.1);
        expect(lifted.edge).toEqual(lifted.fill);
      }
    }
  }, 60_000);

  it("a desktop window's foot is the corner row: Settings as a 28 px icon button at the sidebar's bottom left, and no computer picker, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar-hosts", theme, "", "[data-sidebar-corner] button");
      const foot = await page!.evaluate(() => {
        const button = document.querySelector<HTMLElement>("[data-sidebar-corner] button")!.getBoundingClientRect();
        const sidebar = document.querySelector<HTMLElement>("[data-slot=sidebar-container], [data-slot=sidebar]")!.getBoundingClientRect();
        const glyph = document.querySelector<HTMLElement>("[data-sidebar-search] svg")!.getBoundingClientRect();
        const icon = document.querySelector<HTMLElement>("[data-sidebar-corner] button svg")!.getBoundingClientRect();
        return { width: button.width, height: button.height, fromBottom: Math.round(sidebar.bottom - button.bottom), iconLeft: Math.round(icon.left), glyphLeft: Math.round(glyph.left), label: document.querySelector("[data-sidebar-corner] button")!.getAttribute("aria-label"), hosts: document.querySelectorAll("[data-host-foot]").length, words: document.querySelector("[data-slot=sidebar-footer]")!.textContent };
      });
      console.info(`sidebar corner ${theme}: ${JSON.stringify(foot)}`);
      expect([foot.width, foot.height]).toEqual([28, 28]);
      expect(foot.label).toBe("Settings");
      expect(foot.hosts).toBe(0);
      expect(foot.words).toBe("");
      // The gear stands on the same left edge as the search row's glyph above it.
      expect(foot.iconLeft).toBe(foot.glyphLeft);
      expect(foot.fromBottom).toBeLessThanOrEqual(12);
      await shot(`sidebar-corner-1280-${theme}`);
      await shot(`sidebar-corner-256-${theme}`, "[data-slot=sidebar]");
    }
  }, 60_000);

  it("nothing anywhere in the sidebar wears caps or letter-spacing, its foot included, and the head sits in the fixed header outside the scrolling list", async () => {
    await open("sidebar", "dark");
    const dressed = await page!.locator("[data-slot=sidebar] *").evaluateAll(els =>
      els
        .filter(el => el.children.length === 0)
        .map(el => ({ text: (el.textContent ?? "").trim().slice(0, 20), transform: getComputedStyle(el).textTransform, spacing: getComputedStyle(el).letterSpacing }))
        .filter(read => read.transform !== "none" || read.spacing !== "normal"),
    );
    expect(dressed.map(read => [read.text, read.transform])).toEqual([]);
    expect(await page!.locator("[data-slot=sidebar-content] [data-k=project-switcher]").count()).toBe(0);
    expect(await page!.locator("[data-slot=sidebar] [data-k=project-switcher]").count()).toBe(1);
    expect(await page!.locator("[data-slot=sidebar-content] [data-sidebar-row]").count()).toBeGreaterThan(0);
  }, 30_000);

  it("each child list draws its rail per item: the height of the item on every one but the last, 15 px to the tick on the last, the tick 4 by 1 at 15 px, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar", theme);
      const rails = await page!.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("[data-sidebar-tree] ul li")]
          .filter(li => getComputedStyle(li.parentElement!).marginLeft === "12px")
          .map(li => {
            const before = getComputedStyle(li, "::before");
            const after = getComputedStyle(li, "::after");
            return {
              id: li.querySelector<HTMLElement>("[data-sidebar-row]")?.dataset["rowId"] ?? "?",
              last: li === li.parentElement!.lastElementChild,
              height: li.getBoundingClientRect().height,
              rail: parseFloat(before.height),
              railWidth: before.width,
              tick: { top: after.top, width: after.width, height: after.height },
              ink: before.backgroundColor,
            };
          }),
      );
      console.info(`rails at ${theme}: ${JSON.stringify(rails)}`);
      expect(rails.map(item => item.id)).toEqual(["thread:th_build", "thread:th_review", "thread:th_child"]);
      for (const item of rails) {
        expect(item.railWidth, item.id).toBe("1px");
        expect(item.tick, item.id).toEqual({ top: "15px", width: "4px", height: "1px" });
        expect(item.ink, item.id).toBe(theme === "dark" ? "rgba(255, 255, 255, 0.16)" : "rgba(0, 0, 0, 0.16)");
        if (item.last) expect(item.rail, `${item.id} is last`).toBe(15);
        else expect(Math.round(item.rail), item.id).toBe(Math.round(item.height));
      }
    }
  }, 60_000);

  it("the state words read at 4.5 to 1 or better on a flat tile and on the lifted tile, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar", theme);
      const flat = await textContrast(page!, "[data-slot=sidebar] [data-thread-status][data-tone]");
      expect(flat.length).toBeGreaterThan(1);
      for (const ratio of flat) expect(ratio, `a state word on a flat tile reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      await page!.waitForTimeout(400);
      const lifted = await textContrast(page!, "[data-sidebar-row][data-active=true] [data-thread-status][data-tone]");
      expect(lifted).toHaveLength(1);
      expect(lifted[0], `the lifted tile's word reads at ${lifted[0]} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      console.info(`${theme}: state words on flat tiles ${flat.map(r => r.toFixed(2)).join(", ")}, on the lifted tile ${lifted[0]!.toFixed(2)} to 1`);
    }
  }, 90_000);

  it("no plus stands in the list: the compose glyph in the head is the one add control at rest", async () => {
    await open("sidebar", "dark");
    expect(await page!.locator("[data-sidebar-tree] svg.lucide-plus").count()).toBe(0);
    expect(await page!.locator("[data-sidebar-tree] [data-sidebar=menu-action]").count()).toBe(0);
  }, 30_000);

  it("the switcher's menu opens under the head at the head's width, its rows 36 px, and comes to rest with no transform, in both themes", async () => {
    for (const theme of THEMES) {
      await open("switcher-open", theme, "", "[data-project-switcher-menu]");
      // The menu slides in on the translate property and the primitive scales on transform: both at rest first.
      await page!.waitForFunction(() => {
        const style = getComputedStyle(document.querySelector("[data-slot=popover-popup]")!);
        return style.transform === "none" && style.translate === "none" && style.opacity === "1";
      });
      const read = await page!.evaluate(() => {
        const head = document.querySelector<HTMLElement>("[data-k=project-switcher]")!.getBoundingClientRect();
        const popup = document.querySelector<HTMLElement>("[data-slot=popover-popup]")!;
        const menu = popup.getBoundingClientRect();
        const style = getComputedStyle(popup);
        return {
          head: { left: head.left, right: head.right, bottom: head.bottom },
          menu: { left: menu.left, right: menu.right, top: menu.top },
          radius: style.borderTopLeftRadius,
          border: style.borderTopWidth,
          options: [...popup.querySelectorAll<HTMLElement>("[role=option], [data-k=add-project-row]")].map(el => ({ text: el.textContent, height: el.getBoundingClientRect().height })),
          field: popup.querySelector<HTMLElement>("[data-switcher-search]")!.closest("label")!.getBoundingClientRect().height,
          expanded: document.querySelector("[data-k=project-switcher]")!.getAttribute("aria-expanded"),
        };
      });
      console.info(`switcher menu at ${theme}: ${JSON.stringify(read)}`);
      expect(Math.abs(read.menu.left - read.head.left)).toBeLessThan(1);
      expect(Math.abs(read.menu.right - read.head.right)).toBeLessThan(1);
      expect(Math.round(read.menu.top - read.head.bottom)).toBe(4);
      expect(read.expanded).toBe("true");
      expect(read.border).toBe("1px");
      expect(read.options.map(option => option.text)).toEqual(["All projects", "spoo", "wsp", "landingspoo", "Add a project"]);
      for (const option of read.options) expect(option.height).toBe(ONE_LINE);
      expect(read.field).toBe(32);
      await shot(`switcher-menu-${theme}`, "[data-slot=popover-popup]");
      await shot(`switcher-open-1280-${theme}`);
    }
  }, 60_000);

  it("at 390 the sidebar is a sheet with the same rows at the same heights, and no hover glyph there takes a tap, in both themes", async () => {
    for (const theme of THEMES) {
      for (const [screen, extra, first] of [
        ["sidebar", "", "[data-sidebar-row]"],
        ["sidebar-picked", "&pick=pr_spoo", "[data-sidebar-row][data-active=true]"],
        ["sidebar-empty", "", "[data-k=new-project]"],
      ] as const) {
        await page!.setViewportSize({ width: 390, height: 844 });
        await page!.goto(url(screen, theme, extra));
        await page!.waitForSelector("[data-slot=sidebar-trigger]");
        // At this width the right panel of the workspace the store opens on is a sheet over the whole page; Escape
        // shuts it, and the trigger then opens the sidebar's own sheet.
        await page!.keyboard.press("Escape");
        await page!.waitForSelector("[data-slot=sheet-viewport]", { state: "detached" });
        await page!.locator("[data-slot=sidebar-trigger]").first().click();
        await page!.waitForSelector(`[data-slot=sidebar][data-mobile=true] ${first}`);
        // The sheet slides in; its rows are read once it stands still.
        await page!.waitForTimeout(400);
        const read = await rows();
        if (screen === "sidebar-empty") for (const row of read) expect(row.height, `${row.id} at 390 ${theme}`).toBe(ONE_LINE);
        else expectOneGrammar(read, `${screen} at 390 ${theme}`);
        const onTop = await page!.evaluate(() => {
          const box = document.querySelector("[data-slot=sidebar][data-mobile=true]")!.getBoundingClientRect();
          return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("[data-slot=sidebar]") !== null;
        });
        expect(onTop, `${screen} at 390 ${theme}`).toBe(true);
        const pluses = await page!.locator("[data-slot=sidebar][data-mobile=true] svg.lucide-plus").evaluateAll(els => els.map(el => el.closest("button")!).filter(button => button.dataset["k"] !== "new-project").map(button => getComputedStyle(button).opacity));
        expect(pluses.filter(opacity => opacity !== "0")).toEqual([]);
        if (screen === "sidebar-picked") {
          // A tap beside the head's chevron, where its hidden plus stands, lands on the head.
          const hit = await page!.evaluate(() => {
            const head = document.querySelector<HTMLElement>("[data-slot=sidebar][data-mobile=true] [data-k=project-switcher]")!;
            const box = head.getBoundingClientRect();
            return document.elementFromPoint(box.right - 40, box.top + 14)?.closest("[data-k=project-switcher]") === head;
          });
          expect(hit, `a tap beside the head's chevron at 390 ${theme}`).toBe(true);
        }
        await shot(`${screen}-390-${theme}`);
      }
    }
  }, 150_000);
});

/** The settings screens the wireframe page holds, each with the element its shot waits on. */
const SETTINGS_SCREENS = [
  ["settings-appearance", "[data-settings-at=appearance]"],
  ["settings-light-picked", "[data-settings-at=appearance]"],
  ["settings-computers", "[data-settings-at=computers] [data-place-row=solari]"],
  ["settings-computer", "[data-settings-at='computer:p_spoo'] [data-k=remove-line]"],
  ["settings-computer-failed", "[data-settings-at='computer:p_lab'] [data-k=place-sentence]"],
  ["settings-this-mac", "[data-settings-at='computer:here'] [data-k=computer-head]"],
  ["settings-cloud", "[data-settings-at='computer:solari'] [data-k=remove-line]"],
  ["settings-projects", "[data-settings-at=projects] [data-project-row=pr_landing]"],
  ["settings-project", "[data-settings-at='project:pr_spoo'] [data-k=project-threads]"],
  ["settings-devices", "[data-settings-at=devices] [data-device-row=d_3]"],
  ["settings-account", "[data-settings-at=account] [data-k=account-action]"],
  ["settings-keybindings", "[data-settings-at=keybindings] [data-slot=kbd]"],
  ["settings-version", "[data-settings-at=general] [data-k=version]"],
  ["settings-usage", "[data-settings-at=usage] [data-used-row=codex]"],
  ["settings-search", "[data-settings-at=search] [data-settings-row=server-icons]"],
  ["settings-over-panel", "[data-settings-at=appearance]"],
  ["settings-add-computer", "[data-add-computer] [data-k=where-field]"],
  ["settings-remove-computer", "[data-k=remove-sentence]"],
] as const;
/** A row or a line grows with what it says; the least it stands at is one 20 px line between its 12 px pads. */
const LEAST_ROW = 44;
/** The computers whose page is photographed to its foot, in a window tall enough to hold the whole of it. */
const FOOT_SCREENS = ["settings-computer", "settings-computer-failed", "settings-this-mac"] as const;
const FOOT_SIZES = [
  { width: 1280, height: 1900 },
  { width: 390, height: 3000 },
] as const;

/** Every row, line and sidebar row of a settings screen, with its height and what it holds. */
interface SettingsRead {
  rows: { id: string; height: number; card: string; fill: string; spills: boolean; chips: boolean; chipsCut: string[] }[];
  lines: { id: string; height: number; spills: boolean }[];
  /** Each list in the list grammar: the classes its card wears, and its rows' heights. */
  grids: { id: string; card: string; rows: number[] }[];
  sidebarRows: { id: string; height: number; active: boolean; dimmed: boolean; opacity: number }[];
  cutSegments: string[];
  /** Every word, sentence and value whose box cannot hold it: the ones a person would read cut short. */
  cutWords: string[];
  dressed: string[];
  scroll: { page: number; client: number };
  /** The opacity a held control stands at beside a live one, so a row that does nothing reads as doing nothing. */
  opacities: { held: number[]; live: number[] };
}

describe.skipIf(renderSkipped !== undefined)("the settings page laid out in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let base = "";

  beforeAll(async () => {
    vite = await startVite(WEB_DIR, "/test/wireframe/index.html");
    base = `${vite.base}/test/wireframe/index.html`;
    browser = await launchRender();
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => window.localStorage.clear());
    mkdirSync(SHOTS_DIR, { recursive: true });
  }, 60_000);

  afterAll(() => stopRender(browser, vite?.child));

  const url = (screen: string, theme: (typeof THEMES)[number], extra = ""): string => `${base}?screen=${screen}&theme=${theme}${extra}`;
  /** Opens a screen with the computer's own scheme set to the shot's side, so the theme rule's system pick draws it. */
  const open = async (screen: string, theme: (typeof THEMES)[number], waitFor: string, size: { width: number; height: number } = { width: 1280, height: 800 }, extra = ""): Promise<void> => {
    await page!.setViewportSize(size);
    await page!.emulateMedia({ colorScheme: theme });
    await page!.goto(url(screen, theme, extra));
    await page!.waitForSelector(waitFor);
  };
  /** A shot named by its page, width and theme, the screen's own settings- prefix said once. */
  const shot = async (name: string, selector?: string): Promise<string> => {
    const path = join(SHOTS_DIR, `settings-${name.replace(/^settings-/, "")}.png`);
    if (selector === undefined) await page!.screenshot({ path });
    else await page!.locator(selector).first().screenshot({ path });
    console.info(`settings screenshot: ${path}`);
    return path;
  };

  const read = (): Promise<SettingsRead> =>
    page!.evaluate(() => {
      const box = (el: Element) => el.getBoundingClientRect();
      const spills = (el: HTMLElement): boolean => el.scrollHeight > el.clientHeight + 1;
      const rows = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-row]")].map(el => ({
        id: el.dataset["settingsRow"] ?? "?",
        height: box(el).height,
        card: el.closest<HTMLElement>("[data-settings-card]")?.dataset["settingsCard"] ?? "?",
        fill: getComputedStyle(el).backgroundColor,
        spills: spills(el),
        chips: el.querySelector("[data-chips]") !== null,
        // A chip cut by its own ellipsis, or standing past the row's edge.
        chipsCut: [...el.querySelectorAll<HTMLElement>("[data-chip]")]
          .filter(chip => {
            const words = chip.querySelector<HTMLElement>("span:last-child") ?? chip;
            const c = box(chip);
            const r = box(el);
            return words.scrollWidth > words.clientWidth + 1 || c.right > r.right + 0.5 || c.bottom > r.bottom + 0.5;
          })
          .map(chip => (chip.textContent ?? "").trim()),
      }));
      const grids = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-grid]")].map(el => ({
        id: el.dataset["grid"] ?? "?",
        card: el.querySelector<HTMLElement>(":scope > [data-grid-row], :scope > div:not([data-grid-head])")?.className ?? "",
        rows: [...el.querySelectorAll<HTMLElement>("[data-grid-row]")].map(row => box(row).height),
      }));
      const lines = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-line]")].map(el => ({
        id: el.dataset["settingsLine"] ?? "?",
        height: box(el).height,
        spills: spills(el),
      }));
      // A word cut is one whose own box cannot hold it: sideways where it stands on one line, or below the last
      // line it is allowed where it wraps.
      const cutWords = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-settings-word], [data-settings-page] [data-settings-description], [data-settings-page] [data-settings-label], [data-settings-page] [data-grid-name], [data-settings-page] [data-grid-note]")]
        .filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
        .map(el => `${(el.textContent ?? "").trim()} [${el.scrollWidth}/${el.clientWidth} ${el.scrollHeight}/${el.clientHeight}]`);
      const opacity = (selector: string): number[] => [...document.querySelectorAll<HTMLElement>(selector)].map(el => Number(getComputedStyle(el).opacity));
      const sidebarRows = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-sidebar-row]")].map(el => ({
        id: el.dataset["rowId"] ?? "?",
        height: box(el).height,
        active: el.dataset["active"] === "true",
        dimmed: el.hasAttribute("data-dimmed"),
        opacity: Number(getComputedStyle(el).opacity),
      }));
      const cutSegments = [...document.querySelectorAll<HTMLElement>("[data-settings-page] [data-slot=segmented-control] [role=radio]")].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent ?? "");
      // Caps and tracked-out words, which nothing wears now; the page title's tight tracking draws it closer, which is
      // no dress, and a picture's masked code is not words.
      const dressed = [...document.querySelectorAll<HTMLElement>("[data-settings-page] *, [data-slot=sidebar] *")]
        .filter(el => {
          const s = getComputedStyle(el);
          return /\p{L}/u.test(el.textContent ?? "") && (s.textTransform !== "none" || parseFloat(s.letterSpacing) > 0);
        })
        .map(el => (el.textContent ?? "").trim().slice(0, 20));
      const pageEl = document.querySelector<HTMLElement>("[data-settings-page]")!;
      const viewport = pageEl.closest<HTMLElement>("[data-slot=scroll-area-viewport]")!;
      return {
        rows,
        lines,
        grids,
        sidebarRows,
        cutSegments,
        cutWords,
        dressed,
        scroll: { page: Math.max(pageEl.scrollWidth, viewport.scrollWidth), client: viewport.clientWidth },
        opacities: { held: opacity("[data-settings-page] [data-slot=button][data-held]"), live: opacity("[data-settings-page] [data-slot=button]:not([data-held]):not(:disabled)") },
      };
    });

  const expectGrammar = (got: SettingsRead, where: string): void => {
    // A row and a line grow with what they say, at every width, so nothing in one is cut for want of room.
    for (const row of got.rows) {
      expect(row.fill, `${row.id} at ${where} carries no fill of its own`).toBe("rgba(0, 0, 0, 0)");
      if (row.chips) expect(row.chipsCut, `chips cut in ${row.id} at ${where}`).toEqual([]);
      expect(row.height, `a row of ${row.card} at ${where}`).toBeGreaterThanOrEqual(LEAST_ROW);
      expect(row.spills, `${row.id} at ${where} holds what it says`).toBe(false);
    }
    for (const line of got.lines) {
      expect(line.height, `${line.id} at ${where}`).toBeGreaterThanOrEqual(LEAST_ROW);
      expect(line.spills, `${line.id} at ${where} holds what it says`).toBe(false);
    }
    // A list in the list grammar stands in the one settings card, its rows grown like any row.
    for (const grid of got.grids) {
      for (const surface of CARD_SURFACE.split(" ")) expect(grid.card.split(" "), `the ${grid.id} list's card at ${where}`).toContain(surface);
      for (const height of grid.rows) expect(height, `a row of the ${grid.id} list at ${where}`).toBeGreaterThanOrEqual(LEAST_ROW);
    }
    expect(got.cutWords, `words cut at ${where}`).toEqual([]);
    for (const row of got.sidebarRows) expect(row.height, `${row.id} at ${where}`).toBe(ONE_LINE);
    expect(got.cutSegments, `segments cut at ${where}`).toEqual([]);
    expect(got.dressed, `caps or tracking at ${where}`).toEqual([]);
    expect(got.scroll.page, `sideways scroll at ${where}`).toBeLessThanOrEqual(got.scroll.client);
    // A control nobody can press stands further down the opacity ramp than every live one beside it.
    for (const held of got.opacities.held) for (const live of got.opacities.live) expect(held, `a held control at ${where} against a live one`).toBeLessThan(live);
    // A row with no match for the typed text stands back by opacity, which reads the same way on both sides; an
    // ink swap read brighter than the rest ink on dark and did nothing on light.
    for (const row of got.sidebarRows) expect(row.opacity, `${row.id} at ${where}`).toBe(row.dimmed ? 0.5 : 1);
  };

  it("every row and line as tall as what it says and nothing in one cut, a row of chips whole, the sidebar rows 36 with exactly one lifted, no caps but the small mono labels, no fill on a row, no cut segment and no sideways scroll, on every screen in both themes at 1280, photographed", async () => {
    for (const theme of THEMES) {
      for (const [screen, waitFor] of SETTINGS_SCREENS) {
        await open(screen, theme, waitFor);
        const got = await read();
        console.info(`${screen} ${theme}: rows ${JSON.stringify(got.rows.map(r => [r.id, r.height]))}, lines ${JSON.stringify(got.lines.map(l => [l.id, l.height]))}, cut ${JSON.stringify(got.cutWords)}`);
        expectGrammar(got, `${screen} ${theme} 1280`);
        // While the results stand in the centre no row is the page, so the search screen lifts none.
        expect(got.sidebarRows.filter(row => row.active).length, `lifted rows on ${screen} ${theme}`).toBe(screen === "settings-search" ? 0 : 1);
        // The muted words read at AA on both sides: descriptions, state words and the sub-heads.
        const ratios = await textContrast(page!, "[data-settings-page] [data-settings-description], [data-settings-page] [data-settings-word], [data-settings-page] [data-settings-head], [data-settings-page] [data-settings-mark]");
        for (const ratio of ratios) expect(ratio, `muted text on ${screen} ${theme} reads at ${ratio}`).toBeGreaterThanOrEqual(4.5);
        await shot(`${screen}-1280-${theme}`);
      }
    }
  }, 300_000);

  it("at 390 every row and line stands what it holds under its words, nothing cut, and the settings sidebar is the sheet with the groups", async () => {
    for (const theme of THEMES) {
      for (const [screen, waitFor] of SETTINGS_SCREENS) {
        if (screen === "settings-search") continue;
        await open(screen, theme, waitFor, { width: 390, height: 844 });
        const got = await read();
        expectGrammar(got, `${screen} ${theme} 390`);
        await shot(`${screen}-390-${theme}`);
      }
      // The sheet: the groups at 36 px, one lifted; then the field's results in the sheet, a tap landing on the row.
      await open("settings-appearance", theme, "[data-settings-at=appearance]", { width: 390, height: 844 });
      await page!.locator("[data-slot=sidebar-trigger]").first().click();
      await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-settings-groups]");
      await page!.waitForTimeout(400);
      const sheet = await read();
      for (const row of sheet.sidebarRows) expect(row.height).toBe(ONE_LINE);
      expect(sheet.sidebarRows.filter(row => row.active).map(row => row.id)).toEqual(["group:appearance"]);
      await shot(`settings-appearance-390-sheet-${theme}`);
      await page!.locator("[data-slot=sidebar][data-mobile=true] [data-k=settings-search] input, [data-slot=sidebar][data-mobile=true] input[data-k=settings-search]").first().fill("icons");
      await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-row-id='result:privacy:server-icons']");
      // The centre keeps its page while the results stand in the sheet.
      expect(await page!.locator("[data-settings-page]").getAttribute("data-settings-at")).toBe("appearance");
      await shot(`settings-search-390-sheet-${theme}`);
      await page!.locator("[data-slot=sidebar][data-mobile=true] [data-row-id='result:privacy:server-icons']").click();
      await page!.waitForSelector("[data-slot=sidebar][data-mobile=true]", { state: "detached" });
      expect(await page!.locator("[data-settings-page]").getAttribute("data-settings-at")).toBe("privacy");
    }
  }, 300_000);

  it("General's Version card while behind in the app on its own host: Get, Downloading held, then Quit and open, nothing cut, photographed", async () => {
    for (const theme of THEMES) {
      await open("settings-version-behind", theme, "[data-settings-at=general] [data-k=version]");
      const get = page!.locator("[data-k=get-release]");
      await page!.waitForFunction(() => document.querySelector<HTMLElement>("[data-k=get-release]")?.title !== "");
      expect(await get.textContent()).toBe("Get 0.3.0");
      expect((await read()).cutWords, `words cut at settings-version-behind ${theme}`).toEqual([]);
      await shot(`settings-version-behind-1280-${theme}`);
      await get.click();
      await page!.waitForSelector("[data-k=get-release]:disabled");
      expect(await get.textContent()).toBe("Downloading");
      expect((await read()).cutWords, `words cut at settings-version-downloading ${theme}`).toEqual([]);
      await shot(`settings-version-downloading-1280-${theme}`);
      await page!.evaluate(() => (window as unknown as { finishBundle: () => void }).finishBundle());
      await page!.waitForSelector("[data-k=get-release]:not(:disabled)");
      expect(await get.textContent()).toBe("Quit and open");
      expect((await read()).cutWords, `words cut at settings-version-kept ${theme}`).toEqual([]);
      await shot(`settings-version-kept-1280-${theme}`);
    }
  }, 120_000);

  it("General's Version card with newer files under the running host: Restart host in Get's place, nothing cut, photographed", async () => {
    for (const theme of THEMES) {
      await open("settings-version-restart", theme, "[data-settings-at=general] [data-k=restart-host]");
      // A computer here runs an older wsp, so its line stands in a card of its own under the version, What's new under both.
      expect(await page!.locator("[data-settings-card^=version] button").allTextContents()).toEqual(["Restart host", "What's new"]);
      expect((await read()).cutWords, `words cut at settings-version-restart ${theme}`).toEqual([]);
      await shot(`settings-version-restart-1280-${theme}`);
    }
  }, 120_000);

  it("photographs a computer's page to its foot at both widths, so its limits, its agents' link, its image, its threads and Remove are read", async () => {
    for (const theme of THEMES) {
      for (const screen of FOOT_SCREENS) {
        const waitFor = SETTINGS_SCREENS.find(([name]) => name === screen)![1];
        for (const size of FOOT_SIZES) {
          await open(screen, theme, waitFor, size);
          // The whole page is in the window, so the shot ends where the page does rather than where the fold is.
          const over = await page!.evaluate(() => {
            const el = document.querySelector<HTMLElement>("[data-settings-page]")!;
            const viewport = el.closest<HTMLElement>("[data-slot=scroll-area-viewport]")!;
            return el.scrollHeight - viewport.clientHeight;
          });
          expect(over, `${screen} at ${size.width} by ${size.height} stands whole in the window`).toBeLessThanOrEqual(0);
          await shot(`${screen}-foot-${size.width}-${theme}`);
        }
      }
    }
  }, 180_000);

  it("stands a computer's page on one left edge: every section's and list's head on the cards' outer edge, and every row's first mark or word the card's hairline and its 20 px inset in, at both widths", async () => {
    for (const screen of ["settings-computer", "settings-computer-failed", "settings-this-mac", "settings-cloud"] as const) {
      const waitFor = SETTINGS_SCREENS.find(([name]) => name === screen)![1];
      for (const size of FOOT_SIZES) {
        await open(screen, "dark", waitFor, size);
        const edges = await page!.evaluate(() => {
          const pageEl = document.querySelector<HTMLElement>("[data-settings-page]")!;
          const left = (el: Element): number => Math.round(el.getBoundingClientRect().left);
          // A row's lead is the first box down its first children that stands in from the row's own edge.
          const lead = (row: HTMLElement): number => {
            let el: Element | null = row;
            while (el !== null && left(el) <= left(row)) el = el.firstElementChild;
            return el === null ? NaN : left(el);
          };
          const rows = [...pageEl.querySelectorAll<HTMLElement>("[data-settings-row], [data-grid-row], [data-thread-row], [data-k=remove-line], [data-k=computer-head]")];
          return {
            heads: [...pageEl.querySelectorAll("[data-settings-head], [data-grid-head] > span:first-child")].map(left),
            cards: [...pageEl.querySelectorAll<HTMLElement>("[data-settings-card] > div, [data-grid] > div:not([data-grid-head]), [data-k=remove-line]")].filter(el => getComputedStyle(el).borderLeftWidth === "1px").map(left),
            leads: rows.map(row => [row.dataset["settingsRow"] ?? row.dataset["threadRow"] ?? row.dataset["k"] ?? "grid-row", lead(row)] as const),
          };
        });
        console.info(`${screen} at ${size.width} edges: ${JSON.stringify(edges)}`);
        const edge = edges.cards[0]!;
        expect(edges.cards.length, screen).toBeGreaterThan(1);
        expect(new Set([...edges.cards, ...edges.heads]), `${screen} at ${size.width}`).toEqual(new Set([edge]));
        expect(edges.leads.length, screen).toBeGreaterThan(1);
        for (const [id, x] of edges.leads) expect(x, `${id} on ${screen} at ${size.width}`).toBe(edge + 21);
      }
    }
  }, 120_000);

  it("opens one group's sub-rows at a time: picking Computers folds Appearance's sections and lists the computers right under it, 36 px apart", async () => {
    const tops = (): Promise<[string, number][]> =>
      page!.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-sidebar-row]")].map(el => [el.dataset["rowId"] ?? "?", Math.round(el.getBoundingClientRect().top)] as [string, number]));
    await open("settings-appearance", "dark", "[data-settings-at=appearance]");
    const before = await tops();
    expect(before.some(([id]) => id.startsWith("section:"))).toBe(true);
    expect(before.some(([id]) => id.startsWith("computer:"))).toBe(false);
    await page!.locator("[data-k=settings-computers]").click();
    await page!.waitForSelector("[data-settings-at=computers]");
    // The group's list grows to its height in 140 ms; the rows are read once it stands.
    await page!.waitForTimeout(400);
    const after = await tops();
    const ids = after.map(([id]) => id);
    expect(ids.some(id => id.startsWith("section:"))).toBe(false);
    const at = ids.indexOf("group:computers");
    const computers = ids.filter(id => id.startsWith("computer:"));
    expect(computers.length).toBeGreaterThan(1);
    // The computers follow their group with nothing between, and the next group follows them.
    expect(ids.slice(at + 1, at + 1 + computers.length)).toEqual(computers);
    expect(ids[at + 1 + computers.length]).toBe("group:projects");
    // The computers stand one under the other from the group's own row down, 36 px apart, no gap opening among them.
    const steps = ids.slice(at, at + 1 + computers.length).map(id => after.find(([i]) => i === id)![1]);
    expect(new Set(steps.slice(1).map((top, i) => top - steps[i]!))).toEqual(new Set([ONE_LINE]));
    // The groups above the one that opened stand where they were.
    for (const [id, top] of before.filter(([id]) => id === "group:general" || id === "group:appearance")) expect(after.find(([i]) => i === id)![1], `${id} stayed where it was`).toBe(top);
  }, 60_000);

  it("the Light theme picked on the dark side draws the page light, and Restore defaults stands only off the defaults and puts the page back", async () => {
    await open("settings-light-picked", "dark", "[data-settings-at=appearance]");
    await page!.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    // The grid under the side segments holds the light side's pictures, with the light pick checked.
    expect(await page!.locator("[data-k=theme-picker] [data-theme-option][aria-checked=true]").getAttribute("data-theme-option")).toBe(DEFAULT_PREFERENCES.lightTheme);
    expect(await page!.locator("[data-k=restore-defaults]").count()).toBe(1);
    await shot("light-picked-1280-dark");
    await page!.locator("[data-k=restore-defaults]").click();
    await page!.waitForFunction(() => document.documentElement.classList.contains("dark"));
    expect(await page!.locator("[data-k=restore-defaults]").count()).toBe(0);
    await open("settings-appearance", "dark", "[data-settings-at=appearance]");
    expect(await page!.locator("[data-k=restore-defaults]").count()).toBe(0);
  }, 60_000);

  it("Settings takes the whole region right of the sidebar and the panel comes back on the chord, in both windows", async () => {
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1024, height: 700 },
    ]) {
      await open("settings-over-panel", "dark", "[data-settings-at=appearance]", size);
      expect(await page!.locator("[data-preview-panel-mode]").count()).toBe(0);
      expect(await page!.locator("[data-right-panel-tabbar]").count()).toBe(0);
      expect(await page!.locator("[data-panel-layout-controls]").count()).toBe(0);
      const region = await page!.evaluate(() => {
        const centre = document.querySelector("[data-shell-center]")!.getBoundingClientRect();
        const sidebar = document.querySelector("[data-slot=sidebar-inner]")!.getBoundingClientRect();
        return { gap: Math.round(centre.x - sidebar.right), right: Math.round(centre.right), width: Math.round(centre.width), sidebar: Math.round(sidebar.width) };
      });
      expect(region.gap).toBeLessThanOrEqual(1);
      expect(region.right).toBe(size.width);
      console.info(`settings region at ${size.width}: sidebar ${region.sidebar}, region ${region.width}`);
      // The chord the app reads is the one the browser's own platform gives it, so the press has to follow the
      // platform too: pinned to the Mac's key, this case waited 30 s for a panel no Ctrl had asked for.
      await page!.keyboard.press("ControlOrMeta+Comma");
      await page!.waitForSelector("[data-right-panel-tabbar]");
      expect(await page!.locator("[data-settings-groups]").count()).toBe(0);
    }
  }, 60_000);

  it("at 390 the sheet opened on the workspace body stays open with the settings body when Settings opens from its foot row", async () => {
    await page!.setViewportSize({ width: 390, height: 844 });
    await page!.emulateMedia({ colorScheme: "dark" });
    await page!.goto(url("sidebar", "dark"));
    await page!.waitForSelector("[data-slot=sidebar-trigger]");
    await page!.keyboard.press("Escape");
    await page!.waitForSelector("[data-slot=sheet-viewport]", { state: "detached" });
    await page!.locator("[data-slot=sidebar-trigger]").first().click();
    await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-k=settings-row]");
    await page!.locator("[data-slot=sidebar][data-mobile=true] [data-k=settings-row]").click();
    await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-settings-groups]");
    expect(await page!.locator("[data-slot=sidebar][data-mobile=true] [data-sidebar-tree]").count()).toBe(0);
    await shot("from-foot-390-dark");
  }, 60_000);

  it("Add a computer stands over Computers as one 560 px dialog of one height, its foot inside it, and as the phone's sheet at 390", async () => {
    const READY = "[data-add-computer] [data-k=where-field]";
    const layout = () =>
      page!.evaluate(() => {
        const box = (el: Element) => {
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), bottom: Math.round(b.bottom) };
        };
        return { dialog: box(document.querySelector("[data-add-computer]")!), foot: box(document.querySelector("[data-add-computer] [data-slot=dialog-footer]")!), field: box(document.querySelector("[data-add-computer] [data-k=where-field]")!) };
      });
    for (const theme of THEMES) {
      await open("settings-add-computer", theme, READY);
      const wide = await layout();
      console.info(`add a computer at 1280 ${theme}: ${JSON.stringify(wide)}`);
      expect(wide.dialog.w).toBe(560);
      expect(wide.dialog.h).toBe(640);
      expect(wide.foot.bottom).toBeLessThanOrEqual(wide.dialog.bottom);
      await shot(`add-computer-1280-${theme}`, "[data-add-computer]");
    }
    await open("settings-add-computer", "dark", READY, { width: 390, height: 844 });
    const phone = await layout();
    console.info(`add a computer at 390: ${JSON.stringify(phone)}`);
    expect(phone.dialog.w).toBe(390);
    expect(phone.foot.bottom).toBeLessThanOrEqual(phone.dialog.bottom);
    await shot("add-computer-390-dark", "[data-add-computer]");
  }, 90_000);

  it("Computers draws each refusal where its control is, in the host's two halves: the add this window watched fail on the check it stopped at, the places read above Add a computer, the ssh config where its hosts would be", async () => {
    /** A slot's words and whether it stands inside what holds it: the settings page, or Add a computer's dialog. */
    const slotRead = (k: string, within = "[data-settings-page]") =>
      page!.evaluate(
        ([key, holder]) => {
          const slot = document.querySelector<HTMLElement>(`[data-k=${key}]`)!;
          const panel = document.querySelector<HTMLElement>(holder!)!.getBoundingClientRect();
          const b = slot.getBoundingClientRect();
          return { text: slot.textContent, fix: slot.querySelector("span.text-foreground")?.textContent?.trim() ?? null, inside: b.left >= panel.left && b.right <= panel.right + 0.5, h: Math.round(b.height) };
        },
        [k, within],
      );
    for (const theme of THEMES) {
      await open("settings-add-computer-failed", theme, "[data-add-computer] [data-k=step-refusal]");
      const add = await slotRead("step-refusal", "[data-add-computer]");
      console.info(`add refused ${theme}: ${JSON.stringify(add)}`);
      expect(add.text).toBe("spoo has no curl or wget on its PATH. Install one of them there, then add again.");
      expect(add.fix).toBe("Install one of them there, then add again.");
      expect(add.inside).toBe(true);
      expect(await page!.locator("[data-add-computer] [data-step-row][data-state=failed]").count()).toBe(1);
      await page!.waitForTimeout(400);
      await shot(`add-computer-refused-${theme}`, "[data-add-computer]");

      await open("settings-computers-refused", theme, "[data-k=ssh-hosts-refused]");
      const places = await slotRead("places-refused");
      const hosts = await slotRead("ssh-hosts-refused", "[data-add-computer]");
      console.info(`computers refused ${theme}: ${JSON.stringify({ places, hosts })}`);
      expect(places.fix).toBe("Fix or move ~/.wsp/state.json, then start wsp again.");
      expect(places.inside).toBe(true);
      expect(hosts.text).toBe("Hosts from your ssh config not read: ~/.ssh/config: permission denied");
      expect(hosts.inside).toBe(true);
      // The page that draws the refusal is on screen, so no notice says it again.
      expect(await page!.locator("[data-notice]").count()).toBe(0);
      // The road opens with a 200 ms rise; the shots wait it out.
      await page!.waitForTimeout(400);
      await shot(`computers-refused-${theme}`);
      await shot(`computers-refused-add-${theme}`, "[data-add-computer]");
    }
  }, 90_000);
});
