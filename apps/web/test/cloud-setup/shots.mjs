// SPDX-License-Identifier: AGPL-3.0-only
// Photographs every step and state of the cloud setup fixture in both themes
// at 1280 by 800, for a reviewer to look at before the owner does. Runs
// against the dev server: node test/cloud-setup/shots.mjs <out dir> [base url].
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2];
const base = process.argv[3] ?? "http://localhost:5177";
if (out === undefined) throw new Error("usage: node test/cloud-setup/shots.mjs <out dir> [base url]");
mkdirSync(out, { recursive: true });

/** Each state: the fixture step, then what to do on the page before the shot. */
const STATES = [
  ["choice", "choice"],
  ["keys-empty", "keys"],
  ["keys-typed", "keys", async page => page.locator("[role=dialog] input").fill("slr_live_x9k2m4p7q1w8e5r3t6y0u2i4o6p8a1s3d5f7g9h2j4k6l8")],
  ["reading-midway", "reading", async page => page.waitForTimeout(2600)],
  ["agents", "agents"],
  ["tools-top", "tools"],
  ["tools-bottom", "tools", async page => page.locator("[role=dialog] [data-slot=scroll-area-viewport]").evaluate(el => el.scrollTo(0, el.scrollHeight))],
  ["also", "also"],
  ["logins", "logins"],
  ["logins-picker-open", "logins", async page => page.locator("[role=dialog] [data-k=answer]").first().click()],
  ["logins-key-field", "logins", async page => {
    const picker = page.locator("[role=dialog] [data-k=answer][data-row='logins/claude']");
    await picker.click();
    await page.locator("[data-k=option][data-value=key]").click();
    await page.waitForTimeout(200);
  }],
  ["ask", "ask"],
  ["building-stage-open", "building"],
  ["signing-slide", "signing"],
  ["retry-and-cancel-disabled", "retry"],
  ["retry-cancel-tooltip", "retry", async page => {
    await page.locator("[role=dialog] [data-k=secondary-reason]").hover();
    await page.waitForTimeout(700);
  }],
  ["signing-cancel-hover", "signing", async page => {
    await page.locator("[role=dialog] [data-k=secondary]").hover();
    await page.waitForTimeout(300);
  }],
  ["done", "done"],
  ["failed", "failed"],
  // A short window: the card keeps the active stage and its block in view, done rows gone under the top fade.
  ["building-633", "building", undefined, { width: 1280, height: 633 }],
  ["signing-633", "signing", undefined, { width: 1280, height: 633 }],
  ["tools-633", "tools", undefined, { width: 1280, height: 633 }],
];

const browser = await chromium.launch();
for (const theme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  let n = 0;
  for (const [name, step, act, viewport] of STATES) {
    n += 1;
    await page.setViewportSize(viewport ?? { width: 1280, height: 800 });
    await page.goto(`${base}/test/cloud-setup/index.html?theme=${theme}&screen=${step}`);
    await page.waitForSelector("[role=dialog] [data-k=title]");
    await page.waitForTimeout(400);
    if (act !== undefined) await act(page);
    else await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(250);
    const file = join(out, `${String(n).padStart(2, "0")}-${name}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
  await page.close();
}
await browser.close();
