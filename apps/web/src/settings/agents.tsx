// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Agents: the agents, tool servers and skills on one of the
// person's computers, the same lists a task's right panel reads on its own
// machine. The top bar holds the computer it reads and the tab; the page draws
// the agents manager for that one kind, so its details, acts and sign-ins are
// the panel's own.
import { BotIcon, ScrollTextIcon, ServerIcon } from "lucide-react";
import { HERE_PLACE_ID, type PlaceView } from "@wsp/protocol";
import { AgentsManager } from "../components/agents/AgentsManager.js";
import { recipeMissLines } from "../components/agents/agentsRows.js";
import { AGENTS } from "../components/agents/kinds/agents.js";
import { SERVERS } from "../components/agents/kinds/servers.js";
import { SKILLS } from "../components/agents/kinds/skills.js";
import type { AnyKind } from "../components/agents/kinds/kind.js";
import { useAgentActs } from "../components/agents/useAgentActs.js";
import { useAgentsReport } from "../components/agents/useAgentsReport.js";
import { useServerActs } from "../components/agents/useServerActs.js";
import { useServerTools } from "../components/agents/useServerTools.js";
import { useSkillActs } from "../components/agents/useSkillActs.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { useStore } from "../protocol/store.js";
import { ComputerGlyph } from "./ComputerGlyph.js";
import { AGENTS_PAGE_WORDS as W } from "./format.js";
import { absentOf, isProviderPlace, placeName } from "./places.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore, type AgentsTab } from "./settingsStore.js";

const KIND_OF: Record<AgentsTab, AnyKind> = { agents: AGENTS, servers: SERVERS, skills: SKILLS };
const TABS: ReadonlyArray<{ value: AgentsTab; label: React.ReactNode }> = [
  { value: "agents", label: <><BotIcon aria-hidden className="size-4" />{W.tabs.agents}</> },
  { value: "servers", label: <><ServerIcon aria-hidden className="size-4" />{W.tabs.servers}</> },
  { value: "skills", label: <><ScrollTextIcon aria-hidden className="size-4" />{W.tabs.skills}</> },
];

/** The computers whose own agents a person manages: this one and every computer joined to it. A cloud's agents are its
 * image's, managed on that cloud's page. */
const computersOf = (places: readonly PlaceView[]): PlaceView[] => places.filter(place => !isProviderPlace(place));

function usePickedPlace(): PlaceView | undefined {
  const places = useStore(s => s.places);
  const picked = useSettingsStore(s => s.agentsPlace);
  const computers = computersOf(places);
  return computers.find(place => place.id === (picked ?? HERE_PLACE_ID)) ?? computers.find(place => place.id === HERE_PLACE_ID) ?? computers[0];
}

/** The top bar on the Agents page: which computer it reads, and which list. */
export function AgentsTopBar() {
  const places = useStore(s => s.places);
  const place = usePickedPlace();
  const tab = useSettingsStore(s => s.agentsTab);
  const pickTab = useSettingsStore(s => s.pickAgentsTab);
  const pickPlace = useSettingsStore(s => s.pickAgentsPlace);
  const computers = computersOf(places);
  return (
    <span className="flex items-center gap-2 [-webkit-app-region:no-drag]">
      {place === undefined ? null : (
        <Select value={place.id} onValueChange={id => pickPlace(id as string)}>
          <SelectTrigger size="sm" aria-label={W.computer} data-k="agents-picker" className="h-9 min-w-48">
            <SelectValue>
              {(id: string) => {
                const shown = computers.find(p => p.id === id);
                return shown === undefined ? null : (
                  <span className="flex items-center gap-2">
                    <ComputerGlyph place={shown} className="size-4 text-foreground/80" />
                    {placeName(shown)}
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {computers.map(p => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  <ComputerGlyph place={p} className="size-4 text-foreground/80" />
                  {placeName(p)}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      )}
      <SegmentedControl data-k="agents-tabs" aria-label={W.tab} value={tab} segments={TABS} onChange={pickTab} className="h-9" segmentClassName="gap-2 px-3.5 text-sm" />
    </span>
  );
}

function AgentsOn({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const tab = useSettingsStore(s => s.agentsTab);
  const target = { placeId: place.id };
  const { report, reading, error, refresh } = useAgentsReport(target);
  const tools = useServerTools(target);
  const acts = useAgentActs(target);
  const skills = useSkillActs(target);
  const servers = useServerActs(target);
  const here = place.id === HERE_PLACE_ID;
  const name = placeName(place);
  const away = here ? null : absentOf(place, ctx.now);
  return (
    <AgentsManager
      key={`${place.id}:${tab}`}
      shell="page"
      head={{ computer: name }}
      report={report}
      reading={reading}
      error={error}
      on={name}
      ctx={{
        where: here ? "here" : "box",
        ...(here ? {} : { computer: name }),
        heldWhy: away?.away ?? null,
        ...(tools === undefined ? {} : { tools }),
        ...(acts === undefined ? {} : { acts }),
        ...(skills === undefined ? {} : { skills }),
        ...(servers === undefined ? {} : { servers }),
      }}
      onRefresh={refresh}
      now={ctx.now}
      misses={recipeMissLines(place.provision?.rows ?? [])}
      kinds={[KIND_OF[tab]]}
    />
  );
}

function AgentsPage({ ctx }: { ctx: SettingsContext }) {
  const place = usePickedPlace();
  if (place === undefined) return null;
  return <AgentsOn place={place} ctx={ctx} />;
}

export function agentsCards(ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "agents", items: [], body: <AgentsPage ctx={ctx} /> }];
}
