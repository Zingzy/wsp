// SPDX-License-Identifier: AGPL-3.0-only
// Opens a thread's copy in an editor on the computer the host runs on: the
// default, or the one just picked, which becomes the default first so the
// host opens in it. A workspace whose files are on another machine asks the
// host nothing; its header already says where they are.
import { isLocalWorkspace, type EditorId } from "@wsp/protocol";
import { noticeFailure } from "../notices/store.js";
import { useStore } from "../protocol/store.js";
import { projectFolderOf } from "./root.js";

export async function openCopyInEditor(workspaceId: string, pick?: EditorId): Promise<void> {
  const { api, workspaces, setPreferences } = useStore.getState();
  const workspace = workspaces.find(w => w.id === workspaceId);
  if (api?.openInEditor === undefined || workspace === undefined || !isLocalWorkspace(workspace)) return;
  if (pick !== undefined) await setPreferences({ editor: pick });
  try {
    await api.openInEditor(workspaceId, projectFolderOf(workspace));
  } catch (e) {
    noticeFailure(e);
  }
}
