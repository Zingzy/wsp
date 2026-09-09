// SPDX-License-Identifier: AGPL-3.0-only
// The drag window's geometry, in one place. scripts/dmg-background.mjs draws
// the image to it, electron-builder.yml places the two icons at the same
// numbers, and test/dmg.test.ts holds the yml to this file, so moving an icon
// cannot leave the arrow drawn at the old height.

/** The window the disk image opens at: dmg-builder reads it off the background image's size, so the image is drawn
 * at exactly this, and every coordinate below is in its pixels. */
export const DMG_WINDOW = { width: 660, height: 400 };

/** How wide each icon is drawn, which is what the two centres have to stay clear of. */
export const DMG_ICON_SIZE = 128;

/** Where each icon's centre sits: the app on the left, the Applications folder on the right, on one line. */
export const DMG_ICONS = { app: { x: 172, y: 186 }, applications: { x: 488, y: 186 } };

/** How far the arrow stops short of either icon. */
const ARROW_CLEARANCE = 52;

/** The arrow between the two, from the app's right edge to the folder's left edge, on their line. */
export const DMG_ARROW = {
  y: DMG_ICONS.app.y,
  from: DMG_ICONS.app.x + DMG_ICON_SIZE / 2 + ARROW_CLEARANCE,
  to: DMG_ICONS.applications.x - DMG_ICON_SIZE / 2 - ARROW_CLEARANCE,
};
