// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useSyncExternalStore } from "react";
import { makeApi, ProtocolClient } from "./protocol/client.js";
import { useCreation, useReady, useSelectedId, useSelectedThreadId, useSettingsOpen, useStore } from "./protocol/store.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./components/ui/empty.js";
import { WorkspaceTerminalDrawer } from "./components/WorkspaceTerminalDrawer.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { useThemeEffect } from "./settings/theme.js";
import { AppShell } from "./shell/AppShell.js";
import { useNeedsYouEffect } from "./shell/needsYou.js";
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
  useThemeEffect();
  useNeedsYouEffect();
  return <Shell />;
}

/** The center slot: the settings page while it is open, else the selected workspace's thread with the terminal drawer
 * under it, or the creation in progress. */
function WorkspaceCenter() {
  const workspaceId = useSelectedId();
  const threadId = useSelectedThreadId();
  const creation = useCreation(workspaceId);
  const settingsOpen = useSettingsOpen();
  if (settingsOpen) return <SettingsPage />;
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
      <div className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
        <WorkspaceThread workspaceId={workspaceId} threadId={threadId} />
      </div>
      <WorkspaceTerminalDrawer workspaceId={workspaceId} />
    </>
  );
}

/** The window below the connection: the three-region shell, on this computer when nothing else is recorded yet. */
export function Shell() {
  const ready = useReady();
  return (
    <AppShell>
      {ready ? (
        <WorkspaceCenter />
      ) : (
        <div className="p-6 font-mono text-sm text-muted-foreground">connecting to runtime…</div>
      )}
    </AppShell>
  );
}
