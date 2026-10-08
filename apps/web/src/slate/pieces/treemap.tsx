// SPDX-License-Identifier: AGPL-3.0-only
// Sizes of one whole's parts as nested boxes, squarified: groups first, each group's parts inside its box, a wider
// gap between groups than within one. Each group takes a theme ink of its own mixed into the card, the largest the
// slate's accent; a part's name and size sit inside its box where they fit, and the legend under it names the groups.
import { KEYCAP_BEVEL } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { useWidth } from "./chart.js";
import { figure, NOTE, num, str } from "./look.js";

type Box = { x: number; y: number; w: number; h: number };
type Part = { name: string; value: number };

/** Lays the values, largest first, into rows along the box's short side, each row kept as near square as it goes. */
function squarify<T extends { value: number }>(items: readonly T[], box: Box): Array<T & Box> {
  const out: Array<T & Box> = [];
  const total = items.reduce((sum, i) => sum + i.value, 0);
  if (total <= 0) return out;
  const scale = (box.w * box.h) / total;
  let rest = [...items].sort((a, b) => b.value - a.value);
  let free = { ...box };
  const worst = (row: T[], side: number): number => {
    const area = row.reduce((sum, i) => sum + i.value * scale, 0);
    return Math.max(...row.map(i => { const a = i.value * scale; return Math.max((side * side * a) / (area * area), (area * area) / (side * side * a)); }));
  };
  while (rest.length > 0) {
    const side = Math.min(free.w, free.h);
    const row: T[] = [rest[0]!];
    let k = 1;
    while (k < rest.length && worst([...row, rest[k]!], side) <= worst(row, side)) row.push(rest[k++]!);
    rest = rest.slice(k);
    const area = row.reduce((sum, i) => sum + i.value * scale, 0);
    const thick = area / side;
    let along = 0;
    for (const item of row) {
      const len = (item.value * scale) / thick;
      out.push(free.w >= free.h ? { ...item, x: free.x, y: free.y + along, w: thick, h: len } : { ...item, x: free.x + along, y: free.y, w: len, h: thick });
      along += len;
    }
    free = free.w >= free.h ? { x: free.x + thick, y: free.y, w: free.w - thick, h: free.h } : { x: free.x, y: free.y + thick, w: free.w, h: free.h - thick };
  }
  return out;
}

const GROUP_INK = ["var(--slate-accent,var(--primary))", "var(--warning)", "var(--status-working)", "var(--success)", "var(--status-input)", "var(--muted-foreground)"];
const tint = (ink: string): string => `color-mix(in srgb, ${ink} 24%, color-mix(in srgb, var(--card) 40%, var(--background)))`;
const GROUP_GAP = 4;
const PART_GAP = 2;

export const treemap: PieceView = {
  type: "treemap",
  card: false,
  accent: true,
  rowScoped: ["name", "value", "group"],
  component: function TreemapPiece({ piece, props, slate }) {
    const [ref, width] = useWidth();
    const label = str(props["label"]) ?? "";
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const parts = items.map((item, index) => ({
      name: str(slate.resolve(piece.props?.["name"], { item, index })) ?? "",
      value: Math.max(0, num(slate.resolve(piece.props?.["value"], { item, index })) ?? 0),
      group: str(slate.resolve(piece.props?.["group"], { item, index })) ?? "",
    }));
    const byGroup = new Map<string, Part[]>();
    // A part of 0 has no area to lay out: squarifying it divides 0 by 0.
    for (const p of parts) if (p.value > 0) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
    const groups = [...byGroup].map(([name, list]) => ({ name, list, value: list.reduce((sum, p) => sum + p.value, 0) })).sort((a, b) => b.value - a.value);
    const inkOf = new Map(groups.map((g, k) => [g.name, GROUP_INK[Math.min(k, GROUP_INK.length - 1)]!]));
    const height = width >= 520 ? 300 : 240;
    const laid = width === 0 ? [] : squarify(groups, { x: 0, y: 0, w: width, h: height });
    const shown = (v: number): string => figure(v, props["format"]) ?? "";
    const comma = label.indexOf(", ");
    return (
      <figure data-slate-treemap className="flex min-w-0 flex-col gap-2.5">
        <figcaption className="flex flex-wrap items-baseline gap-x-2 text-note leading-5 text-foreground">
          {comma < 0 ? label : label.slice(0, comma)}
          {comma < 0 ? null : <span className="text-xs leading-4 text-muted-foreground">{label.slice(comma + 2)}</span>}
        </figcaption>
        {parts.length === 0 ? <span className={NOTE}>Not read yet</span> : null}
        <div ref={ref} className="relative w-full" style={{ height: parts.length === 0 ? 0 : height }}>
          {laid.flatMap(g => {
            const inner = { x: g.x + GROUP_GAP / 2, y: g.y + GROUP_GAP / 2, w: Math.max(0, g.w - GROUP_GAP), h: Math.max(0, g.h - GROUP_GAP) };
            return squarify(g.list, inner).map((p, k) => {
              const w = Math.max(0, p.w - PART_GAP);
              const h = Math.max(0, p.h - PART_GAP);
              const named = w >= 44 && h >= 20;
              const sized = w >= 56 && h >= 38;
              // Padding only on a tile that holds words: a sliver narrower than its padding would grow past its box.
              return (
                <div
                  key={`${g.name}/${k}`}
                  data-slate-tile
                  title={`${g.name} ${p.name}: ${shown(p.value)}`}
                  className={cn("absolute flex flex-col gap-0.5 overflow-hidden rounded-xs", named && "px-2 py-1.5", KEYCAP_BEVEL)}
                  style={{ left: p.x + PART_GAP / 2, top: p.y + PART_GAP / 2, width: w, height: h, background: tint(inkOf.get(g.name)!) }}
                >
                  {named ? <span className="truncate text-xs leading-4 text-foreground">{p.name}</span> : null}
                  {sized ? <span className="truncate font-mono text-meta leading-4 text-muted-foreground tabular-nums">{shown(p.value)}</span> : null}
                </div>
              );
            });
          })}
        </div>
        {groups.length < 2 ? null : (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs leading-4 text-muted-foreground">
            {groups.map(g => (
              <span key={g.name} className="flex items-center gap-1.5">
                <span aria-hidden className="size-2.5 rounded-xs" style={{ background: tint(inkOf.get(g.name)!) }} />
                <span className="text-foreground">{g.name}</span>
                <span className="font-mono tabular-nums">{shown(g.value)}</span>
              </span>
            ))}
          </div>
        )}
      </figure>
    );
  },
};
