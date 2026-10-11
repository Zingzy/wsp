// SPDX-License-Identifier: AGPL-3.0-only
// A project's image in the window: ProjectGlyph draws it in the glyph's own box
// with no frame of its own, the glyph standing while it is read and whenever it
// cannot draw; the window asks the host once for every hash it lacks and lets a
// URL go once nothing names its hash; the palette's switch rows and the New
// thread heading draw through the one mark; and the Icon row on a project's
// page and in Add a project takes an image by the select's foot, a drop or a
// paste, keeps nothing until Use image, and clears it on reset or a glyph.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES, type PlaceView, type ProjectView, type SessionView, type WorkspaceView } from "@wsp/protocol";

vi.mock("../src/projects/imageFile.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/projects/imageFile.js")>()),
  fitProjectIcon: vi.fn(async (file: Blob) => (file.size === 0 ? { refusal: { said: "wsp could not read this file as an image.", fix: "Open it in an image editor, save it again and pick that." } } : { png: new Blob(["fitted"], { type: "image/png" }) })),
}));

import { deriveSidebarProjects } from "../src/adapt/index.js";
import { HeroMark } from "../src/components/chat/EmptyHero.js";
import { buildPaletteItems } from "../src/components/palette/paletteItems.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { followProjectIcons, resetProjectIcons, useProjectIcons } from "../src/projects/images.js";
import { IconSelect } from "../src/projects/LookPicker.js";
import { ProjectGlyph } from "../src/projects/look.js";
import { PROJECTS_WORDS } from "../src/settings/format.js";
import { AddProjectDialog } from "../src/sidebar/AddProjectDialog.js";
import { everything, folderLooks, noPicks } from "../src/settings/add/choices.js";
import { ProjectsPicks } from "../src/settings/add/PickLists.js";
import { pickOption } from "./select.js";
import { mountSettings, settingsApi, settle } from "./settings-harness.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const dataUrl = (word: string): string => `data:image/png;base64,${btoa(word)}`;

let made = 0;
const revoked: string[] = [];
beforeEach(() => {
  made = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => `blob:wsp/${++made}`);
  URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url));
});
afterEach(() => {
  cleanup();
  resetProjectIcons();
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false }, api: null });
});

const wearing = (projectIcon: Record<string, string>, projectLook: Record<string, { icon?: "rocket"; hue?: "teal" | "violet" }> = {}): void =>
  useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false, projectLook, projectIcon } });

