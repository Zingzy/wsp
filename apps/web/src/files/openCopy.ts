// SPDX-License-Identifier: AGPL-3.0-only
// Opens a thread's copy in an editor on the computer the host runs on: the
// default, or the one just picked, which becomes the default first so the
// host opens in it. A running workspace on another computer opens there over
// ssh, in the editor named or the host's default; the host's refusal for want
// of the line in the person's ssh config raises the one question, and a yes
// runs the same open again. A napping one asks the host nothing.
import { isLocalWorkspace, SSH_BEHIND_KIND, type EditorId, type WorkspaceView } from "@wsp/protocol";
import { addNotice, noticeFailure } from "../notices/store.js";
import { RequestError } from "../protocol/client.js";
import { useStore } from "../protocol/store.js";
import { useSshConsent } from "./EditorConsent.js";
import { projectFolderOf } from "./root.js";

/** Whether an Open is waiting on the workspace's computer to update its wsp, which is a wait and not a failure. */
export const waitsForUpdate = (e: unknown): e is RequestError => e instanceof RequestError && e.kind === SSH_BEHIND_KIND;

/** An Open that did not happen, said as a wait where it waits for an update and as the host's refusal otherwise. */
export function openFailed(e: unknown): void {
  if (waitsForUpdate(e)) addNotice({ kind: "waiting", text: e.message });
  else noticeFailure(e);
}

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
      useSshConsent.setState({ asking: { workspaceId, run } });
      return;
    }
    openFailed(e);
  }
}
