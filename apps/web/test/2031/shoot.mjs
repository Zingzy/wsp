// SPDX-License-Identifier: AGPL-3.0-only
// Photographs the design page: each state alone at 1440 by 900 (the Settings shell's width), both themes, device
// scale 2, reduced motion, and the threads state at 390. node test/2031/shoot.mjs <base url> <out folder> [chrome path]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [base, out, executablePath] = process.argv.slice(2);
if (base === undefined || out === undefined) throw new Error("usage: shoot.mjs <base url> <out folder> [chrome path]");
mkdirSync(out, { recursive: true });

const STATES = ["threads", "stop", "ending", "loading", "filter", "processes", "ports", "all", "away", "empty", "beside", "panel", "sheet"];
const NARROW = ["threads", "panel"];
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });
try {
  for (const theme of ["dark", "light"]) {
    const errors = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce", colorScheme: theme });
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => m.type() === "error" && errors.push(m.text()));
    const shoot = async (state, file, full) => {
      await page.goto(`${base}/test/2031/index.html?theme=${theme}&state=${state}`);
      await page.waitForSelector(`[data-state=${state}]`);
      await page.waitForTimeout(600);
      if (state === "ending") await page.hover("[data-proc-row='35002']");
      if (state === "sheet") await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.screenshot({ path: join(out, file), fullPage: full });
    };
    for (const state of STATES) await shoot(state, `${state}-${theme}.png`, !["stop", "sheet"].includes(state));
    await page.setViewportSize({ width: 390, height: 844 });
    for (const state of NARROW) await shoot(state, `${state}-narrow-${theme}.png`, state !== "panel");
    if (errors.length > 0) console.log(`${theme} page errors:\n${errors.join("\n")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`shots in ${out}`);