describe("the mark", () => {
  it("draws the image in the glyph's own box, any class the row puts on the mark landing on it, with no frame of its own", () => {
    wearing({ pr_1: A }, { pr_1: { icon: "rocket", hue: "teal" } });
    useProjectIcons.setState({ urls: { [A]: "blob:wsp/a" } });
    const dim = "size-3 shrink-0 opacity-40 grayscale";
    const { container } = render(
      <>
        {["size-3", "size-4", "size-6", "size-10", dim].map(size => (
          <ProjectGlyph key={size} projectId="pr_1" className={size} />
        ))}
      </>,
    );
    const imgs = [...container.querySelectorAll("img[data-project-icon]")];
    expect(imgs.map(img => img.getAttribute("src"))).toEqual(Array(5).fill("blob:wsp/a"));
    expect(imgs.map(img => img.getAttribute("class")!.split(" ").find(c => c.startsWith("size-")))).toEqual(["size-3", "size-4", "size-6", "size-10", "size-3"]);
    for (const img of imgs) {
      expect(img.getAttribute("class")).toContain("object-contain");
      expect(img.getAttribute("class")).not.toMatch(/rounded|mask|ring|border|bg-/);
    }
    expect(imgs[4]!.getAttribute("class")).toContain("opacity-40 grayscale");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("stands as the glyph in its hue while the image is read from the host, where none is kept, and where the image will not draw", async () => {
    wearing({ pr_1: A }, { pr_1: { icon: "rocket", hue: "teal" } });
    const { container } = render(<ProjectGlyph projectId="pr_1" className="size-3" />);
    const glyph = (): Element | null => container.querySelector("svg.lucide-rocket");
    expect(glyph()?.getAttribute("data-hue")).toBe("teal");
    expect(glyph()?.getAttribute("class")).toContain("size-3");
    act(() => useProjectIcons.setState({ urls: { [A]: "blob:wsp/a" } }));
    expect(glyph()).toBeNull();
    expect(container.querySelector("img[data-project-icon]")!.getAttribute("class")).toContain("size-3");
    fireEvent.error(container.querySelector("img")!);
    expect(glyph()).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("the New thread heading draws through it at 40 px and stroke 1.5, the neutral ink its own and a picked hue over it", () => {
    wearing({}, { pr_teal: { icon: "rocket", hue: "teal" } });
    const { container } = render(
      <>
        <HeroMark projectId="pr_plain" />
        <HeroMark projectId="pr_teal" />
      </>,
    );
    const [plain, teal] = [...container.querySelectorAll("svg")];
    expect(plain!.getAttribute("class")).toContain("size-10");
    expect(plain!.getAttribute("class")).toContain("text-foreground/70");
    expect(plain!.getAttribute("stroke-width")).toBe("1.5");
    expect(teal!.getAttribute("class")).toContain("text-teal-500");
    expect(teal!.getAttribute("class")).not.toContain("text-foreground/70");
    act(() => {
      wearing({ pr_teal: A }, { pr_teal: { icon: "rocket", hue: "teal" } });
      useProjectIcons.setState({ urls: { [A]: "blob:wsp/a" } });
    });
    expect(container.querySelector("img")!.getAttribute("class")).toContain("size-10");
  });

  it("the palette's switch rows draw each project's own glyph in its hue, and its image where it wears one", () => {
    const view = (id: string, project: string): WorkspaceView => ({ id, name: id, machineId: `m_${id}`, project: { id: project, name: project, path: "/root", computer: "default" }, phase: "running", golden: "", createdAt: "2026-09-01T00:00:00Z" });
    const session = (workspaceId: string): SessionView => ({ id: `s_${workspaceId}`, threadId: `t_${workspaceId}`, workspaceId, harness: "claude", status: "completed", prompt: "Fix it.", startedBy: "person", startedAt: 1, endedAt: 2 });
    const projects = deriveSidebarProjects({ workspaces: [view("ws_a", "pr_a"), view("ws_b", "pr_b")], sessions: { ws_a: [session("ws_a")], ws_b: [session("ws_b")] } });
    wearing({ pr_b: B }, { pr_a: { icon: "rocket", hue: "violet" } });
    useProjectIcons.setState({ urls: { [B]: "blob:wsp/b" } });
    const rows = buildPaletteItems({ projects, selectedId: null, query: "", messageHits: [], canCreate: false, recorded: [], picks: [], asks: false, handlers: {} as never, verbs: {} as never, places: [] }).workspaceItems;
    const drawn = rows.map(row => render(<>{row.icon}</>).container);
    expect(drawn[0]!.querySelector("svg")!.getAttribute("class")).toContain("lucide-rocket");
    expect(drawn[0]!.querySelector("svg")!.getAttribute("data-hue")).toBe("violet");
    expect(drawn[1]!.querySelector("img")!.getAttribute("src")).toBe("blob:wsp/b");
  });
});

describe("the window's images", () => {
  it("asks once for every hash it lacks, revokes a URL once nothing names its hash, and asks again for a missing one only after a gap", async () => {
    const asked: string[][] = [];
    const api = { projectIcons: vi.fn(async (hashes: readonly string[]) => (asked.push([...hashes]), Object.fromEntries(hashes.map(h => [h, h === C ? null : dataUrl(h.slice(0, 4))])))) } as unknown as Api;
    followProjectIcons({ api, projectIcon: { pr_1: A, pr_2: B, pr_3: A, pr_4: C } });
    await waitFor(() => expect(Object.keys(useProjectIcons.getState().urls).sort()).toEqual([A, B]));
    expect(asked).toEqual([[A, B, C]]);
    // The same names again ask nothing: a hash never changes its bytes, and one the host does not keep waits for a gap.
    followProjectIcons({ api, projectIcon: { pr_1: A, pr_2: B, pr_4: C } });
    await settle();
    expect(asked).toHaveLength(1);
    const { urls } = useProjectIcons.getState();
    followProjectIcons({ api, projectIcon: { pr_1: A, pr_4: C } });
    expect(revoked).toEqual([urls[B]]);
    expect(Object.keys(useProjectIcons.getState().urls)).toEqual([A]);
    followProjectIcons({ api, projectIcon: { pr_1: A, pr_4: C }, again: true });
    await settle();
    expect(asked).toEqual([[A, B, C], [C]]);
  });
});

describe("a recipe's folder row", () => {
  it("carries the image's hash, draws it where the host keeps it and the glyph and hue where it does not", async () => {
    const looks = folderLooks({ pr_lab: { icon: "rocket", hue: "teal" } }, { pr_lab: A });
    const file = everything("box", { agents: [], mcp: [], clis: [], skills: [], plugins: [], configs: [], folders: [] } as never, [lab, { ...lab, id: "pr_site", name: "site", path: "/Users/dev/site" }], looks);
    expect(file.folders["lab"]).toEqual({ from: "/Users/dev/lab", name: "lab", icon: "rocket", hue: "teal", image: A, keep: [] });
    expect(file.folders["site"]).toEqual({ from: "/Users/dev/site", name: "site", keep: [] });
    const api = { projectIcons: vi.fn(async (hashes: readonly string[]) => Object.fromEntries(hashes.map(h => [h, h === A ? dataUrl("png") : null]))) } as unknown as Api;
    followProjectIcons({ api, projectIcon: {} });
    const { container, unmount } = render(
      <>
        <ProjectGlyph look={{ icon: "rocket", hue: "teal", image: A }} />
        <ProjectGlyph look={{ icon: "book", hue: "violet", image: B }} />
      </>,
    );
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:wsp/1"));
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.querySelector("svg")!.getAttribute("class")).toContain("lucide-book");
    expect(container.querySelector("svg")!.getAttribute("data-hue")).toBe("violet");
    // A row's hash is held only while the row draws.
    unmount();
    expect(revoked).toEqual(["blob:wsp/1"]);
  });
});

describe("Add a computer's Projects step", () => {
  it("shows the image a ticked row carries, and a glyph picked on the row takes the image off it", async () => {
    const picks = { ...noPicks("box"), folders: { lab: { from: "/Users/dev/lab", name: "lab", icon: "rocket" as const, hue: "teal" as const, image: A, keep: [] } } };
    const onChange = vi.fn();
    render(<ProjectsPicks picks={picks} onChange={onChange} box="box" folders={[{ key: "lab", name: "lab", path: "/Users/dev/lab", icon: "rocket", hue: "teal", image: A }]} taken={() => false} />);
    const trigger = document.querySelector<HTMLElement>("[data-k=project-icon]")!;
    expect(trigger.textContent).toBe(PROJECTS_WORDS.iconImage);
    const offered = await pickOption(trigger, "Book");
    expect(offered).not.toContain(PROJECTS_WORDS.chooseImage);
    expect(onChange).toHaveBeenLastCalledWith({ ...picks, folders: { lab: { from: "/Users/dev/lab", name: "lab", icon: "book", hue: "teal", keep: [] } } });
  });
});

const AT = "2026-09-12T09:14:00.000Z";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true, present: true, takesForks: false };
const lab: ProjectView = { id: "pr_lab", name: "lab", computer: "here", source: { kind: "folder", path: "/Users/dev/lab" }, path: "/Users/dev/lab", remote: "https://github.com/acme/lab.git", defaultBranch: "main", memoryKey: "-x", memoryDir: "/x", createdAt: AT };

async function projectPage(worn: Record<string, string> = {}) {
  const projectIcon = vi.fn(async (_id: string, png: string | null) => (png === null ? null : A));
  const record = { ...DEFAULT_PREFERENCES, labs: false, projectLook: { pr_lab: { icon: "rocket" as const } }, projectIcon: worn };
  const { api, sets } = settingsApi({ projectIcon, projectIcons: async hashes => Object.fromEntries(hashes.map(h => [h, dataUrl("png")])) }, record);
  useStore.setState({ places: [here], projects: [lab], workspaces: [], preferences: record });
  mountSettings({ api, at: { kind: "project", id: "pr_lab" } });
  await settle();
  const row = (): HTMLElement => document.querySelector<HTMLElement>("[data-settings-page] [data-settings-row=icon]")!;
  const trigger = (): HTMLElement => row().querySelector<HTMLElement>("[data-k=project-icon]")!;
  return { projectIcon, sets, row, trigger };
}

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-k=project-icon-sheet]");
const filesOf = (file: File) => ({ files: [file], types: ["Files"] });
const logo = (): File => new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "logo.svg", { type: "image/svg+xml" });

