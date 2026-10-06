// SPDX-License-Identifier: AGPL-3.0-only
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils.js";

/** One quiet line: what a piece draws in place of what failed or what this build cannot draw. Never red. */
export function Quiet({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p {...rest} className={cn("text-xs leading-4 text-muted-foreground", className)} />;
}
