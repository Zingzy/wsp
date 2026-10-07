// SPDX-License-Identifier: AGPL-3.0-only
// A sign-in that asks the person to pick, drawn in place as the terminal it
// runs in on that computer: the host started the agent's own login in a pty
// there, and this attaches to it over a link of its own to that computer,
// opened while the flow stands and closed with it. The host watches the pty
// end and reads whether it signed in.
import { useEffect, useState } from "react";
import { useStore } from "../../protocol/store.js";
import { connectDaemonLink, type DaemonLink } from "../../terminal/daemon-link.js";
import { WorkspaceTerminals, type TerminalWire } from "../../terminal/link.js";
import { TerminalViewport } from "../ThreadTerminalDrawer.js";
import { ownsKeys } from "../../keyOwners.js";

/** About 17 rows: OpenCode's provider picker draws 15 with its question, and lists past seven providers scroll inside it. */
const BOX_PX = 344;
const NO_CONFIG = {};
/** Esc is the login's own (OpenCode's picker quits on it), never the sheet's or the page's around it. */
const ESCAPE = ownsKeys(["Escape"]);

export function SignInTerminal({ placeId, ptyId }: { placeId: string; ptyId: string }) {
  const api = useStore(s => s.api);
  const [held, setHeld] = useState<WorkspaceTerminals | null>(null);
  useEffect(() => {
    if (api === null) return;
    let link: DaemonLink | null = null;
    let stale = false;
    const wire: TerminalWire = { request: (op, params) => (link !== null ? link.request(op, params) : Promise.reject(new Error("not answering"))) };
    const model = new WorkspaceTerminals(wire);
    link = connectDaemonLink({
      daemon: api.daemon,
      target: { placeId },
      onEvent: e => model.feedEvent(e),
      onStatus: (s, refusal) => {
        if (s !== "dead") model.feedStatus(s, refusal);
        if (s === "live")
          void model.resumeRun(ptyId).then(ok => {
            if (ok && !stale) setHeld(model);
          });
      },
    });
    return () => {
      stale = true;
      link?.close();
      setHeld(null);
    };
  }, [api, placeId, ptyId]);
  return (
    <div data-k="sign-in-terminal" data-owns-keys={ESCAPE} className="overflow-hidden rounded-[var(--control-radius)] border border-border bg-[var(--terminal-background)]" style={{ height: BOX_PX }}>
      {held === null ? null : <TerminalViewport terminalId={ptyId} io={held.io(ptyId)} config={NO_CONFIG} focusRequestId={0} autoFocus resizeEpoch={0} drawerHeight={BOX_PX} />}
    </div>
  );
}
