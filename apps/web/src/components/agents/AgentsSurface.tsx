// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's Agents surface: the agents, skills and MCP servers read
// on the task's own machine and its project, drawn at the panel's width with
// no card shell. A task on a box offers no act of its own, since what is
// installed is that box's: the head names the box and opens its page. A fork
// at a cloud is a copy of the image, so its one act is Edit image.
import { isLocalWorkspace } from "@wsp/protocol";
import { useAbsentComputer, useStore, useWorkspace } from "../../protocol/store.js";
import { placeName, placeOf } from "../../settings/places.js";
import { useSettingsStore } from "../../settings/settingsStore.js";
import { Button } from "../ui/button.js";
import type { AgentsWhere } from "./agentsRows.js";
import { AgentsList } from "./AgentsList.js";
import { useAgentsReport } from "./useAgentsReport.js";
import { useServerTools } from "./useServerTools.js";

export function AgentsSurface({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);
  const places = useStore(s => s.places);
  const absent = useAbsentComputer(workspaceId);
  const { report, reading, error, refresh } = useAgentsReport(workspace === null ? null : { workspaceId });
  const tools = useServerTools(workspace === null ? null : { workspaceId });
  const place = workspace === null ? undefined : placeOf(places, workspace);
  const where: AgentsWhere = workspace === null || isLocalWorkspace(workspace) ? "here" : place?.kind === "computer" ? "box-task" : "fork";
  const computer = where === "box-task" && place !== undefined ? placeName(place) : undefined;
  const openComputer = (): void => {
    if (place === undefined) return;
    useSettingsStore.getState().go({ kind: "computer", id: place.id });
    useStore.getState().openSettings();
  };
  return (
    <div data-k="agents-surface" className="min-h-0 flex-1 overflow-y-auto">
      <AgentsList
        shell="panel"
        report={report}
        reading={reading}
        error={error}
        on={workspace?.name ?? ""}
        ctx={{ where, ...(computer === undefined ? {} : { computer }), heldWhy: absent?.away ?? null, ...(where === "fork" ? { editImage: () => useStore.getState().openSetup() } : {}), ...(tools === undefined ? {} : { tools }) }}
        onRefresh={refresh}
        now={Date.now()}
        {...(computer === undefined
          ? {}
          : {
              headLink: (
                <Button data-k="agents-computer" size="xs" variant="ghost" className="font-mono text-xs" onClick={openComputer}>
                  {computer}
                </Button>
              ),
            })}
      />
    </div>
  );
}
