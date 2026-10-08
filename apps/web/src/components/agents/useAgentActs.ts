// SPDX-License-Identifier: AGPL-3.0-only
// The sign-ins and writes one list takes on its target: each row's sign-in
// as it stands, fed by the host's steps for a watched run, the paste for a
// token or key, and the line for the person's terminal; the wsp tools being
// written into an agent's config. A watched run belongs to the window, not to
// the view that started it: closing a view never ends it, and any view of the
// same target draws it, until it lands, fails or Cancel stops it on the host.
// A signed-in run leaves its row, since the report read again after it says
// so; a cancelled one stops on the host and leaves its row at once.
import { useCallback, useEffect, useState } from "react";
import type { AgentsSignInEvent, AgentsTarget } from "@wsp/protocol";
import { useStore } from "../../protocol/store.js";
import type { AgentActs, SignInFlow, SignInStart } from "./agentsRows.js";
import { agentRowId } from "./kinds/agents.js";

interface Handle {
  readonly signInId?: string;
  readonly stop?: () => void;
  readonly off?: () => void;
}

/** One watched run this window started, by its target and row. */
interface Watched {
  flow: SignInFlow;
  handle?: Handle;
  /** Cancel was pressed, or a new run took its row: a handle that answers late is stopped. */
  ended?: true;
}

const watched = new Map<string, Watched>();
const watchers = new Set<() => void>();
const changed = (): void => watchers.forEach(redraw => redraw());
const watchKey = (targetKey: string, rowId: string): string => `${targetKey}\0${rowId}`;

const end = (run: Watched): void => {
  run.ended = true;
  run.handle?.stop?.();
};

/** Ends every run this window watches, for a test that starts from a first window. */
export const forgetSignIns = (): void => {
  for (const run of watched.values()) end(run);
  watched.clear();
};

