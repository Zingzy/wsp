// SPDX-License-Identifier: AGPL-3.0-only
// What a host resolver reads a slate's sources off: the thread's own rows and turn results, its account, its
// workspace's checkout, pull request and cost, and the slate's state. The runtime fills it per read.
import type { AccountRow, Checkout, PullRequestSeen, SessionView, SlateJson, TurnResult } from "@wsp/protocol";

export interface SlateSourceContext {
  threadId: string;
  workspaceId: string;
  now: number;
  /** The thread's rows, oldest first. */
  rows(): SessionView[];
  /** The results of the thread's ended turns, oldest first, off its transcript. */
  results(): TurnResult[];
  /** The account the thread runs on, as the Usage page lists it. */
  account(): Promise<AccountRow | undefined>;
  workspace(): SlateWorkspaceFacts | undefined;
  state: Record<string, SlateJson>;
}

export interface SlateWorkspaceFacts {
  computer?: string;
  project?: string;
  folder?: string;
  checkout?: Checkout;
  pr?: PullRequestSeen;
  rateUsdPerHour?: number;
  accruedUsd?: number;
}

/** One source on the host: its first path segment and the whole value its paths are read out of. A value that has
 * not arrived reads undefined, and every path under it then reads as not there yet. */
export interface HostSlateSource {
  name: string;
  view(ctx: SlateSourceContext): Promise<SlateJson | undefined> | SlateJson | undefined;
}

/** A value as JSON: absent fields dropped, so a view never carries undefined. */
export const json = (value: unknown): SlateJson => JSON.parse(JSON.stringify(value ?? null)) as SlateJson;
