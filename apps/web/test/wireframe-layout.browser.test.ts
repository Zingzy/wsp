// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar of the four nouns in a real Chromium, on the wireframe page's
// fixed store: every one-line row (search, head, project, thread, fold, leaf)
// is 28 px and every two-line row (workspace, creation) 44 px at three sidebar
// widths and in the 390 px sheet; every row ends at one right edge; nothing in
// the sidebar wears caps or letter-spacing; the head sits in the fixed header
// over the scrolling tree; each child list's rail runs the height of its item
// and stops at the tick on the last one; the state words read at AA on a flat
// row and on the lifted row; the one lifted row stands off the ground on both
// sides, on light by a darker fill with a hairline edge; a project row's plus
// is nothing at rest and there on hover, and on the phone's sheet every hover
// glyph is nothing at rest but the selected workspace row's chevron; every row
// fades its fill and ink in 150 ms; the leaf under an empty project is a
// sentence in the sans; the held compose glyph still answers a hover with its
// tooltip; the switcher's menu is the head's width, its rows 28 px, at rest
// with no transform once open; the desktop foot names this computer; and the
// whole is photographed on every screen in both themes for a judge. Vite serves test/wireframe to Playwright's
// browser, so like the shell layout test it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium on the machine.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textContrast, wcagContrast } from "./contrast";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS_DIR = join(tmpdir(), "wsp-render");
const THEMES = ["dark", "light"] as const;
const WIDTHS = [220, 256, 480] as const;
const ONE_LINE = 28;
const TWO_LINE = 44;

/** Every row of the sidebar by what it is, with its box and the box of the slot at its right edge. */
interface RowRead {
  id: string;
  kind: "one" | "two";
  height: number;
  left: number;
  right: number;
  slotRight: number | null;
}

if (renderSkipped !== undefined) console.info(`wireframe layout render test skipped: ${renderSkipped}`);

