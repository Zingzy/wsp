// SPDX-License-Identifier: AGPL-3.0-only
// First-run wizard against a fixture wire: the fake api records calls and
// hands the test the event listener so golden.stage frames can be pushed by
// hand. No timers drive steps; every transition here comes from a frame or a
// resolved request.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoldenBuilderView, GoldenManifest, GoldenStage, GoldenVersion, WorkspaceView } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { getTerminals } from "../src/terminal/link.js";

class FakeRfb extends EventTarget {
  static instances: FakeRfb[] = [];
  viewOnly = false;
  scaleViewport = false;
  background = "";
  constructor(
    readonly target: HTMLElement,
    readonly url: string,
  ) {
    super();
    FakeRfb.instances.push(this);
  }
  disconnect() {}
  focus() {}
}
vi.mock("@novnc/novnc", () => ({ default: FakeRfb }));
// WebGL cannot exist under jsdom; the terminal falls back to the DOM renderer.
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): { dispose(): void } {
      return { dispose() {} };
    }
  },
}));

const { Shell } = await import("../src/App.js");
const { useStore } = await import("../src/protocol/store.js");

const STREAM = "wss://stream.example.test/m_builder";
const builder: GoldenBuilderView = { id: "m_builder", name: "default", kind: "desktop", createdAt: "2026-09-02T00:00:00Z", screen: { streamUrl: STREAM } };
const headless: GoldenBuilderView = { id: "m_headless", name: "default", kind: "sandbox", createdAt: "2026-09-02T00:00:00Z" };
const DAEMON_TOKEN = "wizard-daemon-token";
const version: GoldenVersion = { version: 1, snapshotId: "snap_golden-v1", baseTemplate: "default", kind: "desktop", setupSha: "x", createdAt: "t", smoke: { cmd: "claude --version", exitCode: 0 } };
const manifest: GoldenManifest = { head: 1, versions: [version] };
const first: WorkspaceView = { id: "ws_first", name: "first", machineId: "m_fork", phase: "running", golden: "snap_golden-v1", createdAt: "t" };

function fixture(opts: { golden?: GoldenManifest; workspaces?: WorkspaceView[]; builder?: GoldenBuilderView; daemonPort?: () => number } = {}) {
  let listener: ((e: ProtocolEvent) => void) | undefined;
  const api = {
    listWorkspaces: vi.fn(async () => opts.workspaces ?? []),
    getWorkspace: vi.fn(async () => first),
    createWorkspace: vi.fn(async () => first),
    createFromGoldenHead: vi.fn(async () => first),
    watchStatuses: vi.fn(async () => []),
    nap: vi.fn(async () => first),
    wake: vi.fn(async () => first),
    upgrade: vi.fn(async () => first),
    capabilities: vi.fn(async () => ({ liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true })),
    portReach: vi.fn(async (_id: string, port: number) => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, expiresAt: Date.now() + 3_600_000 })),
    daemonReach: vi.fn(async () => ({ url: "ws://127.0.0.1:1", expiresAt: 0 })),
    builderReach: vi.fn(async () => ({ url: `ws://127.0.0.1:${opts.daemonPort?.() ?? 1}`, expiresAt: Date.now() + 3_600_000, daemonToken: DAEMON_TOKEN })),
    startSession: vi.fn(async () => ({ id: "s1", workspaceId: "ws_first", harness: "claude", status: "running" as const })),
    listSessions: vi.fn(async () => []),
    sessionHistory: vi.fn(async () => []),
    subscribe: vi.fn((fn: (e: ProtocolEvent) => void) => {
      listener = fn;
      return () => {};
    }),
    getGolden: vi.fn(async () => opts.golden),
    prepareGolden: vi.fn(async () => opts.builder ?? builder),
    sealGolden: vi.fn(async () => ({ manifest, version })),
    listSnapshots: vi.fn(async () => ({ name: "default", head: null, versions: [] })),
    rollbackSnapshot: vi.fn(async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" as const })),
  } satisfies Api;
  // `listener` is the last subscriber, the wizard's; the store subscribes first on bind.
  const push = (e: ProtocolEvent) =>
    act(() => {
      listener?.(e);
    });
  const stage = (s: GoldenStage, detail?: string) => push({ type: "golden.stage", name: "default", stage: s, ...(detail !== undefined ? { detail } : {}) });
  return { api, stage, push };
}

