// SPDX-License-Identifier: AGPL-3.0-only
// A project's home: the new-thread screen with no workspace under it yet, the
// same composer included. The task typed here names the workspace the send makes;
// the picks made here move to that workspace and the message is queued on its
// fresh thread, which sends it the moment the copy stands, so a person types once
// and lands in the running thread.
import { EmptyThread } from "../components/chat/ChatView.js";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { useComposerOptionsStore } from "../components/chat/composerOptionsStore.js";
import { useChatThread } from "../components/chat/useChatThread.js";
import { useStore } from "../protocol/store.js";

/** The workspace's name off the task: its first line, cut at a few words, since the row has room for little more. */
export function nameOfTask(task: string): string {
  const words = task.trim().split("\n")[0]!.split(/\s+/).filter(Boolean);
  return words.slice(0, 5).join(" ").slice(0, 40);
}

/** The key the home's composer keeps its draft and picks under until a workspace exists to hold them. */
const homeKey = (projectId: string): string => `project:${projectId}`;

export function ProjectHome({ projectId }: { projectId: string }) {
  const project = useStore(s => s.projects.find(p => p.id === projectId));
  const createWorkspace = useStore(s => s.createWorkspace);
  const key = homeKey(projectId);
  const thread = useChatThread(key, null, true);
  if (project === undefined) return null;

  const start = async (prompt: string): Promise<void> => {
    const workspaceId = await createWorkspace(project.id, nameOfTask(prompt));
    if (workspaceId === null) return;
    useComposerOptionsStore.setState(s => {
      const picked = s.byWorkspaceId[key];
      return picked === undefined ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: picked } };
    });
    useComposerDraftStore.getState().enqueue(workspaceId, prompt);
  };

  return (
    <div data-k="project-home" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <EmptyThread workspaceName={project.name} />
      </div>
      <ChatComposer key={key} workspaceId={key} thread={thread} onStart={prompt => void start(prompt)} />
    </div>
  );
}
