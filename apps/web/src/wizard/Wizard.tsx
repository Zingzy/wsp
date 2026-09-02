// SPDX-License-Identifier: AGPL-3.0-only
// First run: the window is the wizard until a golden image exists. wsp init
// in the terminal picks what comes along and boots the builder; this is where
// the builder gets pixels: the screen tab's component when it streams a
// display, the terminal tab's against its daemon otherwise, with a checklist
// of the sign-ins beside it. Nothing here probes the builder, the person
// ticks the boxes.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { GoldenBuilderView, GoldenStage } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { ScreenTab } from "../tabs/ScreenTab.js";
import { TerminalTab } from "../tabs/TerminalTab.js";
import { connectDaemonLink, type DaemonLink } from "../terminal/daemon-link.js";
import { provideTerminals, WorkspaceTerminals } from "../terminal/link.js";
import { SEAL_STAGES, initial, reduce, rowStates, type Step } from "./model.js";
import styles from "./Wizard.module.css";

/** Presence only. The host may omit the anthropic flag; the browser never sees a value. */
export interface KeyFlags {
  anthropic: boolean;
}

const STEP_WORD: Record<Step, string> = {
  none: "terminal",
  hero: "set up",
  sealing: "saving",
  done: "done",
  failed: "failed",
};
const TRAIL: Step[] = ["none", "hero", "sealing", "done"];

const STAGE_WORD: Record<GoldenStage, string> = {
  creating: "booting a fresh machine",
  "deploying-daemon": "starting the workspace daemon",
  "installing-harness": "running the setup",
  ready: "ready for you",
  snapshotting: "taking the snapshot",
  "smoke-forking": "booting a fork to prove it works",
  sealed: "sealed",
  failed: "failed",
};

const FIRST_WORKSPACE = "first";
/** The golden wsp init builds; stage frames for any other name belong to someone else's build. */
const GOLDEN_NAME = "default";

export function Wizard({ keys, builder, onDone }: { keys?: KeyFlags; builder?: GoldenBuilderView; onDone: () => void }) {
  const api = useStore(s => s.api);
  const select = useStore(s => s.select);
  const [state, dispatch] = useReducer(reduce, builder, initial);
  const landed = useRef(false);

  useEffect(() => {
    if (!api) return;
    return api.subscribe(e => {
      if (e.type === "golden.stage" && e.name === GOLDEN_NAME) {
        dispatch({ type: "stage", stage: e.stage, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
      }
    });
  }, [api]);

  const fail = useCallback((e: unknown) => dispatch({ type: "failed", detail: e instanceof Error ? e.message : String(e) }), []);

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
      {state.step === "none" && <NoBuilder />}
      {state.step === "hero" && state.builder && <Hero builder={state.builder} keys={keys} onSeal={seal} />}
      {state.step === "sealing" && <Stages title="Saving your golden image" list={SEAL_STAGES} seen={state.seen} detail={state.detail} />}
      {state.step === "done" && <Landing />}
      {state.step === "failed" && <Failed detail={state.detail ?? ""} />}
    </div>
  );
}

function NoBuilder() {
  return (
    <section className={styles.column}>
      <span className={styles.lbl}>golden image</span>
      <h1 className={styles.h1}>Set up one machine. Fork it forever.</h1>
      <p className={styles.p}>
        Your first machine is built from the terminal. It reads what your laptop has, you tick what comes along, and it boots the machine.
        This page opens on it when it is ready.
      </p>
      <pre className={styles.cmd}>wsp init</pre>
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
  "sign in to each agent you brought (claude, then /login, for one)",
  "gh auth login, and any other login you left unticked",
  "check the files you brought landed where you expect",
  "install anything you always want on a fresh machine",
];

/** The builder is not a workspace, so the app's terminal wiring never links it;
 * this links it for the hero's lifetime, through the builder's own reach op. */
function useBuilderTerminals(api: Api | null, builderId: string, wanted: boolean): void {
  useEffect(() => {
    if (!api || !wanted) return;
    const wired: { link: DaemonLink | null } = { link: null };
    const wt = new WorkspaceTerminals({
      request: (op, params) => (wired.link ? wired.link.request(op, params) : Promise.reject(new Error("daemon unreachable"))),
    });
    wired.link = connectDaemonLink({
      reach: () => api.builderReach(builderId),
      onEvent: e => wt.feedEvent(e),
      onStatus: s => {
        if (s !== "dead") wt.feedStatus(s);
      },
    });
    provideTerminals(builderId, wt);
    return () => {
      wired.link?.close();
      provideTerminals(builderId, null);
    };
  }, [api, builderId, wanted]);
}

function Hero({ builder, keys, onSeal }: { builder: GoldenBuilderView; keys?: KeyFlags; onSeal: () => void }) {
  const api = useStore(s => s.api);
  const streamUrl = builder.screen?.streamUrl;
  useBuilderTerminals(api, builder.id, streamUrl === undefined);
  const [ticked, setTicked] = useState<boolean[]>(() => CHECKLIST.map(() => false));
  const items = keys?.anthropic ? CHECKLIST.slice(1) : CHECKLIST;
  return (
    <section className={styles.hero}>
      <div className={styles.screen}>
        {streamUrl !== undefined ? <ScreenTab workspaceId={builder.id} streamUrl={streamUrl} /> : <TerminalTab workspaceId={builder.id} />}
      </div>
      <aside className={styles.side}>
        <span className={styles.lbl}>sign in, then save</span>
        <p className={styles.p}>
          {streamUrl !== undefined ? "This is your machine's live screen. Click control to type into it." : "This is a shell on your machine. Type into it."}
        </p>
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
        <p className={styles.note}>Take your time, but a machine idle for six hours is killed and this setup is lost.</p>
        <div className={styles.actions}>
          <button type="button" className={`${styles.key} ${styles.keySpend}`} onClick={onSeal}>
            Save as my golden image
          </button>
          <span className={styles.hint}>snapshots, then boots a fork to prove it</span>
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

function Failed({ detail }: { detail: string }) {
  return (
    <section className={styles.column}>
      <span className={styles.lbl}>that did not work</span>
      <p className={styles.p}>The machine from this attempt is gone. Run wsp init again in your terminal to boot a fresh one.</p>
      <pre className={styles.err}>{detail}</pre>
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
