// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog: its layout, its Project control and what the
// project's computer says under it, the state with no project to make one of,
// and the four reasons Create is held, each of which is read in the caption
// under the control before any click, with the keycap held while it waits and
// live the moment it can be pressed. Header, panel and footer stack inside one
// flex column of the popup, so the footer stays attached to the card, and the
// form still submits on Enter and on the Create button.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fmtPrice, fmtSize, type PlaceView, type ProjectView, type SealedImageCopy } from "@wsp/protocol";

import { NewWorkspaceDialog } from "../src/sidebar/NewWorkspaceDialog.js";

afterEach(cleanup);

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, shape: { cpu: 8, memMb: 16384 }, engine: "none", present: true, takesForks: false };
const HETZNER: PlaceView = { id: "p_1", kind: "computer", name: "hetzner", default: true, shape: { cpu: 2, memMb: 4096 }, engine: "docker", present: true, takesForks: true, forks: { running: 0, room: 3 } };
const SIZES = [
  { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
  { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
];
const ASCII: PlaceView = { id: "box", kind: "provider", name: "box", default: false, rateUsdPerHour: 0.018, sizes: SIZES, takesForks: true };
/** A place that charges nothing an hour, offering its own two shapes: the row a person meets beside a provider. */
const FREE_SIZES = [
  { cpu: 2, memMb: 4096, rateUsdPerHour: 0 },
  { cpu: 4, memMb: 8192, rateUsdPerHour: 0 },
];
const DOCKER: PlaceView = { id: "docker", kind: "provider", name: "docker", default: false, rateUsdPerHour: 0, sizes: FREE_SIZES, takesForks: true };
const COPY: SealedImageCopy = { place: "box", version: 1, snapshotId: "snap_box", builtAt: "2026-09-12T09:31:00.000Z" };

const cloned = (id: string, name: string, computer: string): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "git", url: `https://github.com/dev/${name}.git` },
  path: `/root/${name}`,
  remote: `https://github.com/dev/${name}.git`,
  defaultBranch: "main",
  memoryKey: `-root-${name}`,
  memoryDir: `/root/.claude-cfg/projects/-root-${name}/memory`,
  createdAt: "2026-09-12T09:31:00.000Z",
});
/** The project a workspace is made of in most of these: one repo on the computer that clones it. */
const SPOO = cloned("pr_1", "spoo-landing", "p_1");
const SITE = cloned("pr_2", "site", "box");
const IN_PLACE: ProjectView = {
  id: "pr_3",
  name: "wsp",
  computer: "here",
  source: { kind: "folder", path: "/Users/dev/wsp" },
  path: "/Users/dev/wsp",
  remote: "https://github.com/dev/wsp.git",
  defaultBranch: "main",
  memoryKey: "-Users-dev-wsp",
  memoryDir: "/Users/dev/.claude/projects/-Users-dev-wsp/memory",
  createdAt: "2026-09-12T09:31:00.000Z",
};

/** What a keycap is drawn as, read the way ui/button.test.tsx reads it: the outline carries the input's hairline. */
const isOutline = (button: HTMLElement): boolean => button.className.split(" ").includes("border-input") && !button.className.split(" ").includes("bg-primary");

const dialogWith = (props: Partial<Parameters<typeof NewWorkspaceDialog>[0]> = {}) => (
  <NewWorkspaceDialog
    initialName="workspace-1"
    places={[HERE, HETZNER, ASCII]}
    projects={[SPOO, SITE]}
    copies={[]}
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

  it("Enter in the name and the Create button both submit the trimmed name on the project the work is on", async () => {
    const onCreate = vi.fn();
    const dialog = await open({ onCreate });
    const input = within(dialog).getByLabelText("Name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  beta " } });
    fireEvent.keyDown(input, { key: "Enter" });
    // The project's id, which is what the wire takes; the computer is the project's own and nothing here says it.
    expect(onCreate).toHaveBeenNthCalledWith(1, "beta", "pr_1", undefined);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenNthCalledWith(2, "beta", "pr_1", undefined);
  });
});

