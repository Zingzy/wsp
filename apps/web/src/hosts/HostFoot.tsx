// SPDX-License-Identifier: AGPL-3.0-only
// The last line of the sidebar in the desktop shell: which host this window
// is on, in mono and muted, with the one glyph that says it is a menu. The
// menu is the shell's own, drawn from the same rows the menu bar's Hosts menu
// is, so the two can never list different hosts. The connect sheet mounts
// here, opened by the menu, by the menu bar, or by a page loaded to open it. A
// browser tab has no shell to move between hosts and draws nothing.
import { useCallback, useEffect, useState } from "react";
import { HOST_WORDS, hostMenuAction, hostsMenuItems, type HostOutcome, type HostsView } from "@wsp/protocol";
import { ChevronsUpDownIcon } from "lucide-react";
import { desktopBridge } from "../lib/desktopShell.js";
import { addNotice } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { FOOT_ROW_CLASS } from "../sidebar/rowGrammar.js";
import { ConnectHostSheet } from "./ConnectHostSheet.js";

const HOSTS_NOT_READ = "hosts not read";

export function HostFoot() {
  const bridge = desktopBridge();
  const open = useStore(s => s.connectOpen);
  const openConnect = useStore(s => s.openConnect);
  const closeConnect = useStore(s => s.closeConnect);
  const [view, setView] = useState<HostsView | null>(null);
  const [refused, setRefused] = useState(false);
  const hosts = bridge?.hosts;
  const reload = useCallback(() => {
    void hosts?.().then(
      next => {
        setView(next);
        setRefused(false);
      },
      () => {
        setView(null);
        setRefused(true);
      },
    );
  }, [hosts]);
  useEffect(reload, [reload]);
  const onOpen = bridge?.onConnectHostOpen;
  useEffect(() => onOpen?.(() => openConnect()), [onOpen, openConnect]);
  useEffect(() => {
    if (hosts === undefined || window.location.hash !== HOST_WORDS.connectHash) return;
    openConnect();
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [hosts, openConnect]);
  if (hosts === undefined) return null;
  const current = view === null ? undefined : view.hosts.find(h => h.alias === view.current);
  const label = view === null ? (refused ? HOSTS_NOT_READ : "") : current?.label ?? view.here;
  const said = (answer: HostOutcome): void => {
    if (!answer.ok) addNotice({ kind: "error", text: answer.error });
  };
  const openMenu = async (): Promise<void> => {
    if (view === null || bridge?.contextMenu === undefined) return;
    const chosen = await bridge.contextMenu(hostsMenuItems(view));
    const action = chosen === null ? undefined : hostMenuAction(chosen);
    if (action === undefined) return;
    if (action.kind === "connect") openConnect();
    else if (action.kind === "switch") said((await bridge.switchHost?.(action.alias)) ?? { ok: true });
    else if (action.kind === "disconnect") said((await bridge.disconnectHost?.(action.alias)) ?? { ok: true });
    reload();
  };
  return (
    <div data-host-foot className="px-1 pb-1">
      <button
        type="button"
        aria-label={HOST_WORDS.hosts}
        onClick={() => void openMenu()}
        className={FOOT_ROW_CLASS}
      >
        <span data-host-label className="min-w-0 flex-1 truncate text-left">
          {label}
        </span>
        {view === null ? null : <ChevronsUpDownIcon aria-hidden className="size-4 shrink-0" />}
      </button>
      {open ? <ConnectHostSheet onClose={closeConnect} /> : null}
    </div>
  );
}
