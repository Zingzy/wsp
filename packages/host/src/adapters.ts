// SPDX-License-Identifier: AGPL-3.0-only
// One adapter factory per agent wsp can drive, keyed by catalog id. Adding an
// agent is its id in THREAD_AGENTS and its factory here; the type ties the two
// together.
import { CLAUDE_CONFIG_DIR } from "@wsp/catalog";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { machineExecStream, type HarnessAdapterFactory } from "@wsp/runtime";
import type { ThreadAgent } from "./thread-agents.js";

export const HARNESS_ADAPTERS: Readonly<Record<ThreadAgent, HarnessAdapterFactory>> = {
  claude: ctx => createClaudeAdapter({ exec: machineExecStream(ctx.machine), configDir: CLAUDE_CONFIG_DIR }),
};
