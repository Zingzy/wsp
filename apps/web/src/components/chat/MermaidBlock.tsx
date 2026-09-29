// SPDX-License-Identifier: AGPL-3.0-only
// A settled reply's Mermaid fence drawn as its diagram, in a chunk of its own.
// Mermaid fetches what a diagram names while it draws, before anything here
// can purify it, so a fence that names an address is never handed to it.
// Otherwise it runs strict (its own DOMPurify over labels, no click
// callbacks, no HTML labels) and bounded, with the CSS and font keys closed
// to the fence's own config, and the SVG it returns is purified once more,
// links out, before it goes in. A fence that does not parse keeps its source,
// with the line saying so and Mermaid's own under it.
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import DOMPurify from "dompurify";
import mermaid from "mermaid";

type Drawn = { kind: "pending" } | { kind: "svg"; svg: string; width: number | null } | { kind: "error"; message: string } | { kind: "refused" };

/** What in a fence could make Mermaid ask the network for something while it draws, or leave a link: an address, a
 * CSS url(), @import or image-set(), an image shape, a click line or an href. */
const NAMES_AN_ADDRESS = [/\/\//, /url\s*\(/i, /@import/i, /image-set\s*\(/i, /\bimg\s*:/i, /^\s*click\b/im, /\bhref\b/i];

export const namesAnAddress = (code: string): boolean => NAMES_AN_ADDRESS.some(pattern => pattern.test(code));

/** The narrowest a diagram draws before its block scrolls sideways instead, so a phone never shrinks its labels past
 * reading; a diagram narrower than this keeps its own width. */
const LEGIBLE_WIDTH = 576;

/** The page's tokens as the hex Mermaid's colour parser reads, each laid over the background so a see-through token
 * reads as the colour it shows; nothing where the page cannot paint, which leaves Mermaid's own palette. */
function themeVariables(): Record<string, string | boolean> | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const paint = canvas.getContext("2d", { willReadFrequently: true });
  if (paint === null) return null;
  const probe = document.createElement("span");
  document.body.append(probe);
  const hex = (token: string): string => {
    for (const layer of ["var(--background)", `var(${token})`]) {
      probe.style.color = layer;
      paint.fillStyle = getComputedStyle(probe).color;
      paint.fillRect(0, 0, 1, 1);
    }
    const [r = 0, g = 0, b = 0] = paint.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`;
  };
  const [background, foreground, border, accent, muted] = ["--background", "--foreground", "--border", "--accent", "--muted-foreground"].map(hex) as [string, string, string, string, string];
  const fontFamily = getComputedStyle(probe).getPropertyValue("--font-sans").trim() || getComputedStyle(document.body).fontFamily;
  probe.remove();
  return {
    background,
    mainBkg: accent,
    primaryColor: accent,
    secondaryColor: accent,
    tertiaryColor: background,
    primaryTextColor: foreground,
    secondaryTextColor: foreground,
    tertiaryTextColor: foreground,
    textColor: foreground,
    primaryBorderColor: border,
    secondaryBorderColor: border,
    tertiaryBorderColor: border,
    nodeBorder: border,
    clusterBkg: background,
    clusterBorder: border,
    lineColor: muted,
    edgeLabelBackground: background,
    fontFamily,
  };
}

let configuredFor: string | null = null;

function configure(theme: "light" | "dark"): void {
  if (configuredFor === theme) return;
  const variables = themeVariables();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    maxTextSize: 50_000,
    maxEdges: 500,
    // Mermaid's own closed keys, and the ones CSS and fonts ride in, which a fence's init directive or front matter
    // would otherwise set.
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "themeCSS", "themeVariables", "fontFamily", "altFontFamily"],
    theme: "base",
    darkMode: theme === "dark",
    ...(variables === null ? {} : { themeVariables: variables }),
  });
  configuredFor = theme;
}

export default function MermaidBlock({ code, resolvedTheme, source }: { code: string; resolvedTheme: "light" | "dark"; source: ReactNode }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<Drawn>({ kind: "pending" });
  useEffect(() => {
    let live = true;
    const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));
    void (async () => {
      if (namesAnAddress(code)) {
        if (live) setDrawn({ kind: "refused" });
        return;
      }
      configure(resolvedTheme);
      try {
        await mermaid.parse(code);
      } catch (e) {
        if (live) setDrawn({ kind: "error", message: said(e) });
        return;
      }
      try {
        const { svg } = await mermaid.render(id, code);
        const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "script", "a"] });
        const natural = /max-width:\s*([\d.]+)px/.exec(clean)?.[1];
        if (live) setDrawn({ kind: "svg", svg: clean, width: natural === undefined ? null : Math.min(Number(natural), LEGIBLE_WIDTH) });
      } catch (e) {
        if (live) setDrawn({ kind: "error", message: said(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [code, id, resolvedTheme]);

  if (drawn.kind === "svg") {
    return (
      <div
        data-mermaid
        className="flex overflow-x-auto px-3 pt-1 pb-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:min-w-(--diagram-min)"
        style={{ "--diagram-min": drawn.width === null ? "0px" : `${drawn.width}px` } as CSSProperties}
        dangerouslySetInnerHTML={{ __html: drawn.svg }}
      />
    );
  }
  return (
    <div data-mermaid={drawn.kind}>
      {source}
      {drawn.kind === "refused" ? (
        <p data-mermaid-note className="px-3 pb-2.5 text-xs text-muted-foreground">
          Diagram names an address and is not drawn
        </p>
      ) : null}
      {drawn.kind === "error" ? (
        <div className="px-3 pb-2.5">
          <p data-mermaid-note className="text-xs text-muted-foreground">Diagram did not parse</p>
          <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">{drawn.message}</p>
        </div>
      ) : null}
    </div>
  );
}
