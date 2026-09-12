// SPDX-License-Identifier: AGPL-3.0-only
// The foot of the sidebar on a computer that joined somebody else's wsp, over
// a fake desktop bridge: the line saying what it runs threads for, the way
// back out beside it, a refusal from the shell as a toast, and the same two
// acts in the Hosts menu, which the host foot draws from the one row list the
// menu bar draws from. A browser tab and a Mac that joined nothing draw
// nothing at all.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HOST_WORDS, type ContextMenuItem, type DesktopBridge, type HostsView, type PlaceStanding } from "@wsp/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostFoot } from "../src/hosts/HostFoot.js";
import { PlaceFoot } from "../src/hosts/PlaceFoot.js";
import { useStore } from "../src/protocol/store.js";

const STANDING: PlaceStanding = {
  hostName: "zingzy-mbp",
  hostUrl: "http://192.168.1.20:4420",
  alias: "192.168.1.20",
  joinedAt: "2026-09-12T09:00:00.000Z",
  awake: false,
};

const VIEW: HostsView = {
  here: "This Mac",
  current: null,
  hosts: [],
  place: { hostName: "zingzy-mbp", awake: true },
};

type Bridge = Partial<DesktopBridge>;

function fakeBridge(over: Bridge = {}): Bridge & { menus: ContextMenuItem[][] } {
  const menus: ContextMenuItem[][] = [];
  const bridge = {
    menus,
    place: vi.fn(async () => STANDING),
    leaveWsp: vi.fn(async () => ({ ok: true as const })),
    setStayAwake: vi.fn(async () => STANDING),
    ...over,
  };
  (window as unknown as { wsp?: unknown }).wsp = bridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { wsp?: unknown }).wsp;
  useStore.setState({ toast: null });
});

const line = (): string => document.querySelector("[data-place-line]")?.textContent ?? "";

describe("the foot of a computer that joined another wsp", () => {
  it("draws nothing in a browser tab, and nothing on a Mac that joined nobody", async () => {
    render(<PlaceFoot />);
    expect(document.querySelector("[data-place-foot]")).toBeNull();
    cleanup();
    fakeBridge({ place: vi.fn(async () => undefined) });
    render(<PlaceFoot />);
    await act(async () => {});
    expect(document.querySelector("[data-place-foot]")).toBeNull();
  });

  it("says what this computer runs threads for, with the way out beside it", async () => {
    fakeBridge();
    render(<PlaceFoot />);
    await waitFor(() => expect(line()).toBe(HOST_WORDS.place.line("zingzy-mbp")));
    expect(screen.getByText(HOST_WORDS.place.leave)).toBeTruthy();
  });

  it("carries its whole sentence on the row's title, since a Mac's own name is longer than the row is wide", async () => {
    // The default name of a Mac, which is what the live run's own computer was called: the row holds twelve
    // characters of name after the fixed half, so the width cuts it and the hover is the only way to read the rest.
    fakeBridge({ place: vi.fn(async () => ({ ...STANDING, hostName: "zingzys-MacBook-Pro" })) });
    render(<PlaceFoot />);
    const whole = HOST_WORDS.place.line("zingzys-MacBook-Pro");
    await waitFor(() => expect(line()).toBe(whole));
    expect(document.querySelector("[data-place-line]")?.getAttribute("title")).toBe(whole);
    expect(document.querySelector("[data-place-line]")?.className).toContain("truncate");
  });

  it("leaves through the shell, and reads the line again so the foot goes with it", async () => {
    const bridge = fakeBridge();
    render(<PlaceFoot />);
    await waitFor(() => expect(line()).toBe(HOST_WORDS.place.line("zingzy-mbp")));
    (bridge.place as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await act(async () => {
      fireEvent.click(screen.getByText(HOST_WORDS.place.leave));
    });
    expect(bridge.leaveWsp).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.querySelector("[data-place-foot]")).toBeNull());
  });

  it("says what the shell refused in the toast, and stays where it is", async () => {
    fakeBridge({ leaveWsp: vi.fn(async () => ({ ok: false as const, at: "url" as const, error: "the wsp over there could not be told" })) });
    render(<PlaceFoot />);
    await waitFor(() => expect(line()).toBe(HOST_WORDS.place.line("zingzy-mbp")));
    await act(async () => {
      fireEvent.click(screen.getByText(HOST_WORDS.place.leave));
    });
    expect(useStore.getState().toast).toBe("the wsp over there could not be told");
  });
});

describe("the Hosts menu on a computer that joined another wsp", () => {
  it("carries the awake row checked and the leave row, and each one acts through the shell", async () => {
    const menus: ContextMenuItem[][] = [];
    const bridge = fakeBridge({
      hosts: vi.fn(async () => VIEW),
      contextMenu: vi.fn(async (items: ContextMenuItem[]) => {
        menus.push(items);
        return "awake:off";
      }),
      switchHost: vi.fn(async () => ({ ok: true as const })),
      disconnectHost: vi.fn(async () => ({ ok: true as const })),
      onConnectHostOpen: vi.fn(() => () => {}),
    });
    render(<HostFoot />);
    // The foot asks the shell for the list as it mounts; the menu is the list, so nothing opens until it has landed.
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByLabelText(HOST_WORDS.hosts));
    });
    const rows = menus.at(-1) ?? [];
    expect(rows.find(r => r.label === HOST_WORDS.place.awakeRow)).toMatchObject({ checked: true });
    expect(rows.find(r => r.label === HOST_WORDS.place.leaveRow("zingzy-mbp"))).toMatchObject({ destructive: true });
    // The row is checked, so pressing it is the person asking for the hold to go.
    expect(bridge.setStayAwake).toHaveBeenCalledWith(false);
  });

  it("says in the toast what the shell refused the awake row, as it does for the leave row", async () => {
    const menus: ContextMenuItem[][] = [];
    fakeBridge({
      hosts: vi.fn(async () => VIEW),
      contextMenu: vi.fn(async (items: ContextMenuItem[]) => {
        menus.push(items);
        return "awake:off";
      }),
      // The hold answers the standing, so a place file that went between the menu opening and the press is a throw.
      setStayAwake: vi.fn(() => Promise.reject(new Error("this computer is not a place in any wsp, so there is nothing to leave"))),
      onConnectHostOpen: vi.fn(() => () => {}),
    });
    render(<HostFoot />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByLabelText(HOST_WORDS.hosts));
    });
    expect(useStore.getState().toast).toBe("this computer is not a place in any wsp, so there is nothing to leave");
  });

  it("leaves the wsp from the menu's own row", async () => {
    const menus: ContextMenuItem[][] = [];
    const bridge = fakeBridge({
      hosts: vi.fn(async () => VIEW),
      contextMenu: vi.fn(async (items: ContextMenuItem[]) => {
        menus.push(items);
        return "leave-place";
      }),
      onConnectHostOpen: vi.fn(() => () => {}),
    });
    render(<HostFoot />);
    // The foot asks the shell for the list as it mounts; the menu is the list, so nothing opens until it has landed.
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByLabelText(HOST_WORDS.hosts));
    });
    expect(bridge.leaveWsp).toHaveBeenCalledOnce();
  });
});
