// SPDX-License-Identifier: AGPL-3.0-only
// A desktop shell attached to a host it did not start can be of another
// release than the page that host serves, and then half the bridge's calls
// fail with nothing said. The page compares the two on load and puts one line
// in the sidebar's own sentence slot, with the releases page behind its button
// where there is a newer app to get. A browser tab has no second half and says
// nothing.
import { act, render, screen, waitFor } from "@testing-library/react";
import { GET_THE_APP_WORD, type BootPayload } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { SidebarProvider } from "../src/components/ui/sidebar.js";
import { useStore } from "../src/protocol/store.js";
import { useShellVersionEffect } from "../src/shell/shellVersion.js";
import { WorkspaceSidebar } from "../src/sidebar/WorkspaceSidebar.js";
import { ScriptedSocket } from "./scripted-socket.js";

const served = (boot: BootPayload | undefined): void => {
  const holder = window as unknown as { __WSP__?: BootPayload };
  if (boot === undefined) delete holder.__WSP__;
  else holder.__WSP__ = boot;
};

function Reader() {
  useShellVersionEffect();
  return null;
}

beforeEach(() => {
  useStore.setState({ toast: null, toastAction: null });
  served({ wsPort: 1, token: "t", version: "0.1.5" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.wsp;
  served(undefined);
  document.body.innerHTML = "";
});

describe("a shell and the host that served it its page", () => {
  it("says nothing at all in a browser tab, which has no shell half to be behind", () => {
    render(<Reader />);
    expect(useStore.getState().toast).toBeNull();
  });

  it("says nothing while the shell and the host are one release", () => {
    window.wsp = { version: "0.1.5" };
    render(<Reader />);
    expect(useStore.getState().toast).toBeNull();
  });

  it("names both releases and offers the releases page when the app is the older half", () => {
    window.wsp = { version: "0.1.3" };
    render(<Reader />);
    expect(useStore.getState().toast).toBe("this app is 0.1.3, the host is 0.1.5: get the new app");
    expect(useStore.getState().toastAction?.word).toBe(GET_THE_APP_WORD);
  });

  it("asks for the app's own host when the host is the older half, with nothing to download", () => {
    window.wsp = { version: "0.1.9" };
    render(<Reader />);
    expect(useStore.getState().toast).toBe("this app is 0.1.9, the host is 0.1.5: run the app's own host");
    expect(useStore.getState().toastAction).toBeNull();
  });

  it("catches the shell that started this: a bridge with no version at all is one from before the bridge had one", () => {
    window.wsp = { pickFolder: async () => undefined };
    render(<Reader />);
    expect(useStore.getState().toast).toBe("this app is older than the host, which is 0.1.5: get the new app");
    expect(useStore.getState().toastAction?.word).toBe(GET_THE_APP_WORD);
  });

  it("is read by the app itself on load, not only by whoever calls the hook", async () => {
    ScriptedSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", ScriptedSocket);
    window.wsp = { version: "0.1.3" };
    render(<App wsUrl="ws://test" token="tok" />);
    await waitFor(() => expect(useStore.getState().toast).toBe("this app is 0.1.3, the host is 0.1.5: get the new app"));
  });

  it("lands as the one muted line the sidebar keeps for a sentence, whose button opens the releases page away from this window", () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    window.wsp = { version: "0.1.3" };
    render(
      <SidebarProvider defaultOpen>
        <Reader />
        <WorkspaceSidebar />
      </SidebarProvider>,
    );
    const line = screen.getByRole("status");
    expect(line.textContent).toContain("this app is 0.1.3, the host is 0.1.5: get the new app");
    const button = document.querySelector<HTMLElement>("[data-toast-action]")!;
    expect(button.textContent).toBe(GET_THE_APP_WORD);
    act(() => button.click());
    expect(open).toHaveBeenCalledWith("https://github.com/Zingzy/wsp/releases", "_blank", "noopener,noreferrer");
  });
});
