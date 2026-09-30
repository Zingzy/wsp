// SPDX-License-Identifier: AGPL-3.0-only
// Opens a thread's copy in an editor on the computer the host runs on: the
// default, or the one just picked, which becomes the default first so the
// host opens in it. A running workspace on another computer opens there over
// ssh, in the editor named or the host's default; the host's refusal for want
// of the line in the person's ssh config raises the one question, and a yes
// runs the same open again. A napping one asks the host nothing.
import { isLocalWorkspace, type EditorId, type WorkspaceView } from "@wsp/protocol";
import { noticeFailure } from "../notices/store.js";
import { RequestError } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { useSshConsent } from "./EditorConsent.js";
import { projectFolderOf } from "./root.js";

/** Whether Open has anywhere to open this workspace: its folder here, or its machine running. */
export const opensInEditor = (workspace: Pick<WorkspaceView, "kind" | "phase">): boolean => isLocalWorkspace(workspace) || workspace.phase === "running";

/** `editor` opens a workspace on another computer in that editor without making it the default: the default may be
 * one with no road there. */
export async function openCopyInEditor(workspaceId: string, pick?: EditorId, editor?: EditorId): Promise<void> {
  const { api, workspaces, setPreferences } = useStore.getState();
  const workspace = workspaces.find(w => w.id === workspaceId);
  const open = api?.openInEditor;
  if (open === undefined || workspace === undefined || !opensInEditor(workspace)) return;
  if (pick !== undefined) await setPreferences({ editor: pick });
  const named = isLocalWorkspace(workspace) ? undefined : (pick ?? editor);
  const run = async (): Promise<void> => {
    await (named === undefined ? open(workspaceId, projectFolderOf(workspace)) : open(workspaceId, projectFolderOf(workspace), undefined, named));
  };
  try {
    await run();
  } catch (e) {
    if (e instanceof RequestError && e.kind === "sshInclude") {
      useSshConsent.setState({ asking: { workspaceId, name: workspace.name, run } });
      return;
    }
    noticeFailure(e);
  }
}
