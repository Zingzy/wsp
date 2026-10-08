// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { onComposerFocusRequest } from "../../shell/shellRequests";

/** Takes the workspace's focus requests into its composer's editor. The focus waits for the render the request
 * came with: a road writes the draft and asks for focus on one tick, and the editor's focus reports the text it
 * holds, which before that render is the old text and would land back on the draft. */
export function useComposerFocusRequest(workspaceId: string, editorRef: RefObject<ComposerPromptEditorHandle | null>): void {
  const [asked, setAsked] = useState(0);
  useEffect(() => onComposerFocusRequest(workspaceId, () => setAsked(n => n + 1)), [workspaceId]);
  useLayoutEffect(() => {
    if (asked > 0) editorRef.current?.focus();
  }, [asked, editorRef]);
}
