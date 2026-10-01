// SPDX-License-Identifier: AGPL-3.0-only
// Add a project: a project is a git repo on one computer, so the dialog opens on
// the repos the chosen computer holds, most recently used first, and the field
// searches all of them by name and path. A path typed from / or ~ walks the disk
// instead. A repository address is cloned by the computer picked: a box or a
// provider clones where it keeps its checkouts, and the host's own computer into
// an empty folder the person names, which is then a folder project like any
// other. owner/repo reads as a search here until no repo matches it. The list
// keeps one height across every state, so nothing around it moves.
import { CloudIcon, FolderGitIcon, FolderIcon, FolderOpenIcon, GitBranchIcon, LaptopIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { HERE_PLACE_ID, projectNameOf, projectSourceOf, sourceKind, type HostFolder, type HostFolderListing, type PlaceView, type ProjectHue, type ProjectIcon } from "@wsp/protocol";
import { HueSelect, IconSelect } from "../projects/LookPicker.js";
import { AddButton } from "../components/ui/add-button.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Kbd } from "../components/ui/kbd.js";
import { baseName } from "../files/entries.js";
import { desktopBridge } from "../lib/desktopShell.js";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { isProviderPlace, placeName, placeTakesWorkspaces } from "../settings/places.js";
import { ADD_PROJECT_WORDS } from "./words.js";

/** How the field names a repository: by its address, which nothing else looks like, as owner/repo, which a search
 * of paths can look like too, or not at all. */
function repositoryWord(word: string): "address" | "short" | null {
  try {
    const kind = sourceKind(word.trim());
    if (kind === "git" || ((kind === "github" || kind === "gitlab") && word.includes(".com/"))) return "address";
    return kind === "github" ? "short" : null;
  } catch {
    return null;
  }
}

/** What a repository word would be called as a project, for the example under the folder field. */
function repoName(word: string): string {
  try {
    const kind = sourceKind(word);
    return kind === "folder" || kind === "computer" ? "repo" : projectNameOf(projectSourceOf(word, kind));
  } catch {
    return "repo";
  }
}

/** A typed path split into the folder to list and the start of the name being typed in it. */
function pathParts(typed: string, home: string): { dir: string; stem: string } {
  const full = typed.startsWith("~") ? `${home}${typed.slice(1)}` : typed;
  const cut = full.lastIndexOf("/");
  return { dir: full.slice(0, cut) || "/", stem: full.slice(cut + 1).toLowerCase() };
}

const tilde = (path: string, home: string): string => (home !== "" && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

const PANE_ROW = "flex h-10 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-sm outline-none transition-colors duration-150";
const SIDE_ROW = "flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm outline-none transition-colors duration-150";

function Hint({ keys, word }: { keys: string; word: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Kbd>{keys}</Kbd>
      {word}
    </span>
  );
}

export function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const addProject = useStore(s => s.addProject);
  const setPreferences = useStore(s => s.setPreferences);
  const [icon, setIcon] = useState<ProjectIcon>("folder");
  const [hue, setHue] = useState<ProjectHue>("neutral");
  const browse = useStore(s => s.api?.hostFolders);
  const places = useStore(s => s.places);
  const openAddComputer = useStore(s => s.openAddComputer);
  const recorded = useStore(s => s.projects);
  const bridge = desktopBridge();
  const computers = useMemo(() => places.filter((place, at) => at === 0 || placeTakesWorkspaces(place)), [places]);
  const [on, setOn] = useState<string>(computers[0]?.id ?? HERE_PLACE_ID);
  const computer = computers.find(place => place.id === on) ?? computers[0];
  const here = computer === undefined || computer === computers[0];
  const [field, setField] = useState("");
  const [repos, setRepos] = useState<HostFolderListing | null>(null);
  const [level, setLevel] = useState<HostFolderListing | null>(null);
  const [lit, setLit] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [cloneTo, setCloneTo] = useState("");

  const home = repos?.dir ?? "";
  const repoShape = repositoryWord(field);
  const query = field.trim().toLowerCase();
  const searched = useMemo(() => (repos?.folders ?? []).filter(f => query === "" || f.path.toLowerCase().includes(query)), [repos, query]);
  const repoWord = repoShape === "address" || (repoShape === "short" && (!here || searched.length === 0));
  const typingPath = !repoWord && (field.startsWith("/") || field.startsWith("~"));
  const path = typingPath ? pathParts(field, home) : null;

  // The repos are read once per open: a scan of the home folder, tens of milliseconds on a warm disk.
  useEffect(() => {
    if (!here || browse === undefined) return;
    let live = true;
    void browse(undefined, false, true).then(
      next => live && setRepos(next),
      e => live && setRefusal(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [browse, here]);

  // A typed path lists the folder it names, one level, as the person types into it.
  const levelDir = path?.dir;
  useEffect(() => {
    if (levelDir === undefined || browse === undefined) return;
    let live = true;
    void browse(levelDir).then(
      next => {
        if (!live) return;
        setLevel(next);
        setRefusal(null);
      },
      e => live && setRefusal(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [browse, levelDir]);

  const rows: readonly HostFolder[] = useMemo(() => {
    if (!here || repoWord) return [];
    if (path !== null) return level?.dir === path.dir ? level.folders.filter(f => baseName(f.path).toLowerCase().startsWith(path.stem)) : [];
    return searched;
  }, [here, repoWord, path?.dir, path?.stem, level, searched]);
  useEffect(() => setLit(0), [field, on]);
  const litRow = rows[lit];
  // A repo already recorded on this computer is shown, so the list matches the disk, but is not added twice.
  const added = useMemo(() => new Set(recorded.filter(p => p.computer === undefined || p.computer === HERE_PLACE_ID).map(p => p.path)), [recorded]);
  const addable = (row: HostFolder | undefined): boolean => row?.repo === true && !added.has(row.path);

  const add = async (source: string, into?: string): Promise<void> => {
    if (adding) return;
    setAdding(true);
    setRefusal(null);
    try {
      const project = await addProject(source, here ? undefined : computer?.id, into);
      if (project !== null && (icon !== "folder" || hue !== "neutral")) void setPreferences({ projectLook: { [project.id]: { icon, hue } } });
      onClose();
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setAdding(false);
    }
  };
  const into = (folder: HostFolder): void => setField(`${tilde(folder.path, home)}/`);
  const choose = async (): Promise<void> => {
    const picked = await bridge?.pickFolder?.();
    if (picked !== undefined) await add(picked);
  };
  const clones = !here && repoWord;
  // The folder a repo is cloned into here is one the host can read as it stands: from the root or the home.
  const clonesHere = here && repoWord;
  const cloneFolder = cloneTo.trim();
  const cloneReady = clonesHere && (cloneFolder.startsWith("/") || cloneFolder.startsWith("~"));
  const pickCloneFolder = async (): Promise<void> => {
    const picked = await bridge?.pickFolder?.();
    if (picked !== undefined) setCloneTo(picked);
  };
  const target = clones || cloneReady ? field.trim() : addable(litRow) ? litRow!.path : null;
  const addTarget = (): void => {
    if (target !== null) void add(target, cloneReady ? cloneFolder : undefined);
  };

  const keys = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setLit(at => Math.min(at + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setLit(at => Math.max(at - 1, 0));
    } else if (e.key === "Tab" && litRow !== undefined) {
      e.preventDefault();
      if (typingPath) into(litRow);
      else setField(tilde(litRow.path, home));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (target !== null) return addTarget();
      if (typingPath && litRow !== undefined) into(litRow);
    }
  };

  const say = (words: string) => <p className="px-3 pt-3 text-sm text-muted-foreground">{words}</p>;
  const listBody = (() => {
    if (clones) {
      return (
        <button type="button" data-k="clone" className={cn(PANE_ROW, "bg-accent text-foreground")} onClick={() => void add(field.trim())}>
          <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{ADD_PROJECT_WORDS.cloneLine(field.trim(), computer === undefined ? "" : placeName(computer))}</span>
        </button>
      );
    }
    if (!here) return say(computer !== undefined && isProviderPlace(computer) ? ADD_PROJECT_WORDS.providerSays(placeName(computer)) : ADD_PROJECT_WORDS.boxSays(computer === undefined ? "" : placeName(computer)));
    if (clonesHere) {
      return (
        <div data-k="clone-into" className={cn(PANE_ROW, "h-auto flex-col items-stretch gap-2 bg-accent py-3 text-foreground")}>
          <span className="flex min-w-0 items-center gap-3">
            <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{ADD_PROJECT_WORDS.cloneInto(field.trim())}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 ps-7">
            <input
              data-k="clone-into-folder"
              autoComplete="off"
              spellCheck={false}
              value={cloneTo}
              disabled={adding}
              placeholder={ADD_PROJECT_WORDS.cloneIntoPlaceholder(repoName(field.trim()))}
              onChange={e => {
                setCloneTo(e.target.value);
                setRefusal(null);
              }}
              onKeyDown={e => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addTarget();
              }}
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 font-mono text-xs outline-none placeholder:font-sans placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {bridge?.pickFolder !== undefined ? (
              <Button variant="outline" data-k="clone-into-choose" onClick={() => void pickCloneFolder()}>
                <FolderOpenIcon aria-hidden />
                {ADD_PROJECT_WORDS.choose}
              </Button>
            ) : null}
          </span>
        </div>
      );
    }
    if (repos === null && path === null) return null;
    if (rows.length === 0) return say(path !== null ? ADD_PROJECT_WORDS.noFolders : field.trim() === "" ? ADD_PROJECT_WORDS.noRepos : ADD_PROJECT_WORDS.noMatch);
    return rows.map((row, at) => (
      <button
        key={row.path}
        type="button"
        data-k="folder-row"
        data-repo={row.repo ? "" : undefined}
        className={cn(PANE_ROW, at === lit ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/60", added.has(row.path) && "cursor-default text-muted-foreground")}
        onMouseEnter={() => setLit(at)}
        onClick={() => (addable(row) ? void add(row.path) : row.repo ? undefined : into(row))}
        aria-disabled={added.has(row.path) || undefined}
      >
        {row.repo ? <FolderGitIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 truncate">{baseName(row.path)}</span>
        {path === null ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{tilde(row.path, home)}</span> : <span className="flex-1" />}
        {added.has(row.path) ? (
          <span className="shrink-0 text-xs text-muted-foreground">{ADD_PROJECT_WORDS.added}</span>
        ) : row.branch !== undefined ? (
          <span className="max-w-40 shrink-0 truncate font-mono text-xs text-muted-foreground">{row.branch}</span>
        ) : null}
      </button>
    ));
  })();

  const glyphOf = (place: PlaceView, at: number) => (at === 0 ? LaptopIcon : isProviderPlace(place) ? CloudIcon : ServerIcon);

  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup className="gap-0 overflow-hidden p-0 sm:max-w-3xl" data-k="add-project">
        <DialogTitle className="sr-only">{ADD_PROJECT_WORDS.title}</DialogTitle>
        <div className="flex h-14 items-center gap-3 border-b border-border px-4">
          <input
            data-k="source"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={field}
            disabled={adding}
            placeholder={here ? ADD_PROJECT_WORDS.search : ADD_PROJECT_WORDS.addressOnly}
            onChange={e => {
              setField(e.target.value);
              setRefusal(null);
            }}
            onKeyDown={keys}
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {here && bridge?.pickFolder !== undefined ? (
            <Button variant="outline" data-k="choose" onClick={() => void choose()}>
              <FolderOpenIcon aria-hidden />
              {ADD_PROJECT_WORDS.choose}
            </Button>
          ) : null}
          <AddButton primary data-k="add" busy={adding} held={target === null || adding} onClick={addTarget}>
            {ADD_PROJECT_WORDS.add}
          </AddButton>
          <Kbd>esc</Kbd>
        </div>
        <div className="grid h-[400px] grid-cols-[minmax(0,1fr)_210px] max-sm:grid-cols-1">
          <div className="flex min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center px-5 text-muted-foreground">
              {path !== null ? <span className="truncate font-mono text-xs">{tilde(path.dir, home)}</span> : here ? <span className={cn(GROUP_LABEL, "truncate")}>{ADD_PROJECT_WORDS.reposOn(computer === undefined ? "" : placeName(computer))}</span> : null}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{listBody}</div>
          </div>
          <aside className="flex min-h-0 flex-col overflow-y-auto p-2 pt-0 max-sm:hidden">
            <span className={cn(GROUP_LABEL, "flex h-10 shrink-0 items-center px-2.5 text-muted-foreground")}>{ADD_PROJECT_WORDS.computers}</span>
            {computers.map((place, at) => {
              const Glyph = glyphOf(place, at);
              return (
                <button key={place.id} type="button" data-k={`computer-${place.id}`} onClick={() => setOn(place.id)} className={cn(SIDE_ROW, place.id === computer?.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
                  <Glyph aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{placeName(place)}</span>
                </button>
              );
            })}
            <button type="button" data-k="add-computer" onClick={() => { onClose(); openAddComputer(); }} className={cn(SIDE_ROW, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
              <PlusIcon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{ADD_PROJECT_WORDS.addComputer}</span>
            </button>
            <span className={cn(GROUP_LABEL, "mt-4 flex h-10 shrink-0 items-center px-2.5 text-muted-foreground")}>{ADD_PROJECT_WORDS.look}</span>
            <div className="flex flex-col gap-2 px-2.5" data-k="new-project-look">
              <IconSelect icon={icon} hue={hue} onChange={setIcon} className="w-full" />
              <HueSelect hue={hue} onChange={setHue} className="w-full" />
            </div>
          </aside>
        </div>
        <div className="flex h-11 items-center gap-4 px-4">
          {refusal !== null ? (
            <span data-k="add-project-refusal" className="min-w-0 truncate text-[13px] text-destructive-foreground" title={refusal}>
              {refusal}
            </span>
          ) : (
            <>
              <Hint keys="↑↓" word={ADD_PROJECT_WORDS.navigate} />
              <Hint keys="↵" word={typingPath && litRow !== undefined && !litRow.repo ? ADD_PROJECT_WORDS.open : ADD_PROJECT_WORDS.add} />
              <Hint keys="tab" word={ADD_PROJECT_WORDS.complete} />
              <Hint keys="/" word={ADD_PROJECT_WORDS.byPath} />
            </>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
