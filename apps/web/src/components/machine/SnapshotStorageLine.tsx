// SPDX-License-Identifier: AGPL-3.0-only
// One line of text under the usage counters: every snapshot on the account,
// what they hold and what that costs a month above the free GB.
import { useCallback, useEffect, useState } from "react";
import type { SnapshotStorage } from "@wsp/protocol";
import { useProtocolEvents, useStore } from "../../protocol/store.js";

export function storageLine(s: SnapshotStorage): string {
  const count = `${s.count} snapshot${s.count === 1 ? "" : "s"}`;
  const size = `${(s.totalBytes / 1e9).toFixed(1)} GB`;
  const cost = s.monthlyUsd > 0 ? `about $${s.monthlyUsd.toFixed(2)}/month above the free ${s.freeGb} GB from ${s.billedFrom}` : `inside the free ${s.freeGb} GB`;
  return `${count} · ${size} · ${cost}`;
}

export function SnapshotStorageLine() {
  const api = useStore(s => s.api);
  const [storage, setStorage] = useState<SnapshotStorage | null>(null);

  const load = useCallback(() => {
    if (!api) return () => {};
    let current = true;
    api.snapshotStorage().then(
      s => {
        if (current) setStorage(s);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [api]);
  useEffect(load, [load]);
  // A seal adds a snapshot; nothing else this client sees changes the account's storage.
  useProtocolEvents(
    useCallback(
      e => {
        if (e.type === "golden.stage" && e.stage === "sealed") load();
      },
      [load],
    ),
  );

  if (storage === null) return null;
  return (
    <p className="mt-1.5 text-[11px] text-muted-foreground" data-k="storage">
      {storageLine(storage)}
    </p>
  );
}
