// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer as the dialog walks it against a fake host: the ssh hosts
// listed and picked, the install's steps as the checks, a host key asked and
// trusted, the picks starting from everything the computer running the host
// has and kept on the pending add as they move, the summary's Set up with a
// recipe saved, the running steps with a sign-in's wait and Retry, the ready
// page, and closing mid-setup said as a notice.
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLACE_HOST_KEY_KIND, RecipeFile, type PlaceAddJob, type PlaceAddStep, type EventUnion, type PendingComputer, type PlaceSetup, type PlaceView, type ProjectView, type RecipeOptions, type RecipeView } from "@wsp/protocol";
import { RequestError, type Api, type SshLogin } from "../src/protocol/client.js";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { closeAdd, openAdd, openPending, openSetup, useAddFlow } from "../src/settings/add/addFlow.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true, present: true, takesForks: false };
const studio: PlaceView = { id: "p_studio", kind: "computer", name: "studio", default: false, present: true, diskFreeBytes: 61 * 1024 ** 3 };
const OPTIONS: RecipeOptions = {
  agents: [
    { id: "claude", name: "Claude Code", signins: ["vault", "machine"] },
    { id: "codex", name: "Codex", signins: ["machine"] },
  ],
  mcp: [{ name: "context7", agents: ["claude", "codex"] }],
  clis: [{ name: "gh", via: "brew", version: "2.86.0" }],
  skills: [{ name: "unslop", from: "~/.claude/skills", linked: false }],
  plugins: [{ name: "frontend-design@claude-plugins-official" }],
  configs: [
    { id: "git", label: "git settings and identity" },
    { id: "github", label: "the GitHub sign-in" },
  ],
};
const wsp: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/zingzy/wsp" }, path: "/Users/zingzy/wsp", remote: "github.com/Zingzy/wsp", defaultBranch: "main", memoryKey: "k", memoryDir: "/m" } as ProjectView;
const RUNNING: PlaceSetup = { state: "running", addId: "a_set", startedAt: "2026-10-03T10:00:00.000Z", steps: [{ step: "floor", state: "done", ms: 72_000 }, { step: "agents", state: "running" }], waiting: [] };

interface Asked {
  adds: SshLogin[];
  chosen: { ref: string; choices: RecipeFile; recipe: string | undefined }[];
  setups: { ref: string; o: unknown }[];
  saved: { name: string; from: unknown }[];
}

/** A host that installs over ssh when asked, answering the add once the case lets it join. */
function host(over: Partial<Api> = {}, recipes: RecipeView[] = []) {
  const asked: Asked = { adds: [], chosen: [], setups: [], saved: [] };
  let join: ((p: PlaceView) => void) | undefined;
  const fake = settingsApi({
    sshHosts: async () => [
      { alias: "studio", hostName: "65.21.4.12", user: "root", from: "config" },
      { alias: "jumpbox", hostName: "jump.zingzy.dev", user: "ubuntu", from: "config" },
    ],
    addComputerOverSsh: (login: SshLogin) =>
      new Promise<PlaceView>(ok => {
        asked.adds.push(login);
        join = ok;
      }),
    recipesOptions: async () => OPTIONS,
    recipesList: async () => recipes,
    placesChoose: async (ref: string, choices: RecipeFile, recipe?: string) => {
      asked.chosen.push({ ref, choices, recipe });
      return { id: "a_1", address: "studio", step: "choosing", placeId: ref, startedAt: "x", choices } as PendingComputer;
    },
    placesSetup: async (ref: string, o: unknown) => {
      asked.setups.push({ ref, o });
      return { addId: "a_set", place: studio, setup: RUNNING };
    },
    recipesSave: async (name: string, from: unknown) => {
      asked.saved.push({ name, from });
      return { name, slug: name.toLowerCase(), summary: "", machines: ["studio"], file: RecipeFile.parse({ name }) };
    },
    ...over,
  } as Partial<Api>);
  return { ...fake, asked, joined: () => join?.(studio) };
}

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-add-computer]");
const step = (): string | null => dialog()?.getAttribute("data-add-computer") ?? null;
const title = (): string => dialog()?.querySelector("[data-slot=dialog-title]")?.textContent ?? "";
const progress = (): string => dialog()?.querySelector("[data-k=progress]")?.textContent ?? "";
const primary = (): HTMLButtonElement => dialog()!.querySelector<HTMLButtonElement>("[data-k=continue]")!;
const press = async (el: Element | null): Promise<void> => {
  fireEvent.click(el!);
  await settle();
};
const stage = (addId: string, s: PlaceAddStep, state: "running" | "done" | "failed", note?: string, placeId?: string): void =>
  act(() => useStore.getState().applyEvent({ type: "place.stage", addId, step: s, state, ...(note === undefined ? {} : { note }), ...(placeId === undefined ? {} : { placeId }) } as EventUnion));
