// SPDX-License-Identifier: AGPL-3.0-only
// The menu bar's two template images, the mark and the question mark it swaps
// to while a thread waits on the person. Run by hand and commit the outputs.
// A template image is black on clear, and macOS draws it in the menu bar's own
// ink, light or dark; the "Template" in the name is what tells Electron so.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "src", "tray");
const mark = readFileSync(join(root, "..", "web", "src", "brand", "mark.svg"), "utf8");
const ask = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 5.6a2.9 2.9 0 1 1 4.3 2.5c-.9.5-1.5 1.1-1.5 2.1v.4"/><circle cx="8" cy="13.7" r="0.35" fill="currentColor"/></svg>`;
/** The menu bar's glyph box, in points; the @2x file is twice it. */
const SIZE = 18;

const browser = await chromium.launch();
async function shoot(svg, size) {
  const tab = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await tab.setContent(`<!doctype html><html><body style="margin:0;background:transparent;color:#000">${svg.replace("<svg ", `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`);
  const png = await tab.screenshot({ omitBackground: true, type: "png" });
  await tab.close();
  return png;
}
mkdirSync(out, { recursive: true });
for (const [name, svg] of [["trayTemplate", mark], ["trayAskTemplate", ask]]) {
  writeFileSync(join(out, `${name}.png`), await shoot(svg, SIZE));
  writeFileSync(join(out, `${name}@2x.png`), await shoot(svg, SIZE * 2));
}
await browser.close();
console.log(`wrote the tray images under ${out}`);
