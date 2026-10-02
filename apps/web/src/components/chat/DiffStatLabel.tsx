// Adapted from pingdotgg/t3code apps/web/src/components/chat/DiffStatLabel.tsx at 57a66608 (MIT).
import { memo } from "react";
import { cn } from "../../lib/utils";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

function formatCompactDiffCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}k`;
  }
  if (value < 1_000_000_000) {
    const m = value / 1_000_000;
    return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}m`;
  }
  const b = value / 1_000_000_000;
  return `${b < 10 ? b.toFixed(1).replace(/\.0$/, "") : Math.round(b)}b`;
}

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  className?: string;
  showParentheses?: boolean;
  layout?: "aligned" | "inline";
  /** The add in green and the delete in red wherever a line count shows (the owner's ruling on #1560); neutral only
   * where a caller asks for a count at rest. */
  tone?: "neutral" | "diff";
  /** Whole figures with their thousands apart and a true minus, where a count is read and not glanced at. */
  whole?: boolean;
}) {
  const { additions, deletions, className, showParentheses = false, layout = "aligned", tone = "diff", whole = false } = props;
  const figure = whole ? (n: number) => n.toLocaleString("en-US") : formatCompactDiffCount;
  const addInk = tone === "diff" ? "text-success" : "text-muted-foreground";
  const delInk = tone === "diff" ? "text-error-foreground" : "text-muted-foreground";
  return (
    <>
      {showParentheses && <span className="text-muted-foreground">(</span>}
      <span
        role="group"
        aria-label={`${additions} additions, ${deletions} deletions`}
        className={cn(
          layout === "inline"
            ? "inline-flex items-center gap-1 tabular-nums align-middle"
            : "inline-grid grid-cols-[4ch_4ch] gap-2 text-right tabular-nums align-middle",
          className,
        )}
      >
        <span aria-hidden="true" className={cn("font-mono", addInk)}>
          +{figure(additions)}
        </span>
        <span aria-hidden="true" className={cn("font-mono", delInk)}>
          {whole ? "\u2212" : "-"}{figure(deletions)}
        </span>
      </span>
      {showParentheses && <span className="text-muted-foreground">)</span>}
    </>
  );
});
