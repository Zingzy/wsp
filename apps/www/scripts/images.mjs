// SPDX-License-Identifier: AGPL-3.0-only
// The images the site makes from its own: the narrow copies of the hero's pictures a phone loads, the link-preview
// images (scripts/og.html filled with each route's line and photographed at 1200x630 into public/) and the 512 px logo
// the structured data names. `pnpm images`, then commit what it wrote; the host's build has no browser.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const dataUrl = (file, type) => `data:${type};base64,${readFileSync(join(root, file)).toString("base64")}`;
const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** The pictures a phone gets at the widths their srcset names. Written first: the pages import them. */
const NARROW = [
  ["src/assets/shots/w-hero.webp", "src/assets/shots/w-hero-1440.webp", 1440],
  ["src/assets/shots/w-hero.webp", "src/assets/shots/w-hero-800.webp", 800],
  ["src/assets/wall/wall.webp", "src/assets/wall/wall-800.webp", 800],
  ...["pr", "deploy", "cart", "traffic", "explain"].map(name => [`src/assets/shots/w-slate-${name}.webp`, `src/assets/shots/w-slate-${name}-1280.webp`, 1280]),
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  for (const [from, to, width] of NARROW) {
    const webp = await page.evaluate(
      async ([src, width]) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        const canvas = new OffscreenCanvas(width, Math.round((image.height * width) / image.width));
        const context = canvas.getContext("2d");
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/webp", quality: 0.85 })).arrayBuffer());
        return Array.from(bytes, b => String.fromCharCode(b)).join("");
      },
      [dataUrl(from, "image/webp"), width],
    );
    writeFileSync(join(root, to), Buffer.from(webp, "latin1"));
    console.log(`wrote ${to}`);
  }

  const vite = await createServer({ root, logLevel: "warn", server: { middlewareMode: true }, appType: "custom" });
  const { ROUTES } = await vite.ssrLoadModule("/src/routes.tsx");
  const { Lockup } = await vite.ssrLoadModule("/src/components/brand.tsx");
  await vite.close();

  const lockup = renderToStaticMarkup(createElement(Lockup));
  const fill = {
    inter: dataUrl("node_modules/@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2", "font/woff2"),
    mono: dataUrl("node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2", "font/woff2"),
    wall: dataUrl("src/assets/wall/wall.webp", "image/webp"),
    shot: dataUrl("src/assets/shots/w-hero.webp", "image/webp"),
    lockup,
  };
  const template = readFileSync(join(root, "scripts/og.html"), "utf8");
  for (const [path, line] of new Map(ROUTES.map(r => [r.image.path, r.image.line]))) {
    await page.setContent(template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key === "line" ? escape(line) : fill[key])), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(root, "public", path), type: "png" });
    console.log(`wrote public${path}`);
  }

  await page.setViewportSize({ width: 512, height: 512 });
  const mark = /<svg[\s\S]*?<\/svg>/.exec(lockup)[0].replace("<svg ", '<svg width="320" height="320" ');
  await page.setContent(`<body style="margin:0;width:512px;height:512px;display:grid;place-items:center;background:#121110;color:#ece6dc">${mark}</body>`);
  await page.screenshot({ path: join(root, "public/logo.png"), type: "png" });
  console.log("wrote public/logo.png");
} finally {
  await browser.close();
}