describe("the Icon row on a project's page", () => {
  it("ends the select in Choose an image over a line, opens the file chooser for the five types, and keeps nothing before Use image", async () => {
    const t = await projectPage();
    const chooser = t.row().querySelector<HTMLInputElement>("[data-k=project-icon-file]")!;
    expect(chooser.accept).toBe("image/png,image/jpeg,image/webp,image/gif,image/svg+xml");
    const click = vi.spyOn(chooser, "click");
    fireEvent.click(t.trigger());
    const foot = await screen.findByRole("option", { name: PROJECTS_WORDS.chooseImage });
    const line = document.querySelector("[data-slot=select-separator]")!;
    expect(line.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.nextElementSibling).toBe(foot);
    await act(async () => void (await new Promise(r => setTimeout(r, 0))));
    const offered = screen.getAllByRole("option").map(o => o.textContent);
    expect(offered.at(-1)).toBe(PROJECTS_WORDS.chooseImage);
    expect(offered).toHaveLength(21);
    fireEvent.keyDown(foot, { key: "Enter" });
    fireEvent.click(foot);
    expect(click).toHaveBeenCalled();
    expect(t.trigger().textContent).toBe("Rocket");

    fireEvent.change(chooser, { target: { files: [logo()] } });
    await waitFor(() => expect(dialog()).not.toBeNull());
    await waitFor(() => expect(dialog()!.querySelectorAll("img[data-project-icon]")).toHaveLength(6));
    expect([...dialog()!.querySelectorAll("[data-theme]")].map(g => g.getAttribute("data-theme"))).toEqual(["paper", "graphite"]);
    expect([...dialog()!.querySelectorAll("img")].map(img => img.getAttribute("class")!.split(" ").find(c => c.startsWith("size-")))).toEqual(["size-3", "size-4", "size-10", "size-3", "size-4", "size-10"]);
    expect(dialog()!.textContent).toContain(PROJECTS_WORDS.imageNote);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(t.projectIcon).not.toHaveBeenCalled();
  });

  it("takes a file dropped on the row or pasted while it holds focus, and Use image sends the fitted PNG", async () => {
    const t = await projectPage();
    fireEvent.dragOver(t.row(), { dataTransfer: filesOf(logo()) });
    expect(t.row().className).toContain("bg-accent");
    fireEvent.drop(t.row(), { dataTransfer: filesOf(logo()) });
    expect(t.row().className).not.toContain("bg-accent");
    await waitFor(() => expect(dialog()?.querySelector("img")).toBeTruthy());
    fireEvent.click(dialog()!.querySelector("[data-k=project-icon-use]")!);
    await waitFor(() => expect(t.projectIcon).toHaveBeenCalledWith("pr_lab", btoa("fitted")));
    await waitFor(() => expect(dialog()).toBeNull());

    t.trigger().focus();
    fireEvent.paste(t.trigger(), { clipboardData: { files: [logo()] } });
    await waitFor(() => expect(dialog()).not.toBeNull());
    // A file that will not fit says why in the slot, in place of the note, and Use image stays held.
    fireEvent.paste(dialog()!, { clipboardData: { files: [new File([], "empty.png")] } });
    await waitFor(() => expect(dialog()!.textContent).toContain("wsp could not read this file as an image."));
    expect(dialog()!.textContent).not.toContain(PROJECTS_WORDS.imageNote);
    expect(dialog()!.querySelector<HTMLButtonElement>("[data-k=project-icon-use]")!.disabled).toBe(true);
    // A refusal leaves both grounds empty, not waiting.
    expect(dialog()!.querySelector("[role=status]")).toBeNull();
  });

  it("with an image worn, the trigger says Image, the row's reset and any glyph each clear it, and the hue keeps it", async () => {
    const t = await projectPage({ pr_lab: A });
    await waitFor(() => expect(t.trigger().textContent).toBe(PROJECTS_WORDS.iconImage));
    const offered = await pickOption(t.trigger(), "Book");
    expect(offered.at(-1)).toBe(PROJECTS_WORDS.chooseAnother);
    await waitFor(() => expect(t.projectIcon).toHaveBeenCalledWith("pr_lab", null));
    expect(t.sets).toEqual([{ projectLook: { pr_lab: { icon: "book", hue: "neutral" } } }]);
    t.projectIcon.mockClear();
    fireEvent.click(t.row().querySelector("[data-k=row-reset]")!);
    await waitFor(() => expect(t.projectIcon).toHaveBeenCalledWith("pr_lab", null));
    t.projectIcon.mockClear();
    await pickOption(document.querySelector<HTMLElement>("[data-settings-page] [data-k=project-hue]")!, "Teal");
    await settle();
    expect(t.projectIcon).not.toHaveBeenCalled();
  });

  it("a recipe's own glyph select offers no image", async () => {
    render(<IconSelect icon="rocket" hue="neutral" onChange={() => {}} />);
    const offered = await pickOption(document.querySelector("[data-k=project-icon]")!, "Book");
    expect(offered).toHaveLength(20);
    expect(document.querySelector("[data-slot=select-separator]")).toBeNull();
  });
});

