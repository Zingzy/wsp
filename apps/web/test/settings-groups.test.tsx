// SPDX-License-Identifier: AGPL-3.0-only
// The five groups beside Appearance and Computers: Projects with each
// project's page and its one act, Devices with Revoke, Account's one row,
// Keybindings as lines per platform, and About's two lines.
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { DEFAULT_KEYBINDINGS } from "../src/keybindingDefaults.js";
import { KEYBINDING_COMMANDS, type KeybindingCommand } from "../src/keybindingTypes.js";
import type { DeviceView, PlaceView, ProjectView, WorkspaceView } from "@wsp/protocol";
import { DEFAULT_PREFERENCES, DEVICES_TICKET_REFUSAL, fmtBytes, projectInUseRefusal } from "@wsp/protocol";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { ABOUT_WORDS, ACCOUNT_WORDS, DEVICES_WORDS, KEYBINDINGS_WORDS, PROJECTS_WORDS, WHERE_WORDS } from "../src/settings/format.js";
import { chordsOf, keybindingCards } from "../src/settings/keybindings.js";
import { JUMP_WORD, KEYBINDING_WORDS } from "../src/settings/keybindingWords.js";
import { placeName } from "../src/settings/places.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { crumb, descriptionOf, lineLabels, lineOf, mountSettings, pageAt, resetSettings, rowOf, rowTitles, settingsApi, settle, wordOf } from "./settings-harness.js";
import { lastNotice } from "./notice-text.js";

const AT = "2026-09-12T09:14:00.000Z";
const here: PlaceView = { id: "here", kind: "computer", name: "zingzy-mbp", default: true, present: true, takesForks: false };
const box: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, takesForks: true };
const solari: PlaceView = { id: "solari", kind: "provider", name: "solari", default: false, rateUsdPerHour: 0.11, takesForks: true };
const project = (id: string, name: string, computer = "here", over: Partial<ProjectView> = {}): ProjectView => ({ id, name, computer, source: { kind: "folder", path: `/Users/dev/${name}` }, path: `/Users/dev/${name}`, remote: `https://github.com/dev/${name}.git`, defaultBranch: "main", memoryKey: `-Users-dev-${name}`, memoryDir: `/Users/dev/.claude-cfg/projects/-Users-dev-${name}/memory`, createdAt: AT, ...over });
const view = (id: string, name: string, projectId: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, kind: "local", project: { id: projectId, name: "spoo", path: "/Users/dev/spoo", computer: "here" }, phase: "running", golden: "", createdAt: AT });
const device = (id: string, name: string, over: Partial<DeviceView> = {}): DeviceView => ({ id, name, createdAt: "2026-09-01T00:00:00Z", lastSeenAt: new Date(Date.now() - 12 * 60_000).toISOString(), ...over });

const mount = async (over: Partial<Api>, group: "projects" | "devices" | "account" | "keybindings" | "about"): Promise<void> => {
  mountSettings({ api: settingsApi(over).api, at: { kind: "group", group } });
  await settle();
};

beforeEach(() => {
  resetSettings();
});

afterEach(() => {
  document.body.innerHTML = "";
  delete window.wsp;
  delete (window as unknown as { __WSP__?: unknown }).__WSP__;
});

