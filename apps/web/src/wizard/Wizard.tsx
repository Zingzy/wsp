// SPDX-License-Identifier: AGPL-3.0-only
// First run: the window is the wizard until a golden image exists. The hero
// step is the builder's live screen (the screen tab's own component) with a
// checklist beside it; nothing here probes the builder, the person ticks the
// boxes themselves.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { GoldenStage } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";
import { ScreenTab } from "../tabs/ScreenTab.js";
import { INITIAL, PREPARE_STAGES, SEAL_STAGES, isReady, reduce, rowStates, type Step } from "./model.js";
import styles from "./Wizard.module.css";

/** Presence only. The host may omit the anthropic flag; the browser never sees a value. */
export interface KeyFlags {
  anthropic: boolean;
}

const STEP_WORD: Record<Step, string> = {
  welcome: "keys",
  preparing: "preparing",
  hero: "set up",
  sealing: "saving",
  done: "done",
  failed: "failed",
};
const TRAIL: Step[] = ["welcome", "preparing", "hero", "sealing", "done"];

const STAGE_WORD: Record<GoldenStage, string> = {
  creating: "booting a fresh desktop",
  "deploying-daemon": "starting the workspace daemon",
  "installing-harness": "installing claude code",
  ready: "ready for you",
  snapshotting: "taking the snapshot",
  "smoke-forking": "booting a fork to prove it works",
  sealed: "sealed",
  failed: "failed",
};

const FIRST_WORKSPACE = "first";

