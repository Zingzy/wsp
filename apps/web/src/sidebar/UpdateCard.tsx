// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's update card, pinned in its foot above the corner's icons while
// this wsp is behind a release: the version and whether it is out or ready, the
// one act its stage takes, and What's new. Dismissed, that release's card is
// gone from every window, since the host keeps the version; a newer one shows.
import { XIcon } from "lucide-react";
import { Mark } from "../brand/Brand.js";
import { Button } from "../components/ui/button.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { useStore } from "../protocol/store.js";
import { dismissUpdate, openReleasePage, runUpdate, updateReady, useDismissed, useUpdateStage, UPDATE_WORDS, type UpdateAct } from "../shell/update.js";

const ACT_WORDS: Record<UpdateAct, string> = {
  link: UPDATE_WORDS.get,
  get: UPDATE_WORDS.get,
  downloading: UPDATE_WORDS.downloading,
  open: UPDATE_WORDS.quitAndOpen,
  restart: UPDATE_WORDS.restart,
  "restart-host": UPDATE_WORDS.restart,
};

export function UpdateCard() {
  const { stage, road } = useUpdateStage();
  const dismissed = useDismissed();
  const running = useStore(s => Object.values(s.sessions).reduce((n, rows) => n + rows.filter(row => row.status === "running").length, 0));
  if (stage === undefined || dismissed === null || stage.version === dismissed) return null;
  const { act, version } = stage;
  // A restart into the checked copy carries the threads on; an app that cannot replace itself says why beside Get.
  const line = act === "restart" ? (running === 0 ? undefined : UPDATE_WORDS.keepRunning(running)) : act === "get" ? desktopBridge()?.updateWhy : undefined;
  return (
    <div data-update-card={act} role="note" className="flex min-w-0 flex-col gap-1 rounded-[var(--control-radius)] bg-sidebar-row-hover px-2 pt-2 pb-2.5 inset-ring inset-ring-[var(--sidebar-row-edge)]">
      <span className="flex h-5 min-w-0 items-center gap-1.5 text-sm text-sidebar-foreground">
        <Mark className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        <span data-k="update-title" className="min-w-0 flex-1 truncate">
          {updateReady(act) ? UPDATE_WORDS.ready(version) : UPDATE_WORDS.out(version)}
        </span>
        <Button variant="ghost" size="icon-micro" data-k="update-dismiss" aria-label={UPDATE_WORDS.dismiss} className="-me-1 text-sidebar-muted-foreground" onClick={() => dismissUpdate(stage, road)}>
          <XIcon aria-hidden />
        </Button>
      </span>
      {line === undefined ? null : (
        <span data-k="update-line" className="text-meta leading-3.5 text-sidebar-muted-foreground">
          {line}
        </span>
      )}
      <span className="flex items-center gap-2 pt-1.5">
        <Button size="xs" variant="outline" data-k="update-act" disabled={act === "downloading"} {...(act === "get" && road?.bundleHover !== undefined ? { title: road.bundleHover } : {})} onClick={() => runUpdate(stage, road)}>
          {ACT_WORDS[act]}
        </Button>
        <Button size="xs" variant="ghost" data-k="update-notes" onClick={() => openReleasePage(stage)}>
          {UPDATE_WORDS.whatsNew}
        </Button>
      </span>
    </div>
  );
}
