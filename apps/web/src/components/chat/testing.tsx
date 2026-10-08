// SPDX-License-Identifier: AGPL-3.0-only
// The real prompt editor wired to a workspace's draft and focus requests the way ChatComposer wires it, for tests of
// the roads that write into the composer from outside it.
import { useCallback, useRef } from "react";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { useComposerDraft, useComposerDraftStore } from "./composerDraftStore";
import { useComposerFocusRequest } from "./composerFocus";

export function MountedComposer({ workspaceId }: { workspaceId: string }) {
  const draft = useComposerDraft(workspaceId);
  const setDraft = useComposerDraftStore(s => s.setDraft);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  useComposerFocusRequest(workspaceId, editorRef);
  const onChange = useCallback((value: string, cursor: number) => setDraft(workspaceId, { prompt: value, cursor }), [setDraft, workspaceId]);
  return <ComposerPromptEditor editorRef={editorRef} value={draft.prompt} cursor={draft.cursor} disabled={false} placeholder="Ask" onChange={onChange} />;
}
