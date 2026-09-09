// SPDX-License-Identifier: AGPL-3.0-only
// Run by hand and commit the outputs; the disk image's window is drawn from
// them. The look is the site's: dark ground, the clouds dithered to two
// colours so nothing glows or gradients, the arrow between where the app and
// the Applications folder sit, and one mono line at the bottom.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { DMG_ARROW, DMG_WINDOW } from "./dmg-layout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "build");
const clouds = readFileSync(join(root, "..", "www", "src", "assets", "clouds.webp")).toString("base64");

const LINE = "one image  ·  apple silicon and intel  ·  agpl-3.0";

const GROUND = "#09090b";
const INK = "#99adcc";
const QUIET = "#52525b";
/** One canvas pixel per cell of the dither, scaled up so the pattern reads as a pattern and not as noise. */
const CELL = 3;

// The same ordered dither the site draws with, in two dimensions instead of a shader: one 8x8 Bayer cell per pixel of
// the small canvas, the picture's brightness pushed down so only the brightest cloud tops light a cell at all. This
// runs inside the page, never in node, and reaches the page's own globals; playwright sends it as its own text.
const DRAW = async ({ src, ground, ink }) => {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.getElementById("dither");
  const w = canvas.width, h = canvas.height;
  const small = document.createElement("canvas");
  small.width = w; small.height = h;
  const from = small.getContext("2d");
  const scale = Math.max(w / image.naturalWidth, h / image.naturalHeight);
  const dw = image.naturalWidth * scale, dh = image.naturalHeight * scale;
  from.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const pixels = from.getImageData(0, 0, w, h).data;
  const bayer = (x, y) => {
    let value = 0;
    for (let bit = 0; bit < 3; bit++) {
      const bx = (x >> bit) & 1, by = (y >> bit) & 1;
      value = value * 4 + (by ? (bx ? 3 : 2) : (bx ? 1 : 0));
    }
    return value / 64;
  };
  const to = canvas.getContext("2d");
  to.fillStyle = ground;
  to.fillRect(0, 0, w, h);
  to.fillStyle = ink;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = (0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]) / 255;
      // Only the brightest cloud tops survive, and the picture dissolves before it reaches the icons.
      const lit = Math.min(1, Math.max(0, (l - 0.66) / 0.3)) * 0.42 * Math.max(0, 1 - y / (h * 0.3));
      if (bayer(x, y) + 1 / 64 < lit) to.fillRect(x, y, 1, 1);
    }
  }
  canvas.dataset.done = "true";
};

function page(scale) {
  const { width, height } = DMG_WINDOW;
  const cell = CELL * scale;
  const arrow = { y: DMG_ARROW.y * scale, from: DMG_ARROW.from * scale, to: DMG_ARROW.to * scale };
  const head = arrow.to - 9 * scale;
  return `<!doctype html><html><body style="margin:0;background:${GROUND}">
<div style="position:relative;width:${width * scale}px;height:${height * scale}px;overflow:hidden">
  <canvas id="dither" width="${Math.ceil((width * scale) / cell)}" height="${Math.ceil((height * scale) / cell)}"
    style="position:absolute;inset:0;width:${width * scale}px;height:${height * scale}px;image-rendering:pixelated"></canvas>
  <svg width="${width * scale}" height="${height * scale}" style="position:absolute;inset:0" fill="none">
    <path d="M ${arrow.from} ${arrow.y} H ${head}" stroke="${QUIET}" stroke-width="${1.5 * scale}" />
    <path d="M ${head} ${arrow.y - 5 * scale} L ${arrow.to} ${arrow.y} L ${head} ${arrow.y + 5 * scale} Z" fill="${QUIET}" />
  </svg>
  <p style="position:absolute;left:0;right:0;bottom:${26 * scale}px;margin:0;text-align:center;color:${QUIET};
    font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:${11 * scale}px;letter-spacing:${0.09 * scale}em">${LINE}</p>
</div></body></html>`;
}

const browser = await chromium.launch();
async function shoot(scale) {
  const { width, height } = DMG_WINDOW;
  const tab = await browser.newPage({ viewport: { width: width * scale, height: height * scale }, deviceScaleFactor: 1 });
  await tab.setContent(page(scale));
  await tab.evaluate(DRAW, { src: `data:image/webp;base64,${clouds}`, ground: GROUND, ink: INK });
  const png = await tab.screenshot({ type: "png" });
  await tab.close();
  return png;
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "dmg-background.png"), await shoot(1));
writeFileSync(join(out, "dmg-background@2x.png"), await shoot(2));
await browser.close();
console.log(`wrote ${join(out, "dmg-background.png")} and ${join(out, "dmg-background@2x.png")}`);
