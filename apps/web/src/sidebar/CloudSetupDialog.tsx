// SPDX-License-Identifier: AGPL-3.0-only
// What the sidebar's cloud row opens: wsp init as the host runs it, drawn as a
// sheet over the whole window in the first launch's grammar and never asking
// the person to run a command. First the choice, manual or an agent; the
// provider key screen when the host holds none; the read of this computer as
// rows; then the screens as data, the build's question, and the build as rows.
// The job, the step and the step's unsent draft live on the host: shutting the
// sheet changes nothing, and it reopens on the step it was shut at with the
// answers and what was ticked or typed since in place, until Start over or the
// build. The sheet's title is the caller's: the sidebar road names these
// screens to a reader and nothing else, so its title stands for screen readers
// alone, and a caller that names its own draws it in the sheet's corner, where
// Settings says which of its rows this sheet was opened from.
import { useEffect, useState } from "react";
import { CLOUD_SETUP_WORDS, FIRST_WORKSPACE, INIT_BUILD_STEP, KEY_REFUSED, KEY_UNCHECKED, initAgentStep, initJobOver, initStepCounter, type InitJob, type InitSetup } from "@wsp/protocol";
import { Dialog, DialogSheet, DialogTitle } from "../components/ui/dialog.js";
import { errorText } from "../lib/utils.js";
import { RequestError } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { IMAGE_WORDS } from "../settings/image.js";
import { AgentLine, agentStepWords } from "../settings/recipe/AgentLine.js";
import { ReadingRows } from "../settings/recipe/ReadingRows.js";
import { RecipeScreen, type Draft } from "../settings/recipe/RecipeScreen.js";
import { RoadChoice, roadReady, type RoadPick } from "../settings/recipe/RoadChoice.js";
import { keptAt, recipeAt, useRecipeJob } from "../settings/recipe/useRecipeJob.js";
import { SetupAsk } from "./cloud-setup/SetupAsk.js";
import { SetupBuild } from "./cloud-setup/SetupBuild.js";
import { SetupKeys, type KeyCheckShown } from "./cloud-setup/SetupKeys.js";
import { SetupScreen } from "./cloud-setup/SetupScreen.js";

type Step = "choice" | "keys" | "job";

/** Where the sheet opens: on the job when one stands, on the choice otherwise. */
const stepFor = (job: InitJob | null): Step => (job === null || initJobOver(job.phase) ? "choice" : "job");

/** The build question's two typed answers, as the draft names them. */
const ASK_NAME = "name";
const ASK_FOLDER = "folder";

