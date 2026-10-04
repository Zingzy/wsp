// SPDX-License-Identifier: AGPL-3.0-only
// What the renderer adds to the protocol's schema 2 shapes: the consent sheet's ask, the approval scopes, and which
// steps the host runs and which the window does (02-model, 07-runs).
import { isSlateSecretHandle, type SlateJson, type SlateRunRecord, type SlateSecretHandle, type SlateStep } from "@wsp/protocol";

export type { SlateDoc, SlateEventName, SlatePiece, SlateRunDecl, SlateRunRecord, SlateRunState, SlateStep } from "@wsp/protocol";

/** What the consent sheet shows for a held run, as the host answers it on the record and on a press that held it
 * (07, "Consent"): the whole command, each env name with the value it carries now (a secret as dots with its
 * length), the computer, the folder, the timeout, and the key an approval names. */
export interface SlateAsk {
  key: string;
  run: string;
  kind: "cmd";
  cmd: string;
  env: Record<string, string>;
  args: string[];
  stdin?: string;
  computer: string;
  folder: string;
  timeoutS: number;
  confirm?: string;
  why: string;
}

export type SlateApproval = "once" | "thread" | "refuse";

export function isRunRecord(value: SlateJson | undefined): value is SlateJson & SlateRunRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value["state"] === "string";
}

export const isSecretHandle = (value: SlateJson | undefined): value is SlateJson & SlateSecretHandle => isSlateSecretHandle(value);

export function stepsOf(declared: SlateStep | SlateStep[] | undefined): SlateStep[] {
  return declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
}

/** The steps the host runs; the rest run in the window that raised the event (02, "Reactions"). */
const HOST_STEPS: ReadonlySet<SlateStep["do"]> = new Set(["set", "toggle", "start", "cancel", "send", "steer", "queue"]);
export const isHostStep = (step: SlateStep): boolean => HOST_STEPS.has(step.do);
