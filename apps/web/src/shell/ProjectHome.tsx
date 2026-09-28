// SPDX-License-Identifier: AGPL-3.0-only
// A project's home: the new-thread screen with no workspace under it yet, the
// same composer included. The task typed here names the workspace the send makes;
// the picks made here move to that workspace and the message is queued on its
// fresh thread, which sends it the moment the copy stands, so a person types once
// and lands in the running thread. A send to several models makes one copy per
// model and starts the thread in each at once, all under one attempt id, since a
// queue drains only in a composer on screen and one copy at most is on screen;
// the computer's free room is read first, and a send it has no room for is
// refused before any copy is made.
import { HERE_PLACE_ID, kindForComputer, placeRoom, plural, workspaceAccess, type ProjectView } from "@wsp/protocol";
import { EmptyThread } from "../components/chat/ChatView.js";
import { HeroAtmosphere } from "../components/chat/EmptyHero.js";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { newId, useComposerDraftStore } from "../components/chat/composerDraftStore.js";
import { attachmentOf, useComposerFilesStore } from "../components/chat/composerFiles.js";
import { useMultiPickStore, type ModelPick } from "../components/chat/composerMultiPick.js";
import { useComposerOptions, useComposerOptionsStore } from "../components/chat/composerOptionsStore.js";
import { startOptionsFrom } from "../components/chat/composerPicks.js";
import { useChatThread } from "../components/chat/useChatThread.js";
import { noticeFailure } from "../notices/store.js";
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
  if (project === undefined) return null;

  const start = async (prompt: string): Promise<string | null> => {
    const picks = useMultiPickStore.getState().byKey[key];
    if (picks !== undefined) return startSeveral(prompt, picks);
    const workspaceId = await createWorkspace(project.id, nameOfTask(prompt));
    if (workspaceId === null) return null;
    useComposerOptionsStore.setState(s => {
      const picked = s.byWorkspaceId[key];
      return picked === undefined ? s : { byWorkspaceId: { ...s.byWorkspaceId, [workspaceId]: picked } };
    });
    const access = useStore.getState().preferences.access[key];
    if (access !== undefined) void useStore.getState().setPreferences({ access: { [workspaceId]: access, [key]: null } });
    useComposerDraftStore.getState().enqueue(workspaceId, prompt);
    return null;
  };

  const startSeveral = async (prompt: string, picks: ReadonlyArray<ModelPick>): Promise<string | null> => {
    const { api, launching, launched } = useStore.getState();
    if (api === null) return null;
    const refused = await roomRefusal(api, project, picks.length);
    if (refused !== null) return refused;
    const attempt = newId();
    const attachments = (useComposerFilesStore.getState().pending[key] ?? []).map(attachmentOf);
    useComposerFilesStore.getState().sendAs(key, attempt);
    useMultiPickStore.getState().set(key, []);
    const kind = kindForComputer(project.computer);
    await Promise.all(
      picks.map(async pick => {
        const name = `${nameOfTask(prompt)} (${pick.label})`;
        const workspaceId = await createWorkspace(project.id, name);
        if (workspaceId === null) return;
        const catalog = catalogs.find(c => c.harness === pick.harness);
        const own = { harness: pick.harness, model: pick.model };
        const options = catalog === undefined ? own : startOptionsFrom(workspaceAccess(catalog, kind), { ...picked, ...own });
        const requestId = newId();
        launching(workspaceId, { requestId, title: prompt, harness: pick.harness });
        await api.startSession({ workspaceId, prompt, requestId, attempt, ...options, ...(attachments.length > 0 ? { attachments } : {}) }).catch((e: unknown) => {
          launched(workspaceId, requestId);
          noticeFailure(e, said => `${name}: ${said}`);
        });
      }),
    );
    return null;
  };

  return (
    <div data-k="project-home" className="relative isolate flex min-h-0 flex-1 flex-col justify-center gap-10 pb-[8vh]">
      <HeroAtmosphere projectId={project.id} />
      <EmptyThread workspaceName={project.name} projectId={project.id} />
      <ChatComposer key={key} workspaceId={key} thread={thread} onStart={start} />
    </div>
  );
}
