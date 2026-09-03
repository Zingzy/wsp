// SPDX-License-Identifier: AGPL-3.0-only
// The first thing wsp init prints: the wordmark in shaded greys, then the
// badge line that opens the clack frame. Off a terminal, or under --yes, one
// plain line with the version.
import { styleText } from "node:util";
import { intro } from "@clack/prompts";
import type { InitIO } from "./init.js";

export const TAGLINE = "your setup, on cloud machines, for coding agents";

/** "wsp" in block letters, written out so no font library is needed. */
export const WORDMARK: readonly string[] = [
  "██╗    ██╗███████╗██████╗ ",
  "██║    ██║██╔════╝██╔══██╗",
  "██║ █╗ ██║███████╗██████╔╝",
  "██║███╗██║╚════██║██╔═══╝ ",
  "╚███╔███╔╝███████║██║     ",
  " ╚══╝╚══╝ ╚══════╝╚═╝     ",
];

// 256-colour greys in the middle of the ramp, so they read on dark and light backgrounds alike.
const FILL = [250, 248, 246, 244, 242, 240];
const OUTLINE = 237;
const grey = (n: number, s: string): string => `\x1b[38;5;${n}m${s}\x1b[39m`;

/** Each row a step darker than the one above; the box-drawing outline darker than the blocks it edges. */
export function wordmark(colour = true): string[] {
  if (!colour) return [...WORDMARK];
  return WORDMARK.map((row, i) => row.replace(/█+|[^█ ]+/g, run => grey(run.startsWith("█") ? FILL[i]! : OUTLINE, run)));
}

export function opening(io: Pick<InitIO, "output" | "isTTY" | "env">, o: { command: string; version: string; yes: boolean }): void {
  const out = { output: io.output };
  if (!io.isTTY || o.yes) {
    intro(`wsp ${o.version}`, out);
    return;
  }
  io.output.write(`\n${wordmark((io.env["NO_COLOR"] ?? "") === "").join("\n")}\n\n`);
  intro(`${styleText("inverse", ` ${o.command} `)}  ${styleText("dim", `${TAGLINE}  ${o.version}`)}`, out);
}