beforeEach(() => {
  FakeRfb.instances = [];
  useStore.setState({ api: null, capabilities: null, workspaces: [], statuses: {}, costs: {}, spending: {}, toast: null, selectedId: null, sessions: {}, ready: false });
});
afterEach(cleanup);

async function mount(opts: Parameters<typeof fixture>[0] = {}, keys?: { anthropic: boolean }) {
  const f = fixture(opts);
  useStore.getState().bind(f.api);
  render(<Shell keys={keys} />);
  await waitFor(() => expect(f.api.getGolden).toHaveBeenCalled());
  return f;
}

describe("first run: wizard or rail", () => {
  it("renders the wizard and no rail when golden.get returns nothing", async () => {
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Prepare my machine" })).toBeDefined());
    expect(screen.queryByText("workspaces")).toBeNull();
  });

  it("renders the rail, not the wizard, the moment a golden exists", async () => {
    await mount({ golden: manifest, workspaces: [first] });
    await waitFor(() => expect(screen.getByText("workspaces")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Prepare my machine" })).toBeNull();
  });

  it("the key status line shows flags only, never values", async () => {
    await mount({}, { anthropic: false });
    await waitFor(() => expect(screen.getByTestId("key-anthropic").textContent).toBe("not found"));
    expect(screen.getByTestId("key-solari").textContent).toBe("found");
    expect(document.body.textContent).not.toMatch(/sk-ant|slr_live/);
  });

  it("says unknown for the anthropic key when the host did not say", async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId("key-anthropic").textContent).toBe("unknown"));
  });
});

