// SPDX-License-Identifier: AGPL-3.0-only
// The mark that leads a row of the setup, from the one place the app's other
// surfaces draw theirs: the agent's own glyph in its brand hue where it has
// one, the company's bundled glyph for a tool the recipe signs in to. A row
// whose tool has no mark of its own leads with its name; nothing is drawn in
// a mark's place. Never fetched from a favicon service (privacy, offline, one
// style).
import { harnessClient } from "../../adapt/harnesses.js";
import { signInMark } from "../../adapt/signins.js";
import { cn } from "../../lib/utils.js";

export function RowMark({ id, className }: { id: string; className?: string }) {
  const mark = harnessClient(id)?.mark ?? signInMark(id);
  if (mark === undefined) return null;
  return (
    <svg preserveAspectRatio="xMidYMid" viewBox={mark.viewBox} className={cn("size-[18px] shrink-0 fill-current", mark.tone, className)} data-row-mark={id} aria-hidden>
      {mark.paths.map(path => (
        <path key={path.d} d={path.d} fillRule={path.fillRule} />
      ))}
    </svg>
  );
}
