// SPDX-License-Identifier: AGPL-3.0-only
// The words a project's look is made of, apart from the index so a recipe's
// folder rows can name them without the two modules reading each other.
import { z } from "zod";

/** The glyphs a project can wear in the sidebar and the switcher; the app maps each word to its drawing. */
export const ProjectIcon = z.enum(["folder", "code", "terminal", "globe", "rocket", "box", "database", "server", "cpu", "zap", "flame", "leaf", "star", "heart", "book", "music", "camera", "gamepad", "shield", "wrench"]);
export type ProjectIcon = z.infer<typeof ProjectIcon>;
/** The hues a project's glyph can take; the app maps each word to a colour of its own theme. */
export const ProjectHue = z.enum(["neutral", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"]);
export type ProjectHue = z.infer<typeof ProjectHue>;

/** An image a project wears, named by the SHA-256 of the PNG the host keeps for it. */
export const ProjectIconHash = z.string().regex(/^[0-9a-f]{64}$/);
/** The one size the host keeps a project's image at: the largest draw is 40 px, 120 px on a 3x screen. */
export const PROJECT_ICON_PX = 128;
/** What the PNG the host keeps may weigh: a 128 px RGBA PNG stored with no compression comes to under 66 KB. */
export const PROJECT_ICON_MAX_BYTES = 80 * 1024;
/** The widest and tallest file the window decodes: a 20000 px square PNG of 1.1 MB took a renderer from 195 MB to
 * 2,095 MB to decode, and 4096 still lets a 12 MP phone photo through. */
export const PROJECT_ICON_SOURCE_PX = 4096;
/** The types the window fits into a project's image, by the type a browser reads off the file. */
export const PROJECT_ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"] as const;

/** What the host's refusal of a project's image tells the person to do; the window fits any file before it sends one. */
export const PROJECT_ICON_AGAIN = "Pick it again; if it is refused again, pick another file.";
/** The host's refusal of a project's image, naming the rule the PNG broke. */
export const projectIconRefusal = (why: string): { said: string; fix: string } => ({ said: `The host did not take this image: ${why}.`, fix: PROJECT_ICON_AGAIN });
