// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog's layout: header, panel and footer stack inside
// one flex column of the popup, so the footer stays attached to the card,
// and the form still submits on Enter and on the Create button.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: element, children, ...rest }: { render: ReactElement<{ children?: ReactNode }>; children?: ReactNode }) => cloneElement(element, rest, children),
  TooltipPopup: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>,
}));

import { NewWorkspaceDialog } from "../src/sidebar/NewWorkspaceDialog.js";

afterEach(cleanup);

const slot = (dialog: HTMLElement, name: string): HTMLElement => dialog.querySelector<HTMLElement>(`[data-slot="dialog-${name}"]`)!;
const before = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("new workspace dialog", () => {
  it("lays header, panel and footer out in one flex column that is the popup's child", async () => {
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={[]} goldenSize={null} refusal={null} onCreate={() => {}} onCancel={() => {}} />);
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
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={[]} goldenSize={null} refusal={null} onCreate={onCreate} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  beta " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenNthCalledWith(1, "beta", "fresh");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenNthCalledWith(2, "beta", "fresh");
  });

  it("offers start fresh and import a project, fresh first; the choice rides along with the name", async () => {
    // Base UI's radio re-dispatches a click as a PointerEvent, which jsdom does not have.
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const onCreate = vi.fn();
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={[]} goldenSize={null} refusal={null} onCreate={onCreate} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const group = within(dialog).getByRole("radiogroup", { name: "Start from" });
    const fresh = within(group).getByRole("radio", { name: /^Start fresh/ });
    const imported = within(group).getByRole("radio", { name: /^Import a project/ });
    expect(within(group).getAllByRole("radio")).toEqual([fresh, imported]);
    expect([fresh, imported].map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(within(group).getByText("Then pick a folder on this Mac; it lands at the same path, caches left behind.")).toBeDefined();
    fireEvent.click(imported);
    expect([fresh, imported].map(r => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "import");
    vi.unstubAllGlobals();
  });

  const SIZES = [
    { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
    { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
  ];

  it("lists the provider's sizes as muted mono rows with the rate of each, the golden's checked; untouched, the create carries no size", async () => {
    const onCreate = vi.fn();
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={SIZES} goldenSize={{ cpu: 2, memMb: 4096 }} refusal={null} onCreate={onCreate} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const group = within(dialog).getByRole("radiogroup", { name: "Size" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map(r => r.closest("label")!.textContent)).toEqual(["2 vCPU · 4 GB$0.11/hr", "2 vCPU · 8 GB$0.15/hr"]);
    expect(radios.map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    for (const r of radios) expect(r.closest("label")!.className.split(" ")).toEqual(expect.arrayContaining(["font-mono", "text-muted-foreground"]));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "fresh");
  });

  it("a picked size rides along with the name; without sizes there is no row, and a golden size off the list checks nothing", async () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const onCreate = vi.fn();
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={SIZES} goldenSize={{ cpu: 2, memMb: 2048 }} refusal={null} onCreate={onCreate} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const group = within(dialog).getByRole("radiogroup", { name: "Size" });
    expect(within(group).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    fireEvent.click(within(group).getByRole("radio", { name: /8\u00a0GB/ }));
    expect(within(group).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "fresh", { cpu: 2, memMb: 8192 });
    cleanup();
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={[]} goldenSize={{ cpu: 2, memMb: 4096 }} refusal={null} onCreate={onCreate} onCancel={() => {}} />);
    const bare = await screen.findByRole("dialog");
    expect(within(bare).queryByRole("radiogroup", { name: "Size" })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("with nothing to fork yet the Create keycap is held and says why, and neither road creates anything", async () => {
    const onCreate = vi.fn();
    const line = "the image is still building · 5 of 13";
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={[]} goldenSize={null} refusal={line} onCreate={onCreate} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog");
    const create = within(dialog).getByRole("button", { name: "Create" });
    expect(create.hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("tooltip").textContent).toBe(line);
    fireEvent.click(create);
    fireEvent.keyDown(within(dialog).getByLabelText("Name"), { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
    // A disabled control cannot be hovered, so the reason hangs on a wrapper around it rather than on the button.
    expect(dialog.querySelector("[data-k=create-reason]")?.contains(create)).toBe(true);
    cleanup();
    render(<NewWorkspaceDialog initialName="workspace-1" sizes={[]} goldenSize={null} refusal={null} onCreate={onCreate} onCancel={() => {}} />);
    const free = await screen.findByRole("dialog");
    expect(within(free).getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false);
    expect(free.querySelector("[data-k=create-reason]")).toBeNull();
  });
});
