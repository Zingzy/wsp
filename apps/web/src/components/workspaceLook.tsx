// SPDX-License-Identifier: AGPL-3.0-only
// A workspace's own look: the hue and the glyph a person picked for it. The
// protocol holds the two closed lists; this file is their one module here, so
// the icon for a glyph and the attribute that carries a hue are written once
// and every surface that draws a workspace in its colour reads them. Adding a
// hue or a glyph is the protocol's list, this file's row, and for a hue the
// --space-tint rule in index.css that gives the id its colour.
import {
  BoxIcon,
  BookIcon,
  BugIcon,
  CircleSlashIcon,
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
import { WORKSPACE_GLYPHS, WORKSPACE_TINTS, lookWord, type LookPart, type WorkspaceGlyph, type WorkspaceLook, type WorkspaceTint, type WorkspaceView } from "@wsp/protocol";
import { WORKSPACE_WORDS } from "../actions/format.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "./ui/dialog.js";

/** One icon of the app's set per glyph id; the type makes a list the protocol grew and this one did not a build error. */
const GLYPH_ICONS: Record<WorkspaceGlyph, LucideIcon> = {
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

/** The word each fact goes by on the menu row, the palette row and the picker's own heading. */
export const LOOK_WORDS: Record<LookPart, string> = { tint: WORKSPACE_WORDS.colour, glyph: WORKSPACE_WORDS.icon };

/** What a person picks when they want neither; the struck circle stands for it in both rows. */
const NONE_WORD = "None";

/** The attribute that puts a workspace's hue on an element and everything under it; nothing without a hue carries it,
 * so the same markup draws untinted. */
export function tintAttr(tint: WorkspaceTint | undefined): { "data-space-tint"?: WorkspaceTint } {
  return tint === undefined ? {} : { "data-space-tint": tint };
}

/** A workspace's glyph in its own hue, wherever the workspace is drawn: the dots row and the Spaces header's lead. */
export function WorkspaceGlyphMark({ glyph, className }: { glyph: WorkspaceGlyph; className?: string }) {
  const Icon = GLYPH_ICONS[glyph];
  return <Icon aria-hidden data-space-glyph={glyph} className={cn("shrink-0 text-[var(--space-tint,currentColor)]", className)} />;
}

const CELL_CLASS = "flex size-7 cursor-pointer items-center justify-center rounded-md outline-hidden ring-ring transition-colors duration-150 hover:bg-accent focus-visible:ring-2";
const PICKED_CLASS = "ring-2 ring-ring";

/** The rows the menu's dialog and the Machine tab both draw: the six hues, then the glyphs, each with the way back to
 * none. A pick goes to the runtime as it is made, the way a name box sends on Enter; there is nothing to confirm. */
export function WorkspaceLookPicker({ workspace, part }: { workspace: WorkspaceView; part?: LookPart }) {
  const setLook = useStore(s => s.setWorkspaceLook);
  const send = (look: WorkspaceLook): void => void setLook({ workspaceId: workspace.id, look });
  return (
    <div data-workspace-look className="flex flex-col gap-3">
      {part === "glyph" ? null : (
        <div className="flex flex-col gap-1.5">
          {part === undefined ? <span className="text-[11px] text-muted-foreground">{WORKSPACE_WORDS.colour}</span> : null}
          <div role="group" aria-label={WORKSPACE_WORDS.colour} className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              aria-label={`${WORKSPACE_WORDS.colour}: ${NONE_WORD}`}
              aria-pressed={workspace.tint === undefined}
              className={cn(CELL_CLASS, "text-muted-foreground", workspace.tint === undefined && PICKED_CLASS)}
              onClick={() => send({ tint: null })}
            >
              <CircleSlashIcon aria-hidden className="size-4" />
            </button>
            {WORKSPACE_TINTS.map(tint => (
              <button
                key={tint}
                type="button"
                {...tintAttr(tint)}
                aria-label={`${WORKSPACE_WORDS.colour}: ${lookWord(tint)}`}
                aria-pressed={workspace.tint === tint}
                className={cn(CELL_CLASS, workspace.tint === tint && PICKED_CLASS)}
                onClick={() => send({ tint })}
              >
                <span aria-hidden className="size-4 rounded-full bg-[var(--space-tint)]" />
              </button>
            ))}
          </div>
        </div>
      )}
      {part === "tint" ? null : (
        <div className="flex flex-col gap-1.5" {...tintAttr(workspace.tint)}>
          {part === undefined ? <span className="text-[11px] text-muted-foreground">{WORKSPACE_WORDS.icon}</span> : null}
          <div role="group" aria-label={WORKSPACE_WORDS.icon} className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              aria-label={`${WORKSPACE_WORDS.icon}: ${NONE_WORD}`}
              aria-pressed={workspace.glyph === undefined}
              className={cn(CELL_CLASS, "text-muted-foreground", workspace.glyph === undefined && PICKED_CLASS)}
              onClick={() => send({ glyph: null })}
            >
              <CircleSlashIcon aria-hidden className="size-4" />
            </button>
            {WORKSPACE_GLYPHS.map(glyph => (
              <button
                key={glyph}
                type="button"
                aria-label={`${WORKSPACE_WORDS.icon}: ${lookWord(glyph)}`}
                aria-pressed={workspace.glyph === glyph}
                className={cn(CELL_CLASS, workspace.glyph === glyph && PICKED_CLASS)}
                onClick={() => send({ glyph })}
              >
                <WorkspaceGlyphMark glyph={glyph} className="size-4" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The picker as the row's menu opens it, on the fact the menu named. */
export function WorkspaceLookDialog({ workspace, part, onClose }: { workspace: WorkspaceView; part: LookPart; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPopup className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{LOOK_WORDS[part]}</DialogTitle>
          <DialogDescription>{workspace.name}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <WorkspaceLookPicker workspace={workspace} part={part} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
