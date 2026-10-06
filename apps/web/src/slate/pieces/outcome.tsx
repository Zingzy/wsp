// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "../../lib/utils.js";

/** The one line under a control after a press: the outcome in muted ink, a refusal in the refusal ink. */
export function Outcome({ said, refused }: { said: string | undefined; refused: string | undefined }) {
  if (said === undefined && refused === undefined) return null;
  return (
    <p data-slate-outcome role="status" className={cn("text-xs leading-4", refused !== undefined ? "text-error-foreground" : "text-muted-foreground")}>
      {refused ?? said}
    </p>
  );
}
