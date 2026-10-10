// SPDX-License-Identifier: AGPL-3.0-only
// A config's text as a turn reads it: the agent's own file, or a project's.
import type { TurnFile } from "../src/mcp-launch.js";

export const own = (text: string, path = "/root/.claude.json"): TurnFile => ({ path, text });
export const proj = (text: string, path = "/root/spoo-ts/.mcp.json"): TurnFile => ({ path, text });
