// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AccountView, DeviceView } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { AccountSection } from "./AccountSection.js";
import { ACCOUNT_WORDS } from "./format.js";

const device = (name: string): DeviceView => ({ id: `d_${name}`, name, createdAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-12T09:00:00Z" });

/** A host that answers both reads, or one that refuses the account read the way a bare runtime does. */
function mount(account: AccountView | Error, devices: readonly DeviceView[] = []) {
  const api = {
    subscribe: () => () => {},
    account: async () => {
      if (account instanceof Error) throw account;
      return account;
    },
    devicesList: async () => devices,
  } as unknown as Api;
  useStore.setState({ api } as never);
  return render(<AccountSection />);
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

const fact = (k: string): string | undefined => document.querySelector<HTMLElement>(`[data-k="${k}"]`)?.textContent ?? undefined;
const action = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('[data-k="account-action"]');

afterEach(() => {
  cleanup();
  useStore.setState({ api: null } as never);
});

describe("with no sign-in", () => {
  it("says not signed in, offers the GitHub sign-in and says in one sentence what a sign-in buys", async () => {
    mount({ signedIn: false });
    await settle();
    expect(fact("account-state")).toBe(ACCOUNT_WORDS.notSignedIn);
    expect(action()?.textContent).toBe(ACCOUNT_WORDS.signIn);
    expect(screen.getByText(ACCOUNT_WORDS.reach)).toBeTruthy();
    expect(fact("account-devices")).toBeUndefined();
  });

  it("draws the sign-in held, with no reason on a hover, since the app has no road to the relay yet", async () => {
    mount({ signedIn: false });
    await settle();
    expect(action()?.disabled).toBe(true);
    expect(action()?.hasAttribute("data-held")).toBe(true);
    // A held control never has a pointer on it, so a title on one is a reason nobody can read.
    expect(action()?.hasAttribute("title")).toBe(false);
  });

  it("claims no state on a host that answers the account read with a refusal, and says what a sign-in buys anyway", async () => {
    // A refusal is not a sign-in state, so the slot stands empty as it does before any answer; the sentence under
    // the row is the answer the section exists for and does not wait on a read.
    mount(new Error("this host keeps no account records; wsp up serves them"));
    await settle();
    expect(fact("account-state")).toBeUndefined();
    expect(screen.getByText(ACCOUNT_WORDS.reach)).toBeTruthy();
  });
});

describe("with a sign-in", () => {
  it("names the account, offers Sign out, drops the sentence and lists the devices", async () => {
    mount({ signedIn: true, login: "zingzy" }, [device("this Mac"), device("old-macbook"), device("Safari on iPhone")]);
    await settle();
    expect(fact("account-state")).toBe("zingzy");
    expect(action()?.textContent).toBe(ACCOUNT_WORDS.signOut);
    expect(screen.queryByText(ACCOUNT_WORDS.reach)).toBeNull();
    expect(fact("account-devices")).toBe("this Mac · old-macbook · Safari on iPhone");
  });

  it("says signed in where the relay named no account, and none where nothing is paired", async () => {
    mount({ signedIn: true });
    await settle();
    expect(fact("account-state")).toBe(ACCOUNT_WORDS.signedIn);
    expect(fact("account-devices")).toBe(ACCOUNT_WORDS.noDevices);
  });
});
