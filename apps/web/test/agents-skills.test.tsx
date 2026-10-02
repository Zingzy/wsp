// SPDX-License-Identifier: AGPL-3.0-only
// Skills in a task's panel: a skill's page draws its SKILL.md, read by the
// host once, in the renderer's restricted mode; its switch and Remove go to
// the host, Remove only once its confirmation is taken; the skill wsp writes
// and a plugin's offer nothing and a project's has no switch; Add skill opens
// a search the host sends to skills.sh, and a result opens its page with its
// SKILL.md before install, the agents to put it in and the project.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport, AgentsTarget, SkillHit, SkillPreview } from "@wsp/protocol";
import { AgentsPanel } from "../src/components/agents/AgentsPanel.js";
import { AGENTS_LIST_WORDS as W, type RowsContext } from "../src/components/agents/agentsRows.js";
import { useSkillActs } from "../src/components/agents/useSkillActs.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { pickOption } from "./select.js";
import { back, factsOf, head, headAct, headActs, headTitle, NOW, openRow, panel, rowOf, tab } from "./agents-panel-harness.js";
const SKILL_MD = "---\nname: frontend-design\ndescription: Design frontends\n---\n# Frontend design\n\nPick a bold direction.\n";
const HITS: SkillHit[] = [
  { id: "anthropics/skills/pdf", source: "anthropics/skills", skillId: "pdf", name: "pdf", installs: 3_612_000 },
  { id: "acme/kit/frontend-design", source: "acme/kit", skillId: "frontend-design", name: "frontend-design", installs: 1_200 },
];

function List({ report = AGENTS_REPORT, ctx = {} }: { report?: AgentsReport; ctx?: Partial<RowsContext> }) {
  const skills = useSkillActs(report.target);
  return <AgentsPanel on={{ name: "spoo" }} read={{ report, reading: false, error: null, readAt: NOW, refresh: () => {} }} ctx={{ where: "box", heldWhy: null, ...ctx, ...(skills === undefined ? {} : { skills }) }} now={NOW} />;
}

type Settle<T> = { resolve(v: T): void; reject(e: Error): void };

function host(o: { preview?: SkillPreview; searchFails?: string } = {}) {
  const previews: [AgentsTarget, string, boolean][] = [];
  const gets: string[] = [];
  const searches: string[] = [];
  const toggles: [string, boolean, boolean][] = [];
  const removes: string[] = [];
  const adds: [string, readonly string[], boolean][] = [];
  const pending: Settle<void>[] = [];
  const wait = (): Promise<void> => new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  useStore.setState({
    api: {
      skillsPreview: async (target: AgentsTarget, name: string, project: boolean) => (previews.push([target, name, project]), o.preview ?? { text: SKILL_MD, size: SKILL_MD.length }),
      skillsGet: async (skill: string) => (gets.push(skill), { text: "---\nname: pdf\n---\n# pdf\n\nFill forms.\n", size: 40 }),
      skillsSearch: async (q: string) => {
        searches.push(q);
        if (o.searchFails !== undefined) throw new Error(o.searchFails);
        return q === "zzz" ? [] : HITS;
      },
      skillsToggle: async (_t: AgentsTarget, name: string, project: boolean, on: boolean) => (toggles.push([name, project, on]), wait()),
      skillsRemove: async (_t: AgentsTarget, name: string) => (removes.push(name), wait()),
      skillsAdd: async (_t: AgentsTarget, skill: string, agents: readonly string[], project: boolean) => (adds.push([skill, agents, project]), { path: "~/.agents/skills/pdf", agents: [] }),
    } as unknown as Api,
  });
  return { previews, gets, searches, toggles, removes, adds, pending };
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
};
const FRONTEND = "skill-user-frontend-design";
const preview = (): HTMLElement | null => panel().querySelector<HTMLElement>("[data-settings-card=kind-doc]");
const typeSearch = (value: string): void => void fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=add-search]")!, { target: { value } });
const add = (): HTMLButtonElement => panel().querySelector<HTMLButtonElement>("[data-k=kind-add]")!;
const turn = (): HTMLButtonElement | null => head().querySelector<HTMLButtonElement>("[data-k=kind-on]");
const removeAct = (): HTMLButtonElement => panel().querySelector<HTMLButtonElement>("[data-settings-card=kind-remove] [data-k=act-remove]")!;
const found = (key: string): HTMLElement => panel().querySelector<HTMLElement>(`[data-found-row="${key}"]`)!;

