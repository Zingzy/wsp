// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, useSyncExternalStore } from "react";
import { makeApi, ProtocolClient } from "./protocol/client.js";
import { useCreation, useReady, useSelectedId, useSelectedThreadId, useStore } from "./protocol/store.js";
import { Mark } from "./brand/Brand.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./components/ui/empty.js";
import { WorkspaceTerminalDrawer } from "./components/WorkspaceTerminalDrawer.js";
import { AppShell } from "./shell/AppShell.js";
import { WorkspaceCreation } from "./shell/WorkspaceCreation.js";
import { WorkspaceThread } from "./shell/WorkspaceThread.js";
import { wireTerminals } from "./terminal/wiring.js";
import { Gallery } from "./gallery/Gallery.js";

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const readHash = () => window.location.hash;

/** #gallery mounts the ui kit proof page with no runtime behind it; every other hash is the app. */
export function Root(props: { wsUrl: string; token: string }) {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  return hash === "#gallery" ? <Gallery /> : <App {...props} />;
}

export function App({ wsUrl, token }: { wsUrl: string; token: string }) {
  const bind = useStore(s => s.bind);
  const setConn = useStore(s => s.setConn);
  const noteGap = useStore(s => s.noteGap);
  useEffect(() => {
    const client = new ProtocolClient({ url: wsUrl, token, onStatus: setConn, onGap: noteGap });
    let live = true;
    void client.connect().then(() => { if (live) bind(makeApi(client)); });
    return () => { live = false; client.close(); };
  }, [wsUrl, token, bind, setConn, noteGap]);
  useEffect(() => wireTerminals(useStore), []);
  return <Shell />;
}

type Golden = "unknown" | "none" | "present";

/** The center slot: the selected workspace's thread with the terminal drawer under it, or the creation in progress. */
function WorkspaceCenter() {
  const workspaceId = useSelectedId();
  const threadId = useSelectedThreadId();
  const creation = useCreation(workspaceId);
  if (creation) return <WorkspaceCreation creation={creation} />;
  if (!workspaceId) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>Pick a workspace to continue</EmptyTitle>
          <EmptyDescription>Select a workspace in the sidebar or create a new one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspaceThread workspaceId={workspaceId} threadId={threadId} />
      </div>
      <WorkspaceTerminalDrawer workspaceId={workspaceId} />
    </>
  );
}

/** The window below the connection: one line pointing at wsp init until a
 * golden image exists, the three-region shell from then on. */
export function Shell() {
  const api = useStore(s => s.api);
  const ready = useReady();
  const [golden, setGolden] = useState<Golden>("unknown");
  useEffect(() => {
    if (!api) return;
    let live = true;
    // A failed lookup falls through to the app; the sidebar's own create reports the error.
    void api
      .getGolden()
      .then(m => { if (live) setGolden(m ? "present" : "none"); })
      .catch(() => { if (live) setGolden("present"); });
    return () => { live = false; };
  }, [api]);
  if (golden === "none") {
    return (
      <p className="flex h-full items-center justify-center gap-2 p-6 font-mono text-sm text-muted-foreground">
        <Mark className="h-[1em] shrink-0" />
        No golden image yet. Run wsp init in a terminal; it opens this app when the machine is ready.
      </p>
    );
  }
  return (
    <AppShell>
      {ready && golden === "present" ? (
        <WorkspaceCenter />
      ) : (
        <div className="p-6 font-mono text-sm text-muted-foreground">connecting to runtime…</div>
      )}
    </AppShell>
  );
}
