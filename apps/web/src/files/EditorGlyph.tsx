// SPDX-License-Identifier: AGPL-3.0-only
// An editor's mark as the catalog carries it, the one drawing the Open menu and
// Settings' editor pick both show.
import { editorMark } from "@wsp/catalog";
import type { EditorId } from "@wsp/protocol";
import { MarkSvg } from "../components/chat/HarnessMark.js";

export function EditorGlyph({ id }: { id: EditorId }) {
  const mark = editorMark(id);
  return mark === undefined ? <span className="size-4 shrink-0" /> : <MarkSvg mark={mark} data-editor-mark={id} className="size-4" />;
}
