// SPDX-License-Identifier: AGPL-3.0-only
// The delete confirmation's sentence for a copy on a computer somebody
// joined: that computer by the name the app gives it, never the cloud; and
// when it is asked at all, as General's Ask before deleting says.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, type PlaceView, type WorkspaceView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { ForgetWorkspaceDialog } from "../src/components/ForgetWorkspaceDialog.js";
import { useStore } from "../src/protocol/store.js";

const spoo: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", label: "spoo in Helsinki", default: false };
const onSpoo: WorkspaceView = { id: "ws_fix", name: "fix-login", machineId: "wsp-workspace-ws_fix", kind: "cloud", place: "p_spoo", project: { id: "pr_1", name: "api", path: "/root/api", computer: "p_spoo" }, phase: "running", golden: "", createdAt: "2026-09-27T00:00:00Z" };

afterEach(() => {
  cleanup();
  useStore.setState({ places: [] });
});

describe("the delete confirmation", () => {
  it("says a copy on a computer somebody joined is deleted from that computer, by the name the app gives it", () => {
    useStore.setState({ places: [spoo] });
    render(<ForgetWorkspaceDialog workspaces={[onSpoo]} threads={1} act="delete" open onOpenChange={() => {}} />);
    const said = document.body.textContent ?? "";
    expect(said).toContain("Its copy on spoo in Helsinki is deleted; its record and 1 thread leave this computer.");
    expect(said).not.toMatch(/cloud|wsp-workspace-ws_fix/);
  });

  it("says each of several copies Keep this one deletes on that computer is deleted from it, never by machine id", () => {
    useStore.setState({ places: [spoo] });
    const second: WorkspaceView = { ...onSpoo, id: "ws_fix2", name: "fix-login-2", machineId: "wsp-workspace-ws_fix2" };
    render(<ForgetWorkspaceDialog workspaces={[onSpoo, second]} threads={2} act="delete" open onOpenChange={() => {}} />);
    const said = document.body.textContent ?? "";
    expect(said).toContain("Each one's copy on spoo in Helsinki is deleted; their records and 2 threads leave this computer.");
    expect(said).not.toMatch(/cloud|wsp-workspace-ws_fix/);
  });
});

describe("ask before deleting", () => {
  const clean = { branch: "main", ahead: 0, behind: 0, changed: 0 };
  const harness = (checkout: object | undefined) => {
    const deleted: string[] = [];
    const forgot: string[] = [];
    const closed: boolean[] = [];
    useStore.setState({
      places: [spoo],
      api: {
        workspaceCheckout: async () => ({ checkout }),
        deleteWorkspace: async (id: string) => void deleted.push(id),
        forget: async (id: string) => void forgot.push(id),
      } as unknown as Api,
    });
    return { deleted, forgot, closed, onOpenChange: (open: boolean) => void closed.push(open) };
  };
  const asks = (askDelete: boolean) => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, askDelete } });
  afterEach(() => useStore.setState({ api: null, preferences: DEFAULT_PREFERENCES }));

  it("asks by default even for a copy that holds nothing", async () => {
    const h = harness(clean);
    render(<ForgetWorkspaceDialog workspaces={[onSpoo]} threads={1} act="delete" open onOpenChange={h.onOpenChange} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" }).hasAttribute("disabled")).toBe(false));
    expect(h.deleted).toEqual([]);
  });

  it("off, deletes a copy that holds nothing at once with no dialog, and forgets a gone one the same way", async () => {
    asks(false);
    const h = harness(clean);
    render(<ForgetWorkspaceDialog workspaces={[onSpoo]} threads={1} act="delete" open onOpenChange={h.onOpenChange} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(h.deleted).toEqual(["ws_fix"]));
    expect(h.closed).toEqual([false]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    cleanup();
    render(<ForgetWorkspaceDialog workspaces={[onSpoo]} threads={1} act="forget" open onOpenChange={h.onOpenChange} />);
    await waitFor(() => expect(h.forgot).toEqual(["ws_fix"]));
  });

  it("off, still asks for a copy holding work or one whose checkout could not be read", async () => {
    asks(false);
    const h = harness({ ...clean, ahead: 2 });
    render(<ForgetWorkspaceDialog workspaces={[onSpoo]} threads={1} act="delete" open onOpenChange={h.onOpenChange} />);
    await waitFor(() => expect(document.querySelector("[data-k=unpushed]")?.textContent).toBe("fix-login holds 2 commits not pushed"));
    expect(h.deleted).toEqual([]);
    cleanup();
    const unread = harness(undefined);
    render(<ForgetWorkspaceDialog workspaces={[onSpoo]} threads={1} act="delete" open onOpenChange={unread.onOpenChange} />);
    await waitFor(() => expect(document.querySelector("[data-k=unpushed]")?.textContent).toBe("fix-login: could not read what is not pushed"));
    expect(unread.deleted).toEqual([]);
  });
});
