// SPDX-License-Identifier: AGPL-3.0-only
// The screen surface against a fake RFB class: no socket, no noVNC wire. The
// fake records construction and lets tests fire noVNC's CustomEvents by hand.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceStatus } from "@wsp/protocol";

class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = [];
  viewOnly = false;
  scaleViewport = false;
  background = "";
  disconnected = false;
  focused = 0;
  constructor(
    readonly target: HTMLElement,
    readonly url: string,
  ) {
    super();
    FakeRfb.instances.push(this);
  }
  disconnect() {
    this.disconnected = true;
  }
  focus() {
    this.focused += 1;
  }
  fire(type: string, detail: unknown = {}) {
    act(() => {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    });
  }
}

vi.mock("@novnc/novnc", () => ({ default: FakeRfb }));

const { ScreenSurface } = await import("../src/screen/ScreenSurface.js");
const { useStore } = await import("../src/protocol/store.js");

const WS = "ws_screen001";
const URL = "wss://stream.example.test/desktop";

function seedStatus(extra: Partial<WorkspaceStatus> = {}) {
  const status: WorkspaceStatus = {
    id: WS,
    name: "desk",
    machineId: "m_desk",
    phase: "running",
    golden: "snap_g",
    createdAt: "2026-09-01T00:00:00Z",
    machineState: "running",
    reach: { state: "reachable" },
    size: { cpu: 2, memMb: 4096 },
    rateUsdPerHour: 0.1,
  };
  useStore.setState({ statuses: { [WS]: { ...status, ...extra } } });
}

beforeEach(() => {
  FakeRfb.instances = [];
  useStore.setState({ statuses: {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("screen surface", () => {
  it("shows the no-display state when no stream url resolves and never opens a client", () => {
    seedStatus();
    render(<ScreenSurface workspaceId={WS} />);
    expect(screen.getByText("This machine has no display")).toBeDefined();
    expect(FakeRfb.instances.length).toBe(0);
  });

  it("connects to the injected url and reports live once the handshake finishes", () => {
    render(<ScreenSurface workspaceId={WS} streamUrl={URL} />);
    expect(FakeRfb.instances.length).toBe(1);
    const rfb = FakeRfb.instances[0]!;
    expect(rfb.url).toBe(URL);
    expect(rfb.scaleViewport).toBe(true);
    expect(screen.getByText("connecting")).toBeDefined();
    rfb.fire("connect");
    expect(screen.queryByText("connecting")).toBeNull();
    expect(screen.getByTitle("live")).toBeDefined();
  });

  it("reads the screen stream carried on the workspace status", () => {
    seedStatus({ screen: { streamUrl: URL } });
    render(<ScreenSurface workspaceId={WS} />);
    expect(FakeRfb.instances[0]?.url).toBe(URL);
  });

  it("disconnects the client on unmount", () => {
    const view = render(<ScreenSurface workspaceId={WS} streamUrl={URL} />);
    const rfb = FakeRfb.instances[0]!;
    rfb.fire("connect");
    view.unmount();
    expect(rfb.disconnected).toBe(true);
  });

  it("starts view-only and toggles into control mode and back", () => {
    render(<ScreenSurface workspaceId={WS} streamUrl={URL} />);
    const rfb = FakeRfb.instances[0]!;
    rfb.fire("connect");
    expect(rfb.viewOnly).toBe(true);
    const toggle = screen.getByRole("switch", { name: "control" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(rfb.viewOnly).toBe(false);
    expect(rfb.focused).toBe(1);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(rfb.viewOnly).toBe(true);
  });

  it("reconnects with a fresh client after an unclean drop", () => {
    vi.useFakeTimers();
    render(<ScreenSurface workspaceId={WS} streamUrl={URL} />);
    const first = FakeRfb.instances[0]!;
    first.fire("connect");
    first.fire("disconnect", { clean: false });
    expect(screen.getByText("reconnecting")).toBeDefined();
    expect(FakeRfb.instances.length).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeRfb.instances.length).toBe(2);
    expect(FakeRfb.instances[1]!.url).toBe(URL);
  });

  it("resets the backoff once a reconnect succeeds", () => {
    vi.useFakeTimers();
    render(<ScreenSurface workspaceId={WS} streamUrl={URL} />);
    FakeRfb.instances[0]!.fire("connect");
    FakeRfb.instances[0]!.fire("disconnect", { clean: false });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const second = FakeRfb.instances[1]!;
    second.fire("connect");
    second.fire("disconnect", { clean: false });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeRfb.instances.length).toBe(3);
  });

  it("stops retrying after a security failure and says why", () => {
    vi.useFakeTimers();
    render(<ScreenSurface workspaceId={WS} streamUrl={URL} />);
    const rfb = FakeRfb.instances[0]!;
    rfb.fire("securityfailure", { status: 1, reason: "bad ticket" });
    rfb.fire("disconnect", { clean: false });
    expect(screen.getByText(/bad ticket/)).toBeDefined();
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(FakeRfb.instances.length).toBe(1);
  });
});
