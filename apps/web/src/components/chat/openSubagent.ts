// SPDX-License-Identifier: AGPL-3.0-only
// The fold of the subagent whose page is open, as the page read it off its lead's transcript. The header's crumb
// stands outside the page, and names from it a subagent its lead's listing does not carry.
import { create } from "zustand";
import type { SubagentRun } from "../../adapt/index.js";

export const useOpenSubagentRun = create<{ run: SubagentRun | null }>(() => ({ run: null }));
