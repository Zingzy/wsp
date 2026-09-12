// SPDX-License-Identifier: AGPL-3.0-only
// One line of text under the usage counters: every snapshot on the account,
// what they hold and what that costs a month above the free GB.
import { useCallback, useEffect, useState } from "react";
import type { SnapshotStorage } from "@wsp/protocol";
import { useProtocolEvents, useStore } from "../../protocol/store.js";

export function storageLine(s: SnapshotStorage): string {
  const count = `${s.count} snapshot${s.count === 1 ? "" : "s"}`;
  // The provider lists and bills snapshots in decimal GB (a 3839352227-byte snapshot is 3.84 GB to it), so this line keeps its unit rather than the binary one fmtBytes prints.
  const size = `${(s.totalBytes / 1e9).toFixed(1)} GB`;
  const cost = s.monthlyUsd > 0 ? `about $${s.monthlyUsd.toFixed(2)}/month above the free ${s.freeGb} GB from ${s.billedFrom}` : `inside the free ${s.freeGb} GB`;
  return `${count} · ${size} · ${cost}`;
}

export function SnapshotStorageLine({ takes = 0 }: { takes?: number }) {
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
  // A take on this pane adds a snapshot the account is billed for, and the provider answers no event for it, so the
  // count the pane took is what this line reads again on.
  useEffect(load, [load, takes]);
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
