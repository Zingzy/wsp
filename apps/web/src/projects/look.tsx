// SPDX-License-Identifier: AGPL-3.0-only
// How a project is drawn wherever it is named: the image the person chose, else
// the glyph and hue they picked on its settings page, kept in the host's
// preferences record, else the folder in the row's own ink.
import {
  BookIcon,
  BoxIcon,
  CameraIcon,
  CodeIcon,
  CpuIcon,
  DatabaseIcon,
  FlameIcon,
  FolderIcon,
  Gamepad2Icon,
  GlobeIcon,
  HeartIcon,
  LeafIcon,
  MusicIcon,
  RocketIcon,
  ServerIcon,
  ShieldIcon,
  StarIcon,
  TerminalIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectHue, ProjectIcon } from "@wsp/protocol";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { useProjectIcons, wantProjectIcon } from "./images.js";

export const PROJECT_GLYPHS: Record<ProjectIcon, LucideIcon> = {
  folder: FolderIcon,
  code: CodeIcon,
  terminal: TerminalIcon,
  globe: GlobeIcon,
  rocket: RocketIcon,
  box: BoxIcon,
  database: DatabaseIcon,
  server: ServerIcon,
  cpu: CpuIcon,
  zap: ZapIcon,
  flame: FlameIcon,
  leaf: LeafIcon,
  star: StarIcon,
  heart: HeartIcon,
  book: BookIcon,
  music: MusicIcon,
  camera: CameraIcon,
  gamepad: Gamepad2Icon,
  shield: ShieldIcon,
  wrench: WrenchIcon,
};

/** Each hue as text and as a swatch; neutral is the row's own ink, so a project nobody coloured reads as before. */
export const PROJECT_HUES: Record<ProjectHue, { text: string; swatch: string }> = {
  neutral: { text: "", swatch: "bg-muted-foreground" },
  red: { text: "text-red-500", swatch: "bg-red-500" },
  orange: { text: "text-orange-500", swatch: "bg-orange-500" },
  amber: { text: "text-amber-500", swatch: "bg-amber-500" },
  green: { text: "text-emerald-500", swatch: "bg-emerald-500" },
  teal: { text: "text-teal-500", swatch: "bg-teal-500" },
  blue: { text: "text-sky-500", swatch: "bg-sky-500" },
  violet: { text: "text-violet-500", swatch: "bg-violet-500" },
  pink: { text: "text-pink-500", swatch: "bg-pink-500" },
};

/** A look named outright, for a row that is no project here yet: a recipe's folder on its way to a computer. */
export interface MarkLook {
  readonly icon?: ProjectIcon | undefined;
  readonly hue?: ProjectHue | undefined;
  readonly image?: string | undefined;
}

/** The image half of a project's mark: the picture filling the glyph's own box, with no frame, radius or mask of its
 * own, so a class the row puts on the mark (its dimming, the inbox's corner) lands on it as on a glyph. */
export function ProjectIconImage({ src, className, onError }: { src: string; className?: string; onError?: () => void }) {
  return <img alt="" aria-hidden draggable={false} data-project-icon src={src} onError={onError} className={cn("size-4 shrink-0 object-contain", className)} />;
}

/** A project's mark in every place it is named. The glyph in its hue stands while the image is read from the host and
 * whenever it cannot draw, in the same box, so nothing moves when it lands. `ink` is the glyph's colour where no hue was picked. */
export function ProjectGlyph({ projectId, look: named, ink, strokeWidth, className }: { projectId?: string; look?: MarkLook; ink?: string; strokeWidth?: number; className?: string }) {
  const held = useStore(s => (projectId === undefined ? undefined : s.preferences.projectLook[projectId]));
  const heldImage = useStore(s => (projectId === undefined ? undefined : s.preferences.projectIcon?.[projectId]));
  const look = named ?? held;
  const image = named === undefined ? heldImage : named.image;
  const url = useProjectIcons(s => (image === undefined ? undefined : s.urls[image]));
  const [broken, setBroken] = useState<string | undefined>(undefined);
  // A row's own hash is not one the record names, so the row holds it while it draws.
  useEffect(() => (named?.image === undefined ? undefined : wantProjectIcon(named.image)), [named?.image]);
  if (url !== undefined && broken !== url) return <ProjectIconImage src={url} onError={() => setBroken(url)} {...(className === undefined ? {} : { className })} />;
  const Glyph = PROJECT_GLYPHS[look?.icon ?? "folder"];
  const hue = look?.hue ?? "neutral";
  // A hue the person picked is the glyph's own; the row's hover and selected inks leave it alone.
  return <Glyph aria-hidden data-hue={hue === "neutral" ? undefined : hue} {...(strokeWidth === undefined ? {} : { strokeWidth })} className={cn("size-4 shrink-0", hue === "neutral" ? ink : PROJECT_HUES[hue].text, className)} />;
}
