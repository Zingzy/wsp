// SPDX-License-Identifier: AGPL-3.0-only
// Claude Code's access modes as the runtime's table hands them out, for the
// pages a browser draws off fake hosts (the dev shell and the prompt dock's
// harness). The one file allowed to repeat the table's sentences: the composer
// pickers test pins it to the table's current words.
export const ACCESS_MODES = [
  { value: "default", label: "Default", description: "Asks in the chat about each action that needs permission" },
  { value: "acceptEdits", label: "Accept edits", description: "Edits files without asking; asks about commands that need permission" },
  { value: "bypassPermissions", label: "Bypass", description: "Runs every action without asking" },
];
