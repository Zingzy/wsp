// SPDX-License-Identifier: AGPL-3.0-only
// The wallpaper the shots sit on, with the narrow copy `pnpm images` makes for a phone.
import wall from "@/assets/wall/wall.webp";
import narrow from "@/assets/wall/wall-800.webp";

export const WALL = { src: wall, srcSet: `${narrow} 800w, ${wall} 2400w` };
