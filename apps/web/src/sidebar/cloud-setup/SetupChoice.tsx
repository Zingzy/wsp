// SPDX-License-Identifier: AGPL-3.0-only
// The first screen: choose what goes on the image on the six screens, or let
// an agent on this computer choose from what your agents used. The agent
// road names its harness from the agents the host found here.
import { CLOUD_SETUP_WORDS, type InitAgent, type InitRoad } from "@wsp/protocol";
import { HarnessMark } from "../../components/chat/HarnessMark.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { cn } from "../../lib/utils.js";
import { CARD, ROW, ROW_LINE, STATE_WORD, SetupFrame } from "./grammar.js";

export interface RoadPick {
  road: InitRoad;
  harness?: string;
}

export function SetupChoice({ agents, pick, onPick, onContinue, refusal }: { agents: readonly InitAgent[]; pick: RoadPick; onPick: (pick: RoadPick) => void; onContinue: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.choice;
  const harness = pick.harness ?? agents[0]?.id;
  const canAgent = agents.length > 0;
  return (
    <SetupFrame k="choice" label={words.label} headline={words.headline} refusal={refusal} primary={{ word: words.keycap, onPress: onContinue, disabled: pick.road === "agent" && !canAgent }}>
      <ul role="radiogroup" aria-label={words.headline} className={CARD}>
        <li className={ROW_LINE}>
          <button type="button" role="radio" aria-checked={pick.road === "manual"} data-k="road-manual" onClick={() => onPick({ road: "manual" })} className={cn(ROW, "w-full cursor-pointer text-left text-sm text-foreground hover:bg-accent/40")}>
            <Dot on={pick.road === "manual"} />
            <span className="min-w-0 flex-1 truncate">{words.manual}</span>
          </button>
        </li>
        <li className={ROW_LINE}>
          <div className={cn(ROW, "text-sm text-foreground", !canAgent && "text-muted-foreground")}>
            <button type="button" role="radio" aria-checked={pick.road === "agent"} data-k="road-agent" disabled={!canAgent} onClick={() => onPick({ road: "agent", ...(harness !== undefined ? { harness } : {}) })} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left disabled:cursor-default">
              <Dot on={pick.road === "agent"} />
              <span className="min-w-0 flex-1 truncate">{words.agent}</span>
            </button>
            {canAgent ? (
              <span className={cn("flex items-center gap-2", STATE_WORD)}>
                {harness !== undefined ? <HarnessMark harness={harness} label={agents.find(a => a.id === harness)?.name ?? harness} /> : null}
                <Select items={agents.map(a => ({ value: a.id, label: a.name }))} value={harness ?? null} onValueChange={value => onPick({ road: "agent", ...(typeof value === "string" ? { harness: value } : {}) })}>
                  <SelectTrigger size="xs" aria-label={words.agentWith} data-k="harness" className="min-w-0 font-mono text-[11px] text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {agents.map(a => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </span>
            ) : (
              <span className={STATE_WORD}>no agent here</span>
            )}
          </div>
        </li>
      </ul>
    </SetupFrame>
  );
}

function Dot({ on }: { on: boolean }) {
  return <span aria-hidden className={cn("size-3.5 shrink-0 rounded-full border transition-colors duration-150", on ? "border-foreground bg-foreground" : "border-input")} />;
}