describe("Projects", () => {
  it("lists one row per project with its glyph, the computer it is on then its source, and the workspace count, and the empty state with the button", async () => {
    useStore.setState({ places: [here, box], projects: [project("pr_spoo", "spoo"), project("pr_landing", "landing", "p_spoo", { source: { kind: "github", repo: "dev/landing" } })], workspaces: [view("ws_a", "pricing page", "pr_spoo"), view("ws_b", "webhook retries", "pr_spoo")] });
    await mount({}, "projects");
    expect(rowTitles()).toEqual(["spoo", "landing"]);
    expect(descriptionOf("pr_spoo")).toBe(`${placeName(here, true)} · /Users/dev/spoo`);
    expect(rowOf("pr_spoo")!.querySelector("svg")).not.toBeNull();
    expect(wordOf("pr_spoo")).toBe("2");
    expect(descriptionOf("pr_landing")).toBe("spoo · dev/landing");
    // A loaded zero is a fact: a blank where a sibling reads 2 cannot be told from a count that never arrived.
    expect(wordOf("pr_landing")).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: PROJECTS_WORDS.add }));
    await waitFor(() => expect(document.querySelector("[data-k=add-project]")).not.toBeNull());
    act(() => useSettingsStore.getState().closeAddProject());
    act(() => useStore.setState({ projects: [] }));
    await settle();
    expect(rowTitles()).toEqual([PROJECTS_WORDS.none]);
    expect(descriptionOf("none")).toBe(PROJECTS_WORDS.noneDescription);
    expect(screen.getByRole("button", { name: PROJECTS_WORDS.add })).toBeTruthy();
  });

  it("a project's page says its lines, its two rows, and Remove held with the refusal while a workspace stands, else asks with the line for the computer's kind and lands the runtime's answer as the toast", async () => {
    const removed: string[] = [];
    const spoo = project("pr_spoo", "spoo", "here", { base: "release", lastAgent: "codex", seeded: { files: 412, bytes: 3_250_000, memory: "landed", commits: 9, at: AT } });
    useStore.setState({ places: [here, box, solari], projects: [spoo, project("pr_landing", "landing", "p_spoo"), project("pr_cloud", "cloud", "solari")], workspaces: [view("ws_a", "pricing page", "pr_spoo")] });
    await mount(
      {
        projectsRemove: async (id: string) => {
          removed.push(id);
          return { said: "landing is no longer a project on spoo" };
        },
      } as Partial<Api>,
      "projects",
    );
    fireEvent.click(rowOf("pr_spoo")!);
    expect(pageAt()).toBe("project:pr_spoo");
    expect(crumb()).toBe("Settings/Projects/spoo");
    expect(lineLabels()).toEqual([PROJECTS_WORDS.source, PROJECTS_WORDS.computer, PROJECTS_WORDS.remote, PROJECTS_WORDS.added, PROJECTS_WORDS.seeded]);
    expect(wordOf("source")).toBe("/Users/dev/spoo");
    expect(wordOf("computer")).toBe("This Mac");
    expect(wordOf("remote")).toBe("https://github.com/dev/spoo.git");
    expect(lineOf("remote")?.getAttribute("title")).toBe(PROJECTS_WORDS.remoteHover);
    expect(wordOf("added")).toMatch(/^Sep 12 \d\d:\d\d$/);
    expect(wordOf("seeded")).toBe(`412 files · ${fmtBytes(3_250_000)} · memory landed`);
    // About comes first, then Look with its two selects, then what a new workspace starts from.
    expect([...document.querySelectorAll("[data-settings-page] [data-settings-head]")].map(h => h.textContent)).toEqual([PROJECTS_WORDS.about, PROJECTS_WORDS.look, PROJECTS_WORDS.newWorkspaces]);
    expect(rowTitles()).toEqual([PROJECTS_WORDS.icon, PROJECTS_WORDS.hue, PROJECTS_WORDS.branch, PROJECTS_WORDS.lastAgent, "Remove spoo"]);
    expect(wordOf("branch")).toBe("release");
    expect(wordOf("last-agent")).toBe("Codex");
    // A workspace stands on it: the button is held with no title and the refusal is the description.
    const remove = (): HTMLElement => document.querySelector<HTMLElement>("[data-k=remove-project]")!;
    expect(remove().hasAttribute("disabled")).toBe(true);
    expect(remove().hasAttribute("title")).toBe(false);
    // Held, it is the neutral outline further down the opacity ramp, with no hue of its own anywhere.
    expect(remove().className).not.toMatch(/warning|bg-destructive/);
    expect(remove().className).toContain("disabled:opacity-50");
    expect(remove().className).toContain("border-input");
    expect(descriptionOf("remove")).toBe(projectInUseRefusal("spoo", ["pricing page"]));
    // A project on a joined computer: the line names wsp's own clone there.
    act(() => useSettingsStore.getState().go({ kind: "project", id: "pr_landing" }));
    await settle();
    expect(wordOf("computer")).toBe("spoo");
    expect(wordOf("branch")).toBe("main");
    expect(rowOf("last-agent")).toBeNull();
    expect(descriptionOf("remove")).toBe(PROJECTS_WORDS.removeOnComputer("spoo"));
    expect(remove().hasAttribute("disabled")).toBe(false);
    fireEvent.click(remove());
    expect(document.querySelector("[data-k=remove-project-title]")?.textContent).toBe("Remove landing?");
    expect(document.querySelector("[data-k=remove-project-sentence]")?.textContent).toBe(PROJECTS_WORDS.removeOnComputer("spoo"));
    expect(document.querySelector<HTMLElement>("[data-k=remove-project-confirm]")!.className).toContain("bg-destructive");
    fireEvent.click(document.querySelector("[data-k=remove-project-confirm]")!);
    await waitFor(() => expect(removed).toEqual(["pr_landing"]));
    await waitFor(() => expect(lastNotice()).toBe("landing is no longer a project on spoo"));
    expect(pageAt()).toBe("projects");
    // A project at a cloud: the line names its image there.
    act(() => useSettingsStore.getState().go({ kind: "project", id: "pr_cloud" }));
    await settle();
    expect(descriptionOf("remove")).toBe(PROJECTS_WORDS.removeAtCloud("Solari"));
  });
});

