// SPDX-License-Identifier: AGPL-3.0-only
// A Mermaid diagram, drawn by the chat's own MermaidBlock as it is: an address in the source is never handed to Mermaid,
// Mermaid runs strict, the SVG is purified again, and the page's tokens are its palette. Mermaid is its own chunk, loaded
// only once a slate holds a diagram. A source built from $values redraws when its text changes, keeping the last drawing
// until the next one is ready; a source that does not parse keeps MermaidBlock's own line under it.
import { lazy, Suspense } from "react";
import { RenderErrorBoundary } from "../../components/RenderErrorBoundary.js";
import { useAppDark } from "../../settings/theme.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";

const MermaidBlock = lazy(() => import("../../components/chat/MermaidBlock.js"));

export const diagram: PieceView = {
  type: "diagram",
  component: function DiagramPiece({ props }) {
    const dark = useAppDark();
    const code = str(props["value"]) ?? "";
    const label = str(props["label"]);
    // What stands while Mermaid loads, and over its line when the source is refused or does not parse.
    const source = <pre data-slate-diagram-source className="overflow-x-auto px-3 pt-1 pb-2 font-mono text-xs leading-4 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{code}</pre>;
    return (
      // The chat holds a wide diagram at 576 px and scrolls it sideways; in the panel the whole flow and its live step
      // stay in view, so the drawing fits the panel's width and a small one keeps its own.
      <figure data-slate-diagram className="flex min-w-0 flex-col gap-2.5 [&_[data-mermaid]_svg]:!min-w-0">
        {label === undefined ? null : <figcaption className="text-[13px] leading-5 text-foreground">{label}</figcaption>}
        {code === "" ? null : (
          <RenderErrorBoundary fallback={source}>
            <Suspense fallback={source}>
              <MermaidBlock code={code} resolvedTheme={dark ? "dark" : "light"} source={source} />
            </Suspense>
          </RenderErrorBoundary>
        )}
      </figure>
    );
  },
};
