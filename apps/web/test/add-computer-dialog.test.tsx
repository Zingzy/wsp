// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer as the dialog walks it against a fake host: the ssh hosts
// listed and picked, the install's steps as the checks, a host key asked and
// trusted, the picks starting from everything the computer running the host
// has and kept on the pending add as they move, the summary's Set up with a
// recipe saved, the running steps with a sign-in's wait and Retry, the ready
// page, and closing mid-setup said as a notice.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AT_ITS_TERMINAL, PLACE_HOST_KEY_KIND, closedBeforeSignInLine, PLACE_SUDO_KIND, RecipeFile, SKIPPED_FOR_NOW, copiedFromLine, noCopyLine, signInThereFix, signInWithFix, type AgentsSignInEvent, type AgentsTarget, type AgentRow, type AgentsReport, type PlaceAddJob, type PlaceAddStep, type EventUnion, type PendingComputer, type PlaceSetup, type PlaceView, type ProjectView, type RecipeOptions, type RecipeView } from "@wsp/protocol";
import { RequestError, type Api, type SshLogin } from "../src/protocol/client.js";
import { useNotices } from "../src/notices/store.js";
import { useStore } from "../src/protocol/store.js";
import { closeAdd, openAdd, openPending, openSetup, useAddFlow } from "../src/settings/add/addFlow.js";
import { fromRecipe, githubPick } from "../src/settings/add/choices.js";
import { useAdds } from "../src/settings/adds.js";
import { useRecipes } from "../src/settings/recipesStore.js";
import { stepLogs } from "../src/settings/add/setup.js";
import { forgetSignIns } from "../src/components/agents/useAgentActs.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { mountSettings, resetSettings, settingsApi, settle } from "./settings-harness.js";
import { noDaemonApi } from "./fake-daemon-api.js";

/** Every command's first word: the parity test holds the skill to name every line of the host's command table as
 * `wsp <words>`, and the host's own sources import nothing a DOM test can load. */
