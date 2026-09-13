// SPDX-License-Identifier: AGPL-3.0-only
// The one line and the one button every pane that needs a daemon this host
// started shows while it is not running: the terminal, the files, the
// processes and the Live rows. The sentence is the reading's, so the row's
// slot, the Workspace pane's State row, Settings and these panes cannot say
// four things about one daemon, and the button is where the click was, so the
// host's refusal lands under it rather than in the sidebar's corner.
import { useCallback, useState } from "react";
import type { AbsentComputer } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";
import { Button } from "./ui/button.js";

const STARTING_WORD = "Starting…";

/** What a start that threw says under the button. The host's own words are not quoted: a spawn that failed ends in
 * whatever it threw, and an exception's words are never what a person reads. */
const START_REFUSED_LINE = "No daemon started; try again.";

/** The ask, and what the last one left behind: the button is held while it is in flight and one written sentence
 * stands under it when the host refused. A client whose host offers no such road hands back no ask, and the panes
 * then draw the sentence alone. */
export function useDaemonRestart(workspaceId: string): { start: (() => void) | null; busy: boolean; refusal: string | null } {
  const api = useStore(s => s.api);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  const restart = api?.restartDaemon;
  const start = useCallback(() => {
    if (restart === undefined) return;
    setBusy(true);
    setRefused(false);
    void restart(workspaceId).then(
      () => setBusy(false),
      () => {
        setBusy(false);
        setRefused(true);
      },
    );
  }, [restart, workspaceId]);
  return { start: restart === undefined ? null : start, busy, refusal: refused ? START_REFUSED_LINE : null };
}

/** The button alone, for a pane whose own title already says the sentence. Nothing at all on a reading this host
 * cannot act on, which is every computer it only waits for. */
export function StartDaemonButton({ absent, workspaceId }: { absent: AbsentComputer; workspaceId: string }) {
  const { start, busy, refusal } = useDaemonRestart(workspaceId);
  if (absent.start === undefined || start === null) return null;
  return (
    <>
      <Button size="xs" variant="outline" disabled={busy} onClick={start} data-k="start-daemon">
        {busy ? STARTING_WORD : absent.start}
      </Button>
      {refusal !== null ? (
        <p className="text-xs text-muted-foreground" data-k="start-daemon-refused">
          {refusal}
        </p>
      ) : null}
    </>
  );
}

/** The sentence and the button together, for a pane whose empty state says nothing else. */
export function DaemonDown({ absent, workspaceId, className }: { absent: AbsentComputer; workspaceId: string; className?: string }) {
  return (
    <div className={className ?? "flex flex-1 flex-col items-center justify-center gap-2 text-center"} data-k="daemon-down">
      <p className="text-sm text-foreground">{absent.said}</p>
      <StartDaemonButton absent={absent} workspaceId={workspaceId} />
    </div>
  );
}