export function Wizard({ keys, onDone }: { keys?: KeyFlags; onDone: () => void }) {
  const api = useStore(s => s.api);
  const select = useStore(s => s.select);
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const landed = useRef(false);

  useEffect(() => {
    if (!api) return;
    return api.subscribe(e => {
      if (e.type === "golden.stage") dispatch({ type: "stage", stage: e.stage, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
    });
  }, [api]);

  const fail = useCallback((e: unknown) => dispatch({ type: "failed", detail: e instanceof Error ? e.message : String(e) }), []);

  const prepare = (): void => {
    if (!api) return;
    dispatch({ type: "prepare" });
    api.prepareGolden("default").then(builder => dispatch({ type: "prepared", builder })).catch(fail);
  };

  const seal = (): void => {
    if (!api || !state.builder) return;
    dispatch({ type: "seal" });
    api.sealGolden(state.builder.id).then(() => dispatch({ type: "sealed" })).catch(fail);
  };

  // One fork of the new golden, then the app. A failed fork still lands: the
  // golden exists and the rail's own create can retry it.
  useEffect(() => {
    if (state.step !== "done" || !api || landed.current) return;
    landed.current = true;
    api
      .createFromGoldenHead(FIRST_WORKSPACE)
      .then(w => select(w.id))
      .catch(() => {})
      .finally(onDone);
  }, [state.step, api, select, onDone]);

  return (
    <div className={styles.wizard} data-step={state.step}>
      <header className={styles.top}>
        <span className={styles.brand}>wsp</span>
        <span className={styles.sep} />
        <span className={styles.lbl}>first run</span>
        <ol className={styles.trail} aria-label="steps">
          {TRAIL.map(s => (
            <li key={s} data-state={s === state.step ? "current" : TRAIL.indexOf(s) < TRAIL.indexOf(state.step) ? "done" : "pending"}>
              {STEP_WORD[s]}
            </li>
          ))}
        </ol>
        <span className={styles.step} data-testid="step">
          {state.step}
        </span>
      </header>
      {state.step === "welcome" && <Welcome keys={keys} onPrepare={prepare} />}
      {state.step === "preparing" && <Stages title="Preparing your machine" list={PREPARE_STAGES} seen={state.seen} detail={state.detail} />}
      {state.step === "hero" && state.builder && (
        <Hero streamUrl={state.builder.screen?.streamUrl} builderId={state.builder.id} keys={keys} ready={isReady(state)} onSeal={seal} />
      )}
      {state.step === "sealing" && <Stages title="Saving your golden image" list={SEAL_STAGES} seen={state.seen} detail={state.detail} />}
      {state.step === "done" && <Landing />}
      {state.step === "failed" && <Failed detail={state.detail ?? ""} onReset={() => dispatch({ type: "reset" })} />}
    </div>
  );
}

function Welcome({ keys, onPrepare }: { keys?: KeyFlags; onPrepare: () => void }) {
  const anthropic = keys === undefined ? "unknown" : keys.anthropic ? "found" : "not found";
  return (
    <section className={styles.column}>
      <span className={styles.lbl}>golden image</span>
      <h1 className={styles.h1}>Set up one machine. Fork it forever.</h1>
      <p className={styles.p}>
        wsp boots a fresh cloud desktop and shows you its screen. You set it up the way you like a computer, then save it as your golden image.
        Every workspace after that is a fork of it.
      </p>
      <dl className={styles.kv}>
        <dt>solari key</dt>
        <dd data-testid="key-solari" data-found="true">found</dd>
        <dt>anthropic key</dt>
        <dd data-testid="key-anthropic" data-found={anthropic === "found"}>{anthropic}</dd>
      </dl>
      <p className={styles.note}>
        No Anthropic key is fine: sign in with your Claude subscription inside the machine during setup, and wsp never sees that credential.
      </p>
      <div className={styles.actions}>
        <button type="button" className={`${styles.key} ${styles.keyPrimary}`} onClick={onPrepare}>
          Prepare my machine
        </button>
        <span className={styles.hint}>boots one cloud desktop on your Solari account; it bills while it runs</span>
      </div>
    </section>
  );
}

function Stages({ title, list, seen, detail }: { title: string; list: readonly GoldenStage[]; seen: readonly GoldenStage[]; detail?: string }) {
  const rows = rowStates(list, seen);
  return (
    <section className={styles.column}>
      <span className={styles.lbl}>{title}</span>
      <ol className={styles.stages}>
        {list.map(s => (
          <li key={s} className={styles.stage} data-testid={`stage-${s}`} data-state={rows[s]}>
            <span className={styles.stageName}>{STAGE_WORD[s]}</span>
            <span className={styles.stageMark}>{rows[s] === "done" ? "done" : rows[s] === "current" ? <Ellipsis /> : ""}</span>
          </li>
        ))}
      </ol>
      <div className={styles.detail}>{detail ?? " "}</div>
    </section>
  );
}

const CHECKLIST = [
  "run claude and sign in with /login if you have no API key",
  "gh auth login",
  "bring your dotfiles and shell setup",
  "install anything you always want on a fresh machine",
];

function Hero({
  streamUrl,
  builderId,
  keys,
  ready,
  onSeal,
}: {
  streamUrl: string | undefined;
  builderId: string;
  keys?: KeyFlags;
  ready: boolean;
  onSeal: () => void;
}) {
  const [ticked, setTicked] = useState<boolean[]>(() => CHECKLIST.map(() => false));
  const items = keys?.anthropic ? CHECKLIST.slice(1) : CHECKLIST;
  return (
    <section className={styles.hero}>
      <div className={styles.screen}>
        <ScreenTab workspaceId={builderId} {...(streamUrl !== undefined ? { streamUrl } : {})} />
      </div>
      <aside className={styles.side}>
        <span className={styles.lbl}>set it up like your own computer</span>
        <p className={styles.p}>This is your machine's live screen. Click control to type into it.</p>
        <ul className={styles.check}>
          {items.map((text, i) => (
            <li key={text}>
              <label>
                <input type="checkbox" checked={ticked[i] ?? false} onChange={e => setTicked(t => t.map((v, j) => (j === i ? e.target.checked : v)))} />
                <span>{text}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className={styles.note}>Take your time, but a long idle break can pause the machine and lose this setup.</p>
        <div className={styles.actions}>
          <button type="button" className={`${styles.key} ${styles.keySpend}`} disabled={!ready} onClick={onSeal}>
            Save as my golden image
          </button>
          <span className={styles.hint}>{ready ? "snapshots, then boots a fork to prove it" : "waiting for the machine to finish installing"}</span>
        </div>
      </aside>
    </section>
  );
}

function Landing() {
  return (
    <section className={styles.column}>
      <span className={styles.lbl}>golden v1 saved</span>
      <div className={styles.detail}>
        forking your first workspace
        <Ellipsis />
      </div>
    </section>
  );
}

function Failed({ detail, onReset }: { detail: string; onReset: () => void }) {
  return (
    <section className={styles.column}>
      <span className={styles.lbl}>that did not work</span>
      <p className={styles.p}>The machine from this attempt is gone. Start over boots a fresh one.</p>
      <pre className={styles.err}>{detail}</pre>
      <div className={styles.actions}>
        <button type="button" className={`${styles.key} ${styles.keyPrimary}`} onClick={onReset}>
          Start over
        </button>
      </div>
    </section>
  );
}

function Ellipsis() {
  return (
    <span className={styles.ell} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
