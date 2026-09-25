// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's host of the agents manager: what a task can use, read on
// its own machine, the computer's own rows and its project's, drawn at the
// panel's width. The head says which computer and which project, and links
// to that computer's page, where everything on it is managed. A task on a box
// offers no act of its own, since what is installed is that box's; a fork at
// a cloud is a copy of the image, so its one act is Edit image.
import { HERE_PLACE_ID, isLocalWorkspace, type WorkspaceView } from "@wsp/protocol";
import { useAbsentComputer, useStore, useWorkspace } from "../../protocol/store.js";
import { placeName, placeOf, THIS_COMPUTER_WORD } from "../../settings/places.js";
import { useSettingsStore } from "../../settings/settingsStore.js";
import { openPanelTerminalWith } from "../../shell/shellCommands.js";
import type { AgentsWhere } from "./agentsRows.js";
import { AgentsManager, type AgentsHead } from "./AgentsManager.js";
import { useAgentActs } from "./useAgentActs.js";
import { useAgentsReport } from "./useAgentsReport.js";
import { useServerTools } from "./useServerTools.js";

/** A path under the machine's home, the way its shell shows it. */
const atHome = (path: string, home: string | undefined): string => (home !== undefined && home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

/** The project's folder where the task works it: its copy on this computer, else where the project lives. */
const projectPath = (workspace: WorkspaceView): string | undefined => {
  const path = workspace.copy?.path ?? workspace.project.path;
  return path === undefined || path === "" ? undefined : atHome(path, workspace.home);
};

export const PANEL_WORDS = {
  title: (computer: string, project: string): string => `On ${computer}, for ${project}`,
  fork: (workspace: string, cloud: string): string => `${workspace} (${cloud})`,
  line: (computer: string, project: string, path: string | undefined): string => `Agents, MCP servers and skills this thread can use: global on ${computer}, plus ${project}'s own${path === undefined ? "" : ` at ${path}`}.`,
  image: "Acts edit the image.",
} as const;

export function AgentsSurface({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const places = useStore(s => s.places);
  const absent = useAbsentComputer(workspaceId);
  const target = workspace === null ? null : { workspaceId };
  const { report, reading, error, refresh } = useAgentsReport(target);
  const tools = useServerTools(target);
  const acts = useAgentActs(target);
  const place = workspace === null ? undefined : placeOf(places, workspace);
  const where: AgentsWhere = workspace === null || isLocalWorkspace(workspace) ? "here" : place?.kind === "computer" ? "box-task" : "fork";
  const cloud = place === undefined ? undefined : placeName(place);
  const computer = where === "here" ? THIS_COMPUTER_WORD : where === "fork" && workspace !== null ? PANEL_WORDS.fork(workspace.name, cloud ?? "") : (cloud ?? "");
  const project = workspace?.project.name ?? "";
  const path = workspace === null ? undefined : projectPath(workspace);
  const line = PANEL_WORDS.line(computer, project, path);
  const placeId = place?.id ?? (where === "here" ? HERE_PLACE_ID : undefined);
  const head: AgentsHead = {
    title: PANEL_WORDS.title(computer, project),
    line: where === "fork" ? `${line} ${PANEL_WORDS.image}` : line,
    ...(placeId === undefined
      ? {}
      : {
          manage: {
            computer: where === "here" ? THIS_COMPUTER_WORD : (cloud ?? ""),
            open: () => {
              useSettingsStore.getState().go({ kind: "computer", id: placeId });
              useStore.getState().openSettings();
            },
          },
        }),
  };
  return (
    <div data-k="agents-surface" className="min-h-0 flex-1 overflow-y-auto">
      <AgentsManager
        shell="panel"
        head={head}
        report={report}
        reading={reading}
        error={error}
        on={computer}
        ctx={{
          where,
          ...(where === "box-task" && cloud !== undefined ? { computer: cloud } : {}),
          heldWhy: absent?.away ?? null,
          ...(where === "fork" ? { editImage: () => useStore.getState().openSetup() } : {}),
          ...(tools === undefined ? {} : { tools }),
          ...(acts === undefined ? {} : { acts }),
          ...(where === "here" ? { typeInTerminal: (typed: string) => void openPanelTerminalWith(workspaceId, typed) } : {}),
          ...(workspace === null ? {} : { project: { name: project, ...(path === undefined ? {} : { path }) } }),
        }}
        onRefresh={refresh}
        now={Date.now()}
      />
    </div>
  );
}
