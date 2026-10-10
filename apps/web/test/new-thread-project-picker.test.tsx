// SPDX-License-Identifier: AGPL-3.0-only
// The two lists New thread picks a project from, the heading's picker and the
// palette's page of projects, each ending with New project, which raises the
// same add-project request the sidebar's row raises; the sidebar's answer to it
// is held here by the same two lines it runs, and its own row is held to that
// answer in sidebar.test.tsx.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostFolderListing, PlaceView, ProjectView } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { NEW_THREAD_PAGE, buildPaletteItems } from "../src/components/palette/paletteItems.js";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "../src/components/palette/CommandPalette.logic.js";
import { HomeProjectPicker } from "../src/shell/NewThreadPicks.js";
import { onAddProjectRequest } from "../src/shell/shellRequests.js";
import { AddProjectDialog } from "../src/sidebar/AddProjectDialog.js";
import { PROJECT_WORDS } from "../src/sidebar/words.js";

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: true, present: true } as PlaceView;
const project = (id: string, name: string, path: string): ProjectView => ({ id, name, computer: "here", source: { kind: "folder", path }, path, remote: "", defaultBranch: "main", memoryKey: "-x", memoryDir: "/x", createdAt: "t" });
const ACME = project("pr_acme", "acme", "/Users/dev/code/acme");
const LAB = project("pr_lab", "lab", "/Users/dev/code/lab");
const REPOS: HostFolderListing = { dir: "/Users/dev", roots: ["/Users/dev"], folders: [{ path: LAB.path, repo: true, branch: "main" }], hidden: 0 };

/** The heading as ProjectHome draws it, on the project the store has home, beside the sidebar's answer to the request. */
function Heading() {
  const home = useStore(s => s.projects.find(p => p.id === s.projectHome));
  const [adding, setAdding] = useState(false);
  useEffect(() => onAddProjectRequest(() => setAdding(true)), []);
  return (
    <>
      {home === undefined ? null : <HomeProjectPicker project={home} />}
      {adding ? <AddProjectDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

afterEach(() => {
  cleanup();
  useStore.setState({ api: null, places: [], projects: [], projectHome: null } as never);
});

describe("the New thread project pickers", () => {
  it("ends with Add a project under the sidebar's own glyph, whose dialog picks the project it records", async () => {
    const projectsAdd = vi.fn(async () => LAB);
    const hostFolders = vi.fn(async () => REPOS);
    useStore.setState({ api: { subscribe: () => () => {}, hostFolders, projectsAdd } as unknown as Api, places: [HERE], projects: [ACME], projectHome: ACME.id } as never);
    render(<Heading />);
    const trigger = () => document.querySelector<HTMLElement>("[data-new-thread-project]")!;
    expect(trigger().dataset["newThreadProject"]).toBe(ACME.id);
    fireEvent.click(trigger());
    const items = await screen.findAllByRole("menuitem");
    const last = items.at(-1)!;
    expect(last.textContent).toBe(PROJECT_WORDS.add);
    expect(last.hasAttribute("data-new-thread-add-project")).toBe(true);
    expect(last.querySelector("svg.lucide-plus")).not.toBeNull();
    expect([...document.querySelectorAll("[role=menuitem], [role=menuitemradio]")].map(el => el.textContent)).toEqual([ACME.name, PROJECT_WORDS.add]);

    fireEvent.click(last);
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).not.toBeNull());
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>("[data-k=folder-row]");
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => fireEvent.click(row));
    expect(projectsAdd).toHaveBeenCalledWith(LAB.path, undefined, undefined);
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).toBeNull());
    expect(trigger().dataset["newThreadProject"]).toBe(LAB.id);
    expect(trigger().textContent).toBe(LAB.name);
  });

  it("the palette's page of projects New thread asks from ends with Add a project too, which opens the same dialog", async () => {
    const addProject = vi.fn();
    const openProjectHome = vi.fn();
    const items = buildPaletteItems({ projects: [], selectedId: null, query: "", messageHits: [], canCreate: true, recorded: [ACME], picks: [ACME], asks: true, handlers: { addProject, openProjectHome } as never, verbs: {} as never, places: [HERE] });
    const page = items.actionItems.find((item): item is CommandPaletteSubmenuItem => item.value === NEW_THREAD_PAGE)!;
    const rows = page.groups.flatMap(group => group.items) as CommandPaletteActionItem[];
    expect(rows.map(row => row.title)).toEqual([ACME.name, PROJECT_WORDS.add]);
    expect(render(<>{rows.at(-1)!.icon}</>).container.querySelector("svg.lucide-plus")).not.toBeNull();
    await rows.at(-1)!.run();
    expect(addProject).toHaveBeenCalledOnce();
    expect(openProjectHome).not.toHaveBeenCalled();
  });
});
