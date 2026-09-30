// SPDX-License-Identifier: AGPL-3.0-only
// A machine's life never reaches the notices stack; the thread on screen says, in plain words, only what the person
// must act on. What a bring back answered is still said once.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_RESTART_FAILED, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, NO_NODE_LINE, type BringBackResult, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { getLive, resetLive } from "../src/machine/live.js";
import { useNotices } from "../src/notices/store.js";
import { broughtBackLine, machineLine, useWorkspaceLineNotices } from "../src/notices/workspaceLines.js";
import { useStore } from "../src/protocol/store.js";
import { statusOf } from "./workspace-status.js";

const view = (id: string, name: string, over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id,
  name,
  machineId: `m_${id}`,
  project: { id: "pr_1", name: "spoo", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-26T10:00:00.000Z",
  ...over,
});

function Harness() {
  useWorkspaceLineNotices();
  return null;
}

const texts = (): string[] => useNotices.getState().notices.map(n => n.text);

beforeEach(() => {
  useNotices.setState({ notices: [], toasts: [], unread: 0 });
  useStore.setState({ places: [], workspaces: [], statuses: {}, sessions: {}, broughtBack: {} } as never);
});
afterEach(cleanup);

describe("a machine's life never pops as a notice", () => {
  it("says nothing on the stack while the helper updates or fails to, while a machine runs and does not answer, or while memory runs near full", () => {
    const GiB = 1024 ** 3;
    resetLive();
    const api = view("ws_a", "api");
    const mac = view("ws_m", "mac", { kind: "local", machineId: "local" });
    const box = view("ws_b", "box");
    useStore.setState({
      workspaces: [api, mac, box],
      statuses: {
        ws_a: statusOf(api, { daemonNote: DAEMON_UPDATING }),
        ws_m: statusOf(mac, { reach: { state: "no-daemon" }, daemonNote: DAEMON_RESTART_FAILED }),
        ws_b: statusOf(box, { reach: { state: "unsupported" }, daemonRefusedAt: { machineId: "m_ws_b", at: "2026-09-30T10:00:00Z", why: NO_NODE_LINE } }),
      },
    } as never);
    render(<Harness />);
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
      getLive("ws_a").feedStatus("connecting");
    });
    expect(useNotices.getState().notices).toEqual([]);
  });
});

describe("the one line the thread on screen says about its machine", () => {
  const GiB = 1024 ** 3;
  const project = (status: Partial<WorkspaceStatus>, over: Partial<WorkspaceView> = {}) => {
    const workspace = view("ws_a", "api", over);
    const st = statusOf(workspace, status);
    return { id: "ws_a", workspace, status: st, reach: st.reach.state };
  };

  it("says what a machine lacks for wsp in plain words, since only the person can put it there", () => {
    expect(machineLine(project({ reach: { state: "unsupported" }, daemonRefusedAt: { machineId: "m_ws_a", at: "2026-09-30T10:00:00Z", why: NO_NODE_LINE } }, { kind: "local" }), undefined)).toBe("This machine has no Node 22");
  });

  it("says a drop with memory near full", () => {
    expect(machineLine(project({ reach: { state: "unreachable" } }), { used: 3.59 * GiB, total: 3.94 * GiB } as never)).toBe("Out of memory, 3.6 of 3.9 GB");
  });

  it("says nothing the person cannot act on: the helper updating or failing to, a machine that runs and does not answer, a paused one", () => {
    for (const status of [{ daemonNote: DAEMON_UPDATING }, { daemonNote: DAEMON_UPDATE_FAILED }, { reach: { state: "no-daemon" as const } }]) expect(machineLine(project(status), undefined), JSON.stringify(status)).toBeNull();
    expect(machineLine(project({ reach: { state: "unsupported" }, daemonRefusedAt: { machineId: "m_ws_a", at: "2026-09-30T10:00:00Z", why: NO_NODE_LINE } }, { kind: "local", phase: "pausing" }), undefined)).toBeNull();
  });
});

describe("what a bring back answered", () => {
  it("says what a bring back answered once, when the answer arrives, with the host's note for a push that opened no pull request", () => {
    const api = view("ws_a", "api");
    useStore.setState({ workspaces: [api], statuses: { ws_a: statusOf(api) } } as never);
    render(<Harness />);
    expect(texts()).toEqual([]);
    const back = { branch: "agent/pricing-page", base: "main", ahead: 1, uncommitted: 0, stat: [], note: "no gh on this computer" } as unknown as BringBackResult;
    act(() => useStore.setState({ broughtBack: { ws_a: back } } as never));
    expect(broughtBackLine(back)).toBe("agent/pricing-page pushed, no pull request: no gh on this computer");
    expect(useNotices.getState().notices).toMatchObject([{ kind: "done", text: broughtBackLine(back), where: "api" }]);
    act(() => useStore.setState({ statuses: { ws_a: statusOf(api, { rateUsdPerHour: 0.2 }) } } as never));
    expect(texts()).toHaveLength(1);
  });
});
