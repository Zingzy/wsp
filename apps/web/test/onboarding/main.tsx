// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the add-a-computer prototype over the real
// app shell and a fake api, one screen per ?screen=, in either theme
// (?theme=light, each side's theme by id with ?lightTheme= and ?darkTheme=).
// Dialog screens stand over Settings > Computers; the settings screens draw
// the prototype's pages in the settings column; ?screen=sidebar closes
// Settings and shows the Setting up section under three threads; ?screen=closing
// is the moment after the dialog is put away mid-setup.
import { createRoot } from "react-dom/client";
import { DEFAULT_PREFERENCES, type SessionView, type WorkspaceView } from "@wsp/protocol";
import { ScrollArea } from "../../src/components/ui/scroll-area";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { addNotice } from "../../src/notices/store";
import { AddComputerDialog, type Screen } from "../../src/proto/onboarding/AddComputerDialog";
import { ComputerPageProto, ComputersProto } from "../../src/proto/onboarding/ComputersProto";
import { PLACES, SETUP_CARDS, STUDIO } from "../../src/proto/onboarding/fixtures";
import { RecipePageProto, RecipesEmptyProto, RecipesListProto } from "../../src/proto/onboarding/RecipesProto";
import { useSettingUp } from "../../src/proto/onboarding/SettingUpSection";
import { useStore } from "../../src/protocol/store";
import { useSettingsStore } from "../../src/settings/settingsStore";
import { applyTheme } from "../../src/settings/theme";
import { AppShell } from "../../src/shell/AppShell";
import { settingsApi } from "../settings-harness";
import "../../src/index.css";
import "../../src/themes/index";

const params = new URLSearchParams(window.location.search);
const theme: "light" | "dark" = params.get("theme") === "light" ? "light" : "dark";
const picks = { lightTheme: params.get("lightTheme") ?? DEFAULT_PREFERENCES.lightTheme, darkTheme: params.get("darkTheme") ?? DEFAULT_PREFERENCES.darkTheme };
applyTheme({ theme, ...picks }, theme === "dark");

const DIALOGS: readonly Screen[] = ["where", "hostkey", "checks", "checks-refused", "startfrom", "agents", "mcp", "clis", "skills", "plugins", "projects", "projects-add", "other", "summary", "summary-disk", "running", "running-failed", "running-blocked", "running-done"];
type Page = "computers" | "computer" | "recipes" | "recipe" | "recipes-empty" | "closing" | "sidebar";
const screen = params.get("screen") ?? "where";
const dialog = (DIALOGS as readonly string[]).includes(screen) ? (screen as Screen) : null;
const page = dialog === null ? (screen as Page) : "computers";

const { api } = settingsApi();
const preferences = { ...DEFAULT_PREFERENCES, theme, ...picks, labs: false, projectLook: { pr_wsp: { icon: "terminal" as const, hue: "amber" as const }, pr_spoo: { icon: "globe" as const, hue: "blue" as const } } };

// Three threads on two projects, so the Setting up section stands under a sidebar with work in it.
const workspace = (id: string, name: string, project: string, place: string): WorkspaceView => ({ id, name, machineId: `m_${id}`, project: { id: `pr_${project}`, name: project, path: `/Users/zingzy/${project}`, computer: place }, phase: "running", golden: "snap_g", createdAt: "2026-10-03T08:00:00Z", place });
const workspaces: WorkspaceView[] = [workspace("ws_1", "relay-helper", "wsp", "p_spoo"), workspace("ws_2", "release-notes", "wsp", "p_here"), workspace("ws_3", "ban-flow", "spoo", "p_here")];
const ago = (m: number): number => Date.now() - m * 60_000;
const sessions: Record<string, SessionView[]> = {
  ws_1: [{ id: "s1", threadId: "s1", workspaceId: "ws_1", harness: "claude", status: "running", prompt: "Move the relay to one callback helper.", startedBy: "person", startedAt: ago(22) }],
  ws_2: [{ id: "s2", threadId: "s2", workspaceId: "ws_2", harness: "codex", status: "completed", prompt: "Release notes for 0.9.", startedBy: "person", startedAt: ago(70), endedAt: ago(61) }],
  ws_3: [{ id: "s3", threadId: "s3", workspaceId: "ws_3", harness: "claude", status: "completed", prompt: "Ban flow: take a link down from the report.", startedBy: "cli", startedAt: ago(140), endedAt: ago(131) }],
};

useStore.setState({ api, conn: "live", ready: true, projectsRead: true, places: PLACES, preferences, settingsOpen: page !== "sidebar", workspaces, sessions });
if (page === "sidebar" || page === "closing") useSettingUp.setState({ cards: SETUP_CARDS });
const go = useSettingsStore.getState().go;
if (page === "computer") go({ kind: "computer", id: STUDIO.id });
else if (page === "recipes" || page === "recipe" || page === "recipes-empty") go({ kind: "group", group: "recipes" });
else go({ kind: "group", group: "computers" });

function ProtoSettingsPage() {
  const content =
    page === "computer" ? <ComputerPageProto /> : page === "recipes" ? <RecipesListProto open={() => {}} openAdd={() => {}} /> : page === "recipe" ? <RecipePageProto /> : page === "recipes-empty" ? <RecipesEmptyProto openAdd={() => {}} /> : <ComputersProto openComputer={() => {}} openAdd={() => {}} />;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div data-settings-page data-settings-at={page} className="group/settings mx-auto flex w-full max-w-[760px] flex-col gap-[30px] px-8 pt-7 pb-12 max-sm:px-4 max-sm:pt-6">
        {content}
      </div>
    </ScrollArea>
  );
}

// ?scroll=bottom scrolls the dialog's panel to its end once drawn, so the rows under the fold can be photographed.
if (params.get("scroll") === "bottom") {
  const scroll = (): void => {
    const panel = document.querySelector("[data-slot=dialog-panel]");
    let box: HTMLElement | null = panel instanceof HTMLElement ? panel.parentElement : null;
    while (box !== null && box.scrollHeight <= box.clientHeight) box = box.parentElement;
    if (box === null) setTimeout(scroll, 50);
    else box.scrollTop = box.scrollHeight;
  };
  setTimeout(scroll, 300);
}

if (page === "closing") {
  setTimeout(() => addNotice({ kind: "note", text: "Setting up in the background. wsp pings you when it needs you.", where: "studio", action: { word: "Open", run: () => {} } }), 50);
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <AppShell>{page === "sidebar" ? <div /> : <ProtoSettingsPage />}</AppShell>
    {dialog === null ? null : <AddComputerDialog screen={dialog} />}
  </TooltipProvider>,
);
