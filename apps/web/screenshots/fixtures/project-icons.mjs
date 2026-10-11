// SPDX-License-Identifier: AGPL-3.0-only
// The tile sidebar with two of its projects wearing images of their own beside the ones that wear a glyph: wsp a flat
// logo on clear, dark-contrast a photo that fills its square. Each image is the one PNG the window keeps for a
// project, kept beside the state as the host keeps it and named in the record by its hash.
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { tiles } from "../fixture-kit.mjs";

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};

/** A 128 px RGBA PNG whose pixel at x, y is `paint(x, y)`, an [r, g, b, a] array. */
const png = paint => {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(128, 0);
  head.writeUInt32BE(128, 4);
  head.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(128 * 513);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) rows.set(paint(x, y), y * 513 + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
};

/** A logo: a blue rounded square with a white ring in it, on clear. */
const LOGO = png((x, y) => {
  const inside = Math.max(Math.abs(x - 63.5) - 40, 0) ** 2 + Math.max(Math.abs(y - 63.5) - 40, 0) ** 2 < 20 ** 2;
  const ring = Math.abs(Math.hypot(x - 63.5, y - 63.5) - 26) < 8;
  return inside ? (ring ? [255, 255, 255, 255] : [37, 99, 235, 255]) : [0, 0, 0, 0];
});
/** A photo: a dusk gradient with a sun, edge to edge. */
const PHOTO = png((x, y) => {
  const sun = Math.hypot(x - 84, y - 70) < 18;
  return sun ? [255, 214, 120, 255] : [Math.round(250 - y * 0.9), Math.round(120 - y * 0.5), Math.round(90 + y * 0.6), 255];
});

const hashOf = bytes => createHash("sha256").update(bytes).digest("hex");

/** A fixture row with `images` (project id to PNG) worn by those projects and kept beside the state. */
export const wearing = (row, images) => ({
  ...row,
  build: (...args) => {
    const state = row.build(...args);
    const held = state.preferences?.default ?? {};
    const projectIcon = Object.fromEntries(Object.entries(images).map(([id, bytes]) => [id, hashOf(bytes)]));
    return { ...state, preferences: { default: { ...held, projectIcon } } };
  },
  files: () => [...(row.files?.() ?? []), ...Object.values(images).map(bytes => ({ path: `project-icons/${hashOf(bytes)}.png`, text: bytes }))],
});

export const IMAGES = { LOGO, PHOTO };

export default wearing({ build: tiles, cloud: "solari", keys: { SOLARI_API_KEY: "slr_fixture_not_a_key" } }, { pr_wsp: LOGO, "pr_dark-contrast": PHOTO });
