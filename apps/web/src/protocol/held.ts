// SPDX-License-Identifier: AGPL-3.0-only
// Answers to reads, kept by what was asked for as long as the window lives: a
// page opened again inside its hold, or a second part of the page asking the
// same, draws the kept answer and asks the host nothing. An answer is asked
// again once its hold is past, once the mark it was read under moves (the
// status push saying the thing changed), or on an ask that forces it (a
// refresh). A refusal is kept to be said and asked again at the next ask,
// since a read dropped while the socket reconnects is no answer. While a new
// read runs the last answer stands.
import { useEffect, useRef } from "react";
import { create } from "zustand";

interface Held {
  /** When the read standing here was asked, in wall-clock ms; 0 for one whose refusal asks again. */
  readonly askedAt: number;
  readonly mark: string;
  readonly asking?: Promise<unknown>;
  readonly value?: unknown;
  readonly answeredAt?: number;
  readonly error?: Error;
}

const useHeldStore = create<{ readonly of: Readonly<Record<string, Held>> }>(() => ({ of: {} }));

const put = (key: string, next: (was: Held | undefined) => Held): void => useHeldStore.setState(s => ({ of: { ...s.of, [key]: next(s.of[key]) } }));

/** The answer kept under key, without asking for one. */
export const heldValue = <T>(key: string): T | undefined => useHeldStore.getState().of[key]?.value as T | undefined;

export interface HoldAsk {
  readonly holdMs: number;
  readonly mark?: string;
  readonly force?: boolean;
}

/** Whether a read under key is in flight or answered inside holdMs under the same mark, so asking would repeat it. */
export function heldFresh(key: string, holdMs: number, mark = ""): boolean {
  const was = useHeldStore.getState().of[key];
  return was !== undefined && was.mark === mark && (was.asking !== undefined || (was.error === undefined && Date.now() - was.askedAt < holdMs));
}

/** The read under key: the read in flight, the kept answer while heldFresh, or a new read. */
export function hold<T>(key: string, read: () => Promise<T>, { holdMs, mark = "", force = false }: HoldAsk): Promise<T> {
  const was = useHeldStore.getState().of[key];
  if (!force && was !== undefined && heldFresh(key, holdMs, mark)) return (was.asking ?? Promise.resolve(was.value)) as Promise<T>;
  const asking = read();
  put(key, held => ({ ...held, askedAt: Date.now(), mark, asking }));
  // Only the newest read writes: one a forced ask or a moved mark replaced lands on nothing.
  const mine = (): boolean => useHeldStore.getState().of[key]?.asking === asking;
  asking.then(
    value => {
      if (mine()) put(key, held => ({ askedAt: held!.askedAt, mark, value, answeredAt: Date.now() }));
    },
    (e: unknown) => {
      if (!mine()) return;
      put(key, held => {
        const { asking: _done, ...rest } = held!;
        return { ...rest, askedAt: 0, error: e instanceof Error ? e : new Error(String(e)) };
      });
    },
  );
  return asking;
}

/** Replaces the kept answer with what an act on it answered, keeping when it was read. */
export function keepHeld<T>(key: string, next: (was: T | undefined) => T): void {
  put(key, held => ({ askedAt: held?.askedAt ?? 0, mark: held?.mark ?? "", ...(held?.asking === undefined ? {} : { asking: held.asking }), ...(held?.answeredAt === undefined ? {} : { answeredAt: held.answeredAt }), value: next(held?.value as T | undefined) }));
}

/** Forgets every kept answer whose key starts with prefix, every one without: a test starts from a first window. */
export function forgetHeld(prefix = ""): void {
  useHeldStore.setState(s => ({ of: Object.fromEntries(Object.entries(s.of).filter(([key]) => !key.startsWith(prefix))) }));
}

export interface HeldRead<T> {
  readonly value: T | undefined;
  readonly reading: boolean;
  readonly error: Error | undefined;
  readonly answeredAt: number | undefined;
}

/** A read a component draws, under key, asked as it mounts and whenever key or mark moves; a change of asked forces
 * one, which is a refresh. A null key or no read asks nothing. */
export function useHeld<T>(key: string | null, read: (() => Promise<T>) | undefined, ask: HoldAsk & { readonly asked?: number }): HeldRead<T> {
  const held = useHeldStore(s => (key === null ? undefined : s.of[key]));
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  const askedSeen = useRef(ask.asked ?? 0);
  const readable = read !== undefined;
  const { holdMs, mark, asked = 0 } = ask;
  useEffect(() => {
    const now = latest.current;
    if (key === null || now === undefined) return;
    const force = asked !== askedSeen.current;
    askedSeen.current = asked;
    hold(key, now, { holdMs, ...(mark === undefined ? {} : { mark }), force }).catch(() => {});
  }, [key, mark, asked, holdMs, readable]);
  return { value: held?.value as T | undefined, reading: held?.asking !== undefined, error: held?.error, answeredAt: held?.answeredAt };
}
