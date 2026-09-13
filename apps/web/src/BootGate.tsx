// SPDX-License-Identifier: AGPL-3.0-only
// The one decision the page makes before the app exists: whether it holds a
// token for this host. A page served on loopback carries the host's own and
// goes straight through; one served beyond it asks the desktop shell, which
// holds a token for whichever host the window is on, then this browser's own
// store, and pairs when neither has one. A token this host no longer honours
// sends the page back to the code screen rather than leaving it dialling
// something that will never answer, except where the shell is the one that
// gave it: the host mints a fresh token at every start and the shell reads the
// token file at every call, so a refusal right after a host restart is
// answered by asking the shell again. Each refused token is asked about once,
// so a host that will not take anything ends on the code screen rather than in
// a loop.
import { useCallback, useEffect, useRef, useState } from "react";
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
  const refused = useRef(new Set<string>());
  const [token, setToken] = useState<string | undefined>(() => (askShell === undefined ? pageToken(boot, storage) : undefined));
  // The shell's answer decides before anything is drawn: the page is blank for the one round trip, never on the code
  // screen for a moment on a host the shell already paired with.
  const [asking, setAsking] = useState(askShell !== undefined);
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    if (askShell === undefined) return;
    let live = true;
    const usable = (held: string | undefined): string | undefined => (held !== undefined && !refused.current.has(held) ? held : undefined);
    const settle = (held: string | undefined): void => {
      if (!live) return;
      setToken(usable(held) ?? usable(storedDeviceToken(storage)));
      setAsking(false);
    };
    askShell().then(settle, () => settle(undefined));
    return () => {
      live = false;
    };
  }, [askShell, storage, asks]);
  const redeem = useCallback(
    async (code: string) => {
      const minted = await redeemPairingCode(url, code, deviceName(at, agent));
      rememberDeviceToken(storage, minted);
      setToken(minted);
    },
    [url, at, agent, storage],
  );
  // The host stopped honouring this token: the device was revoked, the state file it was paired against was
  // replaced, or the host restarted and minted another. The browser's store keeps nothing the host refused; where
  // the shell can be asked, it is asked once more, since a restarted host has a token for this computer already.
  const onUnauthorized = useCallback(() => {
    if (token !== undefined) {
      refused.current.add(token);
      if (storedDeviceToken(storage) === token) forgetDeviceToken(storage);
    }
    if (askShell === undefined) {
      setToken(undefined);
      return;
    }
    setAsking(true);
    setAsks(n => n + 1);
  }, [askShell, storage, token]);
  if (asking) return <div data-k="booting" className="h-dvh bg-background" />;
  if (token === undefined) return <PairScreen onRedeem={redeem} />;
  // A page from the host's own computer holds the host token, which nothing here can replace: it is refused only
  // when the host restarted, and a reload is what fixes that.
  return boot.token !== undefined ? <AppRoot wsUrl={url} token={token} /> : <AppRoot wsUrl={url} token={token} onUnauthorized={onUnauthorized} />;
}
