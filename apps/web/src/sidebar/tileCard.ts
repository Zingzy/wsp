// SPDX-License-Identifier: AGPL-3.0-only
// What a tile tells on its hover card to its right, as T3 Code's sidebar
// details tooltip: the full title, where the thread runs, its branch, the
// agent's model, the pull request with its state as a word and the files
// changed, then whatever holds the thread. The tile itself keeps two rows and
// one mark: an open pull request's icon.
import { agentName } from "@wsp/catalog";
import { PULL_REQUEST_WORDS, type PullRequestState } from "@wsp/protocol";
import { PR_WORDS } from "../pull-request/words.js";
import type { TilePlace } from "./ThreadTile.js";

export interface TileCardInput {
  readonly title: string;
  readonly place: TilePlace;
  /** Empty where the workspace is on no branch or none is known. */
  readonly branch: string;
  readonly harness: string | null;
  /** The model by the label its catalog gives it, where the thread names one. */
  readonly model: string | null;
  readonly pr?: { readonly number: number; readonly state: PullRequestState } | undefined;
  /** What the checkout holds uncommitted, in its own words, where the host read it. */
  readonly changed?: string | undefined;
  /** What holds the thread, each a sentence of its own: the question it waits on, why the pull request is not read. */
  readonly notes: ReadonlyArray<string | null>;
}

export type TileCardLine = { readonly kind: "project" | "computer" | "branch" | "agent" | "pr" | "changed" | "note"; readonly text: string };

export function tileCardLines(o: TileCardInput): { title: string; lines: TileCardLine[] } {
  const line = (kind: TileCardLine["kind"], text: string | null | undefined): TileCardLine[] => (text === null || text === undefined || text === "" ? [] : [{ kind, text }]);
  return {
    title: o.title,
    lines: [
      ...line("project", o.place.project),
      ...line("computer", o.place.computer),
      ...line("branch", o.branch),
      ...line("agent", o.model ?? (o.harness === null ? null : agentName(o.harness))),
      ...line("pr", o.pr === undefined ? null : `${PR_WORDS.row(o.pr.number)}, ${PULL_REQUEST_WORDS[o.pr.state]}`),
      ...line("changed", o.changed),
      ...o.notes.flatMap(note => line("note", note)),
    ],
  };
}

/** Whether a tile's second row ends in the pull request's icon: only while it is open. */
export const tilePrIcon = (pr: { readonly state: PullRequestState } | undefined): boolean => pr?.state === "open";
