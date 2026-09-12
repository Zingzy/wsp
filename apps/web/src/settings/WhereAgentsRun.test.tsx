// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlaceView } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { WhereAgentsRun } from "./WhereAgentsRun.js";

const HERE: PlaceView = { id: "here", kind: "computer", name: "This Mac", default: false, shape: { cpu: 8, memMb: 16 * 1024 }, diskFreeBytes: 210 * 1024 ** 3, docker: false, present: true };
const HETZNER: PlaceView = {
  id: "p_1",
  kind: "computer",
  name: "hetzner",
  default: true,
  os: "Ubuntu 24.04",
  shape: { cpu: 2, memMb: 4 * 1024 },
  diskFreeBytes: 38 * 1024 ** 3,
  docker: true,
  present: true,
  joinedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  lastSeenAt: new Date(Date.now() - 4_000).toISOString(),
  workspaceId: "ws_fix",
};
const LAPTOP: PlaceView = { ...HETZNER, id: "p_2", name: "old-macbook", default: false, os: "macOS 15.6", shape: { cpu: 4, memMb: 8 * 1024 }, diskFreeBytes: 91 * 1024 ** 3, docker: false, present: false, lastSeenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), workspaceId: "ws_old" };
const ASCII: PlaceView = { id: "box", kind: "provider", name: "ascii", default: false, shape: { cpu: 2, memMb: 4 * 1024 }, diskFreeBytes: 40 * 1024 ** 3, rateUsdPerHour: 0.018 };

const workspace = (id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, name, machineId: "local", phase: "running", kind: "local", golden: "", createdAt: new Date().toISOString(), home: "/Users/dev", ...extra });

function mount(places: readonly PlaceView[], removed: string[] = []) {
  const api = {
    subscribe: () => () => {},
    places: async () => [...places],
    removePlace: async (placeId: string) => {
      removed.push(placeId);
      return { removed: true, swept: [], dropped: [] };
    },
  } as unknown as Api;
  useStore.setState({
    api,
    workspaces: [workspace("ws_here", "this-mac"), workspace("ws_fix", "spoo-fix", { kind: "ssh", machineId: "place:p_1" }), workspace("ws_api", "api", { kind: "cloud", machineId: "fk_1" })] as never,
    sessions: { ws_fix: [{ id: "s1" }, { id: "s2" }], ws_api: [{ id: "s3" }] } as never,
  });
  return render(<WhereAgentsRun />);
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};

const row = (container: HTMLElement, id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-k="place-row"][data-place="${id}"]`)!;

afterEach(() => {
  cleanup();
  useStore.setState({ api: null, workspaces: [], sessions: {} });
});

describe("the computers table", () => {
  it("draws the four columns and one row per computer and provider, this computer first", async () => {
    const { container } = mount([HERE, HETZNER, LAPTOP, ASCII]);
    await settle();
    const heads = [...container.querySelectorAll("th")].map(th => th.textContent);
    expect(heads.slice(0, 4)).toEqual(["Computer", "Size", "Disk free", "Workspaces"]);
    const rows = [...container.querySelectorAll('[data-k="place-row"]')].map(r => r.getAttribute("data-place"));
    expect(rows).toEqual(["here", "p_1", "p_2", "box"]);
  });

  it("puts each row's state word in the slot after its name", async () => {
    const { container } = mount([HERE, HETZNER, LAPTOP, ASCII]);
    await settle();
    expect(within(row(container, "here")).getByText((_, el) => el?.getAttribute("data-k") === "state")!.textContent).toBe("");
    expect(within(row(container, "p_1")).getByText("default")).toBeTruthy();
    expect(within(row(container, "p_2")).getByText("offline · 2 h")).toBeTruthy();
  });

  it("counts the workspaces standing on each row and says what stops another one", async () => {
    const { container } = mount([HERE, HETZNER, LAPTOP, ASCII]);
    await settle();
    expect(row(container, "here").textContent).toContain("1 · agents only");
    expect(row(container, "p_1").textContent).toContain("1");
    expect(row(container, "p_2").textContent).toContain("0 · not answering");
    expect(row(container, "box").textContent).toContain("1 · $0.018/h");
  });

  it("opens a computer's detail under its row and leaves this computer without one", async () => {
    const { container } = mount([HERE, HETZNER]);
    await settle();
    expect(container.querySelector('[data-k="place-detail"]')).toBeNull();
    fireEvent.click(row(container, "here"));
    expect(container.querySelector('[data-k="place-detail"]')).toBeNull();
    fireEvent.click(row(container, "p_1"));
    const detail = container.querySelector<HTMLElement>('[data-k="place-detail"]')!;
    expect(detail.getAttribute("data-place")).toBe("p_1");
    expect(detail.textContent).toContain("Ubuntu 24.04 · docker");
    expect(detail.textContent).toContain("spoo-fix · 2 threads");
    expect(row(container, "p_1").getAttribute("aria-expanded")).toBe("true");
  });

  it("offers both roads to another computer under the table", async () => {
    const { container } = mount([HERE]);
    await settle();
    expect(container.querySelector('[data-k="add-computer"]')?.textContent).toBe("Add a computer");
    expect(container.querySelector('[data-k="connect-provider"]')?.textContent).toBe("Connect a provider");
  });
});

describe("the remove dialog", () => {
  it("computes its sentence from what the computer holds", async () => {
    const { container } = mount([HERE, HETZNER]);
    await settle();
    fireEvent.click(row(container, "p_1"));
    fireEvent.click(container.querySelector('[data-k="place-detail"] [data-k="remove"]')!);
    expect(screen.getByText("Remove hetzner?")).toBeTruthy();
    expect(screen.getByText("wsp, your image and its workspace come off hetzner, which is otherwise left as it is. The workspace's record and 2 threads leave this Mac.")).toBeTruthy();
  });

  it("says nothing of a record leaving for a computer that holds none", async () => {
    const { container } = mount([HERE, LAPTOP]);
    await settle();
    fireEvent.click(row(container, "p_2"));
    fireEvent.click(container.querySelector('[data-k="place-detail"] [data-k="remove"]')!);
    expect(screen.getByText("wsp and your image come off old-macbook, which is otherwise left as it is. It is offline; what is on it is swept the next time it connects.")).toBeTruthy();
  });

  it("takes the computer out through the host's own road", async () => {
    const removed: string[] = [];
    const { container } = mount([HERE, HETZNER], removed);
    await settle();
    fireEvent.click(row(container, "p_1"));
    fireEvent.click(container.querySelector('[data-k="place-detail"] [data-k="remove"]')!);
    fireEvent.click(document.querySelector('[data-k="remove-confirm"]')!);
    await settle();
    expect(removed).toEqual(["p_1"]);
  });
});
