// SPDX-License-Identifier: AGPL-3.0-only
// The whole window while this wsp holds no project: one folder, one question,
// one key, and an agent's first reply. Nothing is sealed here, no account is
// asked for and no computer is mentioned, beyond the one quiet door under the
// button for the person who came for a box.
//
// Every state stands in a slot that is there from the first paint: the fact
// line under the fields is empty until a folder is picked, the refusal keeps
// its line whether or not it holds a sentence, and the button keeps the label
// Start and its width while a create runs, held and dimmed. Nothing on this
// screen moves as it fills.
import { useEffect, useState, type DragEvent, type KeyboardEvent } from "react";
import { madeOfWord, type InitAgent, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { FOLDER_GHOST } from "../files/FolderPathField.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { placeName } from "../settings/places.js";
import { FACT } from "../settings/format.js";
import { carriesFiles, droppedFolder } from "../sidebar/folderDrag.js";
import { FIELD_LABEL, LONE_FIELD } from "../sidebar/cloud-setup/rows.js";
import { RefusalSlot } from "../settings/sheetParts.js";
import { FIRST_RUN_WORDS } from "../sidebar/words.js";

export function FirstRun() {
  const api = useStore(s => s.api);
  const places = useStore(s => s.places);
  const addProject = useStore(s => s.addProject);
  const createWorkspace = useStore(s => s.createWorkspace);
  const openAddComputer = useStore(s => s.openAddComputer);
  const [folder, setFolder] = useState("");
  const [work, setWork] = useState("");
  const [agents, setAgents] = useState<readonly InitAgent[] | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const bridge = desktopBridge();

  // The agents on this computer, read the one way every surface reads them, so this screen and the computer's own
  // row in Settings cannot disagree about which agents are here.
  useEffect(() => {
    if (api?.initGet === undefined) return;
    let live = true;
    void api.initGet().then(
      setup => {
        if (live) setAgents(setup.agents);
      },
      () => {
        if (live) setAgents([]);
      },
    );
    return () => {
      live = false;
    };
  }, [api]);

  const noAgent = agents !== null && agents.length === 0;
  const held = api === null || folder.trim() === "" || work.trim() === "" || noAgent || starting;
  const start = async (): Promise<void> => {
    if (held) return;
    setStarting(true);
    setRefusal(null);
    try {
      // The folder is recorded first: a workspace is made of a project, and this screen is the one road that has
      // to record one before it can make the work.
      const project = await addProject(folder.trim());
      if (project === null) return;
      await createWorkspace(project.id, work.trim());
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setStarting(false);
    }
  };
  const enter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void start();
  };
  const drop = (e: DragEvent<HTMLElement>): void => {
    if (!carriesFiles(e.dataTransfer)) return;
    e.preventDefault();
    const file = droppedFolder(e.dataTransfer);
    const path = file !== null ? bridge?.droppedPath?.(file) : undefined;
    if (path !== undefined) setFolder(path);
  };
  const choose = async (): Promise<void> => {
    const picked = await bridge?.pickFolder?.();
    if (picked !== undefined) setFolder(picked);
  };
  const canChoose = bridge?.pickFolder !== undefined;

  return (
    <div data-k="first-run" className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-12">
      <div className="flex w-full max-w-sm flex-col">
        <h1 className="text-xl font-normal tracking-tight" data-k="title">
          {FIRST_RUN_WORDS.title}
        </h1>
        <div className="mt-6 flex flex-col gap-2" onDragOver={e => (carriesFiles(e.dataTransfer) ? e.preventDefault() : undefined)} onDrop={drop} data-k="folder-row">
          <label htmlFor="first-run-folder" className={FIELD_LABEL}>
            {FIRST_RUN_WORDS.folder}
          </label>
          <div className="relative w-full">
            <Input
              id="first-run-folder"
              data-k="folder"
              nativeInput
              autoFocus
              size="compact"
              autoComplete="off"
              spellCheck={false}
              placeholder={FOLDER_GHOST}
              value={folder}
              onChange={e => setFolder(e.target.value)}
              onKeyDown={enter}
              className={cn(LONE_FIELD, "min-w-0", canChoose && "[&_input]:pr-[96px]")}
            />
            {canChoose ? (
              <Button data-k="choose" size="sm" variant="outline" className="absolute top-2 right-2 h-8 font-mono text-xs sm:h-8 sm:text-xs" onClick={() => void choose()}>
                Choose
              </Button>
            ) : null}
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-2">
          <label htmlFor="first-run-work" className={FIELD_LABEL}>
            {FIRST_RUN_WORDS.work}
          </label>
          <Input
            id="first-run-work"
            data-k="work"
            nativeInput
            size="compact"
            autoComplete="off"
            placeholder={FIRST_RUN_WORDS.workGhost}
            value={work}
            onChange={e => setWork(e.target.value)}
            onKeyDown={enter}
            className={cn(LONE_FIELD, "min-w-0")}
          />
        </div>
        {/* The slot stands from the first paint and is empty until a folder is named: what this piece of work will
            be, in the words the row it becomes will carry. */}
        <span className={cn(FACT, "mt-4 min-h-4 truncate")} data-k="lands">
          {folder.trim() === "" ? "" : landsLine(places)}
        </span>
        {/* The agents line says what was found here, and its absence is the one thing that holds Start. Cut to its
            one line, with the whole of it on the line's own hover text: six agents wrapped to two lines at a
            phone's width and pushed the button down as they arrived. */}
        <span className={cn(FACT, "mt-1 min-h-4 truncate")} title={agents === null || noAgent ? undefined : agents.map(agent => agent.name).join(" · ")} data-k="agents">
          {agents === null ? "" : noAgent ? FIRST_RUN_WORDS.noAgent : agents.map(agent => agent.name).join(" · ")}
        </span>
        <div className="mt-6 flex items-center gap-3">
          <Button type="button" data-k="start" held={held} onClick={() => void start()}>
            {FIRST_RUN_WORDS.start}
          </Button>
          <Button type="button" data-k="add-computer" variant="ghost-muted" size="sm" className="font-mono text-xs" onClick={openAddComputer}>
            {FIRST_RUN_WORDS.addComputer}
          </Button>
        </div>
        <RefusalSlot k="first-run-refusal" {...(refusal === null ? {} : { said: refusal })} />
      </div>
    </div>
  );
}

/** What the first piece of work on a folder here will be, off the computer this wsp runs on and the protocol's own
 * word for the road it takes: the folder itself, which is what the runtime does with the first workspace of a
 * project on this computer today. The word comes off the landing's own road once the ruling on that default lands
 * it; nothing here spells the road out. */
export function landsLine(places: readonly PlaceView[]): string {
  const here = places[0];
  return [here === undefined ? undefined : placeName(here, true), madeOfWord("in-place")].filter((part): part is string => part !== undefined).join(" · ");
}
