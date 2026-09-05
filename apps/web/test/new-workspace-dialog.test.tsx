// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog's layout: header, panel and footer stack inside
// one flex column of the popup, so the footer stays attached to the card,
// and the form still submits on Enter and on the Create button.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewWorkspaceDialog } from "../src/sidebar/NewWorkspaceDialog.js";

afterEach(cleanup);

const slot = (dialog: HTMLElement, name: string): HTMLElement => dialog.querySelector<HTMLElement>(`[data-slot="dialog-${name}"]`)!;
const before = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("new workspace dialog", () => {
  it("lays header, panel and footer out in one flex column that is the popup's child", async () => {
    render(<NewWorkspaceDialog initialName="workspace-1" error={null} onCreate={() => {}} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const popup = dialog.closest<HTMLElement>('[data-slot="dialog-popup"]') ?? dialog;
    const header = slot(popup, "header");
    const panel = slot(popup, "panel");
    const footer = slot(popup, "footer");
    const column = footer.parentElement!;
    expect(column.parentElement).toBe(popup);
    expect(column.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0"]));
    expect(column.contains(header)).toBe(true);
    expect(column.contains(panel)).toBe(true);
    expect(before(header, panel)).toBe(true);
    expect(before(panel, footer)).toBe(true);
  });

  it("Enter in the name and the Create button both submit the trimmed name", async () => {
    const onCreate = vi.fn();
    render(<NewWorkspaceDialog initialName="workspace-1" error={null} onCreate={onCreate} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  beta " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenNthCalledWith(1, "beta");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenNthCalledWith(2, "beta");
  });
});
