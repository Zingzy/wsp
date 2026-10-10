// SPDX-License-Identifier: AGPL-3.0-only
// Photographs the design page in both themes, reduced motion: each layout shut and open at 1440 by 900, option a's
// toast, empty and Settings states, each layout open at 390 (the sidebar's sheet opened first for b and c), and the
// open list alone at device scale 2.
// node test/1977/shoot.mjs <base url> <out folder> [chrome path]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [base, out, executablePath] = process.argv.slice(2);
if (base === undefined || out === undefined) throw new Error("usage: shoot.mjs <base url> <out folder> [chrome path]");
mkdirSync(out, { recursive: true });

const WIDE = [
  ["a", "shut"], ["a", "open"], ["a", "toast"], ["a", "empty"], ["a", "settings"],
  ["b", "shut"], ["b", "open"],
  ["c", "shut"], ["c", "open"],
];
const NARROW = ["a", "b", "c"];

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const errors = [];
async function shoot({ theme, option, state, width, scale = 1, list = false }) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: scale, reducedMotion: "reduce", colorScheme: theme });
  page.on("pageerror", e => errors.push(`${option}-${state}-${theme}-${width}: ${e}`));
  await page.goto(`${base}/test/1977/index.html?option=${option}&state=${state}&theme=${theme}`);
  await page.waitForSelector("[data-sidebar-corner], [data-shell-center]");
  if (width < 640 && option !== "a") {
    await page.locator("[data-sidebar=trigger]:visible").first().click();
  }
  await page.waitForSelector("[data-k=notices-bell]", { timeout: 20_000 });
  // The toast lands 600 ms in; the thread's reply and the list's rows settle in the same second.
  await page.waitForTimeout(1500);
  const name = `${option}-${state}-${theme}-${width}${list ? "-list" : ""}.png`;
  if (list) {
    const box = await page.locator("[data-slot=popover-popup]").boundingBox();
    await page.screenshot({ path: join(out, name), clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 } });
  } else await page.screenshot({ path: join(out, name) });
  await page.close();
}

try {
  for (const theme of ["dark", "light"]) {
    for (const [option, state] of WIDE) await shoot({ theme, option, state, width: 1440 });
    for (const option of NARROW) await shoot({ theme, option, state: "open", width: 390 });
    await shoot({ theme, option: "a", state: "open", width: 1440, scale: 2, list: true });
  }
} finally {
  await browser.close();
}
if (errors.length > 0) console.log(`page errors:\n${errors.join("\n")}`);
console.log(`shots in ${out}`);
