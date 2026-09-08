// SPDX-License-Identifier: AGPL-3.0-only
// The chat row for a permission prompt the harness relayed: what it wants to
// run, on what, and the options a person picks from. One uniform row, the
// tool's own input as muted mono text like every other tool row, and the
// options as plain buttons while the turn waits on them; once it is closed the
// buttons go and the outcome takes their place as one muted line, so a
// transcript read later says what was picked without pretending it is still
// open. No chip, no badge, no colour of its own: nothing here is a state word.
// The input wraps whole where every other tool row truncates: this is the row
// where consent is given, and a command cut mid-word is one a person cannot
// judge.
import type { PermissionPrompt } from "../../adapt";
import { permissionAskLine, permissionOutcomeLine } from "@wsp/protocol";
import { Button } from "../ui/button";

/** The tool's input as one line: the harness sends JSON, and the row shows the values a person needs to judge the
 * call rather than the braces around them. */
export function permissionInputLine(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return input;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return input;
  return Object.entries(parsed as Record<string, unknown>)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("  ")
    .replace(/\s+/g, " ")
    .trim();
}

export function PermissionPromptRow({
  permission,
  onAnswer,
}: {
  permission: PermissionPrompt;
  onAnswer: (sessionId: string, askId: string, optionId: string) => void;
}) {
  const open = permission.outcome === null;
  const picked = permission.options.find(o => o.id === permission.optionId);
  const line = permissionInputLine(permission.input);
  return (
    <div className="min-w-0 border-b border-border/60 px-1 pb-2 pt-1" data-permission-prompt={permission.askId} data-permission-open={open ? "true" : "false"}>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm leading-relaxed text-foreground/80">{permissionAskLine(permission.toolName, permission.detail)}</span>
        {line === "" ? null : <span className="break-words whitespace-pre-wrap font-mono text-xs leading-4 text-muted-foreground">{line}</span>}
        {open ? (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {permission.options.map(option => (
              <Button
                key={option.id}
                type="button"
                size="xs"
                variant="outline"
                data-permission-option={option.id}
                onClick={() => onAnswer(permission.sessionId, permission.askId, option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : (
          <span className="font-mono text-xs leading-4 text-muted-foreground" data-permission-outcome={permission.outcome ?? undefined}>
            {permissionOutcomeLine(permission.outcome!, picked)}
          </span>
        )}
      </div>
    </div>
  );
}