describe("the Project control", () => {
  it("is the project's own name with one project, which asks no question, and creates on it", async () => {
    const onCreate = vi.fn();
    const dialog = await open({ projects: [SPOO], onCreate });
    expect(within(dialog).queryByRole("radiogroup", { name: "Project" })).toBeNull();
    expect(dialog.querySelector<HTMLElement>("[data-project=pr_1]")!.textContent).toBe("spoo-landing");
    fireEvent.click(create(dialog));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "pr_1", undefined);
  });

  it("lists every project this wsp holds with the first checked, and a project worked in place here is one of them", async () => {
    const dialog = await open({ projects: [SPOO, SITE, IN_PLACE] });
    const group = within(dialog).getByRole("radiogroup", { name: "Project" });
    const segments = within(group).getAllByRole("radio");
    expect(segments.map(s => s.textContent)).toEqual(["spoo-landing", "site", "wsp"]);
    expect(segments.map(s => s.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("says what the checked project's computer costs, its room, and that the image is built there first", async () => {
    const dialog = await open();
    expect(caption(dialog)).toBe("free · room for 3 workspaces · builds your image there first, about 4 min");
  });

  it("says a provider's rate and which image is there, and offers its sizes under the caption", async () => {
    const onCreate = vi.fn();
    const dialog = await open({ copies: [COPY], goldenSize: { cpu: 2, memMb: 4096 }, onCreate });
    expect(within(dialog).queryByRole("radiogroup", { name: "Size" })).toBeNull();
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Project" })).getByRole("radio", { name: "site" }));
    // The ticked row's rate, not the provider's default: the caption prices the workspace this dialog would make.
    expect(caption(dialog)).toBe("$0.11/hr while awake · naps to $0 · your image is there, v1");
    const sizes = within(dialog).getByRole("radiogroup", { name: "Size" });
    const rows = within(sizes).getAllByRole("radio");
    expect(rows.map(r => r.closest("label")!.textContent)).toEqual(SIZES.map(size => `${fmtSize(size)}${fmtPrice(size.rateUsdPerHour)}`));
    expect(rows.map(r => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(rows[1]!);
    expect(caption(dialog)).toBe("$0.15/hr while awake · naps to $0 · your image is there, v1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "pr_2", { cpu: 2, memMb: 8192 });
  });

  it("quotes the computer's own rate while no size is ticked, since none is priced yet", async () => {
    const dialog = await open({ copies: [COPY], goldenSize: null });
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Project" })).getByRole("radio", { name: "site" }));
    expect(within(within(dialog).getByRole("radiogroup", { name: "Size" })).getAllByRole("radio").map(r => r.getAttribute("aria-checked"))).toEqual(["false", "false"]);
    expect(caption(dialog)).toBe("$0.018/hr while awake · naps to $0 · your image is there, v1");
  });

  it("leaves a size behind when the pick moves to a project whose computer offers none", async () => {
    const onCreate = vi.fn();
    const dialog = await open({ onCreate });
    const pick = within(dialog).getByRole("radiogroup", { name: "Project" });
    fireEvent.click(within(pick).getByRole("radio", { name: "site" }));
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "Size" })).getAllByRole("radio")[1]!);
    fireEvent.click(within(pick).getByRole("radio", { name: "spoo-landing" }));
    expect(within(dialog).queryByRole("radiogroup", { name: "Size" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("workspace-1", "pr_1", undefined);
  });

  it("holds Create on a computer with no room left and gives its caption as the reason", async () => {
    const onCreate = vi.fn();
    const full = { ...HETZNER, forks: { running: 3, room: 0 } };
    const dialog = await open({ places: [HERE, full], projects: [SPOO], onCreate });
    const line = "free · 3 of 3 workspaces · pause or delete one there";
    expect(caption(dialog)).toBe(line);
    expect(create(dialog).disabled).toBe(true);
    expect(isHeld(create(dialog))).toBe(true);
    fireEvent.click(create(dialog));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("prices each computer off its own list, and writes one that charges nothing as free", async () => {
    // One list of sizes for every row quoted the wired provider's three rates under a row that bills nothing, so
    // two places read the same to the cent and there was nothing to choose between them.
    const onDocker = cloned("pr_4", "tools", "docker");
    const dialog = await open({ places: [HERE, HETZNER, ASCII, DOCKER], projects: [SPOO, SITE, onDocker] });
    const pick = within(dialog).getByRole("radiogroup", { name: "Project" });
    fireEvent.click(within(pick).getByRole("radio", { name: "tools" }));
    const rows = within(within(dialog).getByRole("radiogroup", { name: "Size" })).getAllByRole("radio");
    expect(rows.map(r => r.closest("label")!.textContent)).toEqual(FREE_SIZES.map(size => `${fmtSize(size)}free`));
    expect(caption(dialog)).toBe("free · builds your image there first, about 4 min");
    // The project beside it keeps its computer's own shapes and its own prices.
    fireEvent.click(within(pick).getByRole("radio", { name: "site" }));
    expect(within(within(dialog).getByRole("radiogroup", { name: "Size" })).getAllByRole("radio").map(r => r.closest("label")!.textContent)).toEqual(
      SIZES.map(size => `${fmtSize(size)}${fmtPrice(size.rateUsdPerHour)}`),
    );
  });

  it("puts the projects in a select once there are more than four", async () => {
    const many = ["a", "b", "c", "d", "e"].map((name, at) => cloned(`pr_${at}`, name, "p_1"));
    const dialog = await open({ projects: many });
    expect(within(dialog).queryByRole("radiogroup", { name: "Project" })).toBeNull();
    expect(dialog.querySelector<HTMLElement>("[data-slot=select-button]")!.textContent).toContain("a");
  });
});

describe("with no project to make a workspace of", () => {
  it("drops the control for two notes, the second of them the line that records a project, and makes the one road forward the loud key", async () => {
    const onAddComputer = vi.fn();
    const dialog = await open({ projects: [], onAddComputer });
    expect(within(dialog).queryByRole("radiogroup", { name: "Project" })).toBeNull();
    expect(dialog.querySelector("[data-k=no-project-here]")!.textContent).toBe("No projects yet, and a workspace is a copy of one.");
    expect(dialog.querySelector("[data-k=no-project-add]")!.textContent).toBe("Record one with wsp add <folder> here, or wsp add <url> --on <computer> there.");
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