const VERBS = [...new Set([...readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../skills/wsp/SKILL.md"), "utf8").matchAll(/`wsp ([a-z][a-z-]*)/g)].map(m => m[1]!))];
const WSP_COMMAND = new RegExp(`wsp (${VERBS.join("|")})\\b`);

const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", label: "zingzy's MacBook Pro", default: true, present: true, takesForks: false };
const studio: PlaceView = { id: "p_studio", kind: "computer", name: "studio", default: false, present: true, diskFreeBytes: 61 * 1024 ** 3 };
const OPTIONS: RecipeOptions = {
  agents: [
    { id: "claude", name: "Claude Code", signins: ["vault"] },
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
const wsp: ProjectView = { id: "pr_wsp", name: "wsp", computer: "here", source: { kind: "folder", path: "/Users/zingzy/wsp" }, path: "/Users/zingzy/wsp", remote: "github.com/wsp-labs/wsp", defaultBranch: "main", memoryKey: "k", memoryDir: "/m" } as ProjectView;
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
  // The options a dialog read outlive it on purpose; each case starts from a window that read none.
  useAddFlow.setState({ options: null });
});

afterEach(() => {
  act(() => closeAdd());
  cleanup();
  forgetSignIns();
});

describe("Add a computer, from the address to Set up", () => {
  it("lists the ssh hosts, fills the field from a pick, and draws the install's steps as the checks", async () => {
    const fake = host();
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openAdd());
    await settle();
    expect([step(), title(), progress()]).toEqual(["where", "Add a computer", "1 of 11"]);
    expect([...dialog()!.querySelectorAll("[data-choice]")].map(r => r.getAttribute("data-choice"))).toEqual(["studio", "jumpbox"]);
    expect(primary().hasAttribute("data-held")).toBe(true);
    const checked = () => [...dialog()!.querySelectorAll("[data-choice]")].filter(r => r.querySelector("[role=radio]")?.getAttribute("aria-checked") === "true").map(r => r.getAttribute("data-choice"));
    expect(checked()).toEqual([]);
    await press(dialog()!.querySelector("[data-choice='studio']"));
    expect(dialog()!.querySelector<HTMLInputElement>("[data-k=where-field]")!.value).toBe("studio");
    // The host the field names reads picked, whether it was clicked or typed.
    expect(checked()).toEqual(["studio"]);
    act(() => useAddFlow.setState({ address: "jumpbox" }));
    expect(checked()).toEqual(["jumpbox"]);
    act(() => useAddFlow.setState({ address: "studio" }));
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
    act(() => useStore.setState({ places: [here, studio] }));
    act(() => fake.joined());
    await settle();
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

  it("asks on the root row for the password a login's sudo asks for, once, and adds again with it and the trusted key, held nowhere else", async () => {
    const key = "ssh-ed25519 SHA256:tK3mX9Qf2bWq8vRz0YhN4cL7pJd1sE6gA5uF8oH2kIw";
    const asked: SshLogin[] = [];
    const kept: PlaceAddJob[] = [];
    let refuse: (() => void) | undefined;
    const fake = host({
      addComputerOverSsh: (login: SshLogin, addId: string) => {
        asked.push(login);
        if (login.hostKey === undefined) {
          kept.push({ addId, address: "jumpbox", startedAt: "x", state: "failed", steps: [{ step: "connect", state: "failed" }], said: "jumpbox has never been reached from this computer", kind: PLACE_HOST_KEY_KIND, hostKey: key });
          return Promise.reject(new RequestError("jumpbox has never been reached from this computer", PLACE_HOST_KEY_KIND));
        }
        if (login.sudoPassword !== undefined) return new Promise<PlaceView>(() => {});
        return new Promise<PlaceView>((_, no) => (refuse = () => no(new RequestError("jumpbox runs sudo only with ubuntu's password. Type it in Add a computer.", PLACE_SUDO_KIND, "Type it in Add a computer."))));
      },
      placesList: async () => ({ places: [here], adds: kept, pending: [] }),
    } as Partial<Api>);
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => {
      openAdd();
      useAddFlow.setState({ address: "jumpbox" });
    });
    await settle();
    await press(primary());
    expect(step()).toBe("hostkey");
    await press(primary());
    const addId = useAddFlow.getState().addId!;
    stage(addId, "connect", "done", "Ubuntu 24.04");
    stage(addId, "check", "running");
    stage(addId, "chip", "done", "Linux x86_64");
    stage(addId, "root", "running");
    stage(addId, "root", "failed", "jumpbox runs sudo only with ubuntu's password");
    await act(async () => refuse!());
    await settle();
    const root = dialog()!.querySelector<HTMLElement>("[data-step-row='root']")!;
    expect(root.dataset["state"]).toBe("failed");
    // The host's fix names the terminal and the app for a client with no field; here the field below is the fix.
    expect(root.querySelector("[data-k=step-refusal]")?.textContent).toBe("jumpbox runs sudo only with ubuntu's password. Type it below; it goes to sudo there and is kept nowhere.");
    const field = root.querySelector<HTMLInputElement>("[data-k=sudo-password] input, input[data-k=sudo-password]")!;
    expect(field.type).toBe("password");
    const again = root.querySelector<HTMLButtonElement>("[data-k=try-again]")!;
    expect(again.hasAttribute("data-held")).toBe(true);
    fireEvent.change(field, { target: { value: "Tq-not-a-real-pw" } });
    await press(again);
    // The add that carries the password carries the key the person trusted, so the host holds the box against it
    // before the password leaves.
    expect(asked).toEqual([{ address: "jumpbox" }, { address: "jumpbox", hostKey: key }, { address: "jumpbox", hostKey: key, sudoPassword: "Tq-not-a-real-pw" }]);
    expect(step()).toBe("checks");
    // Nothing the window keeps holds it: not the flow, not the adds the host lists.
    expect(JSON.stringify(useAddFlow.getState())).not.toContain("Tq-not-a-real-pw");
    expect(JSON.stringify(useAdds.getState())).not.toContain("Tq-not-a-real-pw");
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

  it("weighs the picks against the computer's room on the summary, and holds Set up where they do not fit", async () => {
    const GB = 1024 ** 3;
    const weighed: { ref: string; choices: RecipeFile }[] = [];
    let free = 61 * GB;
    const fake = host({
      placesEstimate: async (ref: string, choices: RecipeFile) => {
        weighed.push({ ref, choices });
        return { neededBytes: 2 * GB, keptBytes: 7.5 * GB, freeBytes: free, unmeasured: 2 };
      },
    } as Partial<Api>);
    useStore.setState({ places: [here, studio] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => useAddFlow.setState({ open: true, step: "summary", placeId: studio.id, pendingId: "a_1", address: "studio" }));
    await settle();
    await waitFor(() => expect(dialog()!.querySelector("[data-k=disk]")?.textContent).toBe("2 GB needed, 7.5 GB kept free, 61 GB free"));
    expect(weighed.at(-1)!.ref).toBe(studio.id);
    expect(Object.keys(weighed.at(-1)!.choices.agents)).toEqual(["claude", "codex"]);
    expect(dialog()!.querySelector("[data-k=disk]")?.getAttribute("title")).toBe("2 picked rows were not measured");
    expect(dialog()!.querySelector("[data-k=disk-short]")).toBeNull();
    expect(primary().hasAttribute("data-held")).toBe(false);
    // The picks alone fit in 9 GB; with the room the setup keeps free past them they do not.
    free = 9 * GB;
    act(() => useAddFlow.setState({ step: "other" }));
    await settle();
    act(() => useAddFlow.setState({ step: "summary" }));
    await settle();
    await waitFor(() => expect(dialog()!.querySelector("[data-k=disk]")?.textContent).toBe("2 GB needed, 7.5 GB kept free, 9 GB free"));
    expect(dialog()!.querySelector("[data-k=disk]")?.getAttribute("data-short")).toBe("true");
    expect(dialog()!.querySelector("[data-k=disk-short]")?.textContent).toBe("studio has 9 GB free; these picks need 2 GB, and wsp keeps 7.5 GB free there. Untick some rows, or free room on studio.");
    expect(primary().hasAttribute("data-held")).toBe(true);
  });

  it("offers Start from where a recipe is saved, and a pick there takes the recipe's rows", async () => {
    const builders: RecipeView = { name: "Builders", slug: "builders", summary: "1 agent", machines: ["spoo"], savedAt: "2026-10-05T09:00:00.000Z", file: RecipeFile.parse({ name: "Builders", agents: { codex: { signin: "machine" } } }) };
    const fake = host({}, [builders]);
    useStore.setState({ places: [here, studio] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => useAddFlow.setState({ open: true, step: "startfrom", placeId: studio.id, pendingId: "a_1", address: "studio" }));
    await settle();
    expect([title(), progress()]).toEqual(["Start from", "3 of 12"]);
    expect([...dialog()!.querySelectorAll("[data-choice]")].map(c => c.getAttribute("data-choice"))).toEqual(["here", "builders", "none"]);
    // A saved recipe says it is one and the day it was saved, beside the computers that follow it.
    expect(dialog()!.querySelector("[data-choice='builders']")?.textContent).toBe("BuildersA recipe you saved on Oct 5, 2026. 1 agent.on spoo");
    await press(dialog()!.querySelector("[data-choice='builders'] [role=radio]"));
    await rest(450);
    expect(fake.asked.chosen.at(-1)).toMatchObject({ recipe: "builders" });
    expect(Object.keys(useAddFlow.getState().picks!.agents)).toEqual(["codex"]);
  });
});

describe("Add a computer's picks read the host's facts", () => {
  const MB = 1024 ** 2;
  const FACTS: RecipeOptions = {
    ...OPTIONS,
    agents: [
      { id: "claude", name: "Claude Code", signins: ["vault"], kind: "token", bytes: 230 * MB },
      { id: "codex", name: "Codex", signins: ["machine"], kind: "device", bytes: 40 * MB },
    ],
    mcp: [
      { name: "context7", agents: ["claude", "codex"], kind: "key" },
      { name: "github", agents: ["codex"], kind: "token" },
      { name: "linear", agents: ["claude"], kind: "oauth" },
      { name: "playwright", agents: ["claude"], kind: "none" },
      { name: "old", agents: ["claude"] },
    ],
    clis: [
      { name: "gh", via: "apt", version: "2.86.0", bytes: 40 * MB, calls: 8 },
      { name: "go", via: "apt", version: "1.25.1", bytes: 517 * MB },
      { name: "ripgrep", via: "apt", version: "15.1.0", bytes: 6 * MB, calls: 1_108 },
    ],
    configs: [
      { id: "git", label: "git settings and identity" },
      { id: "github", label: "the GitHub sign-in", signins: ["machine", "skip"] },
    ],
    folders: [
      { name: "wsp", path: "/Users/zingzy/wsp", remote: "github.com/wsp-labs/wsp", private: true, unpushed: 2, bytes: 1.1 * 1024 ** 3 },
      { name: "spoo", path: "/Users/zingzy/spoo", remote: "github.com/spoo-me/url-shortener", private: false, unpushed: 0, bytes: 180 * MB },
      { name: "laya", path: "/Users/zingzy/laya", bytes: 340 * MB },
    ],
  };
  const open = async (at: "startfrom" | "agents" | "mcp" | "clis" | "github" | "projects", picks?: RecipeFile, over: Partial<Api> = {}, recipes: RecipeView[] = []): Promise<ReturnType<typeof host>> => {
    const fake = host({ recipesOptions: async () => FACTS, ...over } as Partial<Api>, recipes);
    useStore.setState({ places: [here, studio] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => useAddFlow.setState({ open: true, step: at, placeId: studio.id, pendingId: "a_1", address: "studio", ...(picks === undefined ? {} : { picks }) }));
    await settle();
    return fake;
  };
  const size = (row: string): [string | null | undefined, string | null | undefined] => {
    const cell = dialog()!.querySelector(`[data-pick-row='${row}'] [data-k=size]`);
    return [cell?.textContent, cell?.getAttribute("data-tone")];
  };

  it("says how each agent is signed in here in the Agents page's own sentence", async () => {
    const agent = (id: string, name: string, over: Partial<AgentRow>): AgentRow => ({ id, name, installed: true, road: "own", signIn: "signed-in", signInRoad: "key", wspTools: false, ...over });
    const report: AgentsReport = { ...AGENTS_REPORT, target: { placeId: "here" }, agents: [agent("claude", "Claude Code", { signInKind: "api-key" }), agent("codex", "Codex", { signInKind: "subscription", signInPlan: "plus" })] };
    const reads: unknown[] = [];
    await open("agents", undefined, { agentsRead: async (target: unknown) => (reads.push(target), report) } as Partial<Api>);
    await waitFor(() => expect(dialog()!.querySelector("[data-pick-row='claude']")?.textContent).toContain("Signed in with an API key."));
    expect(dialog()!.querySelector("[data-pick-row='codex']")?.textContent).toContain("Signed in with ChatGPT Plus.");
    expect(reads).toEqual([{ placeId: "here" }]);
  });

  it("draws each agent's size and its sign-in words by how it signs in", async () => {
    await open("agents");
    await waitFor(() => expect(ticked("claude")).toBe(true));
    expect(size("claude")).toEqual(["230 MB", "warning"]);
    expect(size("codex")).toEqual(["40 MB", "muted"]);
    expect(dialog()!.querySelector("[data-pick-row='claude'] [data-slot=select-trigger]")?.textContent).toBe("Copy the key");
    expect(dialog()!.querySelector("[data-pick-row='codex'] [data-slot=select-trigger]")?.textContent).toBe("Sign in on studio with a code");
  });

  it("says how each MCP server signs in on the computer, as the agents step says it for an agent", async () => {
    await open("mcp");
    await waitFor(() => expect(ticked("linear")).toBe(true));
    const note = (row: string): string | null | undefined => dialog()!.querySelector(`[data-pick-row='${row}'] [data-pick-note]`)?.textContent;
    expect(["context7", "github", "linear", "playwright"].map(note)).toEqual(["Key copied.", "Token copied.", "Signs in on studio.", "No sign-in."]);
    // A server the host read no kind for says nothing rather than guess.
    expect(note("old")).toBeUndefined();
  });

  it("asks once whether to copy the keys of the ticked servers that carry one, naming each server and what its keys go by, and keeps the answer in the picks", async () => {
    const keyed = { recipesOptions: async () => ({ ...FACTS, mcp: FACTS.mcp.map(s => (s.name === "context7" ? { ...s, keys: ["CONTEXT7_API_KEY"] } : s.name === "github" ? { ...s, keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] } : s)) }) } as Partial<Api>;
    await open("mcp", undefined, keyed);
    await waitFor(() => expect(ticked("context7")).toBe(true));
    const question = (): HTMLElement | null => dialog()!.querySelector<HTMLElement>("[data-grid='server-keys']");
    const choice = (id: string): Element | null | undefined => question()?.querySelector(`[data-choice='${id}']`);
    const picked = (): string | null | undefined => [...(question()?.querySelectorAll("[data-choice]") ?? [])].find(c => c.querySelector("[role=radio]")?.getAttribute("aria-checked") === "true")?.getAttribute("data-choice");
    const note = (row: string): string | null | undefined => dialog()!.querySelector(`[data-pick-row='${row}'] [data-pick-note]`)?.textContent;
    expect(dialog()!.querySelectorAll("[data-grid='server-keys']")).toHaveLength(1);
    expect(choice("copy")?.textContent).toBe("Copy the keys to studiocontext7: CONTEXT7_API_KEY; github: GITHUB_PERSONAL_ACCESS_TOKEN.");
    expect(choice("leave")?.textContent).toBe("Leave them on zingzy's MacBook Procontext7 and github are skipped on studio until you copy their keys.");
    // Nothing is copied on a tick alone: the answer starts at no, and the rows say so.
    expect(picked()).toBe("leave");
    expect(["context7", "github", "linear"].map(note)).toEqual(["Skipped until you copy its keys.", "Skipped until you copy its keys.", "Signs in on studio."]);
    const answer = (): boolean | undefined => useAddFlow.getState().picks!.copyKeys;
    const before = useAddFlow.getState().picks!.mcp;
    expect(answer()).toBeUndefined();
    await press(choice("copy")!.querySelector("[role=radio]"));
    expect(picked()).toBe("copy");
    // One answer, kept once on the picks: the server rows are as they were.
    expect(answer()).toBe(true);
    expect(useAddFlow.getState().picks!.mcp).toEqual(before);
    expect(["context7", "github"].map(note)).toEqual(["Key copied.", "Token copied."]);
    // A server that carries a key, ticked again after the yes, stands under the yes.
    await press(dialog()!.querySelector("[data-pick-row='github'] [role=checkbox]"));
    expect(question()?.textContent).not.toContain("github");
    await press(dialog()!.querySelector("[data-pick-row='github'] [role=checkbox]"));
    expect(picked()).toBe("copy");
    expect(note("github")).toBe("Token copied.");
    await press(choice("leave")!.querySelector("[role=radio]"));
    expect(answer()).toBeUndefined();
    expect(["context7", "github"].map(note)).toEqual(["Skipped until you copy its keys.", "Skipped until you copy its keys."]);
    // With no ticked server carrying a key there is nothing to ask.
    await press(dialog()!.querySelector("[data-pick-row='context7'] [role=checkbox]"));
    await press(dialog()!.querySelector("[data-pick-row='github'] [role=checkbox]"));
    expect(question()).toBeNull();
  });

  it("ticks no CLI to start, puts the ones the agents ran most first with how often, and ticks every one they ran on one act", async () => {
    await open("clis");
    const rows = (): string[] => [...dialog()!.querySelectorAll<HTMLElement>("[data-pick-row]")].map(r => r.dataset["pickRow"]!);
    await waitFor(() => expect(rows()).toEqual(["ripgrep", "gh", "go"]));
    await waitFor(() => expect(useAddFlow.getState().picks?.agents.claude).toBeDefined());
    expect(useAddFlow.getState().picks!.clis).toEqual({});
    expect(rows().map(ticked)).toEqual([false, false, false]);
    expect(dialog()!.querySelector("[data-slot=dialog-description]")?.textContent).toBe("The command-line tools your agents run, to install on studio. Most used first.");
    const calls = (row: string): string | null | undefined => dialog()!.querySelector(`[data-pick-row='${row}'] [data-k=cli-calls]`)?.textContent;
    expect(rows().map(calls)).toEqual(["1,108 calls", "8 calls", undefined]);
    expect(size("gh")).toEqual(["40 MB", "muted"]);
    expect(size("go")).toEqual(["517 MB", "warning"]);
    const act_ = (): HTMLElement | null => dialog()!.querySelector<HTMLElement>("[data-k=tick-used]");
    // The dialog's outline keycap with its glyph, as every other act in it.
    expect(act_()?.className).toContain("border-input");
    expect(act_()?.querySelector("svg")).not.toBeNull();
    await press(act_());
    expect(rows().map(ticked)).toEqual([true, true, false]);
    expect(Object.keys(useAddFlow.getState().picks!.clis).sort()).toEqual(["gh", "ripgrep"]);
    // Every CLI the agents ran is ticked: a press would move nothing, so it is not offered.
    expect(act_()).toBeNull();
    await press(dialog()!.querySelector("[data-pick-row='gh'] [role=checkbox]"));
    expect(act_()).not.toBeNull();
  });

  it("says under each step's title what it does and why, by the box's name and this computer's", async () => {
    await open("agents");
    const said: Record<string, string | null | undefined> = {};
    for (const at of ["checks", "startfrom", "agents", "mcp", "clis", "skills", "plugins", "github", "projects", "other", "summary"] as const) {
      act(() => useAddFlow.setState({ step: at }));
      await settle();
      said[at] = dialog()!.querySelector("[data-slot=dialog-description]")?.textContent;
    }
    expect(said).toEqual({
      checks: "Making sure wsp can reach studio and run there.",
      startfrom: "Begin with everything on zingzy's MacBook Pro, a saved recipe, or nothing.",
      agents: "The coding agents to install on studio, signed in so threads run there.",
      mcp: "The tool servers your agents use, set up for them on studio.",
      clis: "The command-line tools your agents run, to install on studio. Most used first.",
      skills: "Your agents' skills, copied so they work the same on studio.",
      plugins: "Claude Code plugins to install on studio.",
      github: "How studio signs in to GitHub to clone and push your repos.",
      projects: "Projects on zingzy's MacBook Pro to clone onto studio.",
      other: "Your git and shell settings, so studio behaves like zingzy's MacBook Pro.",
      summary: "What goes on studio, before it starts.",
    });
  });

  it("reads no options when it opens on the running steps, which draw none, and reads them when it opens on Where", async () => {
    const asks: string[] = [];
    const fake = host({ recipesOptions: async () => (asks.push("options"), FACTS) } as Partial<Api>);
    useStore.setState({ places: [here, { ...studio, setup: { state: "running", addId: "a_set", startedAt: "2026-10-03T10:00:00.000Z", steps: [{ step: "floor", state: "running" }], waiting: [] } }] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    expect(step()).toBe("running");
    expect(asks).toEqual([]);
    act(() => closeAdd());
    act(() => openAdd());
    await settle();
    expect(asks).toEqual(["options"]);
  });

  it("shows the plain spinner where a step's list goes until the host answers, and keeps the list through a close and an open", async () => {
    let answer: ((o: RecipeOptions) => void) | undefined;
    const asks: number[] = [];
    await open("clis", undefined, { recipesOptions: () => (asks.push(1), new Promise<RecipeOptions>(done => (answer = done))) } as Partial<Api>);
    expect(dialog()!.querySelector("[data-k=options-loading] [role=status]")).not.toBeNull();
    expect(dialog()!.querySelector("[data-state-mark=working]")).toBeNull();
    expect(dialog()!.querySelector("[data-pick-row]")).toBeNull();
    await act(async () => answer!(FACTS));
    await settle();
    expect(dialog()!.querySelector("[data-pick-row='gh']")).not.toBeNull();
    act(() => closeAdd());
    act(() => useAddFlow.setState({ open: true, step: "clis", placeId: studio.id, pendingId: "a_1", address: "studio" }));
    await settle();
    // Opened again, the list stands at once while the host is asked again.
    expect(asks).toHaveLength(2);
    expect(dialog()!.querySelector("[data-k=options-loading]")).toBeNull();
    expect(dialog()!.querySelector("[data-pick-row='gh']")).not.toBeNull();
  });

  it("gives every pick list one filter, one order, and All, None and Invert over what the filter leaves; a shift-click ticks the range", async () => {
    await open("clis");
    const rows = (): string[] => [...dialog()!.querySelectorAll<HTMLElement>("[data-pick-row]")].map(r => r.dataset["pickRow"]!);
    const clis = (): string[] => Object.keys(useAddFlow.getState().picks!.clis).sort();
    await waitFor(() => expect(rows()).toEqual(["ripgrep", "gh", "go"]));
    await waitFor(() => expect(useAddFlow.getState().picks?.agents.claude).toBeDefined());
    // The same tools from the one component on every step that ticks rows.
    for (const at of ["agents", "mcp", "skills", "plugins", "projects", "other", "clis"] as const) {
      act(() => useAddFlow.setState({ step: at }));
      await settle();
      expect(dialog()!.querySelectorAll("[data-pick-list] [data-pick-tools]"), at).toHaveLength(1);
      expect([...dialog()!.querySelectorAll("[data-pick-tools] [data-k]")].map(el => el.getAttribute("data-k")), at).toEqual(["pick-filter", "pick-order", "pick-all", "pick-none", "pick-invert"]);
    }
    const tool = (k: string): HTMLElement => dialog()!.querySelector<HTMLElement>(`[data-pick-tools] [data-k=${k}]`)!;
    fireEvent.change(tool("pick-filter"), { target: { value: "G" } });
    await settle();
    expect(rows()).toEqual(["ripgrep", "gh", "go"]);
    fireEvent.change(tool("pick-filter"), { target: { value: "go" } });
    await settle();
    expect(rows()).toEqual(["go"]);
    await press(tool("pick-all"));
    expect(clis()).toEqual(["go"]);
    fireEvent.change(tool("pick-filter"), { target: { value: "zzz" } });
    await settle();
    expect(dialog()!.querySelector("[data-k=pick-none-match]")?.textContent).toBe("No row matches zzz.");
    fireEvent.change(tool("pick-filter"), { target: { value: "" } });
    await settle();
    await press(tool("pick-invert"));
    expect(clis()).toEqual(["gh", "ripgrep"]);
    await press(tool("pick-all"));
    expect(clis()).toEqual(["gh", "go", "ripgrep"]);
    await press(tool("pick-none"));
    expect(clis()).toEqual([]);
    // Ordered by name, then by what is ticked; the list's own order is the CLIs' most used first.
    await press(tool("pick-order"));
    expect([...document.querySelectorAll("[role=option]")].map(o => o.textContent)).toEqual(["Most used", "Name", "Ticked first"]);
    const byName = [...document.querySelectorAll("[role=option]")].find(o => o.textContent === "Name")!;
    fireEvent.pointerDown(byName, { pointerType: "mouse" });
    fireEvent.mouseUp(byName);
    await press(byName);
    expect(rows()).toEqual(["gh", "go", "ripgrep"]);
    // A shift-click takes every row from the last one clicked, in the order shown, the way the clicked row went.
    const box = (row: string): HTMLElement => dialog()!.querySelector<HTMLElement>(`[data-pick-row='${row}'] [role=checkbox]`)!;
    const shiftClick = async (row: string): Promise<void> => {
      fireEvent.mouseDown(box(row), { shiftKey: true });
      await press(box(row));
    };
    await press(box("gh"));
    expect(clis()).toEqual(["gh"]);
    await shiftClick("ripgrep");
    expect(clis()).toEqual(["gh", "go", "ripgrep"]);
    await shiftClick("go");
    expect(clis()).toEqual(["gh"]);
    // A plain click after it is one row again.
    fireEvent.mouseDown(box("go"));
    await press(box("go"));
    expect(clis()).toEqual(["gh", "go"]);
    expect(dialog()!.querySelector("[data-pick-row='go'] label")?.getAttribute("title")).toBe("Shift-click to tick or clear every row from the last one you clicked.");
  });

  it("holds Ticked first in the order it stood when picked, so a tick moves no row and a shift-click ranges over the rows as shown", async () => {
    await open("mcp");
    const rows = (): string[] => [...dialog()!.querySelectorAll<HTMLElement>("[data-pick-row]")].map(r => r.dataset["pickRow"]!);
    const ticked = (): string[] => Object.keys(useAddFlow.getState().picks!.mcp).sort();
    await waitFor(() => expect(useAddFlow.getState().picks?.agents.claude).toBeDefined());
    await waitFor(() => expect(rows()).toEqual(["context7", "github", "linear", "old", "playwright"]));
    const tool = (k: string): HTMLElement => dialog()!.querySelector<HTMLElement>(`[data-pick-tools] [data-k=${k}]`)!;
    await press(tool("pick-none"));
    // The servers arrive by name, so the picker offers no order of the list's own beside Name.
    await press(tool("pick-order"));
    expect([...document.querySelectorAll("[role=option]")].map(o => o.textContent)).toEqual(["Name", "Ticked first"]);
    const first = [...document.querySelectorAll("[role=option]")].find(o => o.textContent === "Ticked first")!;
    fireEvent.pointerDown(first, { pointerType: "mouse" });
    fireEvent.mouseUp(first);
    await press(first);
    const box = (row: string): HTMLElement => dialog()!.querySelector<HTMLElement>(`[data-pick-row='${row}'] [role=checkbox]`)!;
    await press(box("linear"));
    expect(rows()).toEqual(["context7", "github", "linear", "old", "playwright"]);
    fireEvent.mouseDown(box("playwright"), { shiftKey: true });
    await press(box("playwright"));
    expect(ticked()).toEqual(["linear", "old", "playwright"]);
    // Picked again, it sorts the ticks of now to the top.
    await press(tool("pick-order"));
    const again = [...document.querySelectorAll("[role=option]")].find(o => o.textContent === "Name")!;
    fireEvent.pointerDown(again, { pointerType: "mouse" });
    fireEvent.mouseUp(again);
    await press(again);
    await press(tool("pick-order"));
    const back = [...document.querySelectorAll("[role=option]")].find(o => o.textContent === "Ticked first")!;
    fireEvent.pointerDown(back, { pointerType: "mouse" });
    fireEvent.mouseUp(back);
    await press(back);
    expect(rows()).toEqual(["linear", "old", "playwright", "context7", "github"]);
  });

  it("opens GitHub on signing in on the computer, from everything here, from nothing, and where a token here could be copied", async () => {
    const withToken = { recipesOptions: async () => ({ ...FACTS, configs: [{ id: "github", label: "the GitHub sign-in", signins: ["vault", "machine", "skip"] }] }) } as Partial<Api>;
    const builders: RecipeView = { name: "Builders", slug: "builders", summary: "1 agent", machines: [], file: RecipeFile.parse({ name: "Builders" }) };
    await open("startfrom", undefined, withToken, [builders]);
    await waitFor(() => expect(useAddFlow.getState().picks?.configs.github).toEqual({ signin: "machine" }));
    const checked = (): string | null | undefined => [...dialog()!.querySelectorAll("[data-choice]")].find(c => c.querySelector("[role=radio]")?.getAttribute("aria-checked") === "true")?.getAttribute("data-choice");
    await press(dialog()!.querySelector("[data-choice='none'] [role=radio]"));
    expect(useAddFlow.getState().picks!.configs.github).toEqual({ signin: "machine" });
    act(() => useAddFlow.setState({ step: "github" }));
    await settle();
    expect(checked()).toBe("machine");
    act(() => useAddFlow.setState({ step: "startfrom" }));
    await settle();
    await press(dialog()!.querySelector("[data-choice='here'] [role=radio]"));
    act(() => useAddFlow.setState({ step: "github" }));
    await settle();
    expect(checked()).toBe("machine");
  });

  it("takes a saved recipe as the host hands it out, says what the host counts in it, and keeps the GitHub choice it saved, a Skip included", async () => {
    const withToken = { recipesOptions: async () => ({ ...FACTS, configs: [{ id: "github", label: "the GitHub sign-in", signins: ["vault", "machine", "skip"] }] }) } as Partial<Api>;
    const file = RecipeFile.parse({ name: "default", agents: { claude: { signin: "vault" } }, mcp: { linear: { agents: ["claude"] } }, clis: { "litmus-cli": { via: "npm" } }, configs: { git: {}, github: { signin: "skip" } } });
    const saved: RecipeView = { name: "default", slug: "default", summary: "1 agent, 1 MCP server, 1 CLI, 2 configs", machines: [], savedAt: "2026-10-01T09:00:00.000Z", file };
    await open("startfrom", undefined, withToken, [saved]);
    await waitFor(() => expect(dialog()!.querySelector("[data-choice='default']")?.textContent).toBe("defaultA recipe you saved on Oct 1, 2026. 1 agent, 1 MCP server, 1 CLI, 2 configs."));
    await press(dialog()!.querySelector("[data-choice='default'] [role=radio]"));
    const picks = useAddFlow.getState().picks!;
    expect([Object.keys(picks.mcp), Object.keys(picks.clis), picks.configs.github]).toEqual([["linear"], ["litmus-cli"], { signin: "skip" }]);
    act(() => useAddFlow.setState({ step: "github" }));
    await settle();
    expect([...dialog()!.querySelectorAll("[data-choice]")].find(c => c.querySelector("[role=radio]")?.getAttribute("aria-checked") === "true")?.getAttribute("data-choice")).toBe("skip");
    // Start from reads every GitHub row as wsp add --recipe and the setup read it: a row naming no way is the token.
    for (const github of [undefined, {}, { signin: "skip" as const }, { signin: "vault" as const }, { signin: "machine" as const }]) {
      const rows = RecipeFile.parse({ name: "r", configs: github === undefined ? {} : { github } });
      expect(githubPick(fromRecipe(rows, "studio")), JSON.stringify(github)).toBe(githubPick(rows));
    }
  });

  it("names the account and scopes of the token it would copy, as gh reads them here", async () => {
    await open("github", undefined, { recipesOptions: async () => ({ ...FACTS, configs: [{ id: "github", label: "the GitHub sign-in", signins: ["vault", "machine", "skip"], account: "Zingzy", scopes: ["repo", "read:org", "workflow"] }] }) } as Partial<Api>);
    await waitFor(() => expect(dialog()!.querySelectorAll("[data-choice]")).toHaveLength(3));
    expect(dialog()!.querySelector("[data-choice='vault']")?.textContent).toContain("Signed in as Zingzy with repo, read:org and workflow.");
  });

  it("offers GitHub the ways the host says it can sign in, and keeps a skip as the choice it is", async () => {
    await open("github");
    await waitFor(() => expect(dialog()!.querySelectorAll("[data-choice]")).toHaveLength(2));
    expect([...dialog()!.querySelectorAll("[data-choice]")].map(c => c.getAttribute("data-choice"))).toEqual(["machine", "skip"]);
    // With no token here the first way is signing in there.
    expect(useAddFlow.getState().picks!.configs.github).toEqual({ signin: "machine" });
    await press(dialog()!.querySelector("[data-choice='skip'] [role=radio]"));
    expect(useAddFlow.getState().picks!.configs.github).toEqual({ signin: "skip" });
    act(() => useAddFlow.setState({ step: "summary" }));
    await settle();
    expect(dialog()!.querySelector("[data-settings-line='GitHub'] [data-settings-word]")?.textContent).toBe("Skip for now");
  });

  it("weighs each project and says a private one needs GitHub only while GitHub is skipped", async () => {
    const picks = (github: "vault" | "skip"): RecipeFile => RecipeFile.parse({ name: "studio", folders: { wsp: { from: "/Users/zingzy/wsp", name: "wsp", keep: [] } }, configs: { github: { signin: github } } });
    await open("projects", picks("skip"));
    const row = (): Element => dialog()!.querySelector("[data-pick-row='wsp']")!;
    expect(size("wsp")).toEqual(["1.1 GB", "danger"]);
    expect(row().textContent).toContain("Private; needs GitHub to clone. Go back to sign in, or skip it.");
    act(() => useAddFlow.setState({ picks: picks("vault") }));
    expect(row().textContent).not.toContain("needs GitHub");
    expect(row().textContent).toContain("github.com/wsp-labs/wsp, 2 unpushed commits come along.");
  });

  it("says of each project whether it has a remote and what of it is not pushed, and that the add refuses one with none", async () => {
    const spoo: ProjectView = { ...wsp, id: "pr_spoo", name: "spoo", path: "/Users/zingzy/spoo", remote: "github.com/spoo-me/url-shortener" };
    const laya: ProjectView = { ...wsp, id: "pr_laya", name: "laya", path: "/Users/zingzy/laya", remote: "" };
    useStore.setState({ projects: [wsp, spoo, laya] });
    await open("projects", RecipeFile.parse({ name: "studio", configs: { github: { signin: "vault" } } }));
    const note = (key: string): string | null | undefined => dialog()!.querySelector(`[data-pick-row='${key}'] [data-pick-note]`)?.textContent;
    await waitFor(() => expect(note("spoo")).toBe("github.com/spoo-me/url-shortener, clean."));
    expect(note("laya")).toBe("No origin remote, so the add refuses it; push it somewhere first.");
    expect(note("wsp")).toBe("github.com/wsp-labs/wsp, 2 unpushed commits come along.");
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
    expect(dialog()!.querySelector("[data-slot=dialog-description]")).toBeNull();
    expect(dialog()!.querySelector("[data-k=close]")?.textContent).toBe("Run in background");
    const signIn = dialog()!.querySelector<HTMLElement>("[data-step-row='signins/codex']")!;
    expect(signIn.dataset["state"]).toBe("needs-you");
    expect(signIn.querySelector("[data-k=sign-in-code]")?.textContent).toBe("4F2K-9QJM");
    expect(signIn.querySelector("[data-k=open-tab]")?.textContent).toBe("Open the tab again");
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await press(signIn.querySelector("[data-k=copy-code]"));
    expect(writeText).toHaveBeenCalledWith("4F2K-9QJM");
    expect(signIn.querySelector("[data-k=copy-code]")?.textContent).toBe("Copy");
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
    // A skill that did not land waits on nobody: the computer reads Ready, as its row on the list does, and the row offers Retry.
    expect(title()).toBe("studio is ready");
    const row = dialog()!.querySelector<HTMLElement>("[data-step-row='skills/b']")!;
    expect(row.querySelector("[data-k=step-refusal]")?.textContent).toBe("a link inside points at a folder");
    await press(row.querySelector("[data-k=retry]"));
    expect(fake.asked.setups).toEqual([{ ref: studio.id, o: {} }]);
  });

  it("offers Copy the keys on a server set aside for its keys where the computer follows no recipe, which sets it up again with the yes", async () => {
    const fake = host();
    const done: PlaceSetup = { ...RUNNING, state: "done", steps: [{ step: "floor", state: "done" }, { step: "mcp", state: "done" }] };
    const applied: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "agents/mcp/codex/sentry", label: "Codex sentry", outcome: "skipped", kind: "server", step: "mcp", note: "not copied: it needs SENTRY_ACCESS_TOKEN", keys: ["SENTRY_ACCESS_TOKEN"] }] };
    const picks = RecipeFile.parse({ name: "studio", agents: { codex: { signin: "machine" } }, mcp: { sentry: { agents: ["codex"] } } });
    useStore.setState({ places: [here, { ...placed(done, applied), picks, recipe: "none" }] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const row = dialog()!.querySelector<HTMLElement>("[data-step-row='agents/mcp/codex/sentry']")!;
    expect(row.textContent).toContain("Not copied: it needs SENTRY_ACCESS_TOKEN.");
    await press(row.querySelector("[data-k=copy-keys]"));
    expect(fake.asked.setups).toEqual([{ ref: studio.id, o: { choices: { ...picks, copyKeys: true } } }]);
  });

  it("offers no Copy the keys on a computer that follows a recipe, whose page gives the yes for every computer that follows it", async () => {
    const done: PlaceSetup = { ...RUNNING, state: "done", steps: [{ step: "floor", state: "done" }, { step: "mcp", state: "done" }] };
    const applied: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "agents/mcp/codex/sentry", label: "Codex sentry", outcome: "skipped", kind: "server", step: "mcp", note: "not copied", keys: ["SENTRY_ACCESS_TOKEN"] }] };
    useStore.setState({ places: [here, { ...placed(done, applied), picks: RecipeFile.parse({ name: "Builders" }), recipe: "builders" }] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    expect(dialog()!.querySelector("[data-step-row='agents/mcp/codex/sentry']")?.textContent).toContain("Not copied: it needs SENTRY_ACCESS_TOKEN; to send it, pick Copy the keys under MCP servers on the recipe Builders in Settings > Recipes.");
    expect(dialog()!.querySelector("[data-k=copy-keys]")).toBeNull();
  });

  it("offers Skip for now on a sign-in that waits and Skip on an item that failed, each answered onto the row", async () => {
    const wait = { row: "signins/codex", label: "Codex", url: "https://auth.openai.com/device", code: "4F2K-9QJM", expiresAt: "2026-10-03T10:10:00.000Z", state: "waiting" as const };
    const done: PlaceSetup = { ...RUNNING, state: "done", steps: [{ step: "floor", state: "done" }, { step: "skills", state: "failed", note: "1 of 2 failed" }], waiting: [wait] };
    const applied: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "skills/a", label: "unslop", outcome: "installed", step: "skills" }, { id: "skills/b", label: "taste", outcome: "failed", step: "skills", note: "a link inside points at a folder" }] };
    const skipped: { placeId: string; row: string }[] = [];
    const fake = host({
      placesSkip: async (placeId: string, row: string) => {
        skipped.push({ placeId, row });
        return placed({ ...done, waiting: [] }, { ...applied, rows: applied.rows.map(r => (r.id === row ? { ...r, outcome: "skipped" as const } : r)) });
      },
    } as Partial<Api>);
    useStore.setState({ places: [here, placed(done, applied)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const signIn = (): HTMLElement | null => dialog()!.querySelector<HTMLElement>("[data-step-row='signins/codex']");
    expect(signIn()!.querySelector("[data-k=skip]")?.textContent).toBe("Skip for now");
    // In the code's line the skip is its text alone, so where the line wraps it stands on the code's left edge.
    expect(signIn()!.querySelector("[data-sign-in-line] [data-k=skip]")?.className).toMatch(/(^| )px-0( |$)/);
    expect(signIn()!.textContent).toContain("You can sign in later in Settings.");
    await press(signIn()!.querySelector("[data-k=skip]"));
    expect(skipped).toEqual([{ placeId: studio.id, row: "signins/codex" }]);
    expect(signIn()).toBeNull();
    const failed = dialog()!.querySelector<HTMLElement>("[data-step-row='skills/b']")!;
    expect([...failed.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Retry", "Skip"]);
    await press(failed.querySelector("[data-k=skip]"));
    expect(skipped.at(-1)).toEqual({ placeId: studio.id, row: "skills/b" });
    expect(dialog()!.querySelector("[data-step-row='skills/b']")).toBeNull();
    expect(title()).toBe("studio is ready");
  });

  it("opens a step that ran on a click to its last lines of output, read on a timer while it runs and never on a render", async () => {
    const reads: { placeId: string; step: string | undefined }[] = [];
    const fake = host({
      placesSetupLog: async (placeId: string, step?: string) => {
        reads.push({ placeId, step });
        return ["2026-10-04T10:00:00Z [floor] apt-get install curl", "2026-10-04T10:00:01Z [agents] the agents: running", "2026-10-04T10:00:02Z [agents] npm install -g @anthropic-ai/claude-code", "2026-10-04T10:00:03Z [agents] added 3 packages in 4s"];
      },
    } as Partial<Api>);
    useStore.setState({ places: [here, placed(RUNNING)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const row = (id: string): HTMLElement => dialog()!.querySelector<HTMLElement>(`[data-step-row='${id}']`)!;
    // Nothing is open, so nothing is read.
    expect(reads).toEqual([]);
    expect(row("agents").querySelector("[data-k=step-log]")).toBeNull();
    // A step not started has no output to open on; Install wsp is no step of the box's log.
    expect(row("mcp").querySelector("[data-k=step-toggle]")).toBeNull();
    expect(row("wsp").querySelector("[data-k=step-toggle]")).toBeNull();
    await press(row("agents").querySelector("[data-k=step-toggle]"));
    await waitFor(() => expect(row("agents").querySelector("[data-k=step-log]")?.textContent).toBe("npm install -g @anthropic-ai/claude-code\nadded 3 packages in 4s"));
    expect(row("agents").querySelector("[data-k=step-toggle]")?.getAttribute("aria-expanded")).toBe("true");
    expect(row("floor").querySelector("[data-k=step-log]")).toBeNull();
    expect(reads).toEqual([{ placeId: studio.id, step: undefined }]);
    for (let i = 0; i < 3; i++) {
      act(() => useStore.setState({ places: [here, placed({ ...RUNNING, steps: [...RUNNING.steps] })] }));
      await settle();
    }
    expect(reads).toHaveLength(1);
    await rest(3100);
    expect(reads).toHaveLength(2);
    await press(row("agents").querySelector("[data-k=step-toggle]"));
    expect(row("agents").querySelector("[data-k=step-log]")).toBeNull();
  });

  it("stands a failed step open on its output, until it is closed", async () => {
    const failed: PlaceSetup = { ...RUNNING, state: "failed", said: "apt-get exited 100", steps: [{ step: "floor", state: "failed", ms: 9_000 }] };
    const fake = host({ placesSetupLog: async () => ["2026-10-04T10:00:00Z [floor] E: Unable to locate package nonsense"] } as Partial<Api>);
    useStore.setState({ places: [here, placed(failed)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const floor = (): HTMLElement => dialog()!.querySelector<HTMLElement>("[data-step-row='floor']")!;
    await waitFor(() => expect(floor().querySelector("[data-k=step-log]")?.textContent).toBe("E: Unable to locate package nonsense"));
    expect(floor().dataset["open"]).toBe("true");
    await press(floor().querySelector("[data-k=step-toggle]"));
    expect(floor().querySelector("[data-k=step-log]")).toBeNull();
  });

  it("keeps each step's last twelve lines of output, oldest first, each cut at its end, and passes over the step's own state", () => {
    const long = `apt-get install -y ${"libssl-dev ".repeat(40)}`;
    const many = Array.from({ length: 14 }, (_, i) => `2026-10-04T10:00:${String(i).padStart(2, "0")}Z [skills] copied skill-${i}`);
    const out = stepLogs([`2026-10-04T10:00:00Z [clis] ${long}`, "2026-10-04T10:00:01Z [mcp] claude mcp add context7", "2026-10-04T10:00:02Z [mcp] the agents' own files and MCP servers: done (7 copied)", "not a line of the log", ...many]);
    expect(out.mcp).toEqual(["claude mcp add context7"]);
    expect(out.clis![0]).toHaveLength(300);
    expect(out.clis![0]!.endsWith("…")).toBe(true);
    expect(out.skills).toHaveLength(12);
    expect(out.skills![0]).toBe("copied skill-2");
    expect(out.skills!.at(-1)).toBe("copied skill-13");
    expect(Object.keys(out)).toEqual(["clis", "mcp", "skills"]);
  });

  it("marks a step not started with a muted empty circle, so every row has its mark", async () => {
    useStore.setState({ places: [here, placed(RUNNING)] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const mark = (id: string): string | null | undefined => dialog()!.querySelector(`[data-step-row='${id}'] [data-state-mark]`)?.getAttribute("data-state-mark");
    expect(["wsp", "floor", "agents", "mcp", "configs"].map(mark)).toEqual(["done", "done", "working", "waiting", "waiting"]);
  });

  it("ticks each running step's time off one interval for the whole list", async () => {
    const ticks: number[] = [];
    const was = window.setInterval;
    window.setInterval = ((fn: () => void, ms?: number) => {
      if (ms === 1000) ticks.push(ms);
      return was(fn, ms);
    }) as typeof window.setInterval;
    try {
      // Each running step counts from when the host started it, so one this window first sees mid-run reads its real time.
      const at = (ago: number): string => new Date(Date.now() - ago).toISOString();
      const three: PlaceSetup = { ...RUNNING, addId: "a_tick", steps: [{ step: "floor", state: "done", ms: 72_000 }, { step: "agents", state: "running", startedAt: at(0) }, { step: "mcp", state: "running", startedAt: at(0) }, { step: "clis", state: "running", startedAt: at(300_000) }] };
      useStore.setState({ places: [here, placed(three)] });
      mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
      act(() => openSetup(studio.id));
      await settle();
      const time = (id: string): string | null | undefined => dialog()!.querySelector(`[data-step-row='${id}'] [data-step-time]`)?.textContent;
      expect(["agents", "mcp", "clis"].map(time)).toEqual(["0s", "0s", "5m"]);
      await rest(1100);
      expect(["agents", "mcp", "clis"].map(time)).toEqual(["1s", "1s", "5m 1s"]);
      expect(time("floor")).toBe("1m 12s");
      expect(ticks).toHaveLength(1);
    } finally {
      window.setInterval = was;
    }
  });

  it("draws every step a frame says is running with its own spinner", async () => {
    useStore.setState({ places: [here, placed(RUNNING)] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    act(() => useStore.getState().applyEvent({ type: "place.setup", addId: RUNNING.addId, placeId: studio.id, line: { step: "mcp", state: "running" }, running: ["agents", "mcp", "clis", "skills"] } as EventUnion));
    await settle();
    const working = [...dialog()!.querySelectorAll<HTMLElement>("[data-step-row][data-state=working]")].map(r => r.dataset["stepRow"]);
    expect(working).toEqual(["agents", "mcp", "clis", "skills"]);
    expect(working.every(id => dialog()!.querySelector(`[data-step-row='${id}'] [data-state-mark=working]`) !== null)).toBe(true);
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

describe("Add a computer, the running sheet as the host has it", () => {
  const placed = (setup: PlaceSetup, applied?: PlaceView["applied"]): PlaceView => ({ ...studio, setup, ...(applied === undefined ? {} : { applied }) });
  const DONE: PlaceSetup = { ...RUNNING, state: "done", finishedAt: "2026-10-03T10:16:00.000Z", steps: [{ step: "floor", state: "done" }, { step: "agents", state: "done" }, { step: "signins", state: "done" }, { step: "github", state: "done" }], waiting: [] };
  // The owner's run: the Codex sign-in had nothing to copy, and GitHub was skipped.
  const OWNERS_RUN: PlaceView["applied"] = {
    hash: "h",
    at: "x",
    rows: [
      { id: "signins/claude", label: "Claude Code", outcome: "present", step: "signins", note: copiedFromLine("zingzy's MacBook Pro") },
      { id: "signins/codex", label: "Codex", outcome: "failed", step: "signins", note: noCopyLine("Codex", "zingzy's MacBook Pro"), fix: signInThereFix("studio") },
      { id: "github", label: "GitHub", outcome: "skipped", step: "github", note: SKIPPED_FOR_NOW },
    ],
  };
  const signInHost = (over: Partial<Api> = {}, o: { late?: boolean } = {}) => {
    const asked: { target: AgentsTarget; agent: string; terminal?: boolean }[] = [];
    const opened: unknown[] = [];
    const told: ((e: AgentsSignInEvent) => void)[] = [];
    const stopped: string[] = [];
    let answer: () => void = () => {};
    const fake = host({
      agentsSignIn: async (target: AgentsTarget, agent: string, _server: string | undefined, onStep: (e: AgentsSignInEvent) => void, terminal?: boolean) => {
        asked.push({ target, agent, ...(terminal === undefined ? {} : { terminal }) });
        told.push(onStep);
        // The host's answer held back until the test lets it go, as a slow host's would be.
        if (o.late === true) await new Promise<void>(r => (answer = r));
        // A sign-in in the person's own terminal names its pty there; any other prints its page and code.
        queueMicrotask(() => onStep(terminal === true ? { type: "agents.signIn", signInId: "si_1", state: "running", ptyId: "pty_9" } : { type: "agents.signIn", signInId: "si_1", state: "waiting", url: "https://github.com/login/device", code: "ABCD-1234" }));
        return { signInId: "si_1", stop: () => void stopped.push(agent), off: () => {} };
      },
      // The link to the computer the terminal attaches over is asked for and never answers here.
      daemon: {
        ...noDaemonApi,
        open: async (target: unknown) => {
          opened.push(target);
          return new Promise<never>(() => {});
        },
      },
      ...over,
    } as Partial<Api>);
    return { ...fake, signIns: asked, opened, stopped, tell: (e: Omit<AgentsSignInEvent, "type" | "signInId">) => act(() => told.at(-1)?.({ type: "agents.signIn", signInId: "si_1", ...e })), answer: () => answer() };
  };

  it("reads done when the host's setup is done and waits on nothing, a failed sign-in and a skipped GitHub included", async () => {
    useStore.setState({ places: [here, placed(DONE, OWNERS_RUN)] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    expect(title()).toBe("studio is ready");
    expect(primary().textContent).toBe("Next");
  });

  it("reads a skipped sign-in as skipped with Sign in on the computer, which starts that sign-in there and draws its code", async () => {
    const fake = signInHost();
    useStore.setState({ places: [here, placed(DONE, OWNERS_RUN)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const github = (): HTMLElement => dialog()!.querySelector<HTMLElement>("[data-step-row='github']")!;
    expect(github().dataset["state"]).toBe("skipped");
    expect(github().querySelector("[data-state-mark]")?.getAttribute("data-state-mark")).toBe("skipped");
    expect(github().textContent).toContain("Skipped.");
    expect(github().querySelector("[data-k=sign-in]")?.textContent).toBe("Sign in on studio");
    await press(github().querySelector("[data-k=sign-in]"));
    await settle();
    expect(fake.signIns).toEqual([{ target: { placeId: studio.id }, agent: "gh" }]);
    expect(github().querySelector("[data-k=sign-in-code]")?.textContent).toBe("ABCD-1234");
  });

  it("offers Sign in on the computer on a sign-in that failed, in place of a Retry that would fail the same way", async () => {
    const fake = signInHost();
    useStore.setState({ places: [here, placed(DONE, OWNERS_RUN)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const codex = dialog()!.querySelector<HTMLElement>("[data-step-row='signins/codex']")!;
    expect(codex.dataset["state"]).toBe("failed");
    expect([...codex.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Sign in on studio", "Skip"]);
    await press(codex.querySelector("[data-k=sign-in]"));
    expect(fake.signIns).toEqual([{ target: { placeId: studio.id }, agent: "codex" }]);
  });

  it("offers Sign in on a GitHub row skipped early while the setup still runs, since the run lands it among its rows", async () => {
    const fake = signInHost();
    const running: PlaceSetup = { ...DONE, state: "running", steps: [...DONE.steps, { step: "clis", state: "running" }] };
    useStore.setState({ places: [here, placed(running, OWNERS_RUN)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const github = dialog()!.querySelector<HTMLElement>("[data-step-row='github']")!;
    expect(github.dataset["state"]).toBe("skipped");
    await press(github.querySelector("[data-k=sign-in]"));
    expect(fake.signIns).toEqual([{ target: { placeId: studio.id }, agent: "gh" }]);
  });

  // What the host offers on an empty vault: Claude Code's sign-in is a token minted here and nothing else, so the
  // vault was its one choice, and it has none; the rest keep the login they run there.
  const EMPTY_VAULT: RecipeOptions = {
    ...OPTIONS,
    agents: [
      { id: "claude", name: "Claude Code", signins: [], kind: "token" },
      { id: "codex", name: "Codex", signins: ["machine"], kind: "device" },
      { id: "cursor", name: "Cursor", signins: ["machine"], kind: "key" },
      { id: "opencode", name: "OpenCode", signins: ["machine"], kind: "key" },
    ],
  };
  const boxReport = (): AgentsReport => ({
    target: { placeId: studio.id },
    home: "/root",
    user: "root",
    readAt: "x",
    agents: [
      { id: "claude", name: "Claude Code", installed: true, road: "wsp", signIn: "none", signInRoad: "token", wspTools: false },
      { id: "opencode", name: "OpenCode", installed: true, road: "wsp", signIn: "none", signInRoad: "terminal", wspTools: false },
    ],
    skills: [],
    servers: [],
    refused: [],
  });

  it("signs Claude Code in with a token pasted on its row where this computer had none to copy, as the computer's Sign-ins do", async () => {
    const keyed: { agent: string; key: string }[] = [];
    const fake = host({ agentsRead: async () => boxReport(), agentsKey: async (agent: string, key: string) => void keyed.push({ agent, key }) } as Partial<Api>);
    const run: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "signins/claude", label: "Claude Code", outcome: "failed", step: "signins", note: noCopyLine("Claude Code", "zingzy's MacBook Pro"), fix: signInWithFix("Claude Code", "token") }] };
    useStore.setState({ places: [here, placed(DONE, run)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const claude = (): HTMLElement => dialog()!.querySelector<HTMLElement>("[data-step-row='signins/claude']")!;
    expect(claude().textContent).toContain("Sign in with a Claude Code token instead.");
    expect([...claude().querySelectorAll("button")].map(b => b.textContent)).toEqual(["Sign in on studio", "Skip"]);
    await press(claude().querySelector("[data-k=sign-in]"));
    expect(claude().querySelector("[data-k=sign-in-mint]")?.textContent).toBe("claude setup-token");
    // The paste stands under the row with Cancel to close it, and no empty refusal room above that.
    expect([...claude().querySelectorAll("[data-k=sign-in], [data-k=skip]")].map(b => b.textContent)).toEqual(["Cancel", "Skip"]);
    expect(claude().querySelector("[data-k=sign-in-refused]")).toBeNull();
    fireEvent.change(claude().querySelector("[data-k=sign-in-key]")!, { target: { value: "sk-ant-oat01-x" } });
    await press(claude().querySelector("[data-k=sign-in-save]"));
    expect(keyed).toEqual([{ agent: "claude", key: "sk-ant-oat01-x" }]);
  });

  it("opens OpenCode's sign-in in place as its own terminal on the computer, since it asks which provider: no line to copy", async () => {
    const fake = signInHost({ agentsRead: async () => boxReport() } as Partial<Api>);
    // The row as the setup lands it for a login that asks the person to pick.
    const run: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "signins/opencode", label: "OpenCode", outcome: "skipped", step: "signins", note: AT_ITS_TERMINAL }] };
    useStore.setState({ places: [here, placed(DONE, run)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const opencode = (): HTMLElement => dialog()!.querySelector<HTMLElement>("[data-step-row='signins/opencode']")!;
    expect(opencode().dataset["state"]).toBe("skipped");
    expect(opencode().textContent).toContain("Signs in at its own terminal on studio.");
    await press(opencode().querySelector("[data-k=sign-in]"));
    await settle();
    expect(fake.signIns).toEqual([{ target: { placeId: studio.id }, agent: "opencode", terminal: true }]);
    expect(opencode().querySelector("[data-k=sign-in-terminal]")).not.toBeNull();
    expect(opencode().querySelector("[data-k=sign-in-line]")).toBeNull();
    await waitFor(() => expect(fake.opened).toEqual([{ placeId: studio.id }]));
    // The flow it opened is closed from its row, not opened again.
    expect([...opencode().querySelectorAll("button")].map(b => b.textContent)).toEqual(["Cancel"]);
  });

  it("says a terminal sign-in the person left as left, with Sign in again under it and no empty line over it", async () => {
    const fake = signInHost({ agentsRead: async () => boxReport() } as Partial<Api>);
    const run: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "signins/opencode", label: "OpenCode", outcome: "skipped", step: "signins", note: AT_ITS_TERMINAL }] };
    useStore.setState({ places: [here, placed(DONE, run)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const opencode = (): HTMLElement => dialog()!.querySelector<HTMLElement>("[data-step-row='signins/opencode']")!;
    await press(opencode().querySelector("[data-k=sign-in]"));
    await settle();
    // Esc in OpenCode's picker, which quits it: the host reads no sign-in there.
    fake.tell({ state: "failed", said: closedBeforeSignInLine("OpenCode") });
    expect(opencode().querySelector("[data-k=sign-in-refused]")?.textContent).toBe("OpenCode closed before it signed in.");
    expect(opencode().querySelector("[data-sign-in-line]")).toBeNull();
    expect(opencode().textContent).not.toMatch(/exit/);
    expect([...opencode().querySelectorAll("button")].map(b => b.textContent)).toContain("Sign in on studio");
  });

  it("gives Esc pressed in a terminal sign-in to that terminal and keeps the sheet open; Esc anywhere else in it closes it", async () => {
    const fake = signInHost({ agentsRead: async () => boxReport() } as Partial<Api>);
    const run: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "signins/opencode", label: "OpenCode", outcome: "skipped", step: "signins", note: AT_ITS_TERMINAL }] };
    useStore.setState({ places: [here, placed(DONE, run)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const opencode = (): HTMLElement => dialog()!.querySelector<HTMLElement>("[data-step-row='signins/opencode']")!;
    await press(opencode().querySelector("[data-k=sign-in]"));
    await settle();
    const terminal = opencode().querySelector<HTMLElement>("[data-k=sign-in-terminal]")!;
    act(() => void fireEvent.keyDown(terminal, { key: "Escape" }));
    await settle();
    expect(dialog()).not.toBeNull();
    expect(fake.stopped).toEqual([]);
    act(() => void fireEvent.keyDown(opencode(), { key: "Escape" }));
    await settle();
    expect(dialog()).toBeNull();
  });

  it("keeps a sign-in the host answers only after the sheet closed, drawn with Cancel when the sheet opens again", async () => {
    const fake = signInHost({ agentsRead: async () => boxReport() } as Partial<Api>, { late: true });
    const run: PlaceView["applied"] = { hash: "h", at: "x", rows: [{ id: "signins/opencode", label: "OpenCode", outcome: "skipped", step: "signins", note: AT_ITS_TERMINAL }] };
    useStore.setState({ places: [here, placed(DONE, run)] });
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    await press(dialog()!.querySelector("[data-step-row='signins/opencode'] [data-k=sign-in]"));
    await press(dialog()!.querySelector("[data-k=close]"));
    expect(dialog()).toBeNull();
    expect(fake.stopped).toEqual([]);
    fake.answer();
    await settle();
    // A run belongs to the window, not to the sheet that started it: nothing stops it, and the sheet opened again
    // draws it with the Cancel that does.
    expect(fake.stopped).toEqual([]);
    act(() => openSetup(studio.id));
    await settle();
    const opencode = (): HTMLElement => dialog()!.querySelector<HTMLElement>("[data-step-row='signins/opencode']")!;
    expect(opencode().querySelector("[data-k=sign-in-terminal]")).not.toBeNull();
    expect([...opencode().querySelectorAll("button")].map(b => b.textContent)).toEqual(["Cancel"]);
    await press(opencode().querySelector("[data-k=sign-in]"));
    expect(fake.stopped).toEqual(["opencode"]);
  });

  it("never ticks an agent silently where this computer can serve none of its choices: it says the road it has", async () => {
    const fake = host({ recipesOptions: async () => EMPTY_VAULT } as Partial<Api>);
    useStore.setState({ places: [here, studio] });
    const pending: PendingComputer = { id: "a_9", address: "studio", step: "choosing", placeId: studio.id, startedAt: "x", choices: RecipeFile.parse({ name: "studio", agents: { claude: {}, codex: { signin: "machine" }, opencode: { signin: "machine" } } }) };
    localStorage.setItem("wsp:add-reached", JSON.stringify({ a_9: "agents" }));
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openPending(pending, 0));
    await settle();
    const claude = dialog()!.querySelector<HTMLElement>("[data-pick-row='claude']")!;
    expect(ticked("claude")).toBe(true);
    expect(claude.querySelector("[role=combobox]")).toBeNull();
    expect(claude.textContent).toContain("Signs in with a token you paste once it is set up.");
    // OpenCode's login asks which provider, so it signs in at its own terminal there once the add is through.
    expect(dialog()!.querySelector<HTMLElement>("[data-pick-row='opencode']")!.textContent).toContain("Signs in at its own terminal on studio once it is set up.");
    expect(dialog()!.querySelector<HTMLElement>("[data-pick-row='codex']")!.textContent).not.toContain("own terminal");
  });

  it("moves a recipe's sign-in this computer cannot serve onto one it can, before anything is set up", async () => {
    const fake = host({ recipesOptions: async () => EMPTY_VAULT } as Partial<Api>);
    useStore.setState({ places: [here, studio] });
    const pending: PendingComputer = { id: "a_9", address: "studio", step: "choosing", placeId: studio.id, startedAt: "x", recipe: "laptop", choices: RecipeFile.parse({ name: "studio", agents: { claude: { signin: "vault" }, codex: { signin: "vault" } } }) };
    localStorage.setItem("wsp:add-reached", JSON.stringify({ a_9: "agents" }));
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openPending(pending, 1));
    await settle();
    await waitFor(() => expect(useAddFlow.getState().picks?.agents).toEqual({ claude: {}, codex: { signin: "machine" } }));
  });

  it("reopens an add closed while its install runs on that install's checks, not the address", async () => {
    const fake = host();
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openAdd());
    await settle();
    act(() => useAddFlow.setState({ address: "studio" }));
    await press(primary());
    const addId = useAddFlow.getState().addId!;
    stage(addId, "connect", "done", "Ubuntu 24.04");
    stage(addId, "root", "running");
    act(() => closeAdd());
    act(() => openPending({ id: addId, address: "studio", step: "check", startedAt: "x", choices: RecipeFile.parse({ name: "studio" }) }, 1));
    await settle();
    expect(step()).toBe("checks");
    expect(dialog()!.querySelector("[data-step-row='root']")?.getAttribute("data-state")).toBe("working");
    // Joined while closed, before any pick: its checks again, and Continue goes on to the first pick.
    act(() => closeAdd());
    act(() => useStore.setState({ places: [here, studio] }));
    act(() => fake.joined());
    await settle();
    act(() => openPending({ id: addId, address: "studio", step: "floor", placeId: studio.id, startedAt: "x", choices: RecipeFile.parse({ name: "studio" }) }, 1));
    await settle();
    expect(step()).toBe("checks");
    await press(primary());
    expect(step()).toBe("agents");
  });

  it("reopens a pending add whose computer's setup started on its running steps", async () => {
    useStore.setState({ places: [here, placed(RUNNING)] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    localStorage.setItem("wsp:add-reached", JSON.stringify({ a_1: "clis" }));
    act(() => openPending({ id: "a_1", address: "studio", step: "choosing", placeId: studio.id, startedAt: "x", choices: RecipeFile.parse({ name: "studio" }) }, 1));
    await settle();
    expect(step()).toBe("running");
  });

  it("says the setup keeps going once a setup, not on every close", async () => {
    useStore.setState({ places: [here, placed({ ...RUNNING, addId: "a_once" })] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    const before = useNotices.getState().notices.length;
    for (let i = 0; i < 3; i++) {
      act(() => openSetup(studio.id));
      await settle();
      await press(dialog()!.querySelector("[data-k=close]"));
    }
    expect(useNotices.getState().notices.slice(before).map(n => n.text)).toEqual(["Setup keeps going. wsp pings you when it needs you."]);
  });

  it("draws the saved line's check in again at most once in a few seconds, however fast the picks move", async () => {
    const fake = host();
    useStore.setState({ places: [here, studio] });
    const pending: PendingComputer = { id: "a_s", address: "studio", step: "choosing", placeId: studio.id, startedAt: "x", choices: RecipeFile.parse({ name: "studio", agents: { claude: { signin: "vault" } } }) };
    localStorage.setItem("wsp:add-reached", JSON.stringify({ a_s: "agents" }));
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openPending(pending, 0));
    await settle();
    const check = (): Element | null => dialog()!.querySelector("[data-k=saved] svg");
    const first = check();
    expect(first).not.toBeNull();
    for (const on of [false, true, false, true]) {
      await press(dialog()!.querySelector("[data-pick-row='codex'] [role=checkbox]"));
      expect(ticked("codex")).toBe(on ? false : true);
    }
    expect(check()).toBe(first);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    try {
      await press(dialog()!.querySelector("[data-pick-row='codex'] [role=checkbox]"));
      expect(check()).not.toBe(first);
    } finally {
      clock.mockRestore();
    }
  });

  it("draws no crab on a setup row: a running step shows the plain spinner", async () => {
    useStore.setState({ places: [here, placed({ ...RUNNING, steps: [...RUNNING.steps, { step: "clis", state: "running" }, { step: "folders", state: "running" }] })] });
    mountSettings({ api: host().api, at: { kind: "group", group: "computers" } });
    act(() => openSetup(studio.id));
    await settle();
    const working = [...dialog()!.querySelectorAll<HTMLElement>("[data-step-row][data-state=working]")];
    expect(working.map(r => r.dataset["stepRow"])).toEqual(["agents", "clis", "folders"]);
    expect(dialog()!.querySelector("[data-crab]")).toBeNull();
    expect(working.every(r => r.querySelector("[data-state-mark=working] .animate-spin") !== null)).toBe(true);
  });

  it("names no vault, no wsp command and no dialling back in any of its words, through the checks and the running rows", async () => {
    const said: string[] = [];
    const fake = host();
    mountSettings({ api: fake.api, at: { kind: "group", group: "computers" } });
    act(() => openAdd());
    await settle();
    act(() => useAddFlow.setState({ address: "studio" }));
    await press(primary());
    const addId = useAddFlow.getState().addId!;
    for (const s of ["connect", "chip", "root", "system", "disk", "reach"] as const) stage(addId, s, "done");
    said.push(dialog()!.textContent ?? "");
    act(() => closeAdd());
    // Claude Code's row here had nothing to copy, over the owner's run where it copied.
    const rows = [
      { id: "signins/claude", label: "Claude Code", outcome: "failed" as const, step: "signins" as const, note: noCopyLine("Claude Code", "zingzy's MacBook Pro"), fix: signInWithFix("Claude Code", "token") },
      { id: "signins/opencode", label: "OpenCode", outcome: "skipped" as const, step: "signins" as const, note: AT_ITS_TERMINAL },
      { id: "folders/app", label: "app", outcome: "failed" as const, step: "folders" as const, note: "private; needs GitHub to clone", fix: "Sign GitHub in on studio, then retry." },
      ...OWNERS_RUN!.rows,
    ];
    const signing = signInHost({ agentsRead: async () => boxReport() } as Partial<Api>);
    cleanup();
    mountSettings({ api: signing.api, at: { kind: "group", group: "computers" } });
    useStore.setState({ places: [here, placed(DONE, { ...OWNERS_RUN!, rows: rows.filter((r, at) => rows.findIndex(x => x.id === r.id) === at) })] });
    act(() => openSetup(studio.id));
    await settle();
    said.push(dialog()!.textContent ?? "");
    // Each row's Sign in pressed in turn, what it opens under the row read too.
    const pressed: string[] = [];
    for (;;) {
      const next = [...dialog()!.querySelectorAll<HTMLElement>("[data-step-row]")].find(row => !pressed.includes(row.dataset["stepRow"]!) && row.querySelector("[data-k=sign-in]")?.textContent?.startsWith("Sign in") === true);
      if (next === undefined) break;
      pressed.push(next.dataset["stepRow"]!);
      await press(next.querySelector("[data-k=sign-in]"));
      await settle();
      said.push(dialog()!.textContent ?? "");
    }
    expect(pressed.sort()).toEqual(["github", "signins/claude", "signins/codex", "signins/opencode"]);
    for (const words of said) {
      expect(words).not.toMatch(/vault/i);
      // textContent runs one element's words into the next with no space, so no word boundary stands before wsp.
      expect(words).not.toMatch(WSP_COMMAND);
      expect(words).not.toMatch(/dial/i);
    }
    expect(said.join(" ")).toContain("Connects back");
    // The verbs come whole off the command table, the two the last review slipped past it included.
    expect(VERBS).toEqual(expect.arrayContaining(["add", "agents", "computers", "init", "mcp", "remove", "servers", "recipes"]));
  });
});
