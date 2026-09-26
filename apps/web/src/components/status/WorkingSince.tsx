// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { formatWorkingDurationLabel, parseTimestampMs } from "../../sidebar/Sidebar.logic.js";

/** How long the latest turn has run, ticking each second. A turn with no start on its row yet, a send the runtime
 * has not answered, counts from the moment it was drawn. */
export function WorkingSince({ since }: { since: string | null }) {
  const [drawnAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const from = since === null ? drawnAt : parseTimestampMs(since);
  return (
    <span aria-hidden className="tabular-nums">
      {formatWorkingDurationLabel(now - from)}
    </span>
  );
}
