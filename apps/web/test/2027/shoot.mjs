// SPDX-License-Identifier: AGPL-3.0-only
// Photographs the design page at the transcript's width (the column is max-w-3xl, 768 px, inside the list's 20 px
// sides), both themes, device scale 2, reduced motion: the whole page, then each state alone.
// node test/2027/shoot.mjs <base url> <out folder> [chrome path]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [base, out, executablePath] = process.argv.slice(2);
if (base === undefined || out === undefined) throw new Error("usage: shoot.mjs <base url> <out folder> [chrome path]");
mkdirSync(out, { recursive: true });

const STATES = ["beside", "group", "running", "done", "failed", "long", "edit", "write", "codex"];
const browser = await chromium.launch({ args: ["--enable-low-end-device-mode"], ...(executablePath ? { executablePath } : {}) });
try {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 808, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce", colorScheme: theme });
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => m.type() === "error" && errors.push(m.text()));
    page.on("response", r => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
    const settle = async () => {
      await page.waitForSelector("[data-state]");
      await page.waitForFunction(() => document.querySelectorAll("[data-call-row] .shiki, [data-call-row] span[style*='color']").length > 0, null, { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(1500);
    };
    await page.goto(`${base}/test/2027/index.html?theme=${theme}`);
    await settle();
    await page.screenshot({ path: join(out, `all-${theme}.png`), fullPage: true });
    for (const state of STATES) {
      await page.goto(`${base}/test/2027/index.html?theme=${theme}&state=${state}`);
      await settle();
      const box = await page.locator(`[data-state=${state}]`).boundingBox();
      await page.screenshot({ path: join(out, `${state}-${theme}.png`), clip: { x: 0, y: Math.max(0, box.y - 16), width: 808, height: box.height + 32 }, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${base}/test/2027/index.html?theme=${theme}`);
    await settle();
    await page.screenshot({ path: join(out, `narrow-${theme}.png`), fullPage: true });
    if (errors.length > 0) console.log(`${theme} page errors:\n${errors.join("\n")}`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`shots in ${out}`);
