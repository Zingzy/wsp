// SPDX-License-Identifier: AGPL-3.0-only
// The first step: choose what goes on the image on the screens, or let an
// agent on this computer choose from what your agents used. Two rows of the
// card, the app's radio at the left of each, the agent picker in the agent
// row's slot. The primary is the one accent on the screen.
import { CLOUD_SETUP_WORDS, type InitAgent, type InitRoad } from "@wsp/protocol";
import { Radio, RadioGroup } from "../../components/ui/radio-group.js";
import { cn } from "../../lib/utils.js";
import { CARD, NAME, ROW, ROW_LINE, RowPicker, STATE_WORD, Slot } from "./rows.js";
import { RowMark } from "./SignInMark.js";
import { SetupScreen } from "./SetupScreen.js";

export interface RoadPick {
  road: InitRoad;
  harness?: string;
}

export function SetupChoice({ agents, pick, onPick, onContinue, refusal }: { agents: readonly InitAgent[]; pick: RoadPick; onPick: (pick: RoadPick) => void; onContinue: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.choice;
  const harness = pick.harness ?? agents[0]?.id;
  const canAgent = agents.length > 0;
  const agent = agents.find(a => a.id === harness);
  return (
    <SetupScreen k="choice" label={words.label} headline={words.headline} top={words.top} refusal={refusal} primary={{ word: words.keycap, onPress: onContinue, disabled: pick.road === "agent" && !canAgent }}>
      <RadioGroup aria-label={words.headline} value={pick.road} onValueChange={value => onPick(value === "agent" ? { road: "agent", ...(harness !== undefined ? { harness } : {}) } : { road: "manual" })} className={cn(CARD, "gap-0")}>
        <label className={cn(ROW, ROW_LINE, "cursor-pointer hover:bg-accent/40")}>
          <Radio value="manual" data-k="road-manual" />
          <span className={NAME}>{words.manual}</span>
        </label>
        <label className={cn(ROW, ROW_LINE, canAgent ? "cursor-pointer hover:bg-accent/40" : "text-muted-foreground")}>
          <Radio value="agent" data-k="road-agent" disabled={!canAgent} />
          <span className={cn(NAME, !canAgent && "text-muted-foreground")}>{words.agent}</span>
          <Slot>
            {canAgent ? (
              <>
                {harness !== undefined ? <RowMark id={harness} label={agent?.name ?? harness} /> : null}
                <RowPicker k="harness" label={words.agentWith} value={harness} choices={agents.map(a => ({ value: a.id, label: a.name }))} onPick={value => onPick({ road: "agent", harness: value })} />
              </>
            ) : (
              <span className={STATE_WORD}>no agent here</span>
            )}
          </Slot>
        </label>
      </RadioGroup>
    </SetupScreen>
  );
}
