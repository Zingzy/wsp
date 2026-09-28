// SPDX-License-Identifier: AGPL-3.0-only
// The boot gate over a fake desktop bridge, asking the shell for a token before
// it asks the person for a code.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WS_PATH, type BootPayload, type ContextMenuItem, type DesktopBridge, type HostsView } from "@wsp/protocol";
import { BootGate } from "../src/BootGate.js";
import { PAIR_HEADING } from "../src/PairScreen.js";

const VIEW: HostsView = {
  here: "This Mac",
  current: "box",
  hosts: [{ alias: "box", url: "https://hbox1.boxes.example" }],
};

type Bridge = Pick<DesktopBridge, "hosts" | "contextMenu" | "switchHost" | "hostToken">;

function fakeBridge(over: Partial<Bridge> = {}): Bridge & { menus: ContextMenuItem[][] } {
  const menus: ContextMenuItem[][] = [];
  const bridge = {
    menus,
    hosts: vi.fn(async () => VIEW),
    contextMenu: vi.fn(async (items: ContextMenuItem[]) => {
      menus.push(items);
      return null;
    }),
    switchHost: vi.fn(async () => ({ ok: true as const })),
    hostToken: vi.fn(async () => undefined),
    ...over,
  };
  (window as unknown as { wsp?: unknown }).wsp = bridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { wsp?: unknown }).wsp;
});

describe("the boot gate in the shell", () => {
  const boot = (over: Partial<BootPayload> = {}): BootPayload => ({ wsPath: WS_PATH, paired: false, version: "0.0.0", ...over });
  const at = { protocol: "http:", host: "127.0.0.1:1" };

  it("with no token in the page asks the shell, and goes through on what it answers", async () => {
    const bridge = fakeBridge({ hostToken: vi.fn(async () => "device-token") });
    render(<BootGate boot={boot()} at={at} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await waitFor(() => expect(bridge.hostToken).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector("[data-k=booting]")).toBeNull());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });

  it("with no token anywhere shows the pairing screen", async () => {
    fakeBridge();
    render(<BootGate boot={boot()} at={at} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    expect(await screen.findByText(PAIR_HEADING)).toBeTruthy();
  });

  it("on this computer's own page asks the shell too, since the page carries a digest of the host's token and never the token", async () => {
    const bridge = fakeBridge({ hostToken: vi.fn(async () => "host-token") });
    render(<BootGate boot={boot({ tokenHash: "a".repeat(64), paired: true })} at={at} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await waitFor(() => expect(bridge.hostToken).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.querySelector("[data-k=booting]")).toBeNull());
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });
});
