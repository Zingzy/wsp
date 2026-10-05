// SPDX-License-Identifier: AGPL-3.0-only
// The thread's standing approvals, from the slate tab's menu: one settings row per command, MCP server,
// domain and reaction send the person allowed, each with Revoke. Revoking stops what it covered; the next start asks.
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Card, Row } from "../settings/rows.js";
import type { SlateRecord } from "./wire.js";

export const STANDING_WORDS = {
  menu: "Approvals",
  title: "Approvals in this thread",
  none: "Nothing in this thread runs without asking.",
  revoke: "Revoke",
  sends: "Reactions may message the agent",
  run: (run: string) => `Run $${run}`,
} as const;

/** What a row names: the command or server as allowed, else the reaction sends, else its key. */
function rowOf(key: string, approval: SlateRecord["approvals"][string]): { title: string; description: string } {
  if (key === "send") return { title: STANDING_WORDS.sends, description: "send() in a reaction" };
  return { title: approval.cmd ?? key, description: approval.run !== undefined ? STANDING_WORDS.run(approval.run) : key };
}

export function StandingApprovals({ record, revoke, onClose }: { record: SlateRecord | null; revoke(key: string): Promise<unknown>; onClose(): void }) {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const allowed = Object.entries(record?.approvals ?? {}).filter(([, a]) => a.state === "allowed");
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{STANDING_WORDS.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="pt-1">
          {allowed.length === 0 ? (
            <p className="text-sm text-muted-foreground">{STANDING_WORDS.none}</p>
          ) : (
            <Card id="slate-approvals">
              {allowed.map(([key, approval]) => {
                const row = rowOf(key, approval);
                return (
                  <Row
                    key={key}
                    id={`approval-${key}`}
                    title={row.title}
                    description={row.description}
                    mono
                    clip
                    control={
                      <Button
                        variant="outline"
                        size="xs"
                        data-slate-revoke={key}
                        disabled={busy !== undefined}
                        onClick={() => {
                          setBusy(key);
                          setRefused(undefined);
                          void revoke(key)
                            .catch((error: unknown) => setRefused(error instanceof Error ? error.message : String(error)))
                            .finally(() => setBusy(undefined));
                        }}
                      >
                        {STANDING_WORDS.revoke}
                      </Button>
                    }
                  />
                );
              })}
            </Card>
          )}
          {refused === undefined ? null : <p data-slate-refused className="pt-3 text-[13px] leading-5 text-error-foreground">{refused}</p>}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
