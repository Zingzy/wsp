// SPDX-License-Identifier: AGPL-3.0-only
import { MARKS, type MarkId } from "@/marks";
import { cn } from "@/lib/utils";

/** The agents a thread can run on. */
const THREADS: readonly MarkId[] = ["claude", "codex", "opencode", "cursor"];

const SVG = /^<svg\b[^>]*\bviewBox="([^"]+)"[^>]*>([\s\S]*)<\/svg>$/;

/** A mark in the ink of the text beside it: every fill it carries, colours and gradients alike, becomes that ink. */
function Mark({ id, className }: { id: MarkId; className?: string }) {
  const [, viewBox, body] = SVG.exec(MARKS[id].svg.trim()) ?? [];
  if (viewBox === undefined || body === undefined) throw new Error(`the ${id} mark needs one svg with a viewBox`);
  const inked = body.replace(/fill="(?!none)[^"]*"/g, 'fill="currentColor"');
  return <svg viewBox={viewBox} aria-hidden className={cn("shrink-0 fill-current", className)} dangerouslySetInnerHTML={{ __html: inked }} />;
}

export function Agents() {
  return (
    <section aria-label="Agents" className="mx-auto max-w-[1200px] px-4 pt-16 sm:px-6 sm:pt-20">
      <p className="text-center text-[15px] text-muted-foreground">Threads run on the agents you already pay for.</p>
      <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-4 sm:gap-x-14">
        {THREADS.map(id => (
          <li key={id} className="flex items-center gap-2.5 text-[18px] font-medium tracking-[-0.01em] text-foreground/85">
            <Mark id={id} className="size-[22px]" />
            {MARKS[id].name}
          </li>
        ))}
      </ul>
    </section>
  );
}