describe("a project's Look", () => {
  it("reads the record's look into the two selects and writes a pick as that project's look", async () => {
    useStore.setState({ places: [here], projects: [project("pr_spoo", "spoo")], workspaces: [] });
    const { api, sets } = settingsApi({}, { ...DEFAULT_PREFERENCES, labs: false, projectLook: { pr_spoo: { icon: "rocket" } } });
    useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, labs: false, projectLook: { pr_spoo: { icon: "rocket" } } } });
    mountSettings({ api, at: { kind: "project", id: "pr_spoo" } });
    await settle();
    const iconSelect = document.querySelector<HTMLElement>("[data-settings-page] [data-k=project-icon]")!;
    const hueSelect = document.querySelector<HTMLElement>("[data-settings-page] [data-k=project-hue]")!;
    expect(iconSelect.textContent).toBe("Rocket");
    expect(hueSelect.textContent).toBe("Neutral");
    fireEvent.click(hueSelect);
    const option = await screen.findByRole("option", { name: "Teal" });
    await settle();
    // Under jsdom the select takes a click on an item only once a key has highlighted it.
    fireEvent.keyDown(option, { key: "Enter" });
    fireEvent.click(option);
    await waitFor(() => expect(sets).toEqual([{ projectLook: { pr_spoo: { icon: "rocket", hue: "teal" } } }]));
    // The select leaves a portal React must unmount itself before the file's teardown empties the body.
    cleanup();
  });
});

describe("Devices", () => {
  it("lists one row per unscoped device with paired and seen, names this browser, and Revoke asks, calls the host and rereads", async () => {
    const revoked: string[] = [];
    let devices: DeviceView[] = [device("d_1", "zingzy-laptop"), device("d_2", "Safari on iPhone", { here: true, lastSeenAt: new Date().toISOString() }), device("d_3", "a thread's token", { scope: { kind: "thread", workspaceId: "ws_a", threadId: "th_1", rootThreadId: "th_1" } })];
    await mount(
      {
        devicesList: async () => devices,
        devicesRevoke: async (id: string) => {
          revoked.push(id);
          devices = devices.filter(d => d.id !== id);
        },
      } as Partial<Api>,
      "devices",
    );
    expect(rowTitles()).toEqual(["zingzy-laptop", DEVICES_WORDS.thisBrowser]);
    expect(descriptionOf("d_1")).toMatch(/^paired Sep 1 \d\d:\d\d · seen 1[12] min ago$/);
    // A device heard from inside the minute says so in words rather than as a span of zero.
    expect(descriptionOf("d_2")).toMatch(/^paired Sep 1 \d\d:\d\d · seen just now$/);
    expect(rowOf("d_1")?.querySelector("[data-settings-description]")?.className).toContain("font-mono");
    // The door to the confirmation is neutral where it stands and red only under the pointer; the act itself, in
    // the dialog, is the one red thing at rest.
    const revoke = rowOf("d_1")!.querySelector<HTMLElement>("[data-k=revoke]")!;
    expect(revoke.className).not.toMatch(/warning/);
    expect(revoke.className).toContain("text-foreground");
    expect(revoke.className).toContain("[:hover,[data-pressed]]:text-destructive-foreground");
    fireEvent.click(revoke);
    expect(document.querySelector("[data-k=revoke-title]")?.textContent).toBe("Revoke zingzy-laptop?");
    expect(document.querySelector("[data-k=revoke-sentence]")?.textContent).toBe(DEVICES_WORDS.revokeDescription);
    const confirm = document.querySelector<HTMLElement>("[data-k=revoke-confirm]")!;
    expect(confirm.className).toContain("bg-destructive");
    expect(confirm.className).not.toMatch(/warning/);
    fireEvent.click(confirm);
    await waitFor(() => expect(revoked).toEqual(["d_1"]));
    await waitFor(() => expect(rowTitles()).toEqual([DEVICES_WORDS.thisBrowser]));
    // Account holds no second list of them.
    act(() => useSettingsStore.getState().go({ kind: "group", group: "account" }));
    await settle();
    expect(document.body.textContent).not.toContain(DEVICES_WORDS.thisBrowser);
  });

  it("holds Revoke and says why in the row where this wsp carries no such request", async () => {
    await mount({ devicesList: async () => [device("d_1", "zingzy-laptop")] } as Partial<Api>, "devices");
    const revoke = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=revoke]")!;
    expect(revoke().disabled).toBe(true);
    expect(revoke().hasAttribute("title")).toBe(false);
    expect(descriptionOf("d_1")).toMatch(new RegExp(`· ${WHERE_WORDS.notYet}$`));
  });

  it("says one line where nothing is paired, and one where a page served on a ticket socket is refused the list", async () => {
    await mount({ devicesList: async () => [] } as Partial<Api>, "devices");
    expect(lineLabels()).toEqual([DEVICES_WORDS.none]);
    document.body.innerHTML = "";
    resetSettings();
    await mount({ devicesList: async () => Promise.reject(new Error(DEVICES_TICKET_REFUSAL)) } as Partial<Api>, "devices");
    expect(lineLabels()).toEqual([DEVICES_WORDS.refused]);
  });
});

