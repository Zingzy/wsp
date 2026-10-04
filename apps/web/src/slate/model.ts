// SPDX-License-Identifier: AGPL-3.0-only
// The schema 2 document as the renderer reads it (02-model, 05-pieces, 07-runs, 08-secrets), and the shapes the
// window's slate ops answer. Values, derived values and runs share one namespace of $names; a run's result record
// and a secret's handle are values like any other.
import type { SlateJson, SlatePropValue } from "@wsp/protocol";

export type SlateStep =
  | { do: "set"; path: string; value: SlatePropValue }
  | { do: "toggle"; path: string }
  | { do: "start"; run: string }
  | { do: "cancel"; run: string }
  | { do: "send" | "steer" | "queue" | "fill"; text: string; with?: string[] }
  | { do: "open"; target: SlatePropValue }
  | { do: "copy"; text: SlatePropValue }
  | { do: "pane"; kind: string };

export type SlateEventName = "press" | "submit" | "change";

export interface SlatePiece {
  type: string;
  props?: Record<string, SlatePropValue>;
  children?: string[];
  when?: string;
  on?: Partial<Record<SlateEventName, SlateStep | SlateStep[]>>;
  fallback?: string | "drop" | { text: string };
}

export interface SlateValueDecl {
  start?: SlateJson;
  secret?: true;
  keep?: true;
}

export interface SlateRunDecl {
  kind: "cmd" | "tool" | "resource";
  cmd?: string;
  env?: Record<string, SlatePropValue>;
  args?: SlatePropValue;
  stdin?: SlatePropValue;
  on?: "thread" | "host";
  cwd?: string;
  timeout?: number;
  stream?: true;
  confirm?: string;
  every?: number;
  once?: true;
  server?: string;
  tool?: string;
  uri?: string;
}

export interface SlateDoc {
  schema: 2;
  kit?: string;
  title?: string;
  root: string;
  values?: Record<string, SlateValueDecl>;
  derived?: Record<string, string>;
  runs?: Record<string, SlateRunDecl>;
  reactions?: unknown[];
  pieces: Record<string, SlatePiece>;
}

export type SlateRunState = "idle" | "held" | "running" | "done" | "failed" | "cancelled";

export interface SlateRunRecord {
  state: SlateRunState;
  why?: string;
  exit?: number | null;
  out?: SlateJson;
  err?: string;
  lines?: string[];
  runs?: number;
}

/** What the window learns of a secret: whether it is filled, and its length; never its text (08). */
export interface SlateSecretHandle {
  secret: true;
  set: boolean;
  len?: number;
  at?: string | number;
}

/** The consent sheet's content when the host held a run on a press: what the command is handed, where, and who
 * wrote it (07, "Consent"). Values arrive as the host evaluated them, a secret's as dots. */
export interface SlateAsk {
  run: string;
  key?: string;
  cmd?: string;
  env?: Record<string, string>;
  args?: string[];
  stdin?: string;
  on?: string;
  cwd?: string;
  timeout?: number;
  turn?: number;
}

export type SlateApproval = "once" | "thread" | "refuse";

export function isRunRecord(value: SlateJson | undefined): value is SlateJson & SlateRunRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value["state"] === "string";
}

export function isSecretHandle(value: SlateJson | undefined): value is SlateJson & SlateSecretHandle {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value["secret"] === true;
}

export function stepsOf(declared: SlateStep | SlateStep[] | undefined): SlateStep[] {
  return declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
}

/** The steps the host runs; the rest run in the window that raised the event (02, "Reactions"). */
const HOST_STEPS: ReadonlySet<SlateStep["do"]> = new Set(["set", "toggle", "start", "cancel", "send", "steer", "queue"]);
export const isHostStep = (step: SlateStep): boolean => HOST_STEPS.has(step.do);
