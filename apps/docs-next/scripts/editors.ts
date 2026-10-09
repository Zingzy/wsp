// SPDX-License-Identifier: AGPL-3.0-only
// The two editor tables on the Open in your editor page: every editor the host opens a file in, in the picker's
// order, with whether it opens a workspace on another computer over ssh, and the line that installs each one's
// Remote SSH extension.
import { EditorId } from "../../../packages/protocol/src/views/preferences.js";
import { EDITORS } from "../../../packages/host/src/editor.js";
import { table, within, type Generated } from "./generated.js";

export default function editors(): Generated[] {
  const missing = EditorId.options.filter(id => !EDITORS.some(e => e.id === id));
  if (missing.length > 0) throw new Error(`no row in EDITORS for ${missing.join(", ")}`);
  const over = EDITORS.map(e => [e.name, e.remote === undefined ? "No" : e.remoteExtension === undefined ? "Yes" : "Yes, with the Remote SSH extension"]);
  const installs = EDITORS.flatMap(e => (e.remoteExtension === undefined ? [] : [[e.name, `\`${e.remoteExtension.cli} --install-extension ${e.remoteExtension.ids[0]}\``]]));
  return [
    within("content/features/editor.mdx", {
      editors: table(["Editor", "Over ssh"], over),
      "editor-extensions": table(["Editor", "Command that installs the extension"], installs),
    }),
  ];
}
