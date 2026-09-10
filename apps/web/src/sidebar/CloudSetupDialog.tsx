// SPDX-License-Identifier: AGPL-3.0-only
// What the sidebar's cloud row opens: wsp init as the host runs it, drawn as a
// sheet over the whole window in the first launch's grammar and never asking
// the person to run a command. First the choice, manual or an agent; the
// provider key screen when the host holds none; the read of this computer as
// rows; then the screens as data, the build's question, and the build as rows.
// The job, the step and the step's unsent draft live on the host: shutting the
// sheet changes nothing, and it reopens on the step it was shut at with the
// answers and what was ticked or typed since in place, until Start over or the
// build.
import { useCallback, useEffect, useState } from "react";
import { CLOUD_SETUP_WORDS, FIRST_WORKSPACE, INIT_BUILD_STEP, KEY_REFUSED, KEY_UNCHECKED, initAgentStep, initDiskOverLine, initImageBytes, initJobOver, initStepCounter, wspToolsRowId, type InitDraft, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import { Dialog, DialogSheet, DialogTitle } from "../components/ui/dialog.js";
import { errorText } from "../lib/utils.js";
import { RequestError } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { draftOf, SetupAnswers, type Draft } from "./cloud-setup/SetupAnswers.js";
import { SetupAgent } from "./cloud-setup/SetupAgent.js";
import { SetupAsk } from "./cloud-setup/SetupAsk.js";
import { SetupBuild } from "./cloud-setup/SetupBuild.js";
import { SetupChoice, type RoadPick } from "./cloud-setup/SetupChoice.js";
import { SetupFacts } from "./cloud-setup/SetupFacts.js";
import { SetupKeys, type KeyCheckShown } from "./cloud-setup/SetupKeys.js";
import { SetupScreen } from "./cloud-setup/SetupScreen.js";

type Step = "choice" | "keys" | "job";

/** Where the sheet opens: on the job when one stands, on the choice otherwise. */
const stepFor = (job: InitJob | null): Step => (job === null || initJobOver(job.phase) ? "choice" : "job");

/** The screen the first launch already answered on this computer, left out of the app's setup. */
const FIRST_LAUNCH_SCREEN = "wsp";

/** The build question's two typed answers, as the draft names them. */
const ASK_NAME = "name";
const ASK_FOLDER = "folder";

/** The steps the app walks: the screens the host shows, less the one the first launch answered, then the first
 * workspace's question; the count over each title is of these. */
const shownOf = (job: InitJob): InitScreen[] => job.screens.filter(s => s.id !== FIRST_LAUNCH_SCREEN);

/** What the host kept of a step the person left mid-answer, if anything. */
const keptAt = (job: InitJob, at: string): InitDraft | undefined => job.drafts?.find(d => d.at === at);

export function CloudSetupDialog({ onClose }: { onClose: () => void }) {
  const api = useStore(s => s.api);
  const job = useStore(s => s.initJob);
  const select = useStore(s => s.select);
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const [step, setStep] = useState<Step>(() => stepFor(job));
  const [pick, setPick] = useState<RoadPick>({ road: "manual" });
  const [draft, setDraft] = useState<{ key: string; draft: Draft } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [check, setCheck] = useState<KeyCheckShown | null>(null);
  // Whether the key step opens on an empty field though a key is saved: after a build the saved key failed, yes.
  const [keyChange, setKeyChange] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api?.initGet?.().then(setSetup, e => setRefusal(errorText(e)));
  }, [api]);
  // A job that starts while the sheet is open is drawn from where the host says it stands.
  const jobId = job?.id;
  useEffect(() => {
    setDraft(null);
    if (jobId !== undefined) setStep("job");
  }, [jobId]);
  // What a step has and has not sent goes to the host as it changes, so the sheet holds nothing a close would lose.
  // A refused keep is left alone: it costs the person nothing and the step's own Continue is what must be heard.
  const keep = useCallback(
    (at: string, next: Draft): void => {
      void api?.initDraft?.({ at, ticks: [...next.ticks], answers: next.answers }).catch(() => {});
    },
    [api],
  );
  const attempt = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    setRefusal(null);
    try {
      await work();
      return true;
    } catch (e) {
      setRefusal(errorText(e));
      return false;
    }
  }, []);
  // The step moves once the host has taken the start, so a refused one leaves the choice up with the refusal under it.
  const start = (): void => {
    if (api?.initStart === undefined) return;
    void attempt(async () => {
      await api.initStart!({ road: pick.road, ...(pick.harness !== undefined ? { harness: pick.harness } : {}) });
      setStep("job");
    });
  };
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
        setSetup(await api.initKeys!({ solari: keys.solari }));
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
    body = setup === null ? <SetupScreen k="loading" headline={CLOUD_SETUP_WORDS.choice.headline} top={CLOUD_SETUP_WORDS.choice.top} refusal={refusal} /> : <SetupChoice agents={setup.agents} pick={pick} onPick={setPick} onContinue={onContinueChoice} refusal={refusal} />;
  } else if (step === "keys") {
    body = <SetupKeys setup={setup} onSave={onSaveKeys} onBack={() => setStep("choice")} refusal={refusal} check={check} busy={saving} change={keyChange} />;
  } else if (job !== null && initAgentStep(job)) {
    body = (
      <SetupAgent
        job={job}
        refusal={refusal}
        onOpenThread={() => {
          if (job.thread === undefined) return;
          select(job.thread.workspaceId, job.thread.id);
          onClose();
        }}
        onRetry={() => {
          const harness = job.thread?.harness;
          if (api?.initStart === undefined || harness === undefined) return;
          void attempt(() => api.initStart!({ road: "agent", harness }));
        }}
        onAgain={again}
      />
    );
  } else if (job === null || job.phase === "reading") {
    body = <SetupFacts job={job} refusal={refusal} />;
  } else if (job.phase === "answering") {
    const shown = shownOf(job);
    const total = shown.length + 1;
    const at = job.screens[job.step];
    const index = at === undefined || at.id === FIRST_LAUNCH_SCREEN ? shown.length : shown.findIndex(s => s.id === at.id);
    const screen = shown[index];
    const stepTo = (i: number): void => void attempt(() => api!.initStep!({ at: job.screens.findIndex(s => s.id === shown[i]!.id) }));
    const startOver = (): void =>
      void attempt(async () => {
        await api!.initCancel!();
        again();
      });
    if (screen === undefined) {
      // The first launch's answer for the MCP rows rides with the build: the agents here it configured.
      const firstLaunch = job.screens.find(s => s.id === FIRST_LAUNCH_SCREEN);
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
          onBuild={o =>
            void attempt(async () => {
              if (firstLaunch !== undefined) await api!.initAnswer!({ screen: firstLaunch.id, ticks: setup.agents.filter(a => a.configured).map(a => wspToolsRowId(a.id)).filter(id => firstLaunch.items.some(i => i.id === id)) });
              await api!.initBuild!(o);
            })
          }
          onBack={() => (shown.length > 0 ? stepTo(shown.length - 1) : startOver())}
        />
      );
    } else {
      const key = screen.id;
      const current = draft !== null && draft.key === key ? draft.draft : draftOf(screen, keptAt(job, key));
      const image = { used: initImageBytes(job, { at: screen.id, ticks: current.ticks }), ...(job.disk !== undefined ? { total: job.disk.total } : {}) };
      const over = image.total !== undefined ? Math.max(0, image.used - image.total) : 0;
      body = (
        <SetupAnswers
          key={`${job.id}:${key}`}
          screen={screen}
          counter={initStepCounter(index + 1, total)}
          draft={current}
          onDraft={next => {
            setDraft({ key, draft: next });
            // A typed key is not drafted, so a keystroke in one pushes no view to every client watching the job.
            if (next.ticks !== current.ticks || next.answers !== current.answers) keep(key, next);
          }}
          refusal={refusal}
          image={image}
          primary={{
            word: CLOUD_SETUP_WORDS.screen.keycap,
            onPress: () => {
              if (over > 0) {
                setRefusal(initDiskOverLine(over));
                return;
              }
              void attempt(async () => {
                const typed = Object.fromEntries(Object.entries(current.keys).filter(([, v]) => v.trim() !== ""));
                if (Object.keys(typed).length > 0) await api!.initKeys!({ rows: typed });
                await api!.initAnswer!({ screen: screen.id, ticks: [...current.ticks], answers: current.answers });
                setDraft(null);
              });
            },
          }}
          secondary={index > 0 ? { word: CLOUD_SETUP_WORDS.screen.back, onPress: () => stepTo(index - 1) } : { word: CLOUD_SETUP_WORDS.screen.again, onPress: startOver }}
        />
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
        <DialogTitle className="sr-only">{CLOUD_SETUP_WORDS.title}</DialogTitle>
        {body}
      </DialogSheet>
    </Dialog>
  );
}