const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useAgentActs(target: AgentsTarget | null): AgentActs | undefined {
  const api = useStore(s => s.api);
  const targetKey = target === null ? null : JSON.stringify(target);
  // A paste or a line stands in the view that opened it; a watched run stands in `watched`.
  const [local, setLocal] = useState<{ targetKey: string | null; of: Record<string, SignInFlow> }>({ targetKey, of: {} });
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [, redraw] = useState(0);
  useEffect(() => {
    const watcher = (): void => redraw(n => n + 1);
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
  }, []);
  const shown = local.targetKey === targetKey ? local.of : {};

  const put = useCallback(
    (rowId: string, next: ((was: SignInFlow | undefined) => SignInFlow) | undefined): void =>
      setLocal(f => {
        const of: Record<string, SignInFlow> = { ...(f.targetKey === targetKey ? f.of : {}) };
        if (next === undefined) delete of[rowId];
        else of[rowId] = next(of[rowId]);
        return { targetKey, of };
      }),
    [targetKey],
  );

  const start = useCallback(
    (rowId: string, begin: SignInStart): void => {
      if (targetKey === null) return;
      if (begin.kind === "terminal") return;
      if (begin.kind === "copy") return put(rowId, () => ({ kind: "copy", line: begin.line, ...(begin.why !== undefined ? { why: begin.why } : {}) }));
      if (begin.kind === "vault") return put(rowId, () => ({ kind: "vault", agent: begin.agent, word: begin.word, ...(begin.mint !== undefined ? { mint: begin.mint } : {}) }));
      if (api?.agentsSignIn === undefined) return;
      const key = watchKey(targetKey, rowId);
      const was = watched.get(key);
      if (was !== undefined) end(was);
      put(rowId, undefined);
      // What the flow reserves room for rides every step, so its height holds whatever state the host reports.
      const finish = { ...(begin.finish === undefined ? {} : { finish: begin.finish }), ...(begin.pastes === true ? { pastes: true } : {}) };
      const run: Watched = { flow: { kind: "run", state: "running", ...finish } };
      watched.set(key, run);
      changed();
      const live = (): boolean => watched.get(key) === run;
      const target = JSON.parse(targetKey) as AgentsTarget;
      const step = (e: AgentsSignInEvent): void => {
        if (!live()) return;
        if (e.state === "signed-in") {
          run.handle?.off?.();
          watched.delete(key);
          return changed();
        }
        if (e.state === "failed") {
          run.handle?.off?.();
          delete run.handle;
        }
        const before = run.flow;
        run.flow = {
          kind: "run",
          state: e.state,
          ...finish,
          ...(e.url !== undefined ? { url: e.url } : before.kind === "run" && before.url !== undefined ? { url: before.url } : {}),
          ...(e.code !== undefined ? { code: e.code } : {}),
          ...(e.paste !== undefined ? { paste: e.paste } : before.kind === "run" && before.paste !== undefined ? { paste: before.paste } : {}),
          ...(e.said !== undefined ? { said: e.said } : {}),
          ...(e.ptyId !== undefined && "placeId" in target ? { pty: { placeId: target.placeId, ptyId: e.ptyId } } : before.kind === "run" && before.pty !== undefined && e.state !== "failed" ? { pty: before.pty } : {}),
        };
        changed();
      };
      api.agentsSignIn(target, begin.agent, begin.server, step, begin.terminal).then(
        handle => {
          if (run.ended === true) return handle.stop();
          if (!live() || (run.flow.kind === "run" && run.flow.state === "failed")) return handle.off();
          run.handle = handle;
        },
        (e: unknown) => {
          if (!live()) return;
          run.flow = { kind: "run", state: "failed", ...finish, said: said(e) };
          changed();
        },
      );
    },
    [api, targetKey, put],
  );

  const cancel = useCallback(
    (rowId: string): void => {
      put(rowId, undefined);
      if (targetKey === null) return;
      const key = watchKey(targetKey, rowId);
      const run = watched.get(key);
      if (run === undefined) return;
      end(run);
      watched.delete(key);
      changed();
    },
    [put, targetKey],
  );

  const code = useCallback(
    (rowId: string, typed: string): void => {
      const run = targetKey === null ? undefined : watched.get(watchKey(targetKey, rowId));
      const signInId = run?.handle?.signInId;
      if (run === undefined || signInId === undefined || api?.agentsSignInCode === undefined) return;
      api.agentsSignInCode(signInId, typed).catch((e: unknown) => {
        run.flow = { ...(run.flow.kind === "run" ? run.flow : { kind: "run" as const }), state: "failed", said: said(e) };
        changed();
      });
    },
    [api, targetKey],
  );

  const save = useCallback(
    (rowId: string, key: string): void => {
      const flow = shown[rowId];
      if (flow?.kind !== "vault" || api?.agentsKey === undefined) return;
      put(rowId, () => ({ ...flow, saving: true }));
      api.agentsKey(flow.agent, key).then(
        () => put(rowId, undefined),
        (e: unknown) => {
          const { saving: _saving, ...rest } = flow;
          put(rowId, () => ({ ...rest, refused: said(e) }));
        },
      );
    },
    [api, put, shown],
  );

  const addTools = useCallback(
    (agent: string): void => {
      if (targetKey === null || api?.agentsAddTools === undefined) return;
      setAdding(a => new Set([...a, agent]));
      const done = (): void => setAdding(a => new Set([...a].filter(x => x !== agent)));
      api.agentsAddTools(JSON.parse(targetKey) as AgentsTarget, agent).then(done, (e: unknown) => {
        done();
        put(agentRowId(agent), () => ({ kind: "run", state: "failed", said: said(e) }));
      });
    },
    [api, targetKey, put],
  );

  if (targetKey === null || api === null) return undefined;
  return { flowOf: rowId => watched.get(watchKey(targetKey, rowId))?.flow ?? shown[rowId], start, cancel, code, save, addTools, adding: agent => adding.has(agent) };
}
