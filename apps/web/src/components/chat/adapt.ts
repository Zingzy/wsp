// SPDX-License-Identifier: AGPL-3.0-only
// The chat's one import path for view models. src/adapt owns every derivation
// from wire events; the few types below are what the copied rows read that no
// wire event produces yet (checkpoint diffs, harness skills, the timestamp
// setting) and the two id aliases the copies name.
export * from "../../adapt/index.js";

export type MessageId = string;
export type TurnId = string;

export type TimestampFormat = "locale" | "12-hour" | "24-hour";
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

/** The two fields of a harness skill the chat renders (inline `$skill` chips). */
export interface ProviderSkill {
  readonly name: string;
  readonly displayName?: string | undefined;
}

export interface TurnDiffFileChange {
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}
export interface TurnDiffSummary {
  readonly turnId: TurnId;
  readonly files: ReadonlyArray<TurnDiffFileChange>;
  /** What else changed in the same folder meanwhile, whoever wrote it, where the turn's own files are known. */
  readonly others?: ReadonlyArray<TurnDiffFileChange>;
  /** Other threads worked in the folder and the agent named none of its edits: files are the folder's. */
  readonly folder?: true;
}
