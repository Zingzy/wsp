// SPDX-License-Identifier: AGPL-3.0-only
import { CURSOR_AGENT } from "../../agents/cursor.js";
import type { EditorMark } from "../editor.js";

/** The editor wears the mark its maker's agent does. */
export const CURSOR: EditorMark = { ...CURSOR_AGENT.mark!, id: "cursor", editors: ["cursor"] };
