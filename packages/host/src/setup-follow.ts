// SPDX-License-Identifier: AGPL-3.0-only
// One add or one setup followed on the host's socket from before the request
// that starts it: the install's steps, the setup's steps, every sign-in that
// waits on the person and the end. The command line prints them as they come
// and waits on the person where it was not told to go on; the tool returns at
// the first wait, the end or its ceiling, and is called again for the next.
import { PlaceSetupEvent, PlaceStageEvent, PROVIDER_KEY_WORDS, usageRefusal, type AddLine, type PlaceView, type PlaceWait, type SetupEnd } from "@wsp/protocol";
import type { HostClient } from "./verbs.js";

/** What has been heard of one add or setup so far. */
export interface SetupWatch {
  lines: AddLine[];
  /** Every sign-in that waited, by its row, as it last stood: a wait gone from the list landed. */
  waits: Map<string, PlaceWait>;
  /** The last end said, with what it came to: a setup that ended with a wait can end again once the wait lands. */
  end?: { end: SetupEnd; said?: string };
  /** The install's own refusal, where a step of it failed. */
  failed?: string;
  /** Settles at the next thing heard: a line, a wait or an end. */
  next(): Promise<void>;
  /** Takes a second stream as this one's: the run a resume answered with where a setup was already under way. */
  also(addId: string): void;
  off(): void;
}

/** Starts following one stream. `say` hears each line and each wait as it arrives. */
export function watchSetup(client: HostClient, addId: string, say: { line(l: AddLine): void; wait(w: PlaceWait): void } = { line: () => {}, wait: () => {} }): SetupWatch {
  let wake: () => void = () => {};
  let heard = new Promise<void>(r => (wake = r));
  const poke = (): void => {
    const was = wake;
    heard = new Promise<void>(r => (wake = r));
    was();
  };
  const ids = new Set([addId]);
  const watch: SetupWatch = {
    lines: [],
    waits: new Map(),
    next: () => heard,
    also: id => void ids.add(id),
    off: () => off(),
  };
  const off = client.onFrame(frame => {
    const stage = PlaceStageEvent.safeParse(frame);
    if (stage.success && ids.has(stage.data.addId)) {
      const l: AddLine = { step: stage.data.step, state: stage.data.state, ...(stage.data.note !== undefined ? { note: stage.data.note } : {}) };
      watch.lines.push(l);
      if (stage.data.state === "failed") watch.failed = stage.data.note;
      say.line(l);
      poke();
      return;
    }
    const setup = PlaceSetupEvent.safeParse(frame);
    if (!setup.success || !ids.has(setup.data.addId)) return;
    const e = setup.data;
    if (e.line !== undefined) {
      watch.lines.push(e.line);
      say.line(e.line);
    }
    if (e.wait !== undefined) {
      watch.waits.set(e.wait.row, e.wait);
      say.wait(e.wait);
    }
    if (e.end !== undefined) watch.end = { end: e.end, ...(e.said !== undefined ? { said: e.said } : {}) };
    poke();
  });
  return watch;
}

/** The waits still on the person: a wait whose row landed is gone from the computer's own row, which is read. */
export const openWaits = (waiting: readonly PlaceWait[]): PlaceWait[] => waiting.filter(w => w.state === "waiting");

/** The refusal the tool gives a word that is not a computer's: a project and a provider's key are added elsewhere. */
export const addToolRefusal = (word: string): string => `add takes a computer over ssh, by user@host or by an alias from the ssh config, and ${word} is not one`;
export const ADD_TOOL_FIX = "A project is recorded with projects_add; a provider's key and the join code another computer types are handed out at the host's own terminal, with wsp add.";

/** The longest one call of the add tool runs before it answers how far the add got: it never waits on the person,
 * and an agent calls it again with resume for the next part. */
export const ADD_TOOL_MS = 10 * 60_000;

/** What the add tool answers: the computer as it stands, its setup's steps and every sign-in of it waiting on the
 * person, each as the computer's row holds them. */
export type AddAnswer = {
  computer: PlaceView;
  setup: AddLine[];
  waiting: PlaceWait[];
};

/** Whether the tool takes a word as a computer: user@host or an ssh alias, never a path, a repo or a provider. */
export const isComputerWord = (word: string): boolean => !/[/:]/.test(word) && !/^[~.]/.test(word) && !word.endsWith(".git") && !Object.hasOwn(PROVIDER_KEY_WORDS, word);

/** The tool's add: a computer over ssh joined and set up from a saved recipe, or with `resume` a computer already
 * added set up again. Answers at the first of a sign-in waiting on the person (unless `later`), the end, or the
 * ceiling, and never waits on the person. A word that names a project or a provider is refused: those two adds,
 * and the join code, belong at the terminal. */
export async function addComputer(client: HostClient, ask: { address: string; recipe?: string; later?: boolean; resume?: boolean; name?: string; sshPort?: number; keyPath?: string; hostKey?: string }, o: { ceilingMs?: number } = {}): Promise<AddAnswer> {
  if (ask.resume !== true && !isComputerWord(ask.address)) throw usageRefusal(addToolRefusal(ask.address), ADD_TOOL_FIX);
  let wake: () => void = () => {};
  const off = client.onFrame(frame => {
    if (frame.type === "place.setup") wake();
  });
  try {
    await client.events();
    const recipe = ask.recipe !== undefined ? { recipe: ask.recipe } : {};
    const { place } =
      ask.resume === true
        ? await client.request<{ place: PlaceView }>("places.setup", { ref: ask.address, ...recipe })
        : await client.request<{ place: PlaceView }>("places.add", {
            address: ask.address,
            ...(ask.name !== undefined ? { name: ask.name } : {}),
            ...(ask.sshPort !== undefined ? { sshPort: ask.sshPort } : {}),
            ...(ask.keyPath !== undefined ? { keyPath: ask.keyPath } : {}),
            ...(ask.hostKey !== undefined ? { hostKey: ask.hostKey } : {}),
            ...recipe,
          });
    const until = Date.now() + (o.ceilingMs ?? ADD_TOOL_MS);
    for (;;) {
      const heard = new Promise<void>(r => (wake = r));
      const now = (await client.request<{ places: PlaceView[] }>("places.list")).places.find(p => p.id === place.id) ?? place;
      const waiting = now.setup?.waiting ?? [];
      const over = now.setup === undefined || now.setup.state !== "running";
      if (over || (ask.later !== true && openWaits(waiting).length > 0) || Date.now() >= until) return { computer: now, setup: now.setup?.steps ?? [], waiting };
      await Promise.race([heard, client.closed, new Promise<void>(r => setTimeout(r, Math.max(0, until - Date.now())).unref())]);
    }
  } finally {
    off();
  }
}
