// SPDX-License-Identifier: AGPL-3.0-only
// The job the host leaves when the provider refuses the key already saved: the
// first stage failed with the refusal as its line, the sign-ins the screens
// chose and the first workspace skipped as rows the build never reached. The
// shape is pinned by the host's own test (packages/host/test/init-job.test.ts,
// KEY_REFUSED_ROWS), which is where it comes from; every word here is the
// protocol's, so neither side can reword it alone. The render fixture and the
// dialog test both draw this, so what is photographed is what a person sees.
import { GOLDEN_STAGE_WORDS, INIT_ROW_STATES, NEVER_REACHED, SIGN_IN_NEVER_REACHED, savedKeyRefusedLine, type InitRow } from "@wsp/protocol";

/** What the provider answered, as its own status and word. */
export const KEY_REFUSED_SAID = "401 Unauthorized";
export const KEY_REFUSED_LINE = savedKeyRefusedLine(KEY_REFUSED_SAID);

/** The same rows for either answer the check can stop a build with, the line the first stage carries being the one
 * the provider gave: its refusal, or what this computer saw when nothing answered. */
export const keyStoppedRows = (line: string): InitRow[] => [
  { id: "stage/creating", kind: "stage", label: GOLDEN_STAGE_WORDS.creating, state: INIT_ROW_STATES.failed, detail: line, lines: [line] },
  { id: "sign-in/claude", kind: "sign-in", tool: "claude", label: "Claude Code login", state: INIT_ROW_STATES.skipped, detail: SIGN_IN_NEVER_REACHED },
  { id: "sign-in/gh", kind: "sign-in", tool: "gh", label: "GitHub CLI login", state: INIT_ROW_STATES.skipped, detail: SIGN_IN_NEVER_REACHED },
  { id: "workspace/first", kind: "workspace", label: "first", state: INIT_ROW_STATES.skipped, detail: NEVER_REACHED },
];

export const KEY_REFUSED_ROWS: InitRow[] = keyStoppedRows(KEY_REFUSED_LINE);
