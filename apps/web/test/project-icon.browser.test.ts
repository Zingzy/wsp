// SPDX-License-Identifier: AGPL-3.0-only
// A project's image fitted in a real Chromium, by the window's own code. PNG,
// JPEG, WebP, GIF (its first frame) and SVG each become one 128 px PNG, the
// picture centred with no crop on a clear ground, in the shape the host takes.
// Hostile SVGs (a script, an onload, an outside image, @import, a paint server
// and a <use> pointing out, a 100000 px size, no size at all, an entity bomb)
// are each fitted or refused, while a server of our own counts every request
// that reaches it: none may, no script may run, and no SVG's text may land in
// the page. Like the other render tests it runs only when asked for
// (WSP_RENDER=1) and skips without Playwright's Chromium.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchRender, renderSkipped, stopRender } from "./render-browser";
import { startVite, type ViteChild } from "./vite-child";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = "/test/project-icon/index.html";
const WAIT_MS = 15_000;
const MARK = "wsp-hostile-svg";

if (renderSkipped !== undefined) console.info(`project image render test skipped: ${renderSkipped}`);

type Fit = { png: string } | { refusal: { said: string; fix: string } };

/** The PNG's chunks by type, and its pixels inflated: the facts the host's own check reads. */
function pngFacts(b64: string): { width: number; height: number; depth: number; colour: number; interlace: number; bytes: number; chunks: string[]; inflated: number } {
  const png = Buffer.from(b64, "base64");
  const chunks: string[] = [];
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) {
    const type = png.toString("latin1", at + 4, at + 8);
    chunks.push(type);
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), depth: png[24]!, colour: png[25]!, interlace: png[28]!, bytes: png.length, chunks: [...new Set(chunks)], inflated: inflateSync(Buffer.concat(idat)).length };
}

/** A two-frame GIF, 4 by 2: the first frame red, the second blue. LZW is kept to three-bit codes by a clear code
 * every two pixels, so the encoder fits in a line. */
function twoFrameGif(): string {
  const frame = (index: number): number[] => {
    const codes = [4, index, index, 4, index, index, 4, index, index, 4, index, index, 5];
    const bytes: number[] = [];
    let bits = 0;
    let n = 0;
    for (const code of codes) {
      bits |= code << n;
      n += 3;
      while (n >= 8) {
        bytes.push(bits & 255);
        bits >>= 8;
        n -= 8;
      }
    }
    if (n > 0) bytes.push(bits & 255);
    return [0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 4, 0, 2, 0, 0, 2, bytes.length, ...bytes, 0];
  };
  const head = [..."GIF89a"].map(c => c.charCodeAt(0));
  return Buffer.from([...head, 4, 0, 2, 0, 0x80, 0, 0, 255, 0, 0, 0, 0, 255, ...frame(0), ...frame(1), 0x3b]).toString("base64");
}

