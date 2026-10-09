// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { fmtElapsed } from "@wsp/protocol";
import { parseTimestampMs } from "../../sidebar/Sidebar.logic.js";

/** How long the latest turn has run, written to its own node each second so the tick commits nothing to React, as
 * the transcript's working timer does. A turn with no start on its row yet, a send the runtime has not answered,
 * counts from the moment it was drawn. */
export function WorkingSince({ since }: { since: string | null }) {
  const node = useRef<HTMLSpanElement>(null);
  const [drawnAt] = useState(Date.now);
  const from = since === null ? drawnAt : parseTimestampMs(since);
  useEffect(() => {
    const write = () => {
      if (node.current !== null) node.current.textContent = fmtElapsed(Date.now() - from);
    };
    write();
    const id = window.setInterval(write, 1000);
    return () => window.clearInterval(id);
  }, [from]);
  return (
    <span ref={node} aria-hidden className="tabular-nums">
      {fmtElapsed(Date.now() - from)}
    </span>
  );
}
