// SPDX-License-Identifier: AGPL-3.0-only
// The line a computer that joined somebody else's wsp carries at the foot of
// its own sidebar: what it runs threads for, and the way back out. It is drawn
// from the shell, since the place file and the service behind it are this
// login's and no host over the wire knows about them; a browser tab and a Mac
// that joined nothing draw nothing. The same two acts sit in the Hosts menu,
// which reads them off the one row list in the protocol, so this row is a
// shortcut rather than a second road. A Mac's own name is longer than the row
// is wide, so the line is cut by the width and rides the row's title whole, as
// a workspace row's third line does.
import { useCallback, useEffect, useState } from "react";
import { HOST_WORDS, type PlaceStanding } from "@wsp/protocol";
import { desktopBridge } from "../lib/desktopShell.js";
import { useStore } from "../protocol/store.js";
import { FOOT_ROW_GRAMMAR } from "../sidebar/rowGrammar.js";

export function PlaceFoot() {
  const bridge = desktopBridge();
  const place = bridge?.place;
  const leaveWsp = bridge?.leaveWsp;
  const [standing, setStanding] = useState<PlaceStanding | null>(null);
  const read = useCallback(() => {
    void place?.().then(
      answered => setStanding(answered ?? null),
      () => setStanding(null),
    );
  }, [place]);
  useEffect(read, [read]);
  if (place === undefined || standing === null) return null;
  const leave = async (): Promise<void> => {
    const answer = await leaveWsp?.();
    if (answer !== undefined && !answer.ok) useStore.setState({ toast: answer.error });
    read();
  };
  return (
    <div data-place-foot className="px-1 pb-1">
      <div className={FOOT_ROW_GRAMMAR}>
        <span data-place-line className="min-w-0 flex-1 truncate" title={HOST_WORDS.place.line(standing.hostName)}>
          {HOST_WORDS.place.line(standing.hostName)}
        </span>
        <button
          type="button"
          onClick={() => void leave()}
          className="shrink-0 rounded-sm underline-offset-2 transition-colors duration-150 hover:text-sidebar-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {HOST_WORDS.place.leave}
        </button>
      </div>
    </div>
  );
}
