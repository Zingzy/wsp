// SPDX-License-Identifier: AGPL-3.0-only
// A press from a slate control: held until the host answers, a second press within 500 ms folded into the first,
// and the outcome or the refusal said under the control for two seconds.
import { useCallback, useEffect, useRef, useState } from "react";
import { isSlateBinding, type SlatePropValue } from "@wsp/protocol";
import type { RaiseResult } from "../actions.js";

const COALESCE_MS = 500;
const SAID_MS = 2_000;

export function usePress(run: () => Promise<RaiseResult>): { busy: boolean; said: string | undefined; refused: string | undefined; press: () => void } {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RaiseResult>({});
  const last = useRef(-Infinity);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const press = useCallback(() => {
    const now = Date.now();
    if (busy || now - last.current < COALESCE_MS) return;
    last.current = now;
    setBusy(true);
    void run().then(
      outcome => {
        setBusy(false);
        setResult(outcome);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setResult({}), SAID_MS);
      },
      (error: unknown) => {
        setBusy(false);
        setResult({ refused: error instanceof Error ? error.message : String(error) });
      },
    );
  }, [busy, run]);
  return { busy, said: result.said, refused: result.refused, press };
}

/** The own path a two-way prop writes: its binding when that is a bare $name path. */
export function twoWayPath(value: SlatePropValue | undefined): string | undefined {
  if (!isSlateBinding(value)) return undefined;
  const path = value.bind.trim();
  return /^\$[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*|\[-?\d+\])*$/.test(path) ? path : undefined;
}
