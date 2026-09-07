// SPDX-License-Identifier: AGPL-3.0-only
// The mark of the harness a model or thread belongs to, next to it in the
// composer, on the picker's rail and on the sidebar's thread rows: the glyph
// its client module registers, bare, in the brand's own hue where it has one
// and otherwise in the colour of whatever it sits in, like the initials it
// falls back to.
import { harnessClient } from "../../adapt/harnesses";
import { cn } from "../../lib/utils";

export function harnessInitials(label: string): string {
  const words = label.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function HarnessMark({ harness, label, className }: { harness: string; label: string; className?: string }) {
  const mark = harnessClient(harness)?.mark;
  if (mark !== undefined) {
    return (
      <svg preserveAspectRatio="xMidYMid" viewBox={mark.viewBox} className={cn("size-3.5 shrink-0 fill-current", mark.tone, className)} data-harness-mark={harness} aria-hidden>
        {mark.paths.map(path => (
          <path key={path.d} d={path.d} fillRule={path.fillRule} />
        ))}
      </svg>
    );
  }
  return (
    <span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[8px] font-semibold leading-none", className)} data-harness-mark={harness} aria-hidden>
      {harnessInitials(label)}
    </span>
  );
}
