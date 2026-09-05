// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortProbeView } from "@wsp/protocol";
import { useBrowserTabs } from "../../browser/tabs.js";
import { type Api } from "../../protocol/client.js";
import { useStore } from "../../protocol/store.js";
import { BrowserSurface } from "./BrowserSurface.js";

const WS = "ws_pane";
const HOST = "m1-5173.preview.example";
const ROUTE = `https://${HOST}/?pt_token=edge`;
const VITE_BLOCKED = `Blocked request. This host (${HOST}) is not allowed. To allow this host, add it to server.allowedHosts`;

function fakeApi(answers: PortProbeView[]): { api: Api; probes: () => number } {
  let probes = 0;
  const api = {
    subscribe: () => () => {},
    portReach: async () => ({ url: ROUTE, expiresAt: Date.now() + 3_600_000 }),
    portProbe: async () => {
      const answer = answers[Math.min(probes, answers.length - 1)]!;
      probes++;
      return answer;
    },
  } as unknown as Api;
  return { api, probes: () => probes };
}

async function mountOn(port: number, api: Api) {
  useStore.setState({ api });
  const tabId = useBrowserTabs.getState().createTab(WS, port);
  const view = render(<BrowserSurface workspaceId={WS} surface={{ id: `browser:${tabId}`, kind: "preview", resourceId: tabId }} />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return { ...view, tabId };
}

beforeEach(() => {
  useBrowserTabs.setState({ byWorkspaceId: {} });
});
afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
});

describe("BrowserSurface host-check refusal", () => {
  it("frames the route and explains nothing when the port answers 200", async () => {
    const { api, probes } = fakeApi([{ status: 200, body: "<!doctype html>" }]);
    const { container } = await mountOn(5173, api);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(ROUTE);
    expect(screen.queryByText(/refused the preview host/)).toBeNull();
    expect(probes()).toBe(1);
  });

  it("replaces the frame with the sentence and the fix when Vite's host check answers 403", async () => {
    const { api } = fakeApi([{ status: 403, body: VITE_BLOCKED }]);
    const { container } = await mountOn(5173, api);
    expect(screen.getByText(":5173 refused the preview host")).toBeTruthy();
    expect(screen.getByText(/server\.allowedHosts/).textContent).toContain(HOST);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("probes again on reload and frames the page once the server accepts the host", async () => {
    const { api, probes } = fakeApi([{ status: 403, body: VITE_BLOCKED }, { status: 200, body: "<!doctype html>" }]);
    const { container } = await mountOn(5173, api);
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(probes()).toBe(2);
    expect(screen.queryByText(":5173 refused the preview host")).toBeNull();
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(ROUTE);
  });

  it("keeps the frame when the probe itself fails: the frame is the truth then", async () => {
    const api = {
      subscribe: () => () => {},
      portReach: async () => ({ url: ROUTE, expiresAt: Date.now() + 3_600_000 }),
      portProbe: vi.fn(async () => {
        throw new Error("edge unreachable");
      }),
    } as unknown as Api;
    const { container } = await mountOn(5173, api);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(ROUTE);
    expect(screen.queryByText(/refused/)).toBeNull();
  });
});
