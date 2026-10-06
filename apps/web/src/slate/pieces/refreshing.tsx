// SPDX-License-Identifier: AGPL-3.0-only
import { Spinner } from "../../components/ui/spinner.js";
import { cn } from "../../lib/utils.js";

/** The quiet mark a section, an output or the slate's header shows while a run it reads refreshes; its last values
 * stay drawn, so the mark sits in a place that already holds its height. */
export function Refreshing({ className }: { className?: string }) {
  return <Spinner data-slate-refreshing aria-label="Refreshing" className={cn("size-3 shrink-0 text-muted-foreground motion-reduce:animate-none", className)} />;
}