describe("Account", () => {
  it("says nothing but the sentences and the held button with no title while nobody is signed in; signed in reads the login and offers Sign out", async () => {
    await mount({ account: async () => ({ signedIn: false }) } as Partial<Api>, "account");
    expect(rowTitles()).toEqual([ACCOUNT_WORDS.github]);
    // No word for being signed in or not: the button standing there is that state, and the room is the sentence's.
    expect(wordOf("github")).toBeUndefined();
    expect(descriptionOf("github")).toBe(ACCOUNT_WORDS.reach);
    const action = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>("[data-k=account-action]")!;
    expect(action().textContent).toBe(ACCOUNT_WORDS.signIn);
    expect(action().disabled).toBe(true);
    expect(action().hasAttribute("title")).toBe(false);
    expect(action().className).toContain("disabled:opacity-50");
    document.body.innerHTML = "";
    resetSettings();
    await mount({ account: async () => ({ signedIn: true, login: "zingzy" }) } as Partial<Api>, "account");
    expect(wordOf("github")).toBe("zingzy");
    expect(action().textContent).toBe(ACCOUNT_WORDS.signOut);
    expect(descriptionOf("github")).toBe(ACCOUNT_WORDS.reachable);
    // A host that refuses the read leaves the slot empty and keeps the sentence.
    document.body.innerHTML = "";
    resetSettings();
    await mount({ account: async () => Promise.reject(new Error("this host keeps no account records")) } as Partial<Api>, "account");
    expect(wordOf("github")).toBeUndefined();
    expect(descriptionOf("github")).toBe(ACCOUNT_WORDS.reach);
  });
});

