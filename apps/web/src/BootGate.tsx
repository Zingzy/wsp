// SPDX-License-Identifier: AGPL-3.0-only
// The one decision the page makes before the app exists: whether it holds a
// token for this host. A page served on loopback carries the host's own and
// goes straight through; one served beyond it asks the desktop shell, which
// holds the device token of the host it moved the window to, then this
// browser's own store, and pairs when neither has one. A token this host no
// longer honours sends the page back to the code screen rather than leaving
// it dialling something that will never answer.
import { useCallback, useEffect, useState } from "react";
import type { BootPayload } from "@wsp/protocol";
import { AppRoot } from "./AppRoot.js";
import { desktopBridge } from "./lib/desktopShell.js";
import { PairScreen } from "./PairScreen.js";
import { deviceName, forgetDeviceToken, pageToken, redeemPairingCode, rememberDeviceToken, runtimeUrl, storedDeviceToken, type PageLocation } from "./protocol/pairing.js";

export interface BootGateProps {
  boot: BootPayload;
  at: PageLocation;
  agent: string;
  storage: Storage;
}

export function BootGate({ boot, at, agent, storage }: BootGateProps) {
  const url = runtimeUrl(boot, at);
  const askShell = boot.token === undefined ? desktopBridge()?.hostToken : undefined;
  const [token, setToken] = useState<string | undefined>(() => (askShell === undefined ? pageToken(boot, storage) : undefined));
  // The shell's answer decides before anything is drawn: the page is blank for the one round trip, never on the code
  // screen for a moment on a host the shell already paired with.
  const [asking, setAsking] = useState(askShell !== undefined);
  useEffect(() => {
    if (askShell === undefined) return;
    let live = true;
    const settle = (held: string | undefined): void => {
      if (!live) return;
      setToken(held ?? storedDeviceToken(storage));
      setAsking(false);
    };
    askShell().then(settle, () => settle(undefined));
    return () => {
      live = false;
    };
  }, [askShell, storage]);
  const redeem = useCallback(
    async (code: string) => {
      const minted = await redeemPairingCode(url, code, deviceName(at, agent));
      rememberDeviceToken(storage, minted);
      setToken(minted);
    },
    [url, at, agent, storage],
  );
  // The host stopped honouring this browser's token: the device was revoked, or the state file it was paired
  // against was replaced. Drop it and ask for a code rather than dialling something that will never answer.
  const onUnauthorized = useCallback(() => {
    forgetDeviceToken(storage);
    setToken(undefined);
  }, [storage]);
  if (asking) return <div data-k="booting" className="h-dvh bg-background" />;
  if (token === undefined) return <PairScreen onRedeem={redeem} />;
  // A page from the host's own computer holds the host token, which nothing here can replace: it is refused only
  // when the host restarted, and a reload is what fixes that.
  return boot.token !== undefined ? <AppRoot wsUrl={url} token={token} /> : <AppRoot wsUrl={url} token={token} onUnauthorized={onUnauthorized} />;
}