export function CloudSetupDialog({ onClose }: { onClose: () => void }) {
  const saveKeys = useStore(s => s.saveKeys);
  const select = useStore(s => s.select);
  const recipe = useRecipeJob();
  const { api, job, draft, setDraft, refusal, setRefusal, keep, attempt } = recipe;
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const [step, setStep] = useState<Step>(() => stepFor(job));
  const [pick, setPick] = useState<RoadPick>({ road: "manual" });
  const [check, setCheck] = useState<KeyCheckShown | null>(null);
  // Whether the key step opens on an empty field though a key is saved: after a build the saved key failed, yes.
  const [keyChange, setKeyChange] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api?.initGet?.().then(setSetup, e => setRefusal(errorText(e)));
  }, [api, setRefusal]);
  // A job that starts while the sheet is open is drawn from where the host says it stands.
  const jobId = job?.id;
  useEffect(() => {
    if (jobId !== undefined) setStep("job");
  }, [jobId]);
  // The step moves once the host has taken the start, so a refused one leaves the choice up with the refusal under it.
  const start = (): void => recipe.startRoad(pick, () => setStep("job"));
  // The key step is on every run, so a person always sees that a key is set and can change it.
  const onContinueChoice = (): void => {
    if (setup === null) return;
    setKeyChange(false);
    setStep("keys");
  };
  // The host checks the key with the provider before it saves it, so Save spins for as long as that call takes and a
  // key the provider would not take leaves the person on this step with what it said under the field. A saved key the
  // person left as it was is not sent again: Continue starts the job on it.
  const onSaveKeys = (keys: { solari?: string }): void => {
    if (keys.solari === undefined) {
      start();
      return;
    }
    if (api?.initKeys === undefined) return;
    setRefusal(null);
    setCheck(null);
    setSaving(true);
    void (async () => {
      try {
        setSetup(await saveKeys({ key: keys.solari }));
        start();
      } catch (e) {
        const kind = e instanceof RequestError ? e.kind : undefined;
        if (kind === KEY_REFUSED || kind === KEY_UNCHECKED) setCheck({ line: errorText(e), retry: kind === KEY_UNCHECKED });
        else setRefusal(errorText(e));
      } finally {
        setSaving(false);
      }
    })();
  };
  /** The build read the saved key and the provider refused it: back to the step that takes one, with the field clear. */
  const onChangeKey = (): void => {
    setCheck(null);
    setKeyChange(true);
    setStep("keys");
    void api?.initGet?.().then(setSetup, () => {});
  };
  const again = (): void => {
    setStep("choice");
    setDraft(null);
    void api?.initGet?.().then(setSetup, () => {});
  };

  let body;
  if (step === "choice" || setup === null) {
    const words = CLOUD_SETUP_WORDS.choice;
    body =
      setup === null ? (
        <SetupScreen k="loading" headline={words.headline} top={words.top} refusal={refusal} />
      ) : (
        <SetupScreen k="choice" headline={words.headline} top={words.top} refusal={refusal} primary={{ word: words.keycap, onPress: onContinueChoice, disabled: !roadReady(setup.agents, pick) }}>
          <RoadChoice agents={setup.agents} pick={pick} onPick={setPick} />
        </SetupScreen>
      );
  } else if (step === "keys") {
    body = <SetupKeys setup={setup} onSave={onSaveKeys} onBack={() => setStep("choice")} refusal={refusal} check={check} busy={saving} change={keyChange} />;
  } else if (job !== null && initAgentStep(job)) {
    const words = agentStepWords(job);
    body = (
      <SetupScreen
        k="agent"
        headline={words.headline}
        top={words.top}
        refusal={refusal}
        {...(words.over
          ? {
              primary: {
                word: CLOUD_SETUP_WORDS.agent.retry,
                onPress: recipe.retryAgent,
              },
              secondary: { word: CLOUD_SETUP_WORDS.agent.again, onPress: again },
            }
          : {})}
      >
        <AgentLine
          job={job}
          onOpenThread={() => {
            if (job.thread === undefined) return;
            select(job.thread.workspaceId, job.thread.id);
            onClose();
          }}
        />
      </SetupScreen>
    );
  } else if (job === null || job.phase === "reading") {
    body = (
      <SetupScreen k="reading" headline={CLOUD_SETUP_WORDS.reading.headline} top={CLOUD_SETUP_WORDS.reading.top} refusal={refusal}>
        <ReadingRows job={job} />
      </SetupScreen>
    );
  } else if (job.phase === "answering") {
    const { shown, index, screen } = recipeAt(job);
    const total = shown.length + 1;
    const startOver = (): void => recipe.startOver(again);
    if (screen === undefined) {
      const kept = keptAt(job, INIT_BUILD_STEP);
      const typed = draft !== null && draft.key === INIT_BUILD_STEP ? draft.draft.answers : { [ASK_NAME]: kept?.answers[ASK_NAME] ?? FIRST_WORKSPACE, [ASK_FOLDER]: kept?.answers[ASK_FOLDER] ?? "" };
      const asked = (o: { name: string; folder: string }): Draft => ({ ticks: new Set<string>(), answers: { [ASK_NAME]: o.name, [ASK_FOLDER]: o.folder }, keys: {} });
      body = (
        <SetupAsk
          setup={setup}
          counter={initStepCounter(total, total)}
          refusal={refusal}
          name={typed[ASK_NAME] ?? FIRST_WORKSPACE}
          folder={typed[ASK_FOLDER] ?? ""}
          onType={o => setDraft({ key: INIT_BUILD_STEP, draft: asked(o) })}
          // Leaving a field the person did not change keeps nothing: a blur is not news, and a keep is a whole view
          // to every client watching the job.
          onKeep={o => (o.name === (kept?.answers[ASK_NAME] ?? FIRST_WORKSPACE) && o.folder === (kept?.answers[ASK_FOLDER] ?? "") ? undefined : keep(INIT_BUILD_STEP, asked(o)))}
          onBuild={o => void attempt(() => recipe.build(setup.agents, o))}
          onBack={() => (shown.length > 0 ? recipe.stepTo(shown.length - 1) : startOver())}
        />
      );
    } else {
      const current = recipe.draftAt(screen);
      body = (
        <SetupScreen
          key={`${job.id}:${screen.id}`}
          k={`screen-${screen.id}`}
          counter={initStepCounter(index + 1, total)}
          headline={screen.top}
          refusal={refusal}
          primary={{ word: CLOUD_SETUP_WORDS.screen.keycap, onPress: () => recipe.answer(screen) }}
          secondary={index > 0 ? { word: CLOUD_SETUP_WORDS.screen.back, onPress: () => recipe.stepTo(index - 1) } : { word: CLOUD_SETUP_WORDS.screen.again, onPress: startOver }}
        >
          <RecipeScreen screen={screen} draft={current} onDraft={next => recipe.edit(screen, current, next)} image={recipe.imageAt(screen, current)} />
        </SetupScreen>
      );
    }
  } else {
    body = (
      <SetupBuild
        job={job}
        refusal={refusal}
        onCancel={() => void attempt(() => api!.initCancel!())}
        onRetry={tool => void attempt(() => api!.initRetry!({ tool }))}
        onCode={o => void attempt(() => api!.initSignInCode!(o))}
        onChangeKey={onChangeKey}
        onOpenWorkspace={() => {
          if (job.workspace !== undefined) select(job.workspace.id);
          onClose();
        }}
        onAgain={again}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={open => {
        if (open) return;
        if (draft !== null) keep(draft.key, draft.draft);
        onClose();
      }}
    >
      <DialogSheet data-cloud-setup-dialog initialFocus={false}>
        <DialogTitle className="absolute top-5 left-6 font-heading font-semibold text-xl leading-none">{IMAGE_WORDS.sheet}</DialogTitle>
        {body}
      </DialogSheet>
    </Dialog>
  );
}
