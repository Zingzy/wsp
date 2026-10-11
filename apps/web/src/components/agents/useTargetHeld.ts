// SPDX-License-Identifier: AGPL-3.0-only
// What an agents road keeps for one target, part by part, each part a map by
// what it is about: a new target starts from nothing, and an answer that lands
// after the target changed is dropped. Every write a road sends is busy while
// it runs and keeps the host's refusal until the next try.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentsTarget } from "@wsp/protocol";
import { errorText } from "../../lib/utils.js";

/** The parts every road keeps for its writes. */
export interface WriteParts {
  busy: true;
  refused: string;
}

type Shown<M> = { readonly [K in keyof M]: Readonly<Record<string, M[K]>> };

/** Puts one value of one part for the target it was asked for; nothing takes it out. */
export type Put<M> = <K extends keyof M>(part: K, key: string, value: M[K] | undefined, forKey?: string | null) => void;

export function useTargetHeld<M extends WriteParts>(target: AgentsTarget | null, parts: readonly (keyof M)[]): { targetKey: string | null; shown: Shown<M>; put: Put<M> } {
  const targetKey = target === null ? null : JSON.stringify(target);
  const fresh = useCallback((key: string | null): { targetKey: string | null; held: Shown<M> } => ({ targetKey: key, held: Object.fromEntries(parts.map(p => [p, {}])) as Shown<M> }), [parts]);
  const [state, setState] = useState(() => fresh(targetKey));
  const current = useRef(targetKey);
  useEffect(() => {
    current.current = targetKey;
  }, [targetKey]);
  const shown = state.targetKey === targetKey ? state.held : fresh(targetKey).held;
  const put = useCallback<Put<M>>(
    (part, key, value, forKey = targetKey) =>
      setState(s => {
        if (current.current !== forKey) return s;
        const base = s.targetKey === forKey ? s : fresh(forKey);
        const next = { ...base.held[part] } as Record<string, unknown>;
        if (value === undefined) delete next[key];
        else next[key] = value;
        return { targetKey: forKey, held: { ...base.held, [part]: next } };
      }),
    [fresh, targetKey],
  );
  return { targetKey, shown, put };
}

/** One write by its key: busy while it runs, its refusal kept until the next try; nothing where there was nothing to send. */
export function trackWrite<M extends WriteParts>(put: Put<M>, key: string, going: Promise<unknown> | undefined, forKey: string | null): void {
  if (going === undefined) return;
  put("refused", key, undefined, forKey);
  put("busy", key, true, forKey);
  going.then(
    () => put("busy", key, undefined, forKey),
    (e: unknown) => {
      put("busy", key, undefined, forKey);
      put("refused", key, errorText(e), forKey);
    },
  );
}
