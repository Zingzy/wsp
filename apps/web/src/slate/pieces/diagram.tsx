// SPDX-License-Identifier: AGPL-3.0-only
// A Mermaid diagram, drawn by the chat's own MermaidBlock: an address in the source is never handed to Mermaid, Mermaid
// runs strict and the SVG is purified again. Mermaid is its own chunk, loaded only once a slate holds a diagram. Here it
// takes the slate's look: nodes are the settings card's surface with 13 px labels, edges hairlines, edge labels quiet
// words on the ground. It opens fitted to the panel above the 12 px floor, zooms and pans in its frame, and opens whole
// in a dialog over the window, the dialog itself holding focus. A source built from $values redraws in both when its
// text changes; a source that does not parse keeps MermaidBlock's own line under it.
import { Maximize2, Minus, Plus, Scan, X } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { type MermaidLook } from "../../components/chat/MermaidBlock.js";
import { RenderErrorBoundary } from "../../components/RenderErrorBoundary.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogClose, DialogPopup, DialogTitle } from "../../components/ui/dialog.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip.js";
import { useAppDark } from "../../settings/theme.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";
import { ZoomFrame, type ZoomControls } from "./zoom.js";

const MermaidBlock = lazy(() => import("../../components/chat/MermaidBlock.js"));

/** A node's label at the slate's body size, an edge's at the app's least; no label opens under that least, so a drawing
 * opens at its own size at the most shrunk. */
const LABEL_PX = 13;
const EDGE_PX = 12;
const FLOOR_PX = 12;
/** The inline frame's tallest, so a tall flow never swallows the slate; the rest is a pan away. */
const INLINE_CAP = 420;
/** The dialog is the overview, with zoom in a press away, so it fits a drawing whole down to this scale. */
const OVERVIEW_LEAST = 0.4;

/** The settings card for nodes, hairlines for edges, the section head for a group's name. The colours are the page's
 * own variables, so the drawing follows a theme change without being drawn again. Mermaid puts its drawing's id before
 * every rule here as before its own, so these win by coming later with their weight. */
const CARD = "color-mix(in srgb, var(--card) 40%, var(--background))";
const EDGE = "color-mix(in srgb, var(--border) 60%, var(--background))";
const LINE = "color-mix(in srgb, var(--muted-foreground) 60%, var(--background))";
const SLATE_LOOK: MermaidLook = {
  variables: { fontSize: `${LABEL_PX}px` },
  flowchart: { padding: 16, nodeSpacing: 36, rankSpacing: 40 },
  css: [
    `* { filter: none !important; }`,
    `.node rect, .node polygon, .node circle, .node ellipse, .node path { fill: ${CARD} !important; stroke: ${EDGE} !important; stroke-width: 1px !important; }`,
    `.node rect { rx: 10px; ry: 10px; }`,
    `.node .label rect, .node rect.background { fill: none !important; stroke: none !important; }`,
    `.node text, .node tspan { fill: var(--foreground) !important; font-family: var(--font-sans) !important; font-size: ${LABEL_PX}px !important; }`,
    `.flowchart-link { stroke: ${LINE} !important; stroke-width: 1px !important; }`,
    `.marker, marker path { fill: ${LINE} !important; stroke: none !important; }`,
    `.edgeLabel text, .edgeLabel tspan { fill: var(--muted-foreground) !important; font-family: var(--font-sans) !important; font-size: ${EDGE_PX}px !important; }`,
    `.edgeLabel rect, .labelBkg { fill: var(--background) !important; stroke: none !important; opacity: 1 !important; }`,
    `.cluster rect { fill: none !important; stroke: ${EDGE} !important; stroke-width: 1px !important; rx: 10px; ry: 10px; }`,
    `.cluster-label text, .cluster-label tspan { fill: color-mix(in srgb, var(--foreground) 70%, transparent) !important; font-family: var(--font-sans) !important; font-size: 14px !important; }`,
  ].join("\n"),
};

function Drawing({ code, source }: { code: string; source: React.ReactNode }) {
  const dark = useAppDark();
  return (
    <RenderErrorBoundary fallback={source}>
      <Suspense fallback={null}>
        <MermaidBlock code={code} resolvedTheme={dark ? "dark" : "light"} source={source} look={SLATE_LOOK} drawing={null} />
      </Suspense>
    </RenderErrorBoundary>
  );
}

/** One icon button in the slate's quiet style, its word on the hover. */
function IconButton({ label, onClick, children }: { label: string; onClick?: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} className="text-muted-foreground" />}>{children}</TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export const diagram: PieceView = {
  type: "diagram",
  component: function DiagramPiece({ props }) {
    const code = str(props["value"]) ?? "";
    const label = str(props["label"]);
    const [open, setOpen] = useState(false);
    const big = useRef<ZoomControls>(null);
    const popup = useRef<HTMLDivElement>(null);
    // What stands while Mermaid loads, and over its line when the source is refused or does not parse.
    const source = <pre data-slate-diagram-source className="overflow-x-auto pt-1 pb-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{code}</pre>;
    if (code === "") return label === undefined ? null : <p className="text-[13px] leading-5 text-foreground">{label}</p>;
    return (
      <figure data-slate-diagram className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-h-6 items-center gap-3">
          {label === undefined ? null : <figcaption className="min-w-0 flex-1 text-[13px] leading-5 text-foreground">{label}</figcaption>}
          <span className="ml-auto">
            <IconButton label="Expand" onClick={() => setOpen(true)}>
              <Maximize2 aria-hidden className="size-3.5" />
            </IconButton>
          </span>
        </div>
        <ZoomFrame floor={FLOOR_PX / EDGE_PX} cap={INLINE_CAP}>
          <Drawing code={code} source={source} />
        </ZoomFrame>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup ref={popup} initialFocus={popup} data-slate-diagram-expanded className="h-[85vh] w-[90vw] max-w-[min(90vw,1400px)] sm:max-w-[min(90vw,1400px)]" bottomStickOnMobile={false}>
            <div className="flex items-center gap-1 px-5 pt-4 pb-3">
              <DialogTitle className="min-w-0 flex-1 truncate">{label ?? "Diagram"}</DialogTitle>
              <IconButton label="Zoom out" onClick={() => big.current?.zoom(1 / 1.25)}>
                <Minus aria-hidden className="size-3.5" />
              </IconButton>
              <IconButton label="Zoom in" onClick={() => big.current?.zoom(1.25)}>
                <Plus aria-hidden className="size-3.5" />
              </IconButton>
              <IconButton label="Fit" onClick={() => big.current?.fit()}>
                <Scan aria-hidden className="size-3.5" />
              </IconButton>
              <DialogClose render={<Button variant="ghost" size="icon-xs" aria-label="Close" className="text-muted-foreground" />}>
                <X aria-hidden className="size-3.5" />
              </DialogClose>
            </div>
            <ZoomFrame floor={OVERVIEW_LEAST} fill controls={big} className="mx-5 mb-5 flex-1 rounded-xl bg-background">
              <Drawing code={code} source={source} />
            </ZoomFrame>
          </DialogPopup>
        </Dialog>
      </figure>
    );
  },
};
