// SPDX-License-Identifier: AGPL-3.0-only
// What the sidebar's cloud row opens: wsp init as the host runs it, drawn as a
// sheet over the whole window in the first launch's grammar and never asking
// the person to run a command. First the choice, manual or an agent; the
// provider key screen when the host holds none; the read of this computer as
// rows; then the screens as data, the build's question, and the build as rows.
// The job and the step live on the host: shutting the sheet changes nothing,
// and it reopens on the step it was shut at with the answers in place, until
// Start over or the build.
import { useCallback, useEffect, useState } from "react";
import { CLOUD_SETUP_WORDS, initAgentStep, initDiskOverLine, initJobOver, wspToolsRowId, type InitJob, type InitScreen, type InitSetup } from "@wsp/protocol";
import { Dialog, DialogSheet, DialogTitle } from "../components/ui/dialog.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { draftOf, SetupAnswers, tallyOf, type Draft } from "./cloud-setup/SetupAnswers.js";
import { SetupAgent } from "./cloud-setup/SetupAgent.js";
import { SetupAsk } from "./cloud-setup/SetupAsk.js";
import { SetupBuild } from "./cloud-setup/SetupBuild.js";
import { SetupChoice, type RoadPick } from "./cloud-setup/SetupChoice.js";
import { SetupFacts } from "./cloud-setup/SetupFacts.js";
import { SetupKeys } from "./cloud-setup/SetupKeys.js";
import { SetupScreen } from "./cloud-setup/SetupScreen.js";

type Step = "choice" | "keys" | "job";

/** Where the sheet opens: on the job when one stands, on the choice otherwise. */
const stepFor = (job: InitJob | null): Step => (job === null || initJobOver(job.phase) ? "choice" : "job");

/** The screen the first launch already answered on this computer, left out of the app's setup. */
const FIRST_LAUNCH_SCREEN = "wsp";

/** The screens the app walks: the host's, less the one the first launch answered. */
const shownOf = (job: InitJob): InitScreen[] => job.screens.filter(s => s.id !== FIRST_LAUNCH_SCREEN);

/** What the image's disk holds with these ticks: the fixed part the host measured plus every ticked row's size across
 * the screens, the current screen read from the draft. */
export function diskUsed(job: InitJob, current: { screen: string; ticks: ReadonlySet<string> } | undefined): number {
  const fixed = job.disk?.fixed ?? 0;
  return job.screens.reduce((sum, s) => sum + tallyOf(s, current !== undefined && current.screen === s.id ? current.ticks : new Set(s.ticks)).bytes, fixed);
}

export function CloudSetupDialog({ onClose }: { onClose: () => void }) {
  const api = useStore(s => s.api);
  const job = useStore(s => s.initJob);
  const select = useStore(s => s.select);
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const [step, setStep] = useState<Step>(() => stepFor(job));
  const [pick, setPick] = useState<RoadPick>({ road: "manual" });
  const [draft, setDraft] = useState<{ key: string; draft: Draft } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    void api?.initGet?.().then(setSetup, e => setRefusal(errorText(e)));
  }, [api]);
  // A job that starts while the sheet is open is drawn from where the host says it stands.
  const jobId = job?.id;
  useEffect(() => {
    if (jobId !== undefined) setStep("job");
  }, [jobId]);
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
  const onContinueChoice = (): void => {
    if (setup === null) return;
    if (!setup.keys.solari) setStep("keys");
    else start();
  };
  const onSaveKeys = (keys: { solari: string }): void => {
    if (api?.initKeys === undefined) return;
    void attempt(async () => {
      setSetup(await api.initKeys!(keys));
      start();
    });
  };
  const again = (): void => {
    setStep("choice");
    void api?.initGet?.().then(setSetup, () => {});
  };

  let body;
  let disk: { used: number; total: number } | undefined;
  if (step === "choice" || setup === null) {
    body = setup === null ? <SetupScreen k="loading" headline={CLOUD_SETUP_WORDS.choice.headline} top={CLOUD_SETUP_WORDS.choice.top} refusal={refusal} /> : <SetupChoice agents={setup.agents} pick={pick} onPick={setPick} onContinue={onContinueChoice} refusal={refusal} />;
  } else if (step === "keys") {
    body = <SetupKeys setup={setup} onSave={onSaveKeys} onBack={() => setStep("choice")} refusal={refusal} />;
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
      disk = job.disk !== undefined ? { used: diskUsed(job, undefined), total: job.disk.total } : undefined;
      body = (
        <SetupAsk
          setup={setup}
          counter={`${total}/${total}`}
          refusal={refusal}
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
      const key = `${job.id}:${screen.id}`;
      const current = draft !== null && draft.key === key ? draft.draft : draftOf(screen);
      const used = diskUsed(job, { screen: screen.id, ticks: current.ticks });
      disk = job.disk !== undefined ? { used, total: job.disk.total } : undefined;
      const over = disk !== undefined ? Math.max(0, disk.used - disk.total) : 0;
      body = (
        <SetupAnswers
          key={key}
          screen={screen}
          counter={`${index + 1}/${total}`}
          draft={current}
          onDraft={next => setDraft({ key, draft: next })}
          refusal={refusal}
          {...(disk !== undefined ? { disk } : {})}
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
              });
            },
          }}
          secondary={index > 0 ? { word: CLOUD_SETUP_WORDS.screen.back, onPress: () => stepTo(index - 1) } : { word: CLOUD_SETUP_WORDS.screen.again, onPress: startOver }}
        />
      );
    }
  } else {
    disk = job.disk !== undefined ? { used: diskUsed(job, undefined), total: job.disk.total } : undefined;
    body = (
      <SetupBuild
        job={job}
        refusal={refusal}
        onCancel={() => void attempt(() => api!.initCancel!())}
        onRetry={tool => void attempt(() => api!.initRetry!({ tool }))}
        onCode={o => void attempt(() => api!.initSignInCode!(o))}
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
        if (!open) onClose();
      }}
    >
      <DialogSheet data-cloud-setup-dialog initialFocus={false}>
        <DialogTitle className="sr-only">{CLOUD_SETUP_WORDS.title}</DialogTitle>
        {body}
      </DialogSheet>
    </Dialog>
  );
}