afterEach(() => {
  cleanup();
  useStore.setState({ api: null });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a skill's page", () => {
  it("draws its SKILL.md, its frontmatter off, read by the host once as the page opens", async () => {
    const h = host();
    render(<List />);
    tab("Skills");
    openRow(FRONTEND);
    await settle();
    expect(h.previews).toEqual([[{ placeId: "p_spoo" }, "frontend-design", false]]);
    const body = preview()!.querySelector<HTMLElement>("[data-k=skill-preview-body]")!;
    expect(body.querySelector("h1")?.textContent).toBe("Frontend design");
    expect(body.textContent).not.toContain("description: Design frontends");
    expect(preview()!.querySelector("[data-k=skill-preview-cut]")).toBeNull();
    back();
    openRow(FRONTEND);
    await settle();
    expect(h.previews).toHaveLength(1);
  });

  it("reads the SKILL.md again off the new computer when the target under an open page changes", async () => {
    const h = host();
    const { rerender } = render(<List />);
    tab("Skills");
    openRow(FRONTEND);
    await settle();
    rerender(<List report={{ ...AGENTS_REPORT, target: { placeId: "p_other" } }} />);
    await settle();
    expect(h.previews.map(([target]) => target)).toEqual([{ placeId: "p_spoo" }, { placeId: "p_other" }]);
    expect(preview()!.querySelector("[data-k=skill-preview-body] h1")?.textContent).toBe("Frontend design");
  });

  it("says how much of a long SKILL.md it shows, and the host's sentence where the read was refused", async () => {
    host({ preview: { text: "# big\n", size: 130 * 1024 } });
    render(<List />);
    tab("Skills");
    openRow(FRONTEND);
    await settle();
    expect(preview()!.querySelector("[data-k=skill-preview-cut]")?.textContent).toBe("shows the first 64 KB of 130 KB");
    cleanup();
    useStore.setState({ api: { skillsPreview: async () => Promise.reject(new Error("The SKILL.md of pdf could not be read.")) } as unknown as Api });
    render(<List />);
    tab("Skills");
    openRow(FRONTEND);
    await settle();
    expect(preview()!.querySelector("[data-k=skill-preview-refused]")?.textContent).toContain("The SKILL.md of pdf could not be read.");
  });

  it("turns a skill off through the host from its switch, holds it while it runs, and reads off once the report says so", async () => {
    const h = host();
    const { rerender } = render(<List />);
    tab("Skills");
    openRow(FRONTEND);
    expect(turn()?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(turn()!);
    expect(h.toggles).toEqual([["frontend-design", false, false]]);
    expect(turn()?.hasAttribute("data-disabled") || turn()?.getAttribute("aria-disabled") === "true" || turn()?.disabled).toBe(true);
    await act(async () => h.pending[0]!.resolve());
    const off: AgentsReport = { ...AGENTS_REPORT, skills: AGENTS_REPORT.skills.map(s => (s.name === "frontend-design" ? { ...s, paths: s.paths.map(p => ({ ...p, off: true as const })) } : s)) };
    rerender(<List report={off} />);
    expect(turn()?.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(turn()!);
    expect(h.toggles.at(-1)).toEqual(["frontend-design", false, true]);
    await act(async () => h.pending[1]!.reject(new Error("mv: Permission denied")));
    expect(panel().querySelector("[data-k=kind-refused]")?.textContent).toContain("mv: Permission denied");
    back();
    expect(rowOf(FRONTEND).querySelector<HTMLButtonElement>("[data-k=kind-on]")?.getAttribute("aria-checked")).toBe("false");
  });

  it("removes a skill only once the confirmation is taken, whose own button is the red one", async () => {
    const h = host();
    render(<List />);
    tab("Skills");
    openRow(FRONTEND);
    fireEvent.click(removeAct());
    expect(h.removes).toEqual([]);
    const asking = await screen.findByRole("alertdialog");
    expect(within(asking).getByText("Remove frontend-design?")).toBeTruthy();
    expect(within(asking).getByText("Its folder and every link to it leave spoo.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: W.cancel }));
    await settle();
    expect(h.removes).toEqual([]);
    fireEvent.click(removeAct());
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: W.remove });
    expect(confirm.getAttribute("data-k")).toBe("confirm-remove-go");
    expect(confirm.className).toContain("bg-destructive");
    expect(removeAct().className).not.toContain("bg-destructive");
    fireEvent.click(confirm);
    expect(h.removes).toEqual(["frontend-design"]);
  });

  it("offers nothing on the skill wsp writes or a plugin's, and no switch on a project's, which lives in its repo", () => {
    const h = host();
    render(<List />);
    tab("Skills");
    for (const key of ["skill-user-wsp", "skill-plugin-pdf", "skill-project-pr_wsp-wsp-review"]) {
      openRow(key);
      expect(turn(), key).toBeNull();
      expect(headActs(), key).toEqual([]);
      back();
    }
    expect(h.toggles).toEqual([]);
  });
});

describe("Add a skill", () => {
  it("opens a search the host sends to skills.sh once the person pauses, and never an empty one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = host();
    render(<List />);
    tab("Skills");
    expect(add().disabled).toBe(false);
    fireEvent.click(add());
    expect(panel().querySelector("[data-k=agents-back]")?.textContent).toBe("Skills");
    expect(panel().querySelector<HTMLInputElement>("[data-k=add-search]")?.placeholder).toBe(W.searchSkillsSh);
    expect(panel().querySelector("[data-settings-line=add-none]")?.textContent).toBe(W.typeToSearch);
    typeSearch("p");
    typeSearch("pd");
    typeSearch("pdf");
    expect(h.searches).toEqual([]);
    await act(async () => void vi.advanceTimersByTime(260));
    await settle();
    expect(h.searches).toEqual(["pdf"]);
    const rows = [...panel().querySelectorAll<HTMLElement>("[data-found-row]")];
    expect(rows.map(r => [r.querySelector("[data-settings-title]")?.textContent, r.querySelector("[data-settings-description]")?.textContent, r.querySelector("[data-settings-word]")?.textContent])).toEqual([
      ["pdf", "anthropics/skills", "3.6M"],
      ["frontend-design", "acme/kit", W.installed],
    ]);
    typeSearch("   ");
    await act(async () => void vi.advanceTimersByTime(260));
    expect(h.searches).toEqual(["pdf"]);
    typeSearch("zzz");
    fireEvent.keyDown(panel().querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    expect(h.searches).toEqual(["pdf", "zzz"]);
    expect(panel().querySelector("[data-settings-line=add-none]")?.textContent).toBe(W.noHits("zzz"));
  });

  it("says why a search came back with nothing where the host refused it", async () => {
    host({ searchFails: "skills.sh did not answer: getaddrinfo ENOTFOUND skills.sh" });
    render(<List />);
    tab("Skills");
    fireEvent.click(add());
    typeSearch("pdf");
    fireEvent.keyDown(panel().querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    expect(panel().querySelector("[data-settings-line=add-none]")?.textContent).toBe("skills.sh did not answer: getaddrinfo ENOTFOUND skills.sh");
  });

  it("opens a result's page with its SKILL.md off skills.sh before install, the agents to switch on, and Install with the picks, the back going to what was found", async () => {
    const h = host();
    render(<List />);
    tab("Skills");
    fireEvent.click(add());
    typeSearch("pdf");
    fireEvent.keyDown(panel().querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(found("anthropics/skills/pdf"));
    await settle();
    expect(h.gets).toEqual(["anthropics/skills/pdf"]);
    expect(headTitle()).toBe("pdf");
    expect(factsOf().map(f => f[1])).toEqual(["anthropics/skills", "3.6M"]);
    expect(preview()!.querySelector("[data-k=skill-preview-body] h1")?.textContent).toBe("pdf");
    expect(headActs()).toEqual(["Install pdf"]);
    // Codex and OpenCode read the shared folder, so they stand on and held; Claude Code takes a link of its own.
    const option = (id: string): HTMLElement => panel().querySelector<HTMLElement>(`[data-settings-row="choice-agents-${id}"]`)!;
    expect(["claude", "codex", "opencode"].map(id => option(id) !== null)).toEqual([true, true, true]);
    expect(option("codex").querySelector("[data-settings-description]")?.textContent).toBe(W.readsShared);
    expect(panel().querySelector("[data-k=where-pick]")?.textContent).toBe(W.global);
    fireEvent.click(option("claude").querySelector("[data-k=choice-on]")!);
    fireEvent.click(headAct("install")!);
    expect(h.adds).toEqual([["anthropics/skills/pdf", [], false]]);
    const backButton = panel().querySelector<HTMLButtonElement>("[data-k=agents-back]")!;
    expect(backButton.textContent).toBe(W.addSkill);
    back();
    expect(panel().querySelector<HTMLInputElement>("[data-k=add-search]")?.value).toBe("pdf");
    expect(found("anthropics/skills/pdf")).not.toBeNull();
  });

  it("from a task's panel, asks whether it goes in the project, and a skill already there is held", async () => {
    const h = host();
    render(<List ctx={{ where: "here" }} />);
    tab("Skills");
    fireEvent.click(add());
    typeSearch("pdf");
    fireEvent.keyDown(panel().querySelector("[data-k=add-search]")!, { key: "Enter" });
    await settle();
    fireEvent.click(found("anthropics/skills/pdf"));
    await pickOption(panel().querySelector("[data-k=where-pick]")!, /^wsp/);
    fireEvent.click(headAct("install")!);
    expect(h.adds).toEqual([["anthropics/skills/pdf", ["claude"], true]]);
    back();
    fireEvent.click(found("acme/kit/frontend-design"));
    expect(head().querySelector("[data-k=kind-status]")?.textContent).toBe("Installed");
    expect(headAct("install")).toBeNull();
  });

  it("holds Add where the client carries no skills road, and a task on a box holds it for that box's page", () => {
    useStore.setState({ api: {} as unknown as Api });
    render(<List />);
    tab("Skills");
    expect(add().disabled).toBe(true);
    cleanup();
    host();
    render(<List ctx={{ where: "box-task", computer: "spoo" }} />);
    tab("Skills");
    expect(add().disabled).toBe(true);
    expect(add().closest("[title]")?.getAttribute("title")).toBe("on spoo's page");
  });
});
