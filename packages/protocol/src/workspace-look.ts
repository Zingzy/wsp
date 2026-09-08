// SPDX-License-Identifier: AGPL-3.0-only
// The look a person gives one workspace: one muted hue and one glyph, both
// from a closed set, so the record can carry them and every client draws the
// same thing. The hues leave out the greens that mean running and the red
// that means danger, which those colours mean on every surface. The glyphs
// are names of the app's own icons, never emoji: emoji draw differently on
// every platform and the app's chrome carries none.
import { z } from "zod";

/** The six hues offered, in the order the picker shows them. */
export const WORKSPACE_TINTS = ["slate", "teal", "cyan", "indigo", "violet", "pink"] as const;
export const WorkspaceTint = z.enum(WORKSPACE_TINTS);
export type WorkspaceTint = z.infer<typeof WorkspaceTint>;

/** The glyphs offered, in the order the picker shows them; each id names one icon of the app's set. */
export const WORKSPACE_GLYPHS = [
  "terminal",
  "code",
  "bug",
  "wrench",
  "hammer",
  "rocket",
  "flask",
  "database",
  "cloud",
  "globe",
  "compass",
  "map",
  "book",
  "feather",
  "palette",
  "leaf",
  "star",
  "bolt",
  "key",
  "shield",
  "box",
  "folder",
  "chip",
  "lamp",
] as const;
export const WorkspaceGlyph = z.enum(WORKSPACE_GLYPHS);
export type WorkspaceGlyph = z.infer<typeof WorkspaceGlyph>;

/** What one call changes: a key left out keeps that fact as it is, and null clears it back to none. */
export const WorkspaceLook = z.object({
  tint: WorkspaceTint.nullable().optional(),
  glyph: WorkspaceGlyph.nullable().optional(),
});
export type WorkspaceLook = z.infer<typeof WorkspaceLook>;

/** Which of the two facts a picker or a menu entry is for. */
export type LookPart = keyof WorkspaceLook;
