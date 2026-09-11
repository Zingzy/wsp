// SPDX-License-Identifier: AGPL-3.0-only
// The connect sheet and the sidebar's host foot over a fake desktop bridge:
// two roads on one screen, the code typed as a person types it, a refusal
// under the field it is about, the foot naming the host the window is on and
// opening the Hosts menu with that one marked, and the boot gate asking the
// shell for a token before it asks the person for a code.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_WORDS, WS_PATH, type BootPayload, type ContextMenuItem, type DesktopBridge, type HostsView } from "@wsp/protocol";
import { BootGate } from "../src/BootGate.js";
import { PAIR_HEADING } from "../src/PairScreen.js";
import { ConnectHostSheet, shownCode, sentCode } from "../src/hosts/ConnectHostSheet.js";
import { HostFoot } from "../src/hosts/HostFoot.js";
import { useStore } from "../src/protocol/store.js";

const VIEW: HostsView = {
  here: "This Mac",
  current: "box",
  hosts: [{ alias: "box", label: "maya@box", url: "http://127.0.0.1:52001", road: "ssh" }],
};

type Bridge = Pick<DesktopBridge, "hosts" | "contextMenu" | "switchHost" | "connectHost" | "disconnectHost" | "onConnectHostOpen" | "hostToken">;

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
    connectHost: vi.fn(async () => ({ ok: true as const })),
    disconnectHost: vi.fn(async () => ({ ok: true as const })),
    onConnectHostOpen: vi.fn(() => () => {}),
    hostToken: vi.fn(async () => undefined),
    ...over,
  };
  (window as unknown as { wsp?: unknown }).wsp = bridge;
  return bridge;
}

beforeEach(() => {
  useStore.setState({ connectOpen: false });
  // Base UI's radio re-dispatches a click as a PointerEvent, which jsdom does not have.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {});
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { wsp?: unknown }).wsp;
  window.location.hash = "";
});

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;
const refusalAt = (k: string): string => document.querySelector(`[data-k="${k}-refusal"]`)?.textContent ?? "";

describe("the connect sheet", () => {
  it("offers both roads on one screen, the address and the code first, the ssh login behind the other segment", () => {
    fakeBridge();
    render(<ConnectHostSheet onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: HOST_WORDS.sheet.headline })).toBeTruthy();
    expect(screen.getByRole("radio", { name: HOST_WORDS.sheet.direct })).toBeTruthy();
    expect(field(HOST_WORDS.sheet.address).placeholder).toBe(HOST_WORDS.sheet.addressPlaceholder);
    expect(field(HOST_WORDS.sheet.code).placeholder).toBe(HOST_WORDS.sheet.codePlaceholder);
    expect(screen.getByText(HOST_WORDS.sheet.directNote)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: HOST_WORDS.sheet.ssh }));
    expect(field(HOST_WORDS.sheet.login).placeholder).toBe(HOST_WORDS.sheet.loginPlaceholder);
    expect(field(HOST_WORDS.sheet.port).placeholder).toBe(HOST_WORDS.sheet.portPlaceholder);
    expect(screen.getByText(HOST_WORDS.sheet.sshNote)).toBeTruthy();
    expect(screen.queryByText(HOST_WORDS.sheet.directNote)).toBeNull();
  });

  it("the code reads as typed, upper case with one dash allowed, and goes to the host as eight characters", async () => {
    expect(shownCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(shownCode("ab cd!ef")).toBe("ABCDEF");
    expect(shownCode("abcdefghijk")).toBe("ABCDEFGH");
    expect(sentCode("ABCD-EFGH")).toBe("ABCDEFGH");
    const bridge = fakeBridge();
    const onClose = vi.fn();
    render(<ConnectHostSheet onClose={onClose} />);
    // The held keycap carries its reason on a wrapper, so the button is a new element once it is let go: read it each time.
    const connect = (): HTMLButtonElement => screen.getByRole("button", { name: new RegExp(HOST_WORDS.sheet.keycap) }) as HTMLButtonElement;
    expect(connect().disabled).toBe(true);
    fireEvent.change(field(HOST_WORDS.sheet.address), { target: { value: "http://127.0.0.1:14400" } });
    fireEvent.change(field(HOST_WORDS.sheet.code), { target: { value: "abcd-efgh" } });
    expect(field(HOST_WORDS.sheet.code).value).toBe("ABCD-EFGH");
    expect(connect().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(connect());
    });
    expect(bridge.connectHost).toHaveBeenCalledWith({ road: "direct", url: "http://127.0.0.1:14400", code: "ABCDEFGH" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("a refusal lands under the field it is about, in the host's words, and the sheet stays", async () => {
    const bridge = fakeBridge({ connectHost: vi.fn(async () => ({ ok: false as const, at: "code" as const, error: "that pairing code is not one this host is waiting for; run wsp pair on the host for a fresh one" })) });
    const onClose = vi.fn();
    render(<ConnectHostSheet onClose={onClose} />);
    fireEvent.change(field(HOST_WORDS.sheet.address), { target: { value: "http://127.0.0.1:14400" } });
    fireEvent.change(field(HOST_WORDS.sheet.code), { target: { value: "AAAAAAAA" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(HOST_WORDS.sheet.keycap) }));
    });
    await waitFor(() => expect(refusalAt("code")).toMatch(/pairing code/));
    expect(refusalAt("url")).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    expect(bridge.connectHost).toHaveBeenCalledOnce();
    // Typing again takes the refusal off the field it was about.
    fireEvent.change(field(HOST_WORDS.sheet.code), { target: { value: "BBBBBBBB" } });
    expect(refusalAt("code")).toBe("");
  });

  it("over ssh the login and the port go to the shell as typed, the port as a number, and a refusal lands under the login", async () => {
    const bridge = fakeBridge({ connectHost: vi.fn(async () => ({ ok: false as const, at: "address" as const, error: "wsp is not installed on maya@box: run npm i -g @zingzy/wsp there, then connect again." })) });
    render(<ConnectHostSheet onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: HOST_WORDS.sheet.ssh }));
    fireEvent.change(field(HOST_WORDS.sheet.login), { target: { value: "maya@box" } });
    fireEvent.change(field(HOST_WORDS.sheet.port), { target: { value: "2222" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(HOST_WORDS.sheet.keycap) }));
    });
    expect(bridge.connectHost).toHaveBeenCalledWith({ road: "ssh", address: "maya@box", port: 2222 });
    await waitFor(() => expect(refusalAt("address")).toMatch(/npm i -g @zingzy\/wsp/));
  });
});

