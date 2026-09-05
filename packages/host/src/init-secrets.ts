// SPDX-License-Identifier: AGPL-3.0-only
// The secrets step of wsp init: the pack cut every secret export out of the
// rc files it carried, so each name is asked for here once the machine is up.
// The value is typed hidden, travels to the builder in the pty's environment
// and lands as one line at the end of the file it was cut from; it is never
// on the pty's command line, on this screen or in the run log.
import type { Readable, Writable } from "node:stream";
import { styleText } from "node:util";
import { S_BAR, isCancel, log } from "@clack/prompts";
import { passwordPrompt } from "./init-layout.js";
import type { BuilderLink } from "./init-signin.js";
import { runQuiet } from "./signin-relay.js";

export type SecretState = "set" | "skipped" | "failed";

export interface SecretOutcome {
  name: string;
  /** The rc file the export was cut from, `~`-relative; the value is set again at its end. */
  path: string;
  state: SecretState;
  note?: string;
}

export interface SecretsStageOptions {
  /** What the pack cut, per file. */
  cut: readonly { path: string; names: readonly string[] }[];
  /** A fresh link to the builder's daemon, dialled before each write so a dropped one costs that name alone. */
  dial(): Promise<BuilderLink>;
  input: Readable;
  output: Writable;
  /** Set when nobody can type here (no terminal, or --yes): every name is skipped with this note. */
  skipWhy?: string;
  /** Keeps the value out of the run log. */
  hide(value: string): void;
  /** A write that hangs is given up after this. Default 1 min. */
  timeoutMs?: number;
}

const SET_MS = 60_000;
/** The pty environment variable that carries the line; the command names it and never the value. */
const LINE_ENV = "WSP_SECRET_LINE";
const dim = (s: string): string => styleText("dim", s);

/** The line the file gets back: fish sets, every other shell exports; the value is quoted so it lands byte for byte. */
export function exportLine(path: string, name: string, value: string): string {
  if (path.endsWith(".fish")) return `set -gx ${name} '${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return `export ${name}='${value.replace(/'/g, `'\\''`)}'`;
}

/** Appends the line the pty's environment holds to the file under the machine's home. */
export function appendCommand(path: string): string {
  const rel = path.replace(/^~\//, "");
  return `printf '%s\\n' "$${LINE_ENV}" >> "$HOME"/'${rel.replace(/'/g, `'\\''`)}'`;
}

function stateLine(o: SecretOutcome): string {
  switch (o.state) {
    case "set":
      return `${o.name}: ${styleText("green", "set")} in ${o.path} on the machine`;
    case "skipped":
      return `${o.name}: ${dim("skipped")}${o.note !== undefined ? dim(` (${o.note})`) : ""}`;
    case "failed":
      return `${o.name}: ${styleText("yellow", "not set")}${o.note !== undefined ? dim(` (${o.note})`) : ""}`;
    default: {
      const _exhaustive: never = o.state;
      return _exhaustive;
    }
  }
}

export async function secretsStage(o: SecretsStageOptions): Promise<SecretOutcome[]> {
  const outcomes: SecretOutcome[] = o.cut.flatMap(c => c.names.map((name): SecretOutcome => ({ name, path: c.path, state: "skipped" })));
  if (outcomes.length === 0) return outcomes;
  const out = { output: o.output };
  if (o.skipWhy !== undefined) {
    for (const r of outcomes) r.note = o.skipWhy;
    const files = [...new Set(outcomes.map(r => r.path))].join(", ");
    log.step(`Secrets skipped: ${outcomes.map(r => r.name).join(", ")} (${files}). ${o.skipWhy[0]!.toUpperCase()}${o.skipWhy.slice(1)}.`, out);
    return outcomes;
  }
  log.step("Secrets were cut from your files. Paste each to set it on the machine, or leave it empty to skip.", out);
  const timeoutMs = o.timeoutMs ?? SET_MS;
  for (const r of outcomes) {
    const value = await passwordPrompt({ message: r.name, hint: `cut from ${r.path}; the value is set there on the machine and never shown here`, input: o.input, output: o.output });
    if (isCancel(value) || value === "") {
      r.note = "skipped by you";
    } else {
      o.hide(value);
      await set(o, r, value, timeoutMs);
    }
    log.message(stateLine(r), { output: o.output, symbol: dim(S_BAR) });
  }
  return outcomes;
}

/** One write over one fresh link; every failure is this name's note, never the run's end. */
async function set(o: SecretsStageOptions, r: SecretOutcome, value: string, timeoutMs: number): Promise<void> {
  const fail = (note: string): void => {
    r.state = "failed";
    r.note = note;
  };
  try {
    const daemon = await o.dial();
    try {
      const run = await runQuiet(daemon.link, appendCommand(r.path), timeoutMs, { [LINE_ENV]: exportLine(r.path, r.name, value) });
      if (run.dropped) fail("the machine's terminal link dropped");
      else if (run.timedOut) fail(`no answer within ${Math.round(timeoutMs / 60_000)} min`);
      else if (run.exitCode !== 0) fail(`the shell answered exit ${run.exitCode}`);
      else r.state = "set";
    } finally {
      daemon.close();
    }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
