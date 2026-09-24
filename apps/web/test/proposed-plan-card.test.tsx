// SPDX-License-Identifier: AGPL-3.0-only
// Saving a proposed plan into the workspace: the dialog the person is looking
// at says what is wrong with the path, and a save that went through closes it
// with nothing more said.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposedPlanCard } from "../src/components/chat/ProposedPlanCard.js";
import { useNotices } from "../src/notices/store.js";

const PLAN = "# Plan\n\n1. Do the thing";

async function openSave(onSavePlan: (input: { path: string; contents: string }) => Promise<void>) {
  render(<ProposedPlanCard planMarkdown={PLAN} cwd="/w" workspaceRoot="/w" resolvedTheme="dark" onSavePlan={onSavePlan} />);
  fireEvent.click(screen.getByRole("button", { name: "Plan actions" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Save to workspace" }));
  return (await screen.findByLabelText("Workspace path")) as HTMLInputElement;
}

beforeEach(() => act(() => useNotices.getState().clear()));

describe("saving a plan to the workspace", () => {
  it("an empty path is said under the field, not as a toast, and typing clears it", async () => {
    const save = vi.fn(async () => {});
    const field = await openSave(save);
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(document.querySelector("[data-k='plan-path-refusal']")?.textContent).toBe("Type a path in the workspace to save the plan to.");
    expect(useNotices.getState().notices).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "plan.md" } });
    expect(document.querySelector("[data-k='plan-path-refusal']")?.textContent ?? "").toBe("");
  });

  it("a save that went through closes the dialog and says nothing more", async () => {
    const save = vi.fn(async () => {});
    const field = await openSave(save);
    fireEvent.change(field, { target: { value: "plan.md" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ path: "plan.md", contents: expect.any(String) }));
    await waitFor(() => expect(screen.queryByLabelText("Workspace path")).toBeNull());
    expect(useNotices.getState().notices).toEqual([]);
  });
});