describe("the sidebar's host foot", () => {
  it("names the host the window is on and opens the Hosts menu through the shell with that one marked", async () => {
    const bridge = fakeBridge();
    render(<HostFoot />);
    await screen.findByText("maya@box");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: HOST_WORDS.hosts }));
    });
    expect(bridge.menus).toHaveLength(1);
    const rows = bridge.menus[0]!;
    expect(rows.map(r => [r.label, r.checked ?? null])).toEqual([
      ["This Mac", false],
      ["maya@box", true],
      [HOST_WORDS.connectMenu, null],
      ["Disconnect maya@box", null],
    ]);
  });

  it("choosing this computer asks the shell to switch, and choosing connect opens the sheet", async () => {
    const bridge = fakeBridge({ contextMenu: vi.fn(async () => "switch:") });
    render(<HostFoot />);
    await screen.findByText("maya@box");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: HOST_WORDS.hosts }));
    });
    expect(bridge.switchHost).toHaveBeenCalledWith(null);
    (bridge.contextMenu as ReturnType<typeof vi.fn>).mockResolvedValue("connect");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: HOST_WORDS.hosts }));
    });
    expect(useStore.getState().connectOpen).toBe(true);
    expect(screen.getByRole("heading", { name: HOST_WORDS.sheet.headline })).toBeTruthy();
  });

  it("opens the sheet when the page was loaded to do so, and clears the hash", async () => {
    fakeBridge();
    window.location.hash = "#connect";
    render(<HostFoot />);
    await waitFor(() => expect(useStore.getState().connectOpen).toBe(true));
    expect(window.location.hash).toBe("");
  });

  it("draws nothing in a browser tab", () => {
    const { container } = render(<HostFoot />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the boot gate in the shell", () => {
  const boot = (over: Partial<BootPayload> = {}): BootPayload => ({ wsPort: 4410, wsPath: WS_PATH, paired: false, version: "0.0.0", ...over });
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

  it("with the host's own token in the page never asks the shell", async () => {
    const bridge = fakeBridge();
    render(<BootGate boot={boot({ token: "host-token", paired: true })} at={at} agent="Mozilla/5.0 (Macintosh)" storage={window.localStorage} />);
    await act(async () => {});
    expect(bridge.hostToken).not.toHaveBeenCalled();
    expect(screen.queryByText(PAIR_HEADING)).toBeNull();
  });
});
