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
