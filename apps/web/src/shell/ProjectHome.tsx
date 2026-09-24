// SPDX-License-Identifier: AGPL-3.0-only
// A project's home: the new-thread screen with no workspace under it yet. The
// task typed here names the workspace the send makes, and the message is queued
// on that workspace's fresh thread, which sends it the moment the copy stands,
// so a person types once and lands in the running thread.
import { ArrowUpIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { EmptyThread } from "../components/chat/ChatView.js";
import { ComposerSurface } from "../components/chat/ComposerSurface.js";
import { useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";

/** The workspace's name off the task: its first line, cut at a few words, since the row has room for little more. */
export function nameOfTask(task: string): string {
  const words = task.trim().split("\n")[0]!.split(/\s+/).filter(Boolean);
  return words.slice(0, 5).join(" ").slice(0, 40);
}

export function ProjectHome({ projectId }: { projectId: string }) {
  const project = useStore(s => s.projects.find(p => p.id === projectId));
  const createWorkspace = useStore(s => s.createWorkspace);
  const enqueue = useComposerDraftStore(s => s.enqueue);
  const [task, setTask] = useState("");
  const [sending, setSending] = useState(false);
  if (project === undefined) return null;

  const send = async (): Promise<void> => {
    const prompt = task.trim();
    if (prompt === "" || sending) return;
    setSending(true);
    const workspaceId = await createWorkspace(project.id, nameOfTask(prompt));
    if (workspaceId !== null) enqueue(workspaceId, prompt);
    else setSending(false);
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send();
  };

  return (
    <div data-k="project-home" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        <EmptyThread workspaceName={project.name} />
      </div>
      <div className="px-4 pb-4">
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <form
              className="w-full"
              onSubmit={event => {
                event.preventDefault();
                void send();
              }}
            >
              <ComposerSurface.Main>
                <div className="flex flex-col gap-2 rounded-[20px] p-3 sm:px-4">
                  <textarea
                    data-k="project-task"
                    autoFocus
                    rows={3}
                    value={task}
                    disabled={sending}
                    onChange={e => setTask(e.target.value)}
                    onKeyDown={keys}
                    placeholder="Ask anything"
                    className="w-full resize-none bg-transparent text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/70"
                  />
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      aria-label="Send"
                      disabled={task.trim() === "" || sending}
                      className={cn("flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity duration-150 disabled:opacity-40")}
                    >
                      <ArrowUpIcon className="size-4" aria-hidden />
                    </button>
                  </div>
                </div>
              </ComposerSurface.Main>
            </form>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}
