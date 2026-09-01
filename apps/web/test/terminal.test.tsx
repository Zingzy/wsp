// SPDX-License-Identifier: AGPL-3.0-only
// Terminal tab against the real daemon: startDaemon in-process, the reach
// client as the wire, jsdom for the component. WebGL cannot exist under
// jsdom, so that addon is mocked; real rendering is the browser pass's job.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTab } from "../src/tabs/TerminalTab.js";
import { WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import { boot, teardown, WS_ID } from "./terminal-harness.js";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): { dispose(): void } {
      return { dispose() {} };
    }
  },
}));

afterEach(async () => {
  cleanup();
  await teardown();
});

describe("WorkspaceTerminals", () => {
  it("replays scrollback into a sink bound after the output happened", async () => {
    const { wt } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    wt.write(tab.ptyId, "echo replay-mark-$((40 + 2))\r");

    const live: string[] = [];
    const un1 = wt.bind(tab.ptyId, { data: d => live.push(d), reset: () => {} });
    await waitFor(() => expect(live.join("")).toContain("replay-mark-42"), { timeout: 10_000 });
    un1();

    // A sink bound later gets the same bytes back from the mirror, synchronously.
    const replayed: string[] = [];
    const un2 = wt.bind(tab.ptyId, { data: d => replayed.push(d), reset: () => {} });
    expect(replayed.join("")).toContain("replay-mark-42");
    un2();
  }, 15_000);

  it("resize propagates to the daemon pty", async () => {
    const { wt, daemon } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    wt.resize(tab.ptyId, 100, 40);
    await waitFor(() => {
      const p = daemon.ptys.list().find(x => x.id === tab.ptyId);
      expect(p).toMatchObject({ cols: 100, rows: 40 });
    });
  }, 15_000);

  it("unbinding keeps the pty alive; close kills it", async () => {
    const { wt, daemon } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    const un = wt.bind(tab.ptyId, { data: () => {}, reset: () => {} });
    un();
    expect(daemon.ptys.list()).toHaveLength(1);
    expect(daemon.ptys.list()[0]!.exited).toBe(false);

    await wt.close(tab.ptyId);
    expect(daemon.ptys.list()).toHaveLength(0);
    expect(wt.tabs()).toHaveLength(0);
  }, 15_000);

  it("marks the tab exited when the pty's process ends", async () => {
    const { wt } = await boot();
    const tab = await wt.open({ shell: "/bin/sh" });
    const seen: string[] = [];
    const un = wt.bind(tab.ptyId, { data: d => seen.push(d), reset: () => {} });
    wt.write(tab.ptyId, "exit\r");
    await waitFor(() => expect(wt.tabs()[0]).toMatchObject({ exited: true }), { timeout: 10_000 });
    expect(seen.join("")).toContain("[process exited]");
    un();
  }, 15_000);

  it("a pty that cannot re-attach is marked lost while the rest still re-attach", async () => {
    const attaches: string[] = [];
    let nextPty = 1;
    let reattaching = false;
    const wire: TerminalWire = {
      request: async (op, params = {}) => {
        if (op === "pty.create") return { ok: true, ptyId: `p${nextPty++}` };
        if (op === "pty.attach") {
          if (reattaching && params["ptyId"] === "p1") throw new Error("no such pty: p1");
          attaches.push(String(params["ptyId"]));
        }
        return { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await wt.open();
    await wt.open();
    attaches.length = 0;
    reattaching = true;

    wt.feedStatus("connecting");
    wt.feedStatus("live");
    await waitFor(() => expect(attaches).toEqual(["p2"])); // p1 failed, p2 still re-attached
    expect(wt.tabs().find(t => t.ptyId === "p1")).toMatchObject({ exited: true });
    expect(wt.tabs().find(t => t.ptyId === "p2")).toMatchObject({ exited: false });
  });

  it("a connection dying mid-reattach does not mark ptys lost", async () => {
    let nextPty = 1;
    const attaches: string[] = [];
    let pendingReject: ((e: Error) => void) | null = null;
    let deferNext = false;
    const wire: TerminalWire = {
      request: (op, params = {}) => {
        if (op === "pty.create") return Promise.resolve({ ok: true, ptyId: `p${nextPty++}` });
        if (op === "pty.attach") {
          attaches.push(String(params["ptyId"]));
          if (deferNext) {
            deferNext = false;
            return new Promise((_, reject) => {
              pendingReject = reject;
            });
          }
        }
        return Promise.resolve({ ok: true });
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    await wt.open();
    await wt.open();
    attaches.length = 0;

    deferNext = true; // p1's re-attach hangs until the socket death rejects it
    wt.feedStatus("connecting");
    wt.feedStatus("live");
    await waitFor(() => expect(pendingReject).not.toBeNull());
    wt.feedStatus("connecting"); // the connection died again mid-ritual
    pendingReject!(new Error("connection lost"));
    await new Promise(r => setTimeout(r, 25));
    expect(attaches).toEqual(["p1"]); // the ritual stopped, p2 was not attempted
    expect(wt.tabs().every(t => !t.exited)).toBe(true); // nobody wrongly marked lost

    wt.feedStatus("live"); // recovery: the next live transition re-runs the full ritual
    await waitFor(() => expect(attaches).toEqual(["p1", "p1", "p2"]));
  });

  it("a reconnect re-attaches every pty and resets bound sinks", async () => {
    const ops: string[] = [];
    let nextPty = 1;
    const wire: TerminalWire = {
      request: async op => {
        ops.push(op);
        return op === "pty.create" ? { ok: true, ptyId: `p${nextPty++}` } : { ok: true };
      },
    };
    const wt = new WorkspaceTerminals(wire);
    wt.feedStatus("live");
    const a = await wt.open();
    await wt.open();
    wt.feedEvent({ type: "pty.data", ptyId: a.ptyId, data: "pre-cut output" });

    let resets = 0;
    const un = wt.bind(a.ptyId, { data: () => {}, reset: () => resets++ });
    ops.length = 0;
    wt.feedStatus("connecting");
    wt.feedStatus("live");
    await waitFor(() => expect(ops.filter(o => o === "pty.attach")).toHaveLength(2));
    expect(resets).toBe(1);

    // The mirror was invalidated: replay now comes from the daemon, not from us.
    const late: string[] = [];
    wt.bind(a.ptyId, { data: d => late.push(d), reset: () => {} })();
    expect(late).toEqual([]);
    un();
  });
});

describe("TerminalTab", () => {
  it("renders a placeholder when no terminal link exists for the workspace", () => {
    render(<TerminalTab workspaceId="ws_unlinked" />);
    screen.getByText(/no terminal link/);
  });

  it("auto-opens one pty, parks on unmount without killing it, reuses it on remount", async () => {
    const { wt, daemon } = await boot();
    const view = render(<TerminalTab workspaceId={WS_ID} />);
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(1), { timeout: 10_000 });
    await screen.findByRole("tab");
    await waitFor(() => expect(wt.sinkCount()).toBe(1));
    expect(document.querySelector(".xterm")).not.toBeNull();

    view.unmount(); // tab-away
    expect(wt.sinkCount()).toBe(0);
    expect(document.querySelector(".xterm")).toBeNull();
    expect(daemon.ptys.list()).toHaveLength(1); // detach, not kill
    expect(daemon.ptys.list()[0]!.exited).toBe(false);

    render(<TerminalTab workspaceId={WS_ID} />); // tab back
    await waitFor(() => expect(wt.sinkCount()).toBe(1));
    expect(daemon.ptys.list()).toHaveLength(1); // reused, not re-created
  }, 15_000);

  it("the + button opens a second terminal with its own pty id", async () => {
    const { wt, daemon } = await boot();
    render(<TerminalTab workspaceId={WS_ID} />);
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(1), { timeout: 10_000 });
    fireEvent.click(screen.getByLabelText("new terminal"));
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(2), { timeout: 10_000 });
    expect(await screen.findAllByRole("tab")).toHaveLength(2);
    const ids = daemon.ptys.list().map(p => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(wt.tabs().map(t => t.ptyId)).toEqual(ids);
  }, 15_000);

  it("closing the last terminal stays closed instead of respawning", async () => {
    const { daemon } = await boot();
    render(<TerminalTab workspaceId={WS_ID} />);
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(1), { timeout: 10_000 });
    fireEvent.click(screen.getByLabelText(/^close /));
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(0), { timeout: 10_000 });
    await new Promise(r => setTimeout(r, 250)); // the auto-open effect must not refire
    expect(daemon.ptys.list()).toHaveLength(0);
    screen.getByText("no terminals");
  }, 15_000);

  it("renders the connection state: live dot, reconnecting text, reauth banner", async () => {
    const { wt } = await boot();
    render(<TerminalTab workspaceId={WS_ID} />);
    await screen.findByTitle("connected");

    act(() => wt.feedStatus("connecting"));
    screen.getByText("reconnecting");
    expect(screen.queryByTitle("connected")).toBeNull();

    act(() => wt.feedStatus("reauth-needed"));
    screen.getByText("auth expired");
    screen.getByText(/rejected this workspace/);

    act(() => wt.feedStatus("live"));
    await screen.findByTitle("connected");
  }, 15_000);
});
