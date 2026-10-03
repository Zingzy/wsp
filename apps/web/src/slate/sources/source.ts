// SPDX-License-Identifier: AGPL-3.0-only
// One source as the window resolves it (06-sources): what in the window it reads, and how a path under it is read
// off that. A path this window does not hold answers ASK_HOST and is resolved through slates.resolve instead.
import type { SlateJson, SlateView as SlateRecord, ThreadView, TurnResult } from "@wsp/protocol";
import type { CostTick, useStore } from "../../protocol/store.js";

export type AppState = ReturnType<typeof useStore.getState>;

export interface SourceContext {
  readonly threadId: string;
  readonly app: AppState;
  /** The workspace the thread's rows live under, and the thread as they fold. */
  readonly workspaceId: string | null;
  readonly thread: ThreadView | null;
  readonly lastTurn: TurnResult | undefined;
  readonly record: SlateRecord | null;
  /** Values the host resolved for this slate, by path. */
  readonly fromHost: Readonly<Record<string, SlateJson | undefined>>;
  readonly now: number;
}

export const ASK_HOST = Symbol("ask the host");
export type Answer = SlateJson | undefined | typeof ASK_HOST;

export interface SourceModule {
  readonly name: string;
  /** What this source reads in the window; when it is not the same object as before, every path under it moved. */
  input(ctx: SourceContext): unknown;
  select(steps: readonly (string | number)[], ctx: SourceContext): Answer;
  /** Held on the host while a drawn piece binds it, so the host reads it more often (pr while a check is pending). */
  readonly held?: true;
  /** Asked of the window once while bound, for a fact it holds nowhere else. */
  wants?(ctx: SourceContext): void;
}

export type { CostTick };
