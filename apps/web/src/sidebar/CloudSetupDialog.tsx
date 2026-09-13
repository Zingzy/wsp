// SPDX-License-Identifier: AGPL-3.0-only
// What the sidebar's cloud row opens: wsp init as the host runs it, drawn as a
// sheet over the whole window in the first launch's grammar and never asking
// the person to run a command. First the choice, manual or an agent; the
// provider key screen, which is on every run so a person always sees that a key
// is set and can change it; the read of this computer as rows; then the screens
// as data, the build's question, and the build as rows.
// The job, the step and the step's unsent draft live on the host: shutting the
// sheet changes nothing, and the sidebar's road reopens on the step it was shut
// at with the answers and what was ticked or typed since in place, until Start
// over or the build. The sheet's title stands in its corner at the head of the
// window, and is the image's own name whichever road opened it: these screens
// say what goes on the image and nothing else.
//
// Settings > Image > Edit opens the same sheet on the image itself: the screens
// over the recipe that stands, with neither the road question nor the provider
// key step, since that key belongs to connecting a provider and an image is
// built wherever a workspace is first created. It opens on the first row every
// time, it ends where the recipe is written down rather than on a first cloud
// workspace, and its caller says over the footer what that save does.
import { useCallback, useEffect, useRef, useState } from "react";
import { CLOUD_SETUP_WORDS, FIRST_WORKSPACE, INIT_BUILD_STEP, KEY_REFUSED, KEY_UNCHECKED, initAgentStep, initDiskOverLine, initImageBytes, initJobBuilding, initJobOver, initStepCounter, wspToolsRowId, type InitDraft, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import { Dialog, DialogSheet, DialogTitle } from "../components/ui/dialog.js";
import { errorText } from "../lib/utils.js";
import { RequestError } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { IMAGE_WORDS } from "../settings/image.js";
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

/** What Settings > Image > Edit opens this sheet for. Its presence is the whole difference between the two roads:
 * the first run asks which road writes the recipe and for a provider key before the screens, and Edit asks neither. */
export interface ImageEdit {
  /** One line over the footer of every screen: what this road's Save does and nothing more, in its caller's words,
   * since the caller is what knows whether that Save cuts a version. Absent draws no line at all. */
  note?: string;
}

export function CloudSetupDialog({ onClose, edit }: { onClose: () => void; edit?: ImageEdit }) {
  const api = useStore(s => s.api);
  const job = useStore(s => s.initJob);
  const select = useStore(s => s.select);
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const editing = edit !== undefined;
  const [step, setStep] = useState<Step>(() => (editing ? "job" : stepFor(job)));
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
  /** Opens the screens on the image that stands: the read of this computer against the recipe already saved, so
   * the rows come up ticked as the image has them and the sign-ins as they were answered. */
  const openImage = useCallback((): void => {
    if (api?.initStart === undefined) return;
    void attempt(() => api.initStart!({ road: "image" }));
  }, [api, attempt]);
  // Edit is a door on the image, not the first run, so the job starts as the sheet opens rather than after two
  // questions, and it opens on the rows every time: an image job left half answered goes back to its first screen
  // rather than reopening where it was shut, which is what read as the first run's wizard. A build is the one job
  // drawn where it stands: it is what the person is watching and starting another over it would take it away.
  // What stood at the opening is read once, since the host answers before its event lands.
  const asked = useRef(false);
  const stood = useRef(job);
  useEffect(() => {
    if (!editing || asked.current || api?.initStart === undefined) return;
    const held = stood.current;
    if (held !== null && initJobBuilding(held.phase)) return;
    asked.current = true;
    if (held === null || initJobOver(held.phase) || held.road !== "image" || api.initStep === undefined) {
      openImage();
      return;
    }
    void attempt(() => api.initStep!({ at: 0 }));
  }, [editing, api, attempt, openImage]);
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
        setSetup(await api.initKeys!({ key: keys.solari }));
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
    setDraft(null);
    void api?.initGet?.().then(setSetup, () => {});
    if (editing) {
      openImage();
      return;
    }
    setStep("choice");
  };

  let body;
  if (setup === null) {
    // Nothing of either road is drawn before the host has answered, and each waits under the words of the step it
    // is about to show: the first run's question, or the read of this computer the image road goes straight to.
    const waiting = editing ? CLOUD_SETUP_WORDS.reading : CLOUD_SETUP_WORDS.choice;
    body = <SetupScreen k="loading" headline={waiting.headline} top={waiting.top} refusal={refusal} />;
  } else if (step === "choice") {
    body = <SetupChoice agents={setup.agents} pick={pick} onPick={setPick} onContinue={onContinueChoice} refusal={refusal} />;
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
    // The first run ends on the question its build needs; the image road ends where the recipe is written down, so
    // its screens are the whole count and its last one saves.
    const total = editing ? shown.length : shown.length + 1;
    const at = job.screens[job.step];
    const stepAt = at === undefined || at.id === FIRST_LAUNCH_SCREEN ? shown.length : shown.findIndex(s => s.id === at.id);
    // Past the last screen is the build's question on the first run and nothing at all on the image road, whose
    // step lands on its last screen instead.
    const index = editing ? Math.min(stepAt, shown.length - 1) : stepAt;
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
      const saves = editing && index === shown.length - 1;
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
          {...(edit?.note !== undefined ? { note: edit.note } : {})}
          primary={{
            // The image road's last screen writes the recipe down and shuts the sheet: nothing is booted and no
            // version is cut, so the word says save rather than continue.
            word: saves ? CLOUD_SETUP_WORDS.screen.save : CLOUD_SETUP_WORDS.screen.keycap,
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
                if (!saves) return;
                await api!.initSave!();
                onClose();
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
        <DialogTitle className="absolute top-5 left-6 font-heading font-semibold text-xl leading-none">{IMAGE_WORDS.sheet}</DialogTitle>
        {body}
      </DialogSheet>
    </Dialog>
  );
}
