// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { makeApi, ProtocolClient } from "./protocol/client.js";
import { useReady, useStore } from "./protocol/store.js";
import { Rail } from "./components/Rail.js";
import { TabStrip } from "./components/TabStrip.js";
import { MetaPanel } from "./components/MetaPanel.js";
import styles from "./App.module.css";

export function App({ wsUrl, token }: { wsUrl: string; token: string }) {
  const bind = useStore(s => s.bind);
  const ready = useReady();
  useEffect(() => {
    const client = new ProtocolClient({ url: wsUrl, token });
    let live = true;
    void client.connect().then(() => { if (live) bind(makeApi(client)); });
    return () => { live = false; client.close(); };
  }, [wsUrl, token, bind]);
  return (
    <div className={styles.app}>
      <aside className={styles.rail}><Rail /></aside>
      <main className={styles.main}>{ready ? <TabStrip /> : <div className={styles.boot}>connecting to runtime…</div>}</main>
      <aside className={styles.meta}><MetaPanel /></aside>
    </div>
  );
}