describe.skipIf(renderSkipped !== undefined)("the sidebar of the four nouns laid out in Chromium", () => {
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

  /** Every row in the sidebar's tree and its fixed header, read once. */
  const rows = (): Promise<RowRead[]> =>
    page!.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-search-row], [data-slot=sidebar] [data-k=project-switcher], [data-slot=sidebar] [data-sidebar-row], [data-slot=sidebar] [data-k=no-workspaces], [data-slot=sidebar] [data-thread-launch], [data-slot=sidebar] [data-k=new-project]")];
      return els.map(el => {
        const id = el.dataset["rowId"] ?? el.dataset["k"] ?? (el.hasAttribute("data-search-row") ? "search" : el.hasAttribute("data-thread-launch") ? "launch" : "?");
        const box = el.getBoundingClientRect();
        const slot = el.querySelector<HTMLElement>("[data-thread-state], [data-thread-time], [data-workspace-state], [data-project-slot], [data-creation-state]");
        // A row says how many lines it has: a workspace on a branch or a creation is two, everything else one.
        return { id, kind: el.dataset["lines"] === "2" ? "two" : "one", height: box.height, left: box.left, right: box.right, slotRight: slot === null ? null : slot.getBoundingClientRect().right } as const;
      });
    });

  const expectOneGrammar = (read: RowRead[], where: string): void => {
    expect(read.length, where).toBeGreaterThan(2);
    for (const row of read) expect(row.height, `${row.id} at ${where}`).toBe(row.kind === "two" ? TWO_LINE : ONE_LINE);
    // Every row ends at one x whatever its depth: the tree takes its room from the left alone.
    const rights = new Set(read.filter(row => row.id !== "search" && row.id !== "project-switcher").map(row => Math.round(row.right)));
    expect([...rights], `right edges at ${where}`).toHaveLength(1);
    const slots = new Set(read.flatMap(row => (row.slotRight === null ? [] : [Math.round(row.slotRight)])));
    expect(slots.size, `slot edges at ${where}`).toBeLessThanOrEqual(1);
  };

  it("every one-line row is 28 px and every two-line row 44 px at 220, 256 and 480, every row and every slot ending at one x, in both themes", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        await open("sidebar", theme, `&sidebar=${width}`);
        const sidebar = await page!.locator("[data-slot=sidebar]").first().boundingBox();
        expect(Math.round(sidebar!.width)).toBe(width);
        const read = await rows();
        console.info(`rows at ${width} ${theme}: ${JSON.stringify(read.map(r => [r.id, r.height, Math.round(r.left)]))}`);
        expectOneGrammar(read, `${width} ${theme}`);
        // The computer word beside a project on the box ends where every other slot ends, not short of the plus's room.
        const computerRight = await page!.locator("[data-row-id='project:pr_landing'] [data-project-computer]").evaluate(el => el.getBoundingClientRect().right);
        expect(Math.round(computerRight), `the computer word at ${width} ${theme}`).toBe(Math.round(read.find(row => row.id === "thread:th_lead")!.slotRight!));
        // The depth reads in the left edge: 16 px a level.
        const at = (id: string) => read.find(row => row.id === id)!.left;
        expect(Math.round(at("ws:ws_copy") - at("project:pr_spoo"))).toBe(16);
        expect(Math.round(at("thread:th_lead") - at("ws:ws_copy"))).toBe(16);
        expect(Math.round(at("thread:th_build") - at("thread:th_lead"))).toBe(16);
        expect(Math.round(at("thread:th_review") - at("thread:th_build"))).toBe(16);
        expect(Math.round(at("ws:ws_fork") - at("thread:th_lead"))).toBe(16);
        await shot(`sidebar-${width}-${theme}`, "[data-slot=sidebar]");
      }
      await open("sidebar", theme);
      await shot(`sidebar-1280-${theme}`);
    }
  }, 120_000);

  it("under one picked project the tree starts at its workspaces one level out, the head names the project, and the lifted row is the one selected three deep, in both themes", async () => {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        await open("sidebar-picked", theme, `&sidebar=${width}&pick=pr_spoo`, "[data-sidebar-row][data-active=true]");
        const read = await rows();
        expectOneGrammar(read, `picked ${width} ${theme}`);
        expect(read.some(row => row.id.startsWith("project:"))).toBe(false);
        expect(await page!.locator("[data-k=project-switcher] [data-switcher-name]").textContent()).toBe("spoo");
        const lifted = await page!.locator("[data-sidebar-row][data-active=true]").evaluateAll(els => els.map(el => [el.dataset["rowId"], el.dataset["depth"]]));
        expect(lifted).toEqual([["thread:th_review", "3"]]);
        // The head carries the plus while it stands in for the project's row, at nothing until hovered, and in the
        // room the head keeps for it before the chevron.
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
      expectOneGrammar(empty, `empty ${theme}`);
      expect(empty.map(row => row.id)).toEqual(["search", "project-switcher", "new-project"]);
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
      expect(one.filter(row => row.id.startsWith("project:")).map(row => row.id)).toEqual(["project:pr_spoo"]);
      expect(await page!.locator("[data-k=project-switcher] [data-switcher-name]").textContent()).toBe("All projects");
      await shot(`sidebar-one-project-1280-${theme}`);
    }
  }, 90_000);

  it("the leaf under a project with no workspace is a sentence in the sans at the rows' size, not the mono the figures wear", async () => {
    await open("sidebar", "dark");
    const faces = await page!.evaluate(() => {
      const face = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return { family: style.fontFamily, size: style.fontSize };
      };
      return { leaf: face("[data-k=no-workspaces]"), name: face("[data-row-id='project:pr_wsp'] [data-project-name]"), branch: face("[data-row-id='ws:ws_copy'] [data-workspace-meta]") };
    });
    expect(faces.leaf.family).toBe(faces.name.family);
    expect(faces.leaf.family).not.toBe(faces.branch.family);
    expect(faces.leaf.size).toBe("13px");
  }, 30_000);

  it("every row fades its fill and its ink in 150 ms on hover, whatever its kind", async () => {
    await open("sidebar", "dark");
    const read = await rows();
    const fades = await page!.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLElement>("[data-slot=sidebar] [data-search-row], [data-slot=sidebar] [data-k=project-switcher], [data-slot=sidebar] [data-sidebar-row]")];
      return els.map(el => ({ id: el.dataset["rowId"] ?? el.dataset["k"] ?? "search", property: getComputedStyle(el).transitionProperty, duration: getComputedStyle(el).transitionDuration }));
    });
    expect(fades.length).toBe(read.length - 1);
    for (const fade of fades) {
      expect(fade.property, fade.id).toBe("background-color, color");
      expect(fade.duration, fade.id).toBe("0.15s");
    }
    // The kinds this screen has: the search row, the head, a project, a workspace, a thread and a fold.
    expect(fades.some(f => f.id.startsWith("ws:"))).toBe(true);
    expect(fades.some(f => f.id.startsWith("thread:"))).toBe(true);
    expect(fades.some(f => f.id.startsWith("archived:"))).toBe(true);
  }, 30_000);

  it("the one lifted row stands off the ground on both sides: on light a fill one step darker with a hairline edge at 1.2 to 1 or better, on dark the fill alone", async () => {
    for (const theme of THEMES) {
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      // The fill fades in over 150 ms once the row is selected; it is read once it has landed.
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
        // The edge is the inset layer of the row's box shadow, painted over its fill; its colour leads the layer.
        const shadow = getComputedStyle(row).boxShadow;
        const inset = shadow.split(/,\s(?=(?:rgba?|color|oklch)\()/).find(layer => layer.includes("inset")) ?? "";
        const colour = /^(rgba?\([^)]*\)|color\([^)]*\)|oklch\([^)]*\))/.exec(inset)?.[1] ?? "rgba(0, 0, 0, 0)";
        const edge = over(parse(colour), fill);
        return { ground: ground.map(Math.round), fill: fill.map(Math.round), edge: edge.map(Math.round), shadow };
      });
      const fillRatio = wcagContrast(lifted.fill, lifted.ground);
      const edgeRatio = wcagContrast(lifted.edge, lifted.ground);
      console.info(`${theme} lifted row: ground ${lifted.ground}, fill ${lifted.fill} at ${fillRatio} to 1, edge ${lifted.edge} at ${edgeRatio} to 1 (${lifted.shadow})`);
      if (theme === "light") {
        // Darker than the ground by a step, with the component tier hairline round it.
        expect(lifted.fill[0]!).toBeLessThan(lifted.ground[0]!);
        expect(fillRatio).toBeGreaterThan(1.03);
        expect(edgeRatio).toBeGreaterThanOrEqual(1.2);
      } else {
        expect(fillRatio).toBeGreaterThanOrEqual(1.1);
        expect(lifted.edge).toEqual(lifted.fill);
      }
    }
  }, 60_000);

  it("a desktop window names the computer it is on in the foot, one 28 px mono row under Settings, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar-hosts", theme, "", "[data-host-foot] button");
      const foot = await page!.locator("[data-host-foot] button").evaluate(el => ({ text: el.textContent, height: el.getBoundingClientRect().height, family: getComputedStyle(el).fontFamily }));
      expect(foot.text).toBe("This Mac");
      expect(foot.height).toBe(ONE_LINE);
      expect(foot.family).toMatch(/Mono|mono/);
      await shot(`sidebar-hosts-1280-${theme}`);
      await shot(`sidebar-hosts-256-${theme}`, "[data-slot=sidebar]");
    }
  }, 60_000);

  it("nothing in the sidebar wears caps or letter-spacing, and the head sits in the fixed header outside the scrolling tree", async () => {
    await open("sidebar", "dark");
    const dressed = await page!.locator("[data-sidebar-search] *, [data-sidebar-tree] *").evaluateAll(els =>
      els
        .map(el => ({ text: (el.textContent ?? "").trim().slice(0, 20), transform: getComputedStyle(el).textTransform, spacing: getComputedStyle(el).letterSpacing }))
        .filter(read => read.transform !== "none" || read.spacing !== "normal"),
    );
    expect(dressed).toEqual([]);
    expect(await page!.locator("[data-slot=sidebar-content] [data-k=project-switcher]").count()).toBe(0);
    expect(await page!.locator("[data-slot=sidebar] [data-k=project-switcher]").count()).toBe(1);
    expect(await page!.locator("[data-slot=sidebar-content] [data-sidebar-row]").count()).toBeGreaterThan(0);
  }, 30_000);

  it("each child list draws its rail per item: the height of the item on every one but the last, 14 px to the tick on the last, the tick 6 by 1 at 14 px, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar", theme);
      const rails = await page!.evaluate(() => {
        // Colours computed in oklch and in srgb are one colour to a canvas pixel, so every ink is read as bytes.
        const ctx = document.createElement("canvas").getContext("2d")!;
        const bytes = (c: string): number[] => {
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = c;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        const items = [...document.querySelectorAll<HTMLElement>("[data-sidebar-tree] ul li")].filter(li => getComputedStyle(li.parentElement!).marginLeft === "15px");
        return {
          edge: bytes(getComputedStyle(document.querySelector("[data-slot=sidebar]")!).borderRightColor),
          items: items.map(li => {
            const before = getComputedStyle(li, "::before");
            const after = getComputedStyle(li, "::after");
            return {
              id: li.querySelector<HTMLElement>("[data-sidebar-row], [data-k=no-workspaces], [data-thread-launch]")?.dataset["rowId"] ?? "leaf",
              last: li === li.parentElement!.lastElementChild,
              height: li.getBoundingClientRect().height,
              rail: parseFloat(before.height),
              railWidth: before.width,
              tick: { top: after.top, width: after.width, height: after.height },
              ink: before.backgroundColor,
              inkBytes: bytes(before.backgroundColor),
            };
          }),
        };
      });
      console.info(`rails at ${theme}: ${JSON.stringify(rails)}`);
      expect(rails.items.length).toBeGreaterThan(6);
      // The rails' ink: on dark one step over the 6 percent structural hairline, so the tree reads on a bright
      // display; on light the structural hairline itself, the sidebar's own edge.
      for (const item of rails.items) {
        expect(item.railWidth, item.id).toBe("1px");
        expect(item.tick, item.id).toEqual({ top: "14px", width: "6px", height: "1px" });
        expect(item.ink, item.id).not.toBe("rgba(0, 0, 0, 0)");
        if (theme === "dark") expect(item.ink, item.id).toBe("rgba(255, 255, 255, 0.08)");
        else expect(item.inkBytes, item.id).toEqual(rails.edge);
        if (item.last) expect(item.rail, `${item.id} is last`).toBe(14);
        else expect(Math.round(item.rail), item.id).toBe(Math.round(item.height));
      }
    }
  }, 60_000);

  it("the state words read at 4.5 to 1 or better on a flat row and on the lifted row, in both themes", async () => {
    for (const theme of THEMES) {
      await open("sidebar", theme);
      const flat = await textContrast(page!, "[data-slot=sidebar] [data-thread-state]");
      expect(flat.length).toBeGreaterThan(1);
      for (const ratio of flat) expect(ratio, `a state word on a flat row reads at ${ratio} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      await open("sidebar-picked", theme, "&pick=pr_spoo", "[data-sidebar-row][data-active=true]");
      await page!.waitForTimeout(400);
      const lifted = await textContrast(page!, "[data-sidebar-row][data-active=true] [data-thread-state]");
      expect(lifted).toHaveLength(1);
      expect(lifted[0], `the lifted row's word reads at ${lifted[0]} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      await open("bring-back-paused", theme);
      await page!.keyboard.press("Escape");
      const stopped = await textContrast(page!, "[data-row-id='ws:ws_box'] [data-workspace-state]");
      expect(await page!.locator("[data-row-id='ws:ws_box'] [data-workspace-state]").textContent()).toBe("Stopped");
      expect(stopped[0], `Stopped reads at ${stopped[0]} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      console.info(`${theme}: state words on flat rows ${flat.map(r => r.toFixed(2)).join(", ")}, on the lifted row ${lifted[0]!.toFixed(2)}, Stopped ${stopped[0]!.toFixed(2)} to 1`);
    }
  }, 90_000);

  it("a project row's plus is nothing at rest and there on hover, and the row's name keeps its width between the two", async () => {
    await open("sidebar", "dark");
    const plus = page!.locator("[data-row-id='project:pr_spoo'] ~ [data-k=new-workspace]").first();
    const name = page!.locator("[data-row-id='project:pr_spoo'] [data-project-name]");
    expect(await plus.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    const before = await name.boundingBox();
    await page!.locator("[data-row-id='project:pr_spoo']").hover();
    await page!.waitForFunction(() => getComputedStyle(document.querySelector("[data-row-id='project:pr_spoo'] ~ [data-k=new-workspace]")!).opacity === "1");
    expect(await name.boundingBox()).toEqual(before);
    // The compose glyph is the one add control at rest: one plus per project row, all at nothing, and nothing else.
    const atRest = await page!.locator("[data-slot=sidebar] svg.lucide-plus").evaluateAll(els => els.map(el => getComputedStyle(el.closest("button")!).opacity));
    expect(atRest.length).toBe(3);
    expect(atRest.filter(opacity => opacity === "1")).toHaveLength(1);
  }, 30_000);

  it("the switcher's menu opens under the head at the head's width, its rows 28 px, and comes to rest with no transform, in both themes", async () => {
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

  it("at 390 the sidebar is a sheet with the same rows at the same heights, in both themes", async () => {
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
        expectOneGrammar(read, `${screen} at 390 ${theme}`);
        // The sidebar is what the shot is of: the sheet on top at its centre is the sidebar's, not the right panel's.
        const onTop = await page!.evaluate(() => {
          const box = document.querySelector("[data-slot=sidebar][data-mobile=true]")!.getBoundingClientRect();
          return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest("[data-slot=sidebar]") !== null;
        });
        expect(onTop, `${screen} at 390 ${theme}`).toBe(true);
        // No pointer here, so no glyph stands at rest but one: every hover glyph is at nothing except the selected
        // workspace row's chevron, whose state word yields to it; no plus is drawn but the compose glyph's square;
        // the fold rows' chevrons are their own and stay.
        const glyphsAtRest = () => page!.locator("[data-slot=sidebar][data-mobile=true] [data-sidebar=menu-action]").evaluateAll(els => els.map(el => [el.getAttribute("aria-label"), getComputedStyle(el).opacity]).filter(([, opacity]) => opacity !== "0"));
        const liftedWorkspace = () => page!.locator("[data-slot=sidebar][data-mobile=true] [data-row-id^='ws:'][data-active=true]").evaluateAll(rows => rows.map(row => [`Collapse ${row.querySelector("[data-workspace-name]")!.textContent}`, "1", getComputedStyle(row.querySelector("[data-workspace-state]")!).opacity]));
        const lifted = await liftedWorkspace();
        expect(await glyphsAtRest(), `${screen} at 390 ${theme}`).toEqual(lifted.map(([label, opacity]) => [label, opacity]));
        for (const [, , word] of lifted) expect(word).toBe("0");
        // The one plus a row may carry on its face is the empty app's New project row, which is a row and not a glyph.
        const pluses = await page!.locator("[data-slot=sidebar][data-mobile=true] svg.lucide-plus").evaluateAll(els => els.map(el => el.closest("button")!).filter(button => button.dataset["k"] !== "new-project").map(button => getComputedStyle(button).opacity));
        expect(pluses.filter(opacity => opacity !== "0")).toEqual([]);
        await shot(`${screen}-390-${theme}`);
        if (screen === "sidebar") {
          // A tap on another workspace moves the one chevron with the selection.
          await page!.locator("[data-slot=sidebar][data-mobile=true] [data-row-id='ws:ws_copy']").click();
          await page!.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          await page!.mouse.move(385, 840);
          await page!.waitForSelector("[data-slot=sidebar][data-mobile=true] [data-row-id='ws:ws_copy'][data-active=true]");
          await page!.waitForTimeout(250);
          expect(await glyphsAtRest(), `${screen} at 390 ${theme} after a tap`).toEqual([["Collapse webhook retries", "1"]]);
          await shot(`sidebar-workspace-390-${theme}`);
        }
      }
    }
  }, 150_000);
});
