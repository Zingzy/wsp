// SPDX-License-Identifier: AGPL-3.0-only
// Shares of one whole: a thin ring beside its legend, five parts at most, biggest first with the rest as Other, the
// parts the slate's ink in falling strength and Other the quiet grey, the whole's figure in the ring.
import { slateShares } from "@wsp/protocol/slate";
import type { PieceView } from "../SlateView.js";
import { KEYCAP_FILTER } from "./keycap.js";
import { figure, NOTE, num, str } from "./look.js";

const STRENGTH = [100, 68, 46, 30, 18];
const R = 50;
const ROUND = 2 * Math.PI * R;
/** The gap between two parts, along the ring. */
const GAP = 1.6;

export const donut: PieceView = {
  type: "donut",
  card: false,
  accent: true,
  rowScoped: ["name", "value"],
  component: function DonutPiece({ id, piece, props, slate }) {
    const label = str(props["label"]) ?? "";
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const parts = slateShares(items.map((item, index) => ({ name: str(slate.resolve(piece.props?.["name"], { item, index })) ?? "", value: num(slate.resolve(piece.props?.["value"], { item, index })) ?? 0 })));
    const whole = parts.reduce((sum, p) => sum + p.value, 0);
    const ink = slate.isLoud("accent", id) ? "var(--slate-accent,var(--primary))" : "var(--foreground)";
    const inkOf = (k: number, other: boolean): string => (other ? "color-mix(in srgb, var(--muted-foreground) 45%, var(--background))" : `color-mix(in srgb, ${ink} ${STRENGTH[k]}%, var(--background))`);
    const unit = str(props["unit"]);
    let start = 0;
    const comma = label.indexOf(", ");
    return (
      <figure data-slate-donut className="@container flex min-w-0 flex-col gap-2.5">
        <figcaption className="flex flex-wrap items-baseline gap-x-2 text-note leading-5 text-foreground">
          {comma < 0 ? label : label.slice(0, comma)}
          {comma < 0 ? null : <span className="text-xs leading-4 text-muted-foreground">{label.slice(comma + 2)}</span>}
        </figcaption>
        {whole === 0 ? (
          <span className={NOTE}>Not read yet</span>
        ) : (
          <div className="flex min-w-0 items-center gap-5 @min-[520px]:gap-8">
            <div className="relative size-30 shrink-0 @min-[520px]:size-37">
              <svg viewBox="0 0 120 120" className="size-full" aria-hidden>
                <circle cx={60} cy={60} r={R} fill="none" stroke="currentColor" strokeWidth={11} className="text-foreground/[0.06]" />
                {parts.map((p, k) => {
                  const length = (p.value / whole) * ROUND;
                  const drawn = Math.max(0.5, length - (parts.length > 1 ? GAP : 0));
                  const at = start;
                  start += length;
                  // Drawn from twelve o'clock by the dash offset, not by turning the drawing, so the bevel's down stays down.
                  return <circle key={`${k}:${p.name}`} cx={60} cy={60} r={R} fill="none" strokeWidth={11} style={{ stroke: inkOf(k, p.other === true), filter: KEYCAP_FILTER }} strokeDasharray={`${drawn} ${ROUND - drawn}`} strokeDashoffset={ROUND / 4 - at} />;
                })}
              </svg>
              <span className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
                <span className="font-mono text-title leading-5 text-foreground tabular-nums">{figure(whole, props["format"])}</span>
                {unit === undefined ? null : <span className="text-meta leading-4 text-muted-foreground">{unit}</span>}
              </span>
            </div>
            <ul className="flex min-w-0 flex-1 flex-col gap-2">
              {parts.map((p, k) => (
                <li key={`${k}:${p.name}`} data-slate-part className="flex min-w-0 items-center gap-2.5 text-note leading-5">
                  <span aria-hidden className="size-2.5 shrink-0 rounded-xs" style={{ background: inkOf(k, p.other === true) }} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{p.name}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{figure(p.value, props["format"])}</span>
                  <span className="w-9 text-right font-mono text-xs text-foreground tabular-nums">{Math.round((p.value / whole) * 100)}%</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </figure>
    );
  },
};