describe("wizard steps follow the wire", () => {
  it("prepare stages advance the preparing step, the reply opens the hero screen, save waits for ready", async () => {
    const f = await mount();
    let resolvePrepare: (b: GoldenBuilderView) => void = () => {};
    f.api.prepareGolden.mockImplementationOnce(() => new Promise<GoldenBuilderView>(r => { resolvePrepare = r; }));
    await waitFor(() => screen.getByRole("button", { name: "Prepare my machine" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare my machine" }));
    expect(f.api.prepareGolden).toHaveBeenCalledWith("default");
    expect(screen.getByTestId("step").textContent).toBe("preparing");

    f.stage("creating", "desktop from default");
    expect(screen.getByTestId("stage-creating").getAttribute("data-state")).toBe("current");
    expect(screen.getByText("desktop from default")).toBeDefined();
    f.stage("installing-harness");
    expect(screen.getByTestId("stage-creating").getAttribute("data-state")).toBe("done");
    expect(screen.getByTestId("stage-installing-harness").getAttribute("data-state")).toBe("current");
    expect(FakeRfb.instances.length).toBe(0);

    await act(async () => {
      resolvePrepare(builder);
    });
    await waitFor(() => expect(screen.getByTestId("step").textContent).toBe("hero"));
    expect(FakeRfb.instances[0]?.url).toBe(STREAM);
    const save = screen.getByRole("button", { name: "Save as my golden image" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    f.stage("ready");
    expect(save.disabled).toBe(false);
  });

  it("a builder without a screen gets the terminal tab against its own reach, with one pty opened", async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), "wsp-wizard-inbox-"));
    let daemon: DaemonHandle | undefined;
    try {
      daemon = await startDaemon({ port: 0, token: DAEMON_TOKEN, inboxDir, portsSource: async () => [], portsIntervalMs: 1000 });
      const port = daemon.port;
      const f = await mount({ builder: headless, daemonPort: () => port });
      await waitFor(() => screen.getByRole("button", { name: "Prepare my machine" }));
      fireEvent.click(screen.getByRole("button", { name: "Prepare my machine" }));
      await waitFor(() => expect(screen.getByTestId("step").textContent).toBe("hero"));

      expect(FakeRfb.instances).toHaveLength(0);
      expect(screen.queryByText("this machine has no display")).toBeNull();
      await waitFor(() => expect(f.api.builderReach).toHaveBeenCalledWith("m_headless"));
      await waitFor(() => expect(daemon!.ptys.list()).toHaveLength(1), { timeout: 10_000 });
      expect(getTerminals("m_headless")?.status()).toBe("live");
      expect(screen.getByText("Save as my golden image")).toBeDefined();

      f.stage("ready");
      fireEvent.click(screen.getByRole("button", { name: "Save as my golden image" }));
      await waitFor(() => expect(screen.getByTestId("step").textContent).toBe("sealing"));
      expect(getTerminals("m_headless")).toBeNull();
    } finally {
      await daemon?.close();
      rmSync(inboxDir, { recursive: true, force: true });
    }
  }, 20_000);

  it("the hero step says an idle builder is killed after six hours, in one line", async () => {
    const f = await mount();
    await waitFor(() => screen.getByRole("button", { name: "Prepare my machine" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare my machine" }));
    await waitFor(() => expect(screen.getByTestId("step").textContent).toBe("hero"));
    const note = screen.getByText(/six hours/);
    expect(note.textContent).toBe("Take your time, but a machine idle for six hours is killed and this setup is lost.");
    expect(note.textContent).not.toMatch(/pause|shut down/);
    expect(f.api.prepareGolden).toHaveBeenCalledTimes(1);
  });

  it("ignores golden.stage frames for a golden this wizard did not prepare", async () => {
    const f = await mount();
    f.api.prepareGolden.mockImplementationOnce(() => new Promise<GoldenBuilderView>(() => {}));
    await waitFor(() => screen.getByRole("button", { name: "Prepare my machine" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare my machine" }));
    f.stage("creating");
    f.push({ type: "golden.stage", name: "nightly", stage: "failed", detail: "someone else's build" });
    f.push({ type: "golden.stage", name: "nightly", stage: "ready" });
    expect(screen.getByTestId("step").textContent).toBe("preparing");
    expect(screen.getByTestId("stage-creating").getAttribute("data-state")).toBe("current");
  });

  it("a failed stage shows start over with the detail, and start over returns to welcome", async () => {
    const f = await mount();
    f.api.prepareGolden.mockImplementationOnce(() => new Promise<GoldenBuilderView>(() => {}));
    await waitFor(() => screen.getByRole("button", { name: "Prepare my machine" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare my machine" }));
    f.stage("creating");
    f.stage("failed", "golden setup failed (exit 1): curl: no route");
    expect(screen.getByTestId("step").textContent).toBe("failed");
    expect(screen.getByText("golden setup failed (exit 1): curl: no route")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("button", { name: "Prepare my machine" })).toBeDefined();
  });

  it("a rejected prepare request is a failure too", async () => {
    const f = await mount();
    f.api.prepareGolden.mockRejectedValueOnce(new Error("this runtime has no golden recipe"));
    await waitFor(() => screen.getByRole("button", { name: "Prepare my machine" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare my machine" }));
    await waitFor(() => expect(screen.getByTestId("step").textContent).toBe("failed"));
    expect(screen.getByText("this runtime has no golden recipe")).toBeDefined();
  });

  it("seal runs on the wire, creates one workspace from the golden head, and lands on the rail with it selected", async () => {
    const f = await mount();
    await waitFor(() => screen.getByRole("button", { name: "Prepare my machine" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare my machine" }));
    await waitFor(() => expect(screen.getByTestId("step").textContent).toBe("hero"));
    f.stage("ready");

    let resolveSeal: (v: { manifest: GoldenManifest; version: GoldenVersion }) => void = () => {};
    f.api.sealGolden.mockImplementationOnce(() => new Promise(r => { resolveSeal = r; }));
    fireEvent.click(screen.getByRole("button", { name: "Save as my golden image" }));
    expect(f.api.sealGolden).toHaveBeenCalledWith("m_builder");
    expect(screen.getByTestId("step").textContent).toBe("sealing");
    f.stage("snapshotting", "golden-v1");
    f.stage("smoke-forking", "claude --version");
    expect(screen.getByTestId("stage-smoke-forking").getAttribute("data-state")).toBe("current");
    f.stage("sealed", "v1");
    expect(f.api.createFromGoldenHead).not.toHaveBeenCalled();

    await act(async () => {
      resolveSeal({ manifest, version });
    });
    await waitFor(() => expect(f.api.createFromGoldenHead).toHaveBeenCalledTimes(1));
    act(() => {
      f.api.subscribe.mock.calls[0]![0]({ type: "workspace.created", workspace: first });
    });
    await waitFor(() => expect(screen.getByText("workspaces")).toBeDefined());
    expect(useStore.getState().selectedId).toBe("ws_first");
    expect(screen.queryByRole("button", { name: "Save as my golden image" })).toBeNull();
  });
});
