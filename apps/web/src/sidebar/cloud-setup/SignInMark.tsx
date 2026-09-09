// SPDX-License-Identifier: AGPL-3.0-only
// The mark beside a sign-in row: the company's bundled glyph in the row's own
// colour, or the tool's initials in the same box when none is bundled.
import { signInMark } from "../../adapt/signins.js";
import { harnessInitials } from "../../components/chat/HarnessMark.js";
import { cn } from "../../lib/utils.js";

export function SignInMark({ tool, label, className }: { tool: string; label: string; className?: string }) {
  const mark = signInMark(tool);
  if (mark !== undefined) {
    return (
      <svg preserveAspectRatio="xMidYMid" viewBox={mark.viewBox} className={cn("size-3.5 shrink-0 fill-current", className)} data-sign-in-mark={tool} aria-hidden>
        {mark.paths.map(path => (
          <path key={path.d} d={path.d} fillRule={path.fillRule} />
        ))}
      </svg>
    );
  }
  return (
    <span className={cn("inline-flex size-3.5 shrink-0 items-center justify-center font-mono text-[8px] font-semibold leading-none", className)} data-sign-in-mark={tool} aria-hidden>
      {harnessInitials(label)}
    </span>
  );
}
