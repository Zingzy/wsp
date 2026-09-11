// SPDX-License-Identifier: AGPL-3.0-only
// The one decision the page makes before the app exists: whether it holds a
// token for this host. A page served on loopback carries the host's own and
// goes straight through; one served beyond it pairs first, and a token this
// host no longer honours sends the page back to the code screen rather than
// leaving it dialling something that will never answer.
import { useCallback, useState } from "react";
import type { BootPayload } from "@wsp/protocol";
import { AppRoot } from "./AppRoot.js";
import { PairScreen } from "./PairScreen.js";
import { deviceName, forgetDeviceToken, pageToken, redeemPairingCode, rememberDeviceToken, runtimeUrl, type PageLocation } from "./protocol/pairing.js";

export interface BootGateProps {
  boot: BootPayload;
  at: PageLocation;
  agent: string;
  storage: Storage;
}

export function BootGate({ boot, at, agent, storage }: BootGateProps) {
  const url = runtimeUrl(boot, at);
  const [token, setToken] = useState<string | undefined>(() => pageToken(boot, storage));
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
  if (token === undefined) return <PairScreen onRedeem={redeem} />;
  // A page from the host's own computer holds the host token, which nothing here can replace: it is refused only
  // when the host restarted, and a reload is what fixes that.
  return boot.token !== undefined ? <AppRoot wsUrl={url} token={token} /> : <AppRoot wsUrl={url} token={token} onUnauthorized={onUnauthorized} />;
}
