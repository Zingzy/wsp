// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, useSyncExternalStore } from "react";
import type { GoldenBuilderView } from "@wsp/protocol";
import { makeApi, ProtocolClient } from "./protocol/client.js";
import { useReady, useSelectedId, useStore } from "./protocol/store.js";
import { TabStrip } from "./components/TabStrip.js";
import { WorkspaceTerminalDrawer } from "./components/WorkspaceTerminalDrawer.js";
import { AppShell } from "./shell/AppShell.js";
import { wireTerminals } from "./terminal/wiring.js";
import { Wizard, type ChecklistItem, type KeyFlags } from "./wizard/Wizard.js";
import { Gallery } from "./gallery/Gallery.js";

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const readHash = () => window.location.hash;

/** #gallery mounts the ui kit proof page with no runtime behind it; every other hash is the app. */
export function Root(props: { wsUrl: string; token: string; keys?: KeyFlags; builder?: GoldenBuilderView; checklist?: ChecklistItem[] }) {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  return hash === "#gallery" ? <Gallery /> : <App {...props} />;
}

export function App({
  wsUrl,
  token,
  keys,
  builder,
  checklist,
}: {
  wsUrl: string;
  token: string;
  keys?: KeyFlags;
  builder?: GoldenBuilderView;
  checklist?: ChecklistItem[];
}) {
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
  return <Shell {...(keys !== undefined ? { keys } : {})} {...(builder !== undefined ? { builder } : {})} {...(checklist !== undefined ? { checklist } : {})} />;
}

type Golden = "unknown" | "none" | "present";

/** The center slot: the tabs, with the terminal drawer under them. */
function WorkspaceCenter() {
  const workspaceId = useSelectedId();
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <TabStrip />
      </div>
      {workspaceId ? <WorkspaceTerminalDrawer workspaceId={workspaceId} /> : null}
    </>
  );
}

/** The window below the connection: the first-run wizard until a golden
 * image exists, the three-region shell from then on. */
export function Shell({ keys, builder, checklist }: { keys?: KeyFlags; builder?: GoldenBuilderView; checklist?: ChecklistItem[] }) {
  const api = useStore(s => s.api);
  const ready = useReady();
  const [golden, setGolden] = useState<Golden>("unknown");
  useEffect(() => {
    if (!api) return;
    let live = true;
    // A failed lookup falls through to the app; the rail's own create reports the error.
    void api
      .getGolden()
      .then(m => { if (live) setGolden(m ? "present" : "none"); })
      .catch(() => { if (live) setGolden("present"); });
    return () => { live = false; };
  }, [api]);
  if (golden === "none") {
    return (
      <Wizard
        {...(keys !== undefined ? { keys } : {})}
        {...(builder !== undefined ? { builder } : {})}
        {...(checklist !== undefined ? { checklist } : {})}
        onDone={() => setGolden("present")}
      />
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
