// SPDX-License-Identifier: AGPL-3.0-only
// What the sidebar's cloud row opens: wsp init as the host runs it, drawn in
// one modal and never asking the person to run a command. First the choice,
// manual or an agent; the provider key screen when the host holds none; then
// the five screens as data, the build's question, and the build as rows. The
// job lives on the host: shutting the modal changes nothing, and it reopens
// where the job stands.
import { useCallback, useEffect, useState } from "react";
import { CLOUD_SETUP_WORDS, initJobOver, initPhaseWord, type InitJob, type InitSetup } from "@wsp/protocol";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { SetupAsk } from "./cloud-setup/SetupAsk.js";
import { SetupBuild } from "./cloud-setup/SetupBuild.js";
import { SetupChoice, type RoadPick } from "./cloud-setup/SetupChoice.js";
import { SetupKeys } from "./cloud-setup/SetupKeys.js";
import { SetupScreen } from "./cloud-setup/SetupScreen.js";
import { STATE_WORD, SetupFrame } from "./cloud-setup/grammar.js";

type Step = "choice" | "keys" | "job";

/** Where the modal opens: on the job when one stands, on the choice otherwise. */
const stepFor = (job: InitJob | null): Step => (job === null || initJobOver(job.phase) ? "choice" : "job");

/** `openAt` is the screen the modal opens on for a job already answering; a fixture names one, the app walks from the first. */
export function CloudSetupDialog({ onClose, openAt = 0 }: { onClose: () => void; openAt?: number }) {
  const api = useStore(s => s.api);
  const job = useStore(s => s.initJob);
  const select = useStore(s => s.select);
  const [setup, setSetup] = useState<InitSetup | null>(null);
  const [step, setStep] = useState<Step>(() => stepFor(job));
  const [pick, setPick] = useState<RoadPick>({ road: "manual" });
  const [at, setAt] = useState(openAt);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    void api?.initGet?.().then(setSetup, e => setRefusal(errorText(e)));
  }, [api]);
  // A job that starts while the modal is open is drawn from its first screen, whatever an earlier one was left on.
  const jobId = job?.id;
  useEffect(() => {
    if (jobId !== undefined) {
      setAt(openAt);
      setStep("job");
    }
  }, [jobId, openAt]);
  const attempt = useCallback(
    async (work: () => Promise<unknown>) => {
      setRefusal(null);
      try {
        await work();
      } catch (e) {
        setRefusal(errorText(e));
      }
    },
    [],
  );
  // The step moves once the host has taken the start, so a refused one leaves the choice up with the refusal under it.
  const start = (): void => {
    if (api?.initStart === undefined) return;
    void attempt(async () => {
      await api.initStart!({ road: pick.road, ...(pick.harness !== undefined ? { harness: pick.harness } : {}) });
      setAt(0);
      setStep("job");
    });
  };
  const onContinueChoice = (): void => {
    if (setup === null) return;
    if (!setup.keys.solari) setStep("keys");
    else start();
  };
  const onSaveKeys = (keys: { solari?: string; anthropic?: string }): void => {
    if (api?.initKeys === undefined) return;
    void attempt(async () => {
      setSetup(await api.initKeys!(keys));
      start();
    });
  };
  const again = (): void => {
    setStep("choice");
    setAt(0);
    void api?.initGet?.().then(setSetup, () => {});
  };

  let body;
  if (step === "choice" || setup === null) {
    body = setup === null ? <SetupFrame k="loading" label={CLOUD_SETUP_WORDS.choice.label} headline={CLOUD_SETUP_WORDS.choice.headline} refusal={refusal} /> : <SetupChoice agents={setup.agents} pick={pick} onPick={setPick} onContinue={onContinueChoice} refusal={refusal} />;
  } else if (step === "keys") {
    body = <SetupKeys setup={setup} onSave={onSaveKeys} onBack={() => setStep("choice")} refusal={refusal} />;
  } else if (job === null || job.phase === "agent" || job.phase === "reading") {
    const words = job?.phase === "agent" ? CLOUD_SETUP_WORDS.agent : CLOUD_SETUP_WORDS.reading;
    body = (
      <SetupFrame k="reading" label={words.label} headline={words.headline} refusal={refusal}>
        <p role="status" className={`${STATE_WORD} text-center`}>
          {job === null ? initPhaseWord("reading") : job.log.at(-1) ?? initPhaseWord(job.phase)}
        </p>
      </SetupFrame>
    );
  } else if (job.phase === "answering") {
    const screen = job.screens[at];
    if (screen === undefined) {
      body = (
        <SetupAsk
          refusal={refusal}
          onBuild={o => void attempt(() => api!.initBuild!(o))}
          onBack={() => setAt(job.screens.length - 1)}
        />
      );
    } else {
      body = (
        <SetupScreen
          key={`${job.id}:${screen.id}`}
          screen={screen}
          last={false}
          refusal={refusal}
          onContinue={answer =>
            void attempt(async () => {
              await api!.initAnswer!({ screen: screen.id, ...answer });
              setAt(at + 1);
            })
          }
          onBack={() => {
            if (at > 0) setAt(at - 1);
            else void attempt(async () => {
              await api!.initCancel!();
              again();
            });
          }}
        />
      );
    }
  } else {
    body = (
      <SetupBuild
        job={job}
        refusal={refusal}
        onHide={onClose}
        onCancel={() => void attempt(() => api!.initCancel!())}
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
      <DialogPopup className="sm:max-w-xl" data-cloud-setup-dialog initialFocus={false}>
        <DialogTitle className="sr-only">{CLOUD_SETUP_WORDS.title}</DialogTitle>
        {body}
      </DialogPopup>
    </Dialog>
  );
}
