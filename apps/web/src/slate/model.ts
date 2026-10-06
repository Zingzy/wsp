// SPDX-License-Identifier: AGPL-3.0-only
// What the renderer adds to the protocol's schema 2 shapes: the approval scopes, and which steps the host runs and
// which the window does (02-model, 07-runs).
import { type SlateOpParams } from "@wsp/protocol";
import { isSlateSecretHandle, SLATE_STEPS, type SlateJson, type SlateRunRecord, type SlateSecretHandle, type SlateStep } from "@wsp/protocol/slate";

export type { SlateAsk } from "@wsp/protocol";
export type { SlateDoc, SlateEventName, SlatePiece, SlateRunDecl, SlateRunRecord, SlateRunState, SlateStep } from "@wsp/protocol/slate";

export type SlateApproval = SlateOpParams<"slates.approve">["scope"];

export function isRunRecord(value: SlateJson | undefined): value is SlateJson & SlateRunRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof value["state"] === "string";
}

export { isSlateSecretHandle as isSecretHandle };

export function stepsOf(declared: SlateStep | SlateStep[] | undefined): SlateStep[] {
  return declared === undefined ? [] : Array.isArray(declared) ? declared : [declared];
}

/** The steps the host runs; the rest run in the window that raised the event. */
export const isHostStep = (step: SlateStep): boolean => SLATE_STEPS[step.do]?.runs === "host";
