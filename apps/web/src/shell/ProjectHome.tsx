// SPDX-License-Identifier: AGPL-3.0-only
// A project's home: New thread with no workspace under it yet, the same
// composer included, the project the one choice on it. The task typed here names the workspace the send makes;
// the picks made here move to that workspace and the message is queued on its
// fresh thread, which sends it the moment the copy stands, so a person types once
// and lands in the running thread; the store keeps the message through a reload
// until then. A send to several models makes one copy per
// model, and the store starts the thread in each the moment it stands, all under
// one attempt id, since a queue drains only in a composer on screen and one copy
// at most is on screen; the computer's free room is read first, and a send it
// has no room for is refused before any copy is made.
import { HERE_PLACE_ID, START_WORDS, githubLinkOf, placeRoom, plural, projectForRepo, type ProjectView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { RefusalSlot } from "../settings/sheetParts.js";
import { EmptyThread } from "../components/chat/ChatView.js";
import { HeroField } from "../components/chat/EmptyHero.js";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { newId, useComposerDraft, useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { attachmentOf, useComposerFilesStore } from "../components/chat/composerFiles.js";
import { useMultiPickStore, type ModelPick } from "../components/chat/composerMultiPick.js";
import { useComposerOptions, useComposerOptionsStore } from "../components/chat/composerOptionsStore.js";
import { startOptionsFrom } from "../components/chat/composerPicks.js";
import { useChatThread } from "../components/chat/useChatThread.js";
import { noticeFailure } from "../notices/store.js";
import { HomeProjectPicker, WhereItRuns } from "./NewThreadPicks.js";
import type { Api } from "../protocol/client.js";
import { projectHomeKey, useHarnessCatalogs, useStore } from "../protocol/store.js";

/** The workspace's name off the task: its first line, cut at a few words, since the row has room for little more. */
export function nameOfTask(task: string): string {
  const words = task.trim().split("\n")[0]!.split(/\s+/).filter(Boolean);
  return words.slice(0, 5).join(" ").slice(0, 40);
}

/** The line a send to more models than the computer has room for is refused with. */
export function noRoomLine(where: string, free: number, noun: string, asked: number): string {
  return `${where} has room for ${plural(free, `more ${noun}`)} now, and this send needs ${asked}`;
}

/** Why a send to `asked` models is refused before any copy is made, or null when the computer the project lands on
 * takes them all: the room its cap leaves, and the room for forks where it makes them. */
async function roomRefusal(api: Api, project: ProjectView, asked: number): Promise<string | null> {
  if (api.workspacesLanding === undefined || api.placesList === undefined) return null;
  try {
    const landing = await api.workspacesLanding(project.id);
    const { places } = await api.placesList();
    const place = places.find(p => p.id === (landing.place ?? HERE_PLACE_ID));
    if (place === undefined) return null;
    const cap = placeRoom(place);
    const free = Math.min(cap?.room ?? Infinity, place.forks?.room ?? Infinity);
    return asked > free ? noRoomLine(landing.name, free, cap?.noun ?? "workspace", asked) : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function ProjectHome({ projectId }: { projectId: string }) {
  const project = useStore(s => s.projects.find(p => p.id === projectId));
  const createWorkspace = useStore(s => s.createWorkspace);
  const key = projectHomeKey(projectId);
  const thread = useChatThread(key, null, true);
  const catalogs = useHarnessCatalogs(key);
  const picked = useComposerOptions(key);
  // A link in the box names a project of its own, whichever home it was typed in: the send starts on that project.
  const link = githubLinkOf(useComposerDraft(key).prompt);
  const linked = useStore(s => (link === undefined ? undefined : projectForRepo(s.projects, link.repo, HERE_PLACE_ID)));
  if (project === undefined) return null;

  /** A start or a review off the link, through the host, which opens the thread it made. */
  const fromLink = async (url: string, kind: "start" | "review"): Promise<string | null> => {
    const { api, select, preferences } = useStore.getState();
    const go = kind === "start" ? api?.start : api?.review;
    if (go === undefined) return null;
    const access = preferences.access[key];
    try {
      const made = await go({
        url,
        ...(kind === "start" && picked.harness !== undefined ? { agent: picked.harness } : {}),
        ...(picked.model !== undefined && kind === "start" ? { model: picked.model } : {}),
        ...(picked.effort !== undefined ? { effort: picked.effort } : {}),
        ...(kind === "start" && access !== undefined && access !== null ? { access } : {}),
      });
      useComposerDraftStore.getState().setDraft(key, { prompt: "", cursor: 0 });
      useComposerOptionsStore.getState().drop(key, key);
      select(made.workspace.id, made.threadId);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  const start = async (prompt: string): Promise<string | null> => {
    const asked = githubLinkOf(prompt);
    if (asked !== undefined) return fromLink(asked.url, "start");
    const picks = useMultiPickStore.getState().byKey[key];
    if (picks !== undefined) return startSeveral(prompt, picks);
    await createWorkspace(project.id, nameOfTask(prompt), undefined, { prompt, queuedFrom: key });
    return null;
  };

  const startSeveral = async (prompt: string, picks: ReadonlyArray<ModelPick>): Promise<string | null> => {
    const { api } = useStore.getState();
    if (api === null) return null;
    const refused = await roomRefusal(api, project, picks.length);
    if (refused !== null) return refused;
    const attempt = newId();
    const attachments = (useComposerFilesStore.getState().pending[key] ?? []).map(attachmentOf);
    useComposerFilesStore.getState().sendAs(key, attempt);
    useMultiPickStore.getState().set(key, []);
    await Promise.all(
      picks.map(pick => {
        const catalog = catalogs.find(c => c.harness === pick.harness);
        const own = { harness: pick.harness, model: pick.model };
        const options = catalog === undefined ? own : startOptionsFrom(catalog, { ...picked, ...own });
        return createWorkspace(project.id, `${nameOfTask(prompt)} (${pick.label})`, undefined, { prompt, opens: { ...options, harness: pick.harness, attempt }, ...(attachments.length > 0 ? { attachments } : {}) });
      }),
    );
    useComposerOptionsStore.getState().drop(key, key);
    return null;
  };

  return (
    <div data-k="project-home" data-chat-view className="relative isolate flex min-h-0 flex-1 flex-col justify-center gap-10 pb-[8vh]">
      <HeroField />
      <EmptyThread name={project.name} projectId={project.id} picker={<HomeProjectPicker project={project} />} />
      <ChatComposer
        key={key}
        workspaceId={key}
        thread={thread}
        onStart={start}
        where={<WhereItRuns project={project} />}
        {...(link !== undefined && linked !== undefined ? { sendLabel: START_WORDS.startOn(link.number) } : {})}
        {...(link?.kind === "pull_request" && linked !== undefined
          ? {
              beside: (
                <Button type="button" variant="outline" data-k="start-review" onClick={() => void fromLink(link.url, "review").then(said => (said === null ? undefined : noticeFailure(new Error(said))))}>
                  {START_WORDS.review(link.number)}
                </Button>
              ),
            }
          : {})}
        {...(link !== undefined && linked === undefined ? { under: <RefusalSlot k="start-refusal" said={START_WORDS.noProjectForRepo(link.repo)} /> } : {})}
      />
    </div>
  );
}