const ticked = (id: string): boolean => dialog()!.querySelector(`[data-pick-row='${id}']`)?.getAttribute("data-checked") === "true";
const rest = (ms: number): Promise<void> => act(async () => void (await new Promise(r => setTimeout(r, ms))));

beforeEach(() => {
  resetSettings();
  useStore.setState({ places: [here], projects: [wsp] });
});

afterEach(() => {
  act(() => closeAdd());
  cleanup();
});

describe("Add a computer, from the address to Set up", () => {
  it("lists the ssh hosts, fills the field from a pick, and draws the install's steps as the checks", async () => {
    const fake = host();
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openAdd());
    await settle();
    expect([step(), title(), progress()]).toEqual(["where", "Add a computer", "1 of 11"]);
    expect([...dialog()!.querySelectorAll("[data-ssh-host]")].map(r => r.getAttribute("data-ssh-host"))).toEqual(["studio", "jumpbox"]);
    expect(primary().hasAttribute("data-held")).toBe(true);
    await press(dialog()!.querySelector("[data-ssh-host='studio']"));
    expect(dialog()!.querySelector<HTMLInputElement>("[data-k=where-field]")!.value).toBe("studio");
    await press(primary());
    expect(fake.asked.adds).toEqual([{ address: "studio" }]);
    expect(step()).toBe("checks");
    const addId = useAddFlow.getState().addId!;
    stage(addId, "connect", "done", "Ubuntu 24.04");
    stage(addId, "check", "running");
    stage(addId, "chip", "done", "Linux x86_64");
    stage(addId, "root", "running");
    const rows = () => [...dialog()!.querySelectorAll<HTMLElement>("[data-step-row]")].map(r => [r.dataset["stepRow"], r.dataset["state"]]);
    // Each check is its own row, in the order the host reads them.
    expect(rows()).toEqual([
      ["connect", "done"],
      ["chip", "done"],
      ["root", "working"],
      ["system", "waiting"],
      ["disk", "waiting"],
      ["reach", "waiting"],
      ["wsp", "waiting"],
    ]);
    const note = (id: string): string | null | undefined => dialog()!.querySelector(`[data-step-row='${id}']`)?.textContent;
    expect(note("chip")).toContain("Linux x86_64");
    // Continue stands held until the computer joined.
    expect(primary().hasAttribute("data-held")).toBe(true);
    stage(addId, "root", "done");
    stage(addId, "system", "done", "systemd, cgroup v2");
    stage(addId, "disk", "done", "61 GB free");
    stage(addId, "check", "done", "root, systemd, cgroup v2");
    expect(note("disk")).toContain("61 GB free");
    stage(addId, "reach", "done");
    stage(addId, "wsp", "done");
    stage(addId, "join", "done", undefined, studio.id);
    act(() => useStore.setState({ places: [here, studio] }));
    await act(async () => fake.joined());
    await settle();
    expect(rows().every(([, state]) => state === "done")).toBe(true);
    expect(useAddFlow.getState()).toMatchObject({ placeId: studio.id, pendingId: addId });
    expect(primary().hasAttribute("data-held")).toBe(false);
  });

  it("asks the person to trust a host key this computer never met, and adds again with the key they trusted", async () => {
    const key = "ssh-ed25519 SHA256:tK3mX9Qf2bWq8vRz0YhN4cL7pJd1sE6gA5uF8oH2kIw";
    const asked: SshLogin[] = [];
    // The host keeps the refused add with the key as a field under its kind; the sentence is never read for it.
    const kept: PlaceAddJob[] = [];
    const fake = host({
      addComputerOverSsh: async (login: SshLogin, addId: string) => {
        asked.push(login);
        if (login.hostKey !== undefined) return studio;
        kept.push({ addId, address: "studio", startedAt: "x", state: "failed", steps: [{ step: "connect", state: "failed" }], said: "studio has never been reached from this computer", kind: PLACE_HOST_KEY_KIND, hostKey: key });
        return Promise.reject(new RequestError("studio has never been reached from this computer", PLACE_HOST_KEY_KIND));
      },
      placesList: async () => ({ places: [here], adds: kept, pending: [] }),
    } as Partial<Api>);
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => {
      openAdd();
      useAddFlow.setState({ address: "studio" });
    });
    await settle();
    await press(primary());
    expect(step()).toBe("hostkey");
    expect(dialog()!.querySelector("[data-k=host-key]")?.textContent).toBe(key);
    expect(primary().textContent).toBe("Trust and connect");
    await press(primary());
    expect(asked).toEqual([{ address: "studio" }, { address: "studio", hostKey: key }]);
    expect(step()).toBe("checks");
  });

  it("puts a failed check's own sentence on its row, the rows after it never run", async () => {
    const fake = host();
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => {
      openAdd();
      useAddFlow.setState({ address: "jumpbox" });
    });
    await settle();
    await press(primary());
    const addId = useAddFlow.getState().addId!;
    stage(addId, "connect", "done", "Ubuntu 22.04");
    stage(addId, "check", "running");
    stage(addId, "chip", "done", "Linux arm64");
    stage(addId, "root", "running");
    stage(addId, "root", "failed", "jumpbox logs in as a user that is not root");
    const states = Object.fromEntries([...dialog()!.querySelectorAll<HTMLElement>("[data-step-row]")].map(r => [r.dataset["stepRow"], r.dataset["state"]]));
    expect(states).toEqual({ connect: "done", chip: "done", root: "failed", system: "waiting", disk: "waiting", reach: "waiting", wsp: "waiting" });
    expect(dialog()!.querySelector("[data-step-row='root'] [data-k=step-refusal]")?.textContent).toBe("jumpbox logs in as a user that is not root");
  });

  it("puts a refusal on the check that was running with Try again, which goes back to the address", async () => {
    const fake = host({ addComputerOverSsh: async () => Promise.reject(new RequestError("jumpbox logs in as a user that is not root", undefined, "Add it as root.")) } as Partial<Api>);
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => {
      openAdd();
      useAddFlow.setState({ address: "jumpbox" });
    });
    await settle();
    await press(primary());
    const failed = dialog()!.querySelector<HTMLElement>("[data-step-row][data-state=failed]")!;
    expect(failed.dataset["stepRow"]).toBe("connect");
    expect(failed.querySelector("[data-k=step-refusal]")?.textContent).toBe("jumpbox logs in as a user that is not root Add it as root.");
    await press(failed.querySelector("[data-k=try-again]"));
    expect(step()).toBe("where");
  });

  it("starts the picks from everything here, keeps each change on the pending add once, and says it is saved", async () => {
    const fake = host();
    useStore.setState({ places: [here, studio] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => useAddFlow.setState({ open: true, step: "agents", placeId: studio.id, pendingId: "a_1", address: "studio" }));
    await settle();
    expect([step(), title(), progress()]).toEqual(["agents", "Agents", "3 of 11"]);
    await waitFor(() => expect(ticked("claude") && ticked("codex")).toBe(true));
    expect(dialog()!.querySelector("[data-k=saved]")?.textContent).toBe("Saved, you can finish later");
    fireEvent.click(dialog()!.querySelector("[data-pick-row='codex'] [role=checkbox]")!);
    fireEvent.click(dialog()!.querySelector("[data-pick-row='codex'] [role=checkbox]")!);
    fireEvent.click(dialog()!.querySelector("[data-pick-row='codex'] [role=checkbox]")!);
    await rest(450);
    // A burst of changes is one write, the last.
    expect(fake.asked.chosen).toHaveLength(1);
    expect(fake.asked.chosen[0]).toMatchObject({ ref: studio.id, recipe: undefined });
    expect(Object.keys(fake.asked.chosen[0]!.choices.agents)).toEqual(["claude"]);
    expect(Object.keys(fake.asked.chosen[0]!.choices.folders)).toEqual(["wsp"]);
    await press(primary());
    expect(step()).toBe("mcp");
    await press(dialog()!.querySelector("[data-k=back]"));
    expect(step()).toBe("agents");
    expect(ticked("codex")).toBe(false);
  });

  it("holds Continue on Import projects while a project's name is one the computer already has", async () => {
    const fake = host();
    const there: ProjectView = { ...wsp, id: "pr_there", computer: studio.id };
    useStore.setState({ places: [here, studio], projects: [wsp, there] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => useAddFlow.setState({ open: true, step: "projects", placeId: studio.id, pendingId: "a_1", address: "studio" }));
    await settle();
    await waitFor(() => expect(ticked("wsp")).toBe(true));
    expect(dialog()!.querySelector("[data-k=name-taken]")?.textContent).toBe("studio already has a project called wsp.");
    expect(primary().hasAttribute("data-held")).toBe(true);
    fireEvent.change(dialog()!.querySelector("[data-k=project-name]")!, { target: { value: "wsp-box" } });
    expect(dialog()!.querySelector("[data-k=name-taken]")).toBeNull();
    expect(primary().hasAttribute("data-held")).toBe(false);
  });

  it("sets the computer up from the summary with the picks, saves them as a recipe it follows, and goes on to the running steps", async () => {
    const fake = host();
    useStore.setState({ places: [here, studio] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => useAddFlow.setState({ open: true, step: "summary", placeId: studio.id, pendingId: "a_1", address: "studio" }));
    await settle();
    await waitFor(() => expect(dialog()!.querySelector("[data-settings-line='Agents'] [data-settings-word]")?.textContent).toBe("Claude Code, Codex"));
    expect(dialog()!.querySelector("[data-k=disk]")?.textContent).toBe("61 GB free");
    expect(primary().textContent).toBe("Set up studio");
    fireEvent.click(dialog()!.querySelector("[data-pick-row='save'] [role=checkbox]")!);
    fireEvent.change(dialog()!.querySelector("[data-k=recipe-name]")!, { target: { value: "Builders" } });
    await press(primary());
    await settle();
    expect(fake.asked.setups).toHaveLength(1);
    expect(fake.asked.setups[0]!.ref).toBe(studio.id);
    expect(Object.keys((fake.asked.setups[0]!.o as { choices: RecipeFile }).choices.agents)).toEqual(["claude", "codex"]);
    expect(fake.asked.saved).toEqual([{ name: "Builders", from: { computer: studio.id } }]);
    expect(fake.sets).toContainEqual({ recipeLook: { builders: { icon: "rocket" } } });
    expect(step()).toBe("running");
    // The run the host answered stands on the row at once, so its frames fold onto it.
    expect(useStore.getState().places.find(p => p.id === studio.id)?.setup).toEqual(RUNNING);
  });

  it("offers Start from where a recipe is saved, and a pick there takes the recipe's rows", async () => {
    const builders: RecipeView = { name: "Builders", slug: "builders", summary: "1 agent", machines: ["spoo"], file: RecipeFile.parse({ name: "Builders", agents: { codex: { signin: "machine" } } }) };
    const fake = host({}, [builders]);
    useStore.setState({ places: [here, studio] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => useAddFlow.setState({ open: true, step: "startfrom", placeId: studio.id, pendingId: "a_1", address: "studio" }));
    await settle();
    expect([title(), progress()]).toEqual(["Start from", "3 of 12"]);
    expect([...dialog()!.querySelectorAll("[data-choice]")].map(c => c.getAttribute("data-choice"))).toEqual(["here", "builders", "none"]);
    await press(dialog()!.querySelector("[data-choice='builders'] [role=radio]"));
    await rest(450);
    expect(fake.asked.chosen.at(-1)).toMatchObject({ recipe: "builders" });
    expect(Object.keys(useAddFlow.getState().picks!.agents)).toEqual(["codex"]);
  });
});

describe("Add a computer while the setup runs", () => {
  const placed = (setup: PlaceSetup, applied?: PlaceView["applied"]): PlaceView => ({ ...studio, setup, ...(applied === undefined ? {} : { applied }) });

  it("draws the running steps with a sign-in's code and its tab, and says the header and the count", async () => {
    const wait = { row: "signins/codex", label: "Codex", url: "https://auth.openai.com/device", code: "4F2K-9QJM", expiresAt: "2026-10-03T10:10:00.000Z", state: "waiting" as const };
    useStore.setState({ places: [here, placed({ ...RUNNING, waiting: [wait] })] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    expect([title(), progress()]).toEqual(["Setting up studio", "2 of 10 done"]);
    expect(dialog()!.querySelector("[data-slot=dialog-description]")?.textContent).toBe("You can close this. Setup keeps going.");
    const signIn = dialog()!.querySelector<HTMLElement>("[data-step-row='signins/codex']")!;
    expect(signIn.dataset["state"]).toBe("needs-you");
    expect(signIn.querySelector("[data-k=sign-in-code]")?.textContent).toBe("4F2K-9QJM");
    expect(signIn.querySelector("[data-k=open-tab]")?.textContent).toBe("Open the tab again");
    expect(dialog()!.querySelector("[data-step-row='mcp']")?.getAttribute("data-state")).toBe("waiting");
  });

  it("scrolls to the first row that needs the person once, when it first appears, and not on the frames after", async () => {
    const scrolled: string[] = [];
    const was = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-step-row") ?? "");
    };
    try {
      useStore.setState({ places: [here, placed(RUNNING)] });
      mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
      // The rows say whether one needs the person: the page is not searched on a render that brings none.
      const searched: string[] = [];
      const query = Document.prototype.querySelector;
      Document.prototype.querySelector = function (this: Document, selector: string) {
        if (selector.includes("data-step-row")) searched.push(selector);
        return query.call(this, selector);
      } as typeof query;
      try {
        act(() => openSetup(studio.id));
        await settle();
        for (const step of ["agents", "mcp", "clis"] as const) {
          act(() => useStore.setState({ places: [here, placed({ ...RUNNING, steps: [...RUNNING.steps, { step, state: "running" }] })] }));
          await settle();
        }
      } finally {
        Document.prototype.querySelector = query;
      }
      expect(searched).toEqual([]);
      expect(scrolled).toEqual([]);
      const wait = { row: "signins/codex", label: "Codex", code: "4F2K", expiresAt: "x", state: "waiting" as const };
      act(() => useStore.setState({ places: [here, placed({ ...RUNNING, waiting: [wait] })] }));
      await settle();
      expect(scrolled).toEqual(["signins/codex"]);
      act(() => useStore.setState({ places: [here, placed({ ...RUNNING, steps: [...RUNNING.steps, { step: "mcp", state: "running" }], waiting: [wait] })] }));
      await settle();
      expect(scrolled).toEqual(["signins/codex"]);
    } finally {
      Element.prototype.scrollIntoView = was;
    }
  });

  it("offers Retry on a row that did not land, which runs the setup again for what is missing", async () => {
    const fake = host();
    const done: PlaceSetup = { ...RUNNING, state: "done", steps: [{ step: "floor", state: "done" }, { step: "skills", state: "failed", note: "1 of 2 failed" }] };
    useStore.setState({ places: [here, placed(done, { hash: "h", at: "x", rows: [{ id: "skills/a", label: "unslop", outcome: "installed", step: "skills" }, { id: "skills/b", label: "taste", outcome: "failed", step: "skills", note: "a link inside points at a folder" }] })] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    expect(title()).toBe("studio needs you");
    const row = dialog()!.querySelector<HTMLElement>("[data-step-row='skills/b']")!;
    expect(row.querySelector("[data-k=step-refusal]")?.textContent).toBe("a link inside points at a folder");
    await press(row.querySelector("[data-k=retry]"));
    expect(fake.asked.setups).toEqual([{ ref: studio.id, o: {} }]);
  });

  it("goes on to the ready page once every step is done, whose act starts a task on that computer", async () => {
    const ready: PlaceSetup = { ...RUNNING, state: "done", finishedAt: "2026-10-03T10:06:12.000Z", steps: [{ step: "floor", state: "done" }] };
    const there: ProjectView = { ...wsp, id: "pr_there", computer: studio.id };
    useStore.setState({ places: [here, { ...placed(ready), picks: RecipeFile.parse({ name: "studio", agents: { claude: {} } }) }], projects: [wsp, there] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    expect(title()).toBe("studio is ready");
    expect(dialog()!.querySelector("[data-slot=dialog-description]")?.textContent).toBe("Set up in 6m 12s.");
    await press(primary());
    expect(step()).toBe("ready");
    expect(dialog()!.querySelector("[data-k=ready-title]")?.textContent).toBe("studio is ready");
    expect(dialog()!.querySelector("[data-k=ready-wash]")).not.toBeNull();
    await press(dialog()!.querySelector("[data-k=start-task]"));
    expect(useAddFlow.getState().open).toBe(false);
    expect(useStore.getState().projectHome).toBe("pr_there");
  });

  it("says closing mid-setup is fine in a notice whose Open brings the dialog back", async () => {
    useStore.setState({ places: [here, placed(RUNNING)] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    await press(dialog()!.querySelector("[data-k=close]"));
    expect(dialog()).toBeNull();
    const notice = useNotices.getState().notices.at(-1)!;
    expect([notice.text, notice.where]).toEqual(["Setup keeps going. wsp pings you when it needs you.", "studio"]);
    act(() => notice.action!.run());
    await settle();
    expect(step()).toBe("running");
  });

  it("opens a pending add where it was left, with its picks", async () => {
    const fake = host();
    useStore.setState({ places: [here, studio] });
    const pending: PendingComputer = { id: "a_1", address: "studio", step: "choosing", placeId: studio.id, startedAt: "x", choices: RecipeFile.parse({ name: "studio", clis: { gh: { via: "brew" } } }) };
    localStorage.setItem("wsp:add-reached", JSON.stringify({ a_1: "clis" }));
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openPending(pending, 0));
    await settle();
    expect(step()).toBe("clis");
    await waitFor(() => expect(ticked("gh")).toBe(true));
    // Picks already made are not filled from everything again.
    expect(useAddFlow.getState().picks!.mcp).toEqual({});
    expect(fake.asked.chosen).toEqual([]);
    // Its first pick has no install of this window's to go back to.
    act(() => closeAdd());
    act(() => openPending({ ...pending, id: "a_2" }, 0));
    await settle();
    expect(step()).toBe("agents");
    expect(dialog()!.querySelector("[data-k=back]")).toBeNull();
  });
});
