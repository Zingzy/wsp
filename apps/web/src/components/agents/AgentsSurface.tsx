// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's host of the agents manager: what a task can use, read on
// its own machine, the computer's own rows and its project's, drawn at the
// panel's width. Each tab's line names the computer, whose name opens that
// computer's page where everything on it is managed, and the project, its
// folder on its name's hover. A task on a box offers no act of its
// own, since what is installed is that box's; a fork at a cloud is a copy of
// the image, so its one act is Edit image.
import { useEffect, useState } from "react";
import { HERE_PLACE_ID, isLocalWorkspace, type AbsentComputer, type WorkspaceView } from "@wsp/protocol";
import { useAbsentComputer, useStore, useWorkspace } from "../../protocol/store.js";
import { openImageRecipe } from "../../settings/openAt.js";
import { hereName, placeName, placeOf } from "../../settings/places.js";
import { useSettingsStore } from "../../settings/settingsStore.js";
import { openPanelTerminalWith } from "../../shell/shellCommands.js";
import { NOT_ANSWERING_AFTER_MS, saysNotAnswering, type AgentsWhere } from "./agentsRows.js";
import { AgentsManager, type AgentsHead } from "./AgentsManager.js";
import { useAgentActs } from "./useAgentActs.js";
import { useAgentsReport } from "./useAgentsReport.js";
import { useServerTools } from "./useServerTools.js";
import { useServerActs } from "./useServerActs.js";
import { useSkillActs } from "./useSkillActs.js";

/** A path under the machine's home, the way its shell shows it. */
const atHome = (path: string, home: string | undefined): string => (home !== undefined && home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

/** The project's folder where the task works it: its copy on this computer, else where the project lives. */
const projectPath = (workspace: WorkspaceView): string | undefined => {
  const path = workspace.copy?.path ?? workspace.project.path;
  return path === undefined || path === "" ? undefined : atHome(path, workspace.home);
};

export const PANEL_WORDS = {
  fork: (workspace: string, cloud: string): string => `${workspace} (${cloud})`,
} as const;

/** The computer's silence once it has lasted long enough to say, counted from when it was last heard where the host
 * knows that and from when this panel first saw it silent otherwise; the panel draws again as the span runs out. */
function useLastingAbsence(workspaceId: string, lastSeenAt: string | undefined): AbsentComputer | null {
  const absent = useAbsentComputer(workspaceId);
  const silent = absent !== null;
  const [seenSilent, setSeenSilent] = useState<number | null>(null);
  const [, redraw] = useState(0);
  useEffect(() => setSeenSilent(silent ? Date.now() : null), [silent]);
  const heard = lastSeenAt === undefined ? NaN : Date.parse(lastSeenAt);
  const since = Number.isNaN(heard) ? seenSilent : heard;
  const awayMs = !silent || since === null ? null : Date.now() - since;
  // Before the panel has counted any silence it says nothing yet.
  const lasting = silent && since !== null && saysNotAnswering(awayMs);
  useEffect(() => {
    if (absent === null || lasting || awayMs === null) return;
    const timer = setTimeout(() => redraw(n => n + 1), NOT_ANSWERING_AFTER_MS - awayMs);
    return () => clearTimeout(timer);
  }, [absent, lasting, awayMs]);
  return lasting ? absent : null;
}

export function AgentsSurface({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const places = useStore(s => s.places);
  const lastSeenAt = workspace === null ? undefined : placeOf(places, workspace)?.lastSeenAt;
  const absent = useLastingAbsence(workspaceId, lastSeenAt);
  const target = workspace === null ? null : { workspaceId };
  const { report, reading, error, refresh } = useAgentsReport(target);
  const tools = useServerTools(target);
  const acts = useAgentActs(target);
  const skills = useSkillActs(target);
  const servers = useServerActs(target);
  const place = workspace === null ? undefined : placeOf(places, workspace);
  const where: AgentsWhere = workspace === null || isLocalWorkspace(workspace) ? "here" : place?.kind === "computer" ? "box-task" : "fork";
  const cloud = place === undefined ? undefined : placeName(place);
  const computer = where === "here" ? hereName(places) : where === "fork" && workspace !== null ? PANEL_WORDS.fork(workspace.name, cloud ?? "") : (cloud ?? "");
  const project = workspace?.project.name ?? "";
  const path = workspace === null ? undefined : projectPath(workspace);
  const placeId = place?.id ?? (where === "here" ? HERE_PLACE_ID : undefined);
  const head: AgentsHead = {
    ...(computer === "" ? {} : { computer }),
    ...(project === "" ? {} : { project: { name: project, ...(path === undefined ? {} : { path }) } }),
    ...(placeId === undefined
      ? {}
      : {
          open: () => {
            useSettingsStore.getState().go({ kind: "computer", id: placeId });
            useStore.getState().openSettings();
          },
        }),
  };
  return (
    <div data-k="agents-surface" className="flex min-h-0 flex-1 flex-col">
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
          ...(where === "fork" && placeId !== undefined ? { editImage: () => openImageRecipe(placeId) } : {}),
          ...(tools === undefined ? {} : { tools }),
          ...(acts === undefined ? {} : { acts }),
          ...(skills === undefined ? {} : { skills }),
          ...(servers === undefined ? {} : { servers }),
          ...(where === "here" ? { typeInTerminal: (typed: string) => void openPanelTerminalWith(workspaceId, typed) } : {}),
        }}
        onRefresh={refresh}
        now={Date.now()}
      />
    </div>
  );
}
