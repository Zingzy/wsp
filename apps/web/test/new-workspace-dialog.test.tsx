// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog: its layout, its Where control and what each pick
// says under it, the state with nowhere to put a workspace, and the four
// reasons Create is held, each of which is read in the caption under Where
// before any click, with the keycap held while it waits and live the moment it
// can be pressed. Header, panel and footer stack inside one flex column of the
// popup, so the footer stays attached to the card, and the form still submits
// on Enter and on the Create button.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtRate, fmtSize, type PlaceView, type SealedImageCopy } from "@wsp/protocol";

import { NewWorkspaceDialog } from "../src/sidebar/NewWorkspaceDialog.js";

afterEach(cleanup);

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, shape: { cpu: 8, memMb: 16384 }, docker: false, present: true };
const HETZNER: PlaceView = { id: "p_1", kind: "computer", name: "hetzner", default: true, shape: { cpu: 2, memMb: 4096 }, docker: true, present: true, forks: { running: 0, room: 3 } };
const ASCII: PlaceView = { id: "box", kind: "provider", name: "box", default: false, rateUsdPerHour: 0.018 };
const COPY: SealedImageCopy = { place: "box", version: 1, snapshotId: "snap_box", builtAt: "2026-09-12T09:31:00.000Z" };

const SIZES = [
  { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
  { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
];

/** What a keycap is drawn as, read the way ui/button.test.tsx reads it: the outline carries the input's hairline. */
const isOutline = (button: HTMLElement): boolean => button.className.split(" ").includes("border-input") && !button.className.split(" ").includes("bg-primary");

const dialogWith = (props: Partial<Parameters<typeof NewWorkspaceDialog>[0]> = {}) => (
  <NewWorkspaceDialog
    initialName="workspace-1"
    places={[HERE, HETZNER, ASCII]}
    copies={[]}
    sizes={[]}
    goldenSize={null}
    refusal={null}
    onCreate={() => {}}
    onCancel={() => {}}
    onAddComputer={() => {}}
    {...props}
  />
);

const open = async (props: Partial<Parameters<typeof NewWorkspaceDialog>[0]> = {}): Promise<HTMLElement> => {
  render(dialogWith(props));
  return screen.findByRole("dialog");
};

const slot = (dialog: HTMLElement, name: string): HTMLElement => dialog.querySelector<HTMLElement>(`[data-slot="dialog-${name}"]`)!;
const before = (a: Node, b: Node): boolean => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const caption = (dialog: HTMLElement): string | null => dialog.querySelector("[data-k=where-caption]")!.textContent;
const create = (dialog: HTMLElement): HTMLButtonElement => within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement;
/** Whether a keycap is drawn as held; what held is drawn as lives with the button, in ui/button.test.tsx. */
const isHeld = (button: HTMLElement): boolean => button.hasAttribute("data-held");

describe("new workspace dialog", () => {
  it("lays header, panel and footer out in one flex column that is the popup's child", async () => {
    const dialog = await open();
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

  it("Enter in the name and the Create button both submit the trimmed name on the default row", async () => {
    const onCreate = vi.fn();
    const dialog = await open({ onCreate });
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  beta " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenNthCalledWith(1, "beta", "p_1", undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenNthCalledWith(2, "beta", "p_1", undefined);
  });
});

describe("the Where control", () => {
  it("lists every computer and provider that takes a workspace, never this computer, with the default checked", async () => {
    const dialog = await open();
    const group = within(dialog).getByRole("radiogroup", { name: "Where" });
    const segments = within(group).getAllByRole("radio");
    expect(segments.map(s => s.textContent)).toEqual(["hetzner", "ASCII"]);
    expect(segments.map(s => s.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("says what the checked row costs, its room, and that the image is built there first", async () => {
    const dialog = await open();
    expect(caption(dialog)).toBe("free · room for 3 workspaces · builds your image there first, about 4 min");
  });

  it("says a provider's rate and which image is there, and offers its sizes under the caption", async () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const onCreate = vi.fn();
    const dialog = await open({ copies: [COPY], sizes: SIZES, goldenSize: { cpu: 2, memMb: 4096 }, onCreate });
    expect(within(dialog).queryByRole("radiogroup", { name: "Size" })).toBeNull();
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Where" })).getByRole("radio", { name: "ASCII" }));
    // The ticked row's rate, not the provider's default: the caption prices the workspace this dialog would make.
    expect(caption(dialog)).toBe("$0.11/hr while awake · naps to $0 · your image is there, v1");
    const sizes = within(dialog).getByRole("radiogroup", { name: "Size" });
    const rows = within(sizes).getAllByRole("radio");
    expect(rows.map(r => r.closest("label")!.textContent)).toEqual(SIZES.map(size => `${fmtSize(size)}${fmtRate(size.rateUsdPerHour)}`));
    expect(rows.map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(rows[1]!);
    expect(caption(dialog)).toBe("$0.15/hr while awake · naps to $0 · your image is there, v1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "box", { cpu: 2, memMb: 8192 });
    vi.unstubAllGlobals();
  });

  it("quotes the row's own rate while no size is ticked, since none is priced yet", async () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const dialog = await open({ copies: [COPY], sizes: SIZES, goldenSize: null });
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Where" })).getByRole("radio", { name: "ASCII" }));
    expect(within(within(dialog).getByRole("radiogroup", { name: "Size" })).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(caption(dialog)).toBe("$0.018/hr while awake · naps to $0 · your image is there, v1");
    vi.unstubAllGlobals();
  });

  it("leaves a size behind when the pick moves to a row that offers none", async () => {
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const onCreate = vi.fn();
    const dialog = await open({ sizes: SIZES, onCreate });
    const where = within(dialog).getByRole("radiogroup", { name: "Where" });
    fireEvent.click(within(where).getByRole("radio", { name: "ASCII" }));
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Size" })).getAllByRole("radio")[1]!);
    fireEvent.click(within(where).getByRole("radio", { name: "hetzner" }));
    expect(within(dialog).queryByRole("radiogroup", { name: "Size" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "p_1", undefined);
    vi.unstubAllGlobals();
  });

  it("holds Create on a row with no room left and gives its caption as the reason", async () => {
    const onCreate = vi.fn();
    const full = { ...HETZNER, forks: { running: 3, room: 0 } };
    const dialog = await open({ places: [HERE, full], onCreate });
    const line = "free · 3 of 3 workspaces · pause or delete one there";
    expect(caption(dialog)).toBe(line);
    expect(create(dialog).disabled).toBe(true);
    expect(isHeld(create(dialog))).toBe(true);
    fireEvent.click(create(dialog));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("puts the rows in a select once there are more than four", async () => {
    const more = ["a", "b", "c", "d", "e"].map((name, at): PlaceView => ({ ...HETZNER, id: `p_${at}`, name, default: at === 0 }));
    const dialog = await open({ places: [HERE, ...more] });
    expect(within(dialog).queryByRole("radiogroup", { name: "Where" })).toBeNull();
    expect(dialog.querySelector<HTMLElement>("[data-slot=select-button]")!.textContent).toContain("a");
  });
});

describe("with nowhere to put a workspace", () => {
  const NOWHERE = [HERE, { ...HETZNER, id: "p_9", name: "old-macbook", default: false, docker: false, forks: undefined }];

  it("drops the control for two notes, the first of them why this computer is not on the list, and makes the one road forward the loud key", async () => {
    const onAddComputer = vi.fn();
    const dialog = await open({ places: NOWHERE, onAddComputer });
    expect(within(dialog).queryByRole("radiogroup", { name: "Where" })).toBeNull();
    // The answer to a person who has just read in Settings that this Mac is a computer where agents run.
    expect(dialog.querySelector("[data-k=nowhere-here]")!.textContent).toBe("this Mac is already a workspace, the only one it can be");
    expect(dialog.querySelector("[data-k=nowhere-add]")!.textContent).toBe("Add a computer you own or connect a provider, and workspaces can be created there.");
    const add = within(dialog).getByRole("button", { name: "Add a computer" });
    expect(isHeld(add)).toBe(false);
    // The one key that can be pressed here is the loud one: a held Create is drawn as the outline, so leaving this
    // one outline too would give the dialog nothing to press first.
    expect(isOutline(add)).toBe(false);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).className).not.toContain("bg-primary");
    expect(create(dialog).disabled).toBe(true);
    expect(isHeld(create(dialog))).toBe(true);
    expect(within(dialog).queryByRole("tooltip")).toBeNull();
    fireEvent.click(add);
    expect(onAddComputer).toHaveBeenCalled();
  });
});

describe("why Create is held", () => {
  it("with nothing to fork yet the keycap is held and the caption says why, and neither road creates anything", async () => {
    const onCreate = vi.fn();
    const line = "the image is still building · 5 of 13";
    const dialog = await open({ refusal: line, onCreate });
    expect(create(dialog).disabled).toBe(true);
    expect(isHeld(create(dialog))).toBe(true);
    expect(caption(dialog)).toBe(line);
    fireEvent.click(create(dialog));
    fireEvent.keyDown(within(dialog).getByLabelText("Name"), { key: "Enter" });
    expect(onCreate).not.toHaveBeenCalled();
    // No tooltip anywhere: a reason read only on hover was read by nobody.
    expect(within(dialog).queryByRole("tooltip")).toBeNull();
    expect(dialog.querySelector("[data-k=create-reason]")).toBeNull();
  });

  it("the held keycap and the live one stand in the same slot at the same size, and only the variant differs", async () => {
    const held = create(await open({ refusal: "the image is still building" }));
    const spot = { tag: held.tagName, type: held.getAttribute("type"), word: held.textContent, size: held.className.split(" ").filter(c => c.startsWith("h-") || c.startsWith("px-")) };
    cleanup();
    const live = create(await open());
    expect({ tag: live.tagName, type: live.getAttribute("type"), word: live.textContent, size: live.className.split(" ").filter(c => c.startsWith("h-") || c.startsWith("px-")) }).toEqual(spot);
    expect(isHeld(live)).toBe(false);
    expect(live.disabled).toBe(false);
  });

  it("an empty name holds it, and the caption asks for one until it is typed", async () => {
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "   " } });
    expect(create(dialog).disabled).toBe(true);
    expect(isHeld(create(dialog))).toBe(true);
    expect(caption(dialog)).toBe("give the workspace a name");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "beta" } });
    expect(create(dialog).disabled).toBe(false);
    expect(isHeld(create(dialog))).toBe(false);
    expect(caption(dialog)).toBe("free · room for 3 workspaces · builds your image there first, about 4 min");
  });
});
