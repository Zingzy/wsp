// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, useSyncExternalStore } from "react";
import type { GoldenBuilderView } from "@wsp/protocol";
import { makeApi, ProtocolClient } from "./protocol/client.js";
import { useReady, useStore } from "./protocol/store.js";
import { Rail } from "./components/Rail.js";
import { TabStrip } from "./components/TabStrip.js";
import { MetaPanel } from "./components/MetaPanel.js";
import { wireTerminals } from "./terminal/wiring.js";
import { Wizard, type ChecklistItem, type KeyFlags } from "./wizard/Wizard.js";
import styles from "./App.module.css";
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
  useEffect(() => {
    const client = new ProtocolClient({ url: wsUrl, token });
    let live = true;
    void client.connect().then(() => { if (live) bind(makeApi(client)); });
    return () => { live = false; client.close(); };
  }, [wsUrl, token, bind]);
  useEffect(() => wireTerminals(useStore), []);
  return <Shell {...(keys !== undefined ? { keys } : {})} {...(builder !== undefined ? { builder } : {})} {...(checklist !== undefined ? { checklist } : {})} />;
}

type Golden = "unknown" | "none" | "present";

/** The window below the connection: the first-run wizard until a golden
 * image exists, the three-column app from then on. */
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
    <div className={styles.app}>
      <aside className={styles.rail}><Rail /></aside>
      <main className={styles.main}>{ready && golden === "present" ? <TabStrip /> : <div className={styles.boot}>connecting to runtime…</div>}</main>
      <aside className={styles.meta}><MetaPanel /></aside>
    </div>
  );
}
