// SPDX-License-Identifier: AGPL-3.0-only
// A workspace's own look as the chrome draws it: the icon for a glyph, the ink
// the theme lends the chrome, and the attributes that put a theme on the
// sidebar. The protocol holds the glyph list and the theme's maths; this file
// is their one module here, so every surface that draws a workspace's look
// reads it. Adding a glyph is the protocol's list and this file's row. The
// pickers themselves live under ./look.
import {
  BoxIcon,
  BookIcon,
  BugIcon,
  CloudIcon,
  CodeIcon,
  CompassIcon,
  CpuIcon,
  DatabaseIcon,
  FeatherIcon,
  FlaskConicalIcon,
  FolderIcon,
  GlobeIcon,
  HammerIcon,
  KeyIcon,
  LeafIcon,
  LightbulbIcon,
  MapIcon,
  PaletteIcon,
  RocketIcon,
  ShieldIcon,
  SquareTerminalIcon,
  StarIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { fmtThemeVars, themeScheme, type LookPart, type WorkspaceGlyph, type WorkspaceTheme } from "@wsp/protocol";
import { WORKSPACE_WORDS } from "../actions/format.js";
import { cn } from "../lib/utils.js";

/** One icon of the app's set per glyph id; the type makes a list the protocol grew and this one did not a build error. */
export const GLYPH_ICONS: Record<WorkspaceGlyph, LucideIcon> = {
  terminal: SquareTerminalIcon,
  code: CodeIcon,
  bug: BugIcon,
  wrench: WrenchIcon,
  hammer: HammerIcon,
  rocket: RocketIcon,
  flask: FlaskConicalIcon,
  database: DatabaseIcon,
  cloud: CloudIcon,
  globe: GlobeIcon,
  compass: CompassIcon,
  map: MapIcon,
  book: BookIcon,
  feather: FeatherIcon,
  palette: PaletteIcon,
  leaf: LeafIcon,
  star: StarIcon,
  bolt: ZapIcon,
  key: KeyIcon,
  shield: ShieldIcon,
  box: BoxIcon,
  folder: FolderIcon,
  chip: CpuIcon,
  lamp: LightbulbIcon,
};

/** The word each fact goes by on the menu row, the palette row and the popover's own heading. */
export const LOOK_WORDS: Record<LookPart, string> = { theme: WORKSPACE_WORDS.theme, glyph: WORKSPACE_WORDS.icon };

/** A workspace's glyph wherever the workspace is drawn, in the ink of whatever draws it. */
export function WorkspaceGlyphMark({ glyph, className }: { glyph: WorkspaceGlyph; className?: string }) {
  const Icon = GLYPH_ICONS[glyph];
  return <Icon aria-hidden data-space-glyph={glyph} className={cn("shrink-0", className)} />;
}

/** Draws in the theme's ink where a theme is on the sidebar above, and in the ink around it where none is. */
export const TINTED_INK = "text-[var(--space-tint,currentColor)]";

/** What puts a theme on the sidebar: the custom properties the one formatter writes, the mark the stylesheet's
 * gradient and grain rules key on, and the side the theme draws under, which re-scopes the sidebar's tokens where
 * it is pinned away from the app's. Nothing without a theme carries any of it, so the same markup draws plain. */
export function themeAttrs(theme: WorkspaceTheme | undefined, appDark: boolean): { style?: CSSProperties; "data-space-theme"?: ""; "data-space-scheme"?: "light" | "dark" } {
  if (theme === undefined) return {};
  return { style: fmtThemeVars(theme, appDark) as unknown as CSSProperties, "data-space-theme": "", "data-space-scheme": themeScheme(theme, appDark) };
}
