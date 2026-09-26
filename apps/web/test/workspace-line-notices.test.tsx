// SPDX-License-Identifier: AGPL-3.0-only
// The lines a workspace's row used to carry reach the notices stack with the same words: the daemon note, a daemon
// that is not there, a drop with memory near full, and what a bring back answered.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DAEMON_UPDATING, type BringBackResult, type WorkspaceView } from "@wsp/protocol";
import { getLive, resetLive } from "../src/machine/live.js";
import { useNotices } from "../src/notices/store.js";
import { broughtBackLine, useWorkspaceLineNotices } from "../src/notices/workspaceLines.js";
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
  useStore.setState({ workspaces: [], statuses: {}, sessions: {}, broughtBack: {} } as never);
});
afterEach(cleanup);

describe("a workspace's lines on the notices stack", () => {
  it("says what the runtime is doing to a machine's daemon while it does it, keyed, and ends it once it clears", () => {
    const api = view("ws_a", "api");
    useStore.setState({ workspaces: [api], statuses: { ws_a: statusOf(api, { daemonNote: DAEMON_UPDATING }) } } as never);
    render(<Harness />);
    const notice = useNotices.getState().notices.find(n => n.text === DAEMON_UPDATING)!;
    expect(notice).toMatchObject({ kind: "note", where: "api", key: "line:ws_a:daemon" });
    act(() => useStore.setState({ statuses: { ws_a: statusOf(api, { daemonNote: DAEMON_UPDATING }) } } as never));
    expect(texts().filter(t => t === DAEMON_UPDATING)).toHaveLength(1);
    act(() => useStore.setState({ statuses: { ws_a: statusOf(api) } } as never));
    expect(texts()).not.toContain(DAEMON_UPDATING);
  });

  it("says a daemon that is not answering in the words the row used", () => {
    const mac = view("ws_m", "mac", { kind: "local", machineId: "local" });
    useStore.setState({ workspaces: [mac], statuses: { ws_m: statusOf(mac, { reach: { state: "no-daemon" } }) } } as never);
    render(<Harness />);
    expect(useNotices.getState().notices.find(n => n.key === "line:ws_m:daemon-gone")).toMatchObject({ kind: "error", text: "no daemon answering", where: "mac" });
  });

  it("says a drop with memory near full in the row's own short form, and ends it when the link is back", () => {
    const GiB = 1024 ** 3;
    resetLive();
    const api = view("ws_a", "api");
    useStore.setState({ workspaces: [api], statuses: { ws_a: statusOf(api, { reach: { state: "unreachable" } }) } } as never);
    render(<Harness />);
    act(() => {
      getLive("ws_a").feedStatus("live");
      getLive("ws_a").feedSample({ type: "sys.sample", cpu: 99, load1: 6.4, mem: { used: 3.59 * GiB, total: 3.94 * GiB }, disk: { used: 1, total: 10 }, at: 1 });
    });
    expect(texts()).toEqual([]);
    act(() => getLive("ws_a").feedStatus("connecting"));
    expect(useNotices.getState().notices.find(n => n.key === "line:ws_a:memory")).toMatchObject({ kind: "error", text: "out of memory, 3.6 of 3.9 GB", where: "api" });
    act(() => getLive("ws_a").feedStatus("live"));
    expect(texts()).toEqual([]);
  });

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