describe("Keybindings", () => {
  const mac = { platform: "MacIntel", desktopShell: true };
  const label = (command: KeybindingCommand, read = mac): string[][] => chordsOf(DEFAULT_KEYBINDINGS, command, read);

  it("words every command in the closed set, so a command added to it must get its words", () => {
    expectTypeOf(KEYBINDING_WORDS).toEqualTypeOf<Record<KeybindingCommand, string>>();
    for (const command of KEYBINDING_COMMANDS) expect(KEYBINDING_WORDS[command]).not.toBe("");
  });

  it("draws one line per default rule with the chord's keycaps per platform, both where a command has two, the nine jumps as one line, and drops in a tab what the tab keeps", () => {
    expect(label("commandPalette.toggle")).toEqual([["⌘K"]]);
    expect(label("settings.toggle")).toEqual([["⌘,"]]);
    expect(label("chat.new")).toEqual([["⌘N"], ["⌘T"]]);
    expect(label("workspace.next")).toEqual([["⌥⌘Right"], ["⌃Tab"]]);
    expect(label("terminal.zoomIn")).toEqual([["⌘="], ["⇧⌘="]]);
    expect(label("workspace.select.1")).toEqual([["⌘1"], ["⌘9"]]);
    // On another platform the same rules read Ctrl.
    expect(label("commandPalette.toggle", { platform: "Linux x86_64", desktopShell: true })).toEqual([["Ctrl+K"]]);
    // In a browser tab the chords the tab keeps are not drawn: New thread reads its one remaining chord, the
    // workspace switch on a Mac has none left and the thread switch keeps its arrows.
    const tab = { platform: "MacIntel", desktopShell: false };
    expect(label("chat.new", tab)).toEqual([["⌘N"]]);
    expect(label("workspace.next", tab)).toEqual([]);
    expect(label("thread.next", tab)).toEqual([["⌥⌘Down"]]);
    expect(label("workspace.select.1", tab)).toEqual([]);
    const cards = keybindingCards(DEFAULT_KEYBINDINGS, mac);
    expect(cards.map(card => card.head)).toEqual([undefined, KEYBINDINGS_WORDS.workspacesAndThreads, KEYBINDINGS_WORDS.terminal, KEYBINDINGS_WORDS.fixed]);
    expect(cards[0]!.items.map(item => (item.kind === "line" ? item.label : ""))).toEqual(["Search", "Settings", "Toggle the sidebar", "Toggle the terminal drawer", "Toggle the right panel", "Toggle the preview"]);
    expect(cards[1]!.items.map(item => (item.kind === "line" ? item.label : ""))).toEqual(["New thread", "Next workspace", "Previous workspace", "Next thread", "Previous thread", JUMP_WORD]);
    expect(cards[3]!.items.map(item => (item.kind === "line" ? [item.label, item.keys] : []))).toEqual([
      [KEYBINDINGS_WORDS.sendMessage, [["Enter"]]],
      [KEYBINDINGS_WORDS.submitComment, [["⌘Enter"]]],
      [KEYBINDINGS_WORDS.leaveSettings, [["Esc"]]],
    ]);
  });

  it("stands on the page as lines with keycaps, no row and no description", async () => {
    window.wsp = {};
    await mount({}, "keybindings");
    expect(rowTitles()).toEqual([]);
    expect(lineLabels()).toContain("Search");
    expect(document.querySelectorAll("[data-settings-page] [data-slot=kbd]").length).toBeGreaterThan(10);
    expect(document.querySelector("[data-settings-page] [data-command='chat.new'] [data-settings-keys]")?.textContent).toMatch(/N.*T$|N$/);
  });
});

describe("About", () => {
  it("says the app's half and the host's in the shell, the host's alone in a tab, unknown where the shell names none, and Releases opens the releases page", async () => {
    (window as unknown as { __WSP__?: unknown }).__WSP__ = { wsPort: 1, tokenHash: "a".repeat(64), wsPath: "/ws", paired: true, version: "0.1.5" };
    window.wsp = { version: "0.1.3" };
    await mount({}, "about");
    expect(lineLabels()).toEqual([ABOUT_WORDS.app, ABOUT_WORDS.host]);
    expect(document.querySelector("[data-k=app-version] [data-settings-word]")?.textContent).toBe("0.1.3");
    expect(document.querySelector("[data-k=host-version] [data-settings-word]")?.textContent).toBe("0.1.5");
    expect(document.querySelector("[data-k=host-version] [data-settings-word]")?.className).toContain("font-mono");
    expect(rowTitles()).toEqual([]);
    let opened: string | undefined;
    window.open = ((url: string) => {
      opened = url;
      return null;
    }) as typeof window.open;
    fireEvent.click(screen.getByRole("button", { name: ABOUT_WORDS.releases }));
    expect(opened).toMatch(/\/releases$/);
    document.body.innerHTML = "";
    resetSettings();
    delete window.wsp;
    await mount({}, "about");
    expect(lineLabels()).toEqual([ABOUT_WORDS.host]);
    document.body.innerHTML = "";
    resetSettings();
    window.wsp = {};
    await mount({}, "about");
    expect(document.querySelector("[data-k=app-version] [data-settings-word]")?.textContent).toBe(ABOUT_WORDS.unknown);
  });
});
