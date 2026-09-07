// SPDX-License-Identifier: AGPL-3.0-only
// The one contract an agent reads wsp by: with --json stdout carries JSON
// alone, every refusal or failure is one line on stderr, and the exit code is
// the class the error belongs to. The class is read off the kind stamped on
// the error where it was born (the engine's for a provider answer, the two
// helpers here for a refusal), never off its words, so every door classes
// the same failure the same way.
import { z } from "zod";

export const ExitClass = z.enum(["ok", "provider", "auth", "usage"]);
export type ExitClass = z.infer<typeof ExitClass>;

/** The exit code each class owns, the same on every verb and command. */
export const EXIT_CODES: Readonly<Record<ExitClass, number>> = { ok: 0, provider: 1, auth: 2, usage: 3 };

/** What each class means, in the words the skill, the help and the instructions quote. */
export const EXIT_WORDS: Readonly<Record<ExitClass, string>> = {
  ok: "it did what its line says; with --json stdout holds the answer",
  provider: "the host, the runtime, Solari or the machine refused or failed",
  auth: "no key, no sign-in, or the host refused the token",
  usage: "the line was refused before anything ran: a missing argument, an unknown flag or a value nothing takes",
};

/** A failure as --json prints it on stderr and as a tool error carries it beside its text. */
export const VerbFailure = z.object({ error: z.string(), class: ExitClass.exclude(["ok"]), exit: z.number().int() });
export type VerbFailure = z.infer<typeof VerbFailure>;

const KIND_CLASS: Readonly<Record<string, Exclude<ExitClass, "ok">>> = { usage: "usage", invalid: "usage", auth: "auth" };

/** The class of an error, by the kind stamped on it; one with no kind, or a kind no class claims, is the provider's. */
export function exitClassOf(e: unknown): Exclude<ExitClass, "ok"> {
  const kind = typeof e === "object" && e !== null ? (e as { kind?: unknown }).kind : undefined;
  return (typeof kind === "string" ? KIND_CLASS[kind] : undefined) ?? "provider";
}

export function verbFailure(e: unknown): VerbFailure {
  const cls = exitClassOf(e);
  return { error: e instanceof Error ? e.message : String(e), class: cls, exit: EXIT_CODES[cls] };
}

/** A line refused before anything ran: a missing argument, a flag or a value nothing takes. */
export const usageRefusal = (message: string): Error => Object.assign(new Error(message), { kind: "usage" });

/** No key, no sign-in, or a token the host refused. */
export const authRefusal = (message: string): Error => Object.assign(new Error(message), { kind: "auth" });
