// SPDX-License-Identifier: AGPL-3.0-only
// One bar per workspace with a sign-in page waiting: the store takes only
// http(s) URLs, the bar names the workspace, Open goes through window.open
// (the desktop shell turns that into the default browser), Dismiss drops it.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fireEvent, render, screen } from "@testing-library/react";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import type { WorkspaceView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { SignInBanner } from "../src/shell/SignInBanner.js";
import { useSignInStore } from "../src/shell/signInStore.js";
import { wireTerminals } from "../src/terminal/wiring.js";

const execFileAsync = promisify(execFile);
const TOKEN = "banner-token";
const URL_A = "https://dash.example.com/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Fcb&state=S";

const view = (id: string, name: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00Z" });

beforeEach(() => {
  useSignInStore.setState({ byWorkspaceId: {} });
  useStore.setState({ workspaces: [view("ws1", "task-1"), view("ws2", "task-2")] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sign-in store", () => {
  it("keeps one page per workspace, http(s) only", () => {
    const { announce } = useSignInStore.getState();
    announce("ws1", URL_A);
    announce("ws1", "https://github.com/login/device");
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share"]) announce("ws2", url);
    expect(useSignInStore.getState().byWorkspaceId).toEqual({ ws1: { url: "https://github.com/login/device" } });
    announce("ws2", "HTTPS://EXAMPLE.COM/A");
    expect(useSignInStore.getState().byWorkspaceId["ws2"]).toEqual({ url: "HTTPS://EXAMPLE.COM/A" });
    for (const url of ["https://%", "https://[::1", "https://exa%mple.com/x"]) announce("ws1", url);
    expect(useSignInStore.getState().byWorkspaceId["ws1"]).toEqual({ url: "https://github.com/login/device" });
  });
});

describe("SignInBanner", () => {
  it("a bar for a URL that does not parse renders without throwing and names no host", () => {
    useSignInStore.setState({ byWorkspaceId: { ws1: { url: "https://%" } } });
    render(<SignInBanner />);
    expect(screen.getByRole("alert").textContent).toContain("A sign-in page is ready on task-1");
  });

  it("renders nothing with no page waiting", () => {
    render(<SignInBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the workspace, opens the page on click through window.open, and dismisses", () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    useSignInStore.getState().announce("ws1", URL_A);
    useSignInStore.getState().announce("ws2", "https://github.com/login/device");
    render(<SignInBanner />);
    const bars = screen.getAllByRole("alert");
    expect(bars).toHaveLength(2);
    expect(bars[0]!.textContent).toContain("A sign-in page for dash.example.com is ready on task-1");
    expect(bars[1]!.textContent).toContain("A sign-in page for github.com is ready on task-2");
    // The click is never blind (the host shows), and never leaks the flow (path and query only on hover).
    expect(screen.getByTestId("sign-in-banner").textContent).not.toContain("redirect_uri");
    expect(screen.getByTestId("sign-in-banner").textContent).not.toContain("state=");
    expect(bars[0]!.getAttribute("title")).toBe(URL_A);

    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    expect(open).toHaveBeenCalledWith(URL_A, "_blank", "noopener,noreferrer");
    expect(screen.getAllByRole("alert")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("task-2");
    expect(useSignInStore.getState().byWorkspaceId).toEqual({ ws2: { url: "https://github.com/login/device" } });
  });
});

describe("wiring feeds browser.open from the daemon link into the store", () => {
  let daemon: DaemonHandle | undefined;
  let dir: string | undefined;
  let unwire: (() => void) | undefined;
  afterEach(async () => {
    unwire?.();
    await daemon?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    unwire = daemon = dir = undefined;
  });

  it("a shim post on the guest becomes a bar for that workspace", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-banner-"));
    const sockPath = join(dir, "open.sock");
    daemon = await startDaemon({ port: 0, token: TOKEN, openSocketPath: sockPath, portsSource: async () => [] });
    const workspaces = [view("ws1", "task-1")];
    const api = {
      listWorkspaces: async () => workspaces,
      daemonReach: async () => ({ url: `ws://127.0.0.1:${daemon!.port}`, expiresAt: Date.now() + 3_600_000, daemonToken: TOKEN }),
      subscribe: () => () => {},
    } as unknown as Api;
    useStore.setState({ api, workspaces });
    unwire = wireTerminals(useStore, { heartbeatMs: 60_000 });
    const deadline = Date.now() + 5000;
    while (useSignInStore.getState().byWorkspaceId["ws1"] === undefined) {
      if (Date.now() > deadline) throw new Error("no bar within 5 s");
      await execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sockPath, "-X", "POST", "--data-binary", URL_A, "http://wsp/open"]);
      await new Promise(r => setTimeout(r, 100));
    }
    expect(useSignInStore.getState().byWorkspaceId).toEqual({ ws1: { url: URL_A } });

    // The workspace is deleted: its bar goes with it instead of outliving it under an id.
    useStore.setState({ workspaces: [] });
    expect(useSignInStore.getState().byWorkspaceId).toEqual({});
  });
});
