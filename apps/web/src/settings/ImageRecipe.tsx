// SPDX-License-Identifier: AGPL-3.0-only
// Choosing what goes on your image, inside the Image card of any computer's
// page: the init job's own steps (the road, the read of this computer, the
// agent's thread, the host's screens with their drafts and disk tally) drawn
// under the card rather than in a sheet, and Build sending init.build with this
// computer as the place. The recipe is one record, so every computer's card
// edits the same one; once an image stands the host builds it at its own
// place whichever card the press came from, and the last step says so. A typed
// key goes to the key store on Continue and never onto a draft.
import { useEffect, useState, type ReactNode } from "react";
import { CLOUD_SETUP_WORDS, initAgentStep, initJobOver, initStepCounter, type InitSetup, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { FACT } from "./format.js";
import { copyCost, IMAGE_WORDS } from "./image.js";
import { AgentLine, agentStepWords } from "./recipe/AgentLine.js";
import { ReadingRows } from "./recipe/ReadingRows.js";
import { RecipeScreen } from "./recipe/RecipeScreen.js";
import { RoadChoice, roadReady, type RoadPick } from "./recipe/RoadChoice.js";
import { MICRO_LABEL } from "../lib/microLabel.js";
import { recipeAt, useRecipeJob } from "./recipe/useRecipeJob.js";
import { RefusalSlot } from "./sheetParts.js";

interface Action {
  k: string;
  word: string;
  onPress: () => void;
  disabled?: boolean;
}

/** One step of the recipe: its count, title and sentence over the step's card, the quiet links at the left of the
 * foot, what a build takes and the keycap at its right, and the slot a refusal lands in, standing in every state so
 * its arrival moves nothing. */
function RecipeStep({ k, counter, headline, top, note, cost, primary, links, refusal, busy = false, children }: { k: string; counter?: string; headline: string; top?: string; note?: string; cost?: string[]; primary?: Omit<Action, "k">; links: Action[]; refusal: string | null; /** A press is with the host: every press but Close waits for it. */ busy?: boolean; children: ReactNode }) {
  return (
    <div data-k="recipe" data-step={k} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        {counter === undefined ? null : (
          <p data-k="recipe-counter" className={cn(MICRO_LABEL, "text-muted-foreground")}>
            {counter}
          </p>
        )}
        <h3 data-k="recipe-title" className="text-sm leading-5 font-medium text-foreground">
          {headline}
        </h3>
        {top === undefined || top === "" ? null : (
          <p data-k="recipe-sentence" className="text-xs leading-4 text-muted-foreground">
            {top}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-col">{children}</div>
      {note === undefined ? null : (
        <p data-k="recipe-note" className="text-xs leading-4 text-muted-foreground">
          {note}
        </p>
      )}
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          {links.map(link => (
            <Button key={link.k} data-k={`recipe-${link.k}`} size="xs" variant="ghost-muted" disabled={link.disabled === true || (busy && link.k !== "close")} onClick={link.onPress}>
              {link.word}
            </Button>
          ))}
        </div>
        {cost === undefined ? null : (
          <span data-k="recipe-cost" className={cn(FACT, "flex shrink-0 flex-col items-end whitespace-nowrap leading-4")}>
            {cost.map(line => (
              <span key={line}>{line}</span>
            ))}
          </span>
        )}
        {primary === undefined ? null : (
          <Button data-k="recipe-primary" size="xs" variant="default" held={primary.disabled === true} disabled={busy} onClick={primary.onPress}>
            {primary.word}
          </Button>
        )}
      </div>
      <RefusalSlot k="recipe-refusal" {...(refusal === null ? {} : { said: refusal })} />
    </div>
  );
}

export function ImageRecipe({ place, name, version, onClose }: { place: PlaceView; name: string; /** The version the image stands at, absent before the first build. */ version: number | undefined; onClose: () => void }) {
  const select = useStore(s => s.select);
  const recipe = useRecipeJob();
  const { api, job, refusal, setRefusal, attempt } = recipe;
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const [pick, setPick] = useState<RoadPick>({ road: "manual" });
  // The job an ended agent step was left from for the road again: nothing is cancelled, since the job is over.
  const [againFrom, setAgainFrom] = useState<string | null>(null);
  // The setup priced at this computer: its agents for the road and the first launch's answer, and where a build goes.
  useEffect(() => {
    void api?.initGet?.({ on: place.id }).then(setSetup, e => setRefusal(errorText(e)));
  }, [api, place.id, setRefusal]);
  const close: Action = { k: "close", word: IMAGE_WORDS.close, onPress: onClose };
  const choose = (): void => recipe.startRoad(pick);
  const again = (): void => {
    setPick({ road: "manual" });
    setAgainFrom(job?.id ?? null);
  };

  if (setup === null) {
    return (
      <RecipeStep k="loading" headline={CLOUD_SETUP_WORDS.choice.headline} top={CLOUD_SETUP_WORDS.choice.top} links={[close]} refusal={refusal} busy={recipe.busy}>
        {null}
      </RecipeStep>
    );
  }
  // A job that ended on the build starts the recipe over from the road; one that ended on the agent's step keeps it.
  if (job === null || (initJobOver(job.phase) && (!initAgentStep(job) || job.id === againFrom))) {
    const words = CLOUD_SETUP_WORDS.choice;
    return (
      <RecipeStep k="choice" headline={words.headline} top={words.top} primary={{ word: words.keycap, onPress: choose, disabled: !roadReady(setup.agents, pick) }} links={[close]} refusal={refusal} busy={recipe.busy}>
        <RoadChoice agents={setup.agents} pick={pick} onPick={setPick} />
      </RecipeStep>
    );
  }
  if (initAgentStep(job)) {
    const words = agentStepWords(job);
    return (
      <RecipeStep
        k="agent"
        headline={words.headline}
        top={words.top}
        {...(words.over ? { primary: { word: CLOUD_SETUP_WORDS.agent.retry, onPress: recipe.retryAgent } } : {})}
        links={words.over ? [{ k: "again", word: CLOUD_SETUP_WORDS.agent.again, onPress: again }, close] : [close]}
        refusal={refusal} busy={recipe.busy}
      >
        <AgentLine
          job={job}
          onOpenThread={() => {
            if (job.thread === undefined) return;
            useStore.getState().closeSettings();
            select(job.thread.workspaceId, job.thread.id);
          }}
        />
      </RecipeStep>
    );
  }
  if (job.phase !== "answering") {
    return (
      <RecipeStep k="reading" headline={CLOUD_SETUP_WORDS.reading.headline} top={CLOUD_SETUP_WORDS.reading.top} links={[close]} refusal={refusal} busy={recipe.busy}>
        <ReadingRows job={job} />
      </RecipeStep>
    );
  }

  const { shown, index, screen } = recipeAt(job);
  const startOver: Action = { k: "again", word: CLOUD_SETUP_WORDS.screen.again, onPress: () => recipe.startOver(again) };
  const back: Action = { k: "back", word: CLOUD_SETUP_WORDS.screen.back, onPress: () => recipe.stepTo(index - 1) };
  // Where the build goes is the host's word: this computer for a first build, the image's own place after that.
  const home = setup.place;
  const elsewhere = home !== undefined && home.id !== place.id;
  const buildNote = elsewhere ? IMAGE_WORDS.buildsHome(home.name, (version ?? 0) + 1) : undefined;
  const cost = copyCost(setup.pricing?.rateUsdPerHour);
  const build = (): Promise<void> => recipe.build(setup.agents, { on: place.id });
  const last = screen !== undefined && index === shown.length - 1;
  if (screen === undefined) {
    return (
      <RecipeStep
        k="ready"
        headline={IMAGE_WORDS.readyHeadline}
        top={IMAGE_WORDS.buildsHere(elsewhere ? home.name : name)}
        {...(buildNote === undefined ? {} : { note: buildNote })}
        cost={cost}
        primary={{ word: IMAGE_WORDS.build, onPress: () => void attempt(build) }}
        links={[...(shown.length > 0 ? [{ ...back, onPress: () => recipe.stepTo(shown.length - 1) }] : [startOver]), close]}
        refusal={refusal} busy={recipe.busy}
      >
        {null}
      </RecipeStep>
    );
  }
  const current = recipe.draftAt(screen);
  return (
    <RecipeStep
      key={`${job.id}:${screen.id}`}
      k={`screen-${screen.id}`}
      counter={initStepCounter(index + 1, shown.length)}
      headline={screen.top}
      {...(last && buildNote !== undefined ? { note: buildNote } : {})}
      {...(last ? { cost } : {})}
      primary={last ? { word: IMAGE_WORDS.build, onPress: () => recipe.answer(screen, build) } : { word: CLOUD_SETUP_WORDS.screen.keycap, onPress: () => recipe.answer(screen) }}
      links={[index > 0 ? back : startOver, close]}
      refusal={refusal} busy={recipe.busy}
    >
      <RecipeScreen screen={screen} draft={current} onDraft={next => recipe.edit(screen, current, next)} image={recipe.imageAt(screen, current)} />
    </RecipeStep>
  );
}
