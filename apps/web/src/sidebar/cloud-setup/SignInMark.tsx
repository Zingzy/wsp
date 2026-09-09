// SPDX-License-Identifier: AGPL-3.0-only
// The mark that leads a row of the setup, from the one place the app's other
// surfaces draw theirs: the agent's own glyph in its brand hue where it has
// one, the company's bundled glyph for a tool the recipe signs in to, and the
// initials in a hairline ring where neither exists, like the first launch's
// rows. Never fetched from a favicon service (privacy, offline, one style).
import { harnessClient } from "../../adapt/harnesses.js";
import { signInMark } from "../../adapt/signins.js";
import { harnessInitials } from "../../components/chat/HarnessMark.js";
import { cn } from "../../lib/utils.js";

export function RowMark({ id, label, className }: { id: string; label: string; className?: string }) {
  const mark = harnessClient(id)?.mark ?? signInMark(id);
  if (mark !== undefined) {
    return (
      <svg preserveAspectRatio="xMidYMid" viewBox={mark.viewBox} className={cn("size-[18px] shrink-0 fill-current", mark.tone, className)} data-row-mark={id} aria-hidden>
        {mark.paths.map(path => (
          <path key={path.d} d={path.d} fillRule={path.fillRule} />
        ))}
      </svg>
    );
  }
  return (
    <span className={cn("inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-input font-mono text-[9px] leading-none text-muted-foreground", className)} data-row-mark={id} aria-hidden>
      {harnessInitials(label).slice(0, 1)}
    </span>
  );
}

/** The mark beside a sign-in row of the build: the company's glyph in the row's colour, or the tool's initials. */
export function SignInMark({ tool, label, className }: { tool: string; label: string; className?: string }) {
  return <RowMark id={tool} label={label} className={className} />;
}