describe.skipIf(renderSkipped !== undefined)("a project's image fitted in Chromium", () => {
  let vite: ViteChild | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let server: Server | undefined;
  const asked: string[] = [];
  let out = "";

  beforeAll(async () => {
    server = createServer((req, res) => {
      asked.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": req.url?.endsWith(".css") ? "text/css" : "image/svg+xml", "access-control-allow-origin": "*" });
      res.end(req.url?.endsWith(".css") ? "rect{fill:red}" : "<svg xmlns='http://www.w3.org/2000/svg'/>");
    });
    await new Promise<void>(done => server!.listen(0, "127.0.0.1", done));
    out = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vite = await startVite(WEB_DIR, PAGE);
    browser = await launchRender();
    page = await browser.newPage();
    page.setDefaultTimeout(WAIT_MS);
    await page.goto(`${vite.base}${PAGE}`, { timeout: 60_000 });
    await page.waitForFunction(() => window.ready === true, undefined, { timeout: 60_000 });
  }, 90_000);

  afterAll(async () => {
    await stopRender(browser, vite?.child);
    await new Promise(done => server?.close(done));
  });

  const fit = (b64: string): Promise<Fit> => page!.evaluate(bytes => window.fit(bytes), b64);
  const svg = (body: string, attrs = 'width="64" height="64" viewBox="0 0 64 64"'): string => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}><desc>${MARK}</desc>${body}</svg>`).toString("base64");

  it("makes PNG, JPEG, WebP, GIF and SVG each one 128 px PNG the host takes, centred with no crop on a clear ground", async () => {
    const sources: [string, string][] = [];
    for (const type of ["image/png", "image/jpeg", "image/webp"]) sources.push([type, await page!.evaluate(([t, w, h]) => window.source(t, w, h), [type, 400, 200] as [string, number, number])]);
    sources.push(["image/gif", twoFrameGif()]);
    sources.push(["image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="200" height="200" fill="#ff0000"/><rect x="200" width="200" height="200" fill="#0000ff"/></svg>').toString("base64")]);
    for (const [type, bytes] of sources) {
      const fitted = await fit(bytes);
      if (!("png" in fitted)) throw new Error(`${type} was refused: ${fitted.refusal.said}`);
      const facts = pngFacts(fitted.png);
      expect({ ...facts, bytes: facts.bytes <= 80 * 1024 }, type).toEqual({ width: 128, height: 128, depth: 8, colour: 6, interlace: 0, bytes: true, chunks: ["IHDR", "IDAT", "IEND"], inflated: 128 * 513 });
      // A 2:1 picture fills the width and sits in the middle band: clear above and below, both its halves in.
      const { rgba } = await page!.evaluate(([png]) => window.pixels(png, [[64, 2], [64, 125], [3, 64], [124, 64], [64, 64]]), [fitted.png] as [string]);
      const [top, bottom, left, right] = rgba;
      if (type === "image/gif") {
        // The GIF is 4 by 2, so it fills the same band, and only its first frame, red, is drawn.
        expect(top![3], type).toBe(0);
        expect(bottom![3], type).toBe(0);
        expect([left![0]! > 200, left![2]! < 60, right![0]! > 200, right![2]! < 60], type).toEqual([true, true, true, true]);
        continue;
      }
      expect([top![3], bottom![3]], type).toEqual([0, 0]);
      expect([left![0]! > 200, left![2]! < 60, left![3]], type).toEqual([true, true, 255]);
      expect([right![2]! > 200, right![0]! < 60, right![3]], type).toEqual([true, true, 255]);
    }
  }, 60_000);

  it("fits or refuses every hostile SVG with no request reaching a server, no script running, and none of its text in the page", async () => {
    const bomb = Buffer.from(`<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "${MARK}"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;"><!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;"><!ENTITY h "&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;"><!ENTITY i "&h;&h;&h;&h;&h;&h;&h;&h;&h;&h;">]><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text>&i;</text></svg>`).toString("base64");
    const cases: [string, string][] = [
      ["script", svg(`<script>window.top.ran = 1; fetch("${out}/script")</script><rect width="64" height="64" fill="red"/>`)],
      ["onload", svg(`<rect width="64" height="64" fill="red" onload="window.top.ran = 1; fetch('${out}/onload')"/>`, `width="64" height="64" onload="fetch('${out}/root-onload')"`)],
      ["image href", svg(`<image href="${out}/image.svg" width="64" height="64"/><image xlink:href="${out}/xlink.png" width="64" height="64"/>`)],
      ["@import", svg(`<style>@import url(${out}/import.css); rect { fill: url(${out}/style-fill.svg#p) }</style><rect width="64" height="64"/>`)],
      ["fill url", svg(`<rect width="64" height="64" fill="url(${out}/fill.svg#g)" style="filter: url(${out}/filter.svg#f)"/>`)],
      ["use href", svg(`<use href="${out}/use.svg#a"/><use xlink:href="${out}/xlink-use.svg#a"/>`)],
      ["100000 px", svg(`<rect width="100000" height="100000" fill="red"/>`, 'width="100000" height="100000"')],
      ["no size", svg(`<rect width="300" height="150" fill="red"/>`, "")],
      ["entity bomb", bomb],
    ];
    const results: Record<string, string> = {};
    for (const [name, bytes] of cases) {
      const fitted = await fit(bytes);
      results[name] = "png" in fitted ? `fitted ${pngFacts(fitted.png).width}` : `refused: ${fitted.refusal.said}`;
    }
    // Every case ends in a 128 px PNG or a refusal; none hangs or throws.
    for (const [name, said] of Object.entries(results)) expect(said, name).toMatch(/^fitted 128$|^refused: /);
    expect(results["100000 px"]).toBe("fitted 128");
    expect(results["no size"]).toBe("fitted 128");
    // Give a late request time to land before counting.
    await page!.waitForTimeout(500);
    expect(asked).toEqual([]);
    expect(await page!.evaluate(() => (window as unknown as { ran?: number }).ran)).toBeUndefined();
    expect(await page!.evaluate(() => document.documentElement.outerHTML)).not.toContain(MARK);
    expect(await page!.evaluate(() => document.querySelectorAll("svg, img, canvas, iframe").length)).toBe(0);
    // The control: the page's own fetch does reach the server, so the empty count above is the SVGs' doing.
    await page!.evaluate(at => fetch(`${at}/control`).then(() => undefined), out);
    expect(asked).toEqual(["GET /control"]);
    console.info(`hostile SVGs: ${JSON.stringify(results)}`);
  }, 60_000);

  it("refuses a 1.1 MB, 20000 px PNG off its header before the renderer decodes it", async () => {
    const head = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const size = Buffer.alloc(13);
    size.writeUInt32BE(20_000, 0);
    size.writeUInt32BE(20_000, 4);
    size.set([8, 6, 0, 0, 0], 8);
    const bytes = Buffer.concat([head, size, Buffer.alloc(4), Buffer.alloc(1_100_000)]).toString("base64");
    expect(await fit(bytes)).toEqual({ refusal: { said: "This image is over 4096 by 4096 pixels.", fix: "Scale it down, or pick a smaller one." } });
  });
});
