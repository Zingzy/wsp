// SPDX-License-Identifier: AGPL-3.0-only
// A computer's icon: one of a fixed set, the person's pick off the row's context
// menu where they made one, otherwise read off what the computer is. The
// computer the host runs on draws as the Mac its model says it is, or a desktop
// where it is no Mac; a joined box as a server; a cloud as its provider's mark
// where the catalog has one.
import { BoxIcon, CloudIcon, CpuIcon, createLucideIcon, HardDriveIcon, HouseIcon, LaptopIcon, MonitorIcon, PcCaseIcon, ServerIcon, type LucideIcon } from "lucide-react";
import { providerMark } from "@wsp/catalog";
import { ComputerIcon, HERE_PLACE_ID, type MacKind, type PlaceView } from "@wsp/protocol";
import { MarkSvg } from "../components/chat/HarnessMark.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { capitalised } from "./format.js";
import { isProviderPlace } from "./places.js";

const MacMiniIcon = createLucideIcon("mac-mini", [
  ["rect", { x: "3", y: "8", width: "18", height: "7", rx: "2", key: "box" }],
  ["path", { d: "M7 18h10", key: "base" }],
]);
const MacStudioIcon = createLucideIcon("mac-studio", [
  ["rect", { x: "4", y: "6", width: "16", height: "12", rx: "2", key: "box" }],
  ["path", { d: "M8 14h.01", key: "port" }],
  ["path", { d: "M11 14h2", key: "slot" }],
]);

export const COMPUTER_GLYPHS: Record<ComputerIcon, LucideIcon> = {
  laptop: LaptopIcon,
  desktop: MonitorIcon,
  "mac-mini": MacMiniIcon,
  "mac-studio": MacStudioIcon,
  tower: PcCaseIcon,
  server: ServerIcon,
  cloud: CloudIcon,
  cpu: CpuIcon,
  drive: HardDriveIcon,
  container: BoxIcon,
  home: HouseIcon,
};

const MAC_ICONS: Record<MacKind, ComputerIcon> = { macbook: "laptop", imac: "desktop", "mac-mini": "mac-mini", "mac-studio": "mac-studio", "mac-pro": "tower" };

type Computer = Pick<PlaceView, "id" | "kind" | "label" | "name" | "mac">;

export function defaultComputerIcon(place: Computer): ComputerIcon {
  if (isProviderPlace(place as PlaceView)) return "cloud";
  if (place.id !== HERE_PLACE_ID) return "server";
  return place.mac === undefined ? "desktop" : MAC_ICONS[place.mac];
}

const usePickedIcon = (place: Computer): ComputerIcon | undefined => useStore(s => s.preferences.computerLook[place.id]?.icon);

export function useComputerIcon(place: Computer): ComputerIcon {
  return usePickedIcon(place) ?? defaultComputerIcon(place);
}

export function ComputerGlyph({ place, className }: { place: Computer; className?: string }) {
  const picked = usePickedIcon(place);
  const mark = picked === undefined && isProviderPlace(place as PlaceView) ? providerMark(place.name) : undefined;
  if (mark !== undefined) return <MarkSvg mark={mark} data-computer-glyph="brand" data-brand-mark={mark.id} className={cn("size-4 shrink-0", className)} />;
  const icon = picked ?? defaultComputerIcon(place);
  const Glyph = COMPUTER_GLYPHS[icon];
  return <Glyph aria-hidden data-computer-glyph={icon} className={cn("size-4 shrink-0", className)} />;
}

const ICON_WORDS: Partial<Record<ComputerIcon, string>> = { "mac-mini": "Mac mini", "mac-studio": "Mac Studio" };

/** An icon as a person reads its name. */
export const computerIconWord = (icon: ComputerIcon): string => ICON_WORDS[icon] ?? capitalised(icon);