describe("Add a project", () => {
  it("holds the image chosen before the project exists and sends it once the add answers the project's id", async () => {
    const projectIcon = vi.fn(async () => A);
    const addProject = vi.fn(async () => lab);
    useStore.setState({ api: { subscribe: () => () => {}, hostFolders: async () => ({ dir: "/Users/dev", roots: ["/Users/dev"], folders: [{ path: "/Users/dev/lab", repo: true }], hidden: 0 }), projectIcon } as unknown as Api, places: [here], projects: [], addProject, setPreferences: vi.fn(async () => {}) } as never);
    render(<AddProjectDialog onClose={() => {}} />);
    await settle();
    const add = document.querySelector<HTMLElement>("[data-k=add-project]")!;
    await pickOption(add.querySelector("[data-k=project-icon]")!, PROJECTS_WORDS.chooseImage);
    fireEvent.change(add.querySelector("[data-k=project-icon-file]")!, { target: { files: [logo()] } });
    await waitFor(() => expect(dialog()?.querySelector("img")).toBeTruthy());
    fireEvent.click(dialog()!.querySelector("[data-k=project-icon-use]")!);
    await waitFor(() => expect(add.querySelector("[data-k=project-icon]")!.textContent).toBe(PROJECTS_WORDS.iconImage));
    expect(projectIcon).not.toHaveBeenCalled();
    fireEvent.click(add.querySelector("[data-k=folder-row]")!);
    await waitFor(() => expect(projectIcon).toHaveBeenCalledWith("pr_lab", btoa("fitted")));
    expect(addProject).toHaveBeenCalled();
  });
});
