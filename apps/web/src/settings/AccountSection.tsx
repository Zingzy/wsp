// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Account: the one place in the window that says whether this wsp is
// on an account, who it is on, and what a sign-in is for. The sentence under the
// row stands only while nobody is signed in, since it is the answer to a
// question a signed-in person has already had; the devices row takes its place
// afterwards and names every computer paired with this wsp.
//
// The button carries no road yet: signing in and out from the app is the relay
// ticket's, so it is drawn held rather than left off, which is how this column
// already draws an action whose op is not on the wire.
//
// A host that refuses the account read leaves the fact slot empty, the same as
// one that has not answered yet: a refusal is not a sign-in state, and the
// sentence under the row answers the question the section exists for either
// way.
import { useEffect, useState } from "react";
import type { AccountView, DeviceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { useStore } from "../protocol/store.js";
import { ACCOUNT_WORDS, FACT } from "./format.js";
import { Row, Section } from "./rows.js";

export function AccountSection() {
  const api = useStore(s => s.api);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [devices, setDevices] = useState<readonly DeviceView[]>([]);
  useEffect(() => {
    if (api?.account === undefined) return;
    let live = true;
    void api.account()
      .then(next => {
        if (live) setAccount(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);
  // Asked for beside the account rather than after it: the two reads are independent, and the devices row is drawn
  // only once the account read says there is a sign-in, so nothing is shown from a list that arrived first.
  useEffect(() => {
    if (api?.devicesList === undefined) return;
    let live = true;
    void api.devicesList().then(
      next => {
        if (live) setDevices(next);
      },
      () => {
        if (live) setDevices([]);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  const signedIn = account?.signedIn === true;
  return (
    <Section id="settings-account" title={ACCOUNT_WORDS.title}>
      <Row
        id="settings-account-github"
        label={ACCOUNT_WORDS.github}
        {...(account === null
          ? {}
          : {
              fact: (
                <span className={FACT} data-k="account-state">
                  {signedIn ? (account.login ?? ACCOUNT_WORDS.signedIn) : ACCOUNT_WORDS.notSignedIn}
                </span>
              ),
            })}
      >
        <Button data-k="account-action" size="xs" held>
          {signedIn ? ACCOUNT_WORDS.signOut : ACCOUNT_WORDS.signIn}
        </Button>
      </Row>
      {signedIn ? (
        <Row
          id="settings-account-devices"
          label={ACCOUNT_WORDS.devices}
          fact={
            <span className={FACT} data-k="account-devices">
              {devices.length === 0 ? ACCOUNT_WORDS.noDevices : devices.map(d => d.name).join(" · ")}
            </span>
          }
        />
      ) : (
        <Row id="settings-account-reach" label={ACCOUNT_WORDS.reach} note />
      )}
    </Section>
  );
}
