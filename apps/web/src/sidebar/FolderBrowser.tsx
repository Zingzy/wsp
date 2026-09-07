// SPDX-License-Identifier: AGPL-3.0-only
// The folder picker a browser tab has where the desktop shell opens the system
// dialog: no web picker can hand a page a path, so the host lists its own
// folders one level at a time and this walks them. One row of crumbs, the same
// row the panes draw, over one quiet list of folders: a row goes into its
// folder, the crumbs go back out, and one action names the folder shown, which
// is what the system dialog's own Choose does. The list keeps its height
// across levels so the dialog around it never moves, and the typed path in
// the field above still works for a path pasted from somewhere else.
import { FolderGitIcon, FolderIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { folderRefusalLine, type HostFolderListing } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { baseName } from "../files/entries.js";
import { FolderCrumbRow } from "../files/FolderBreadcrumbs.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { count } from "./projectTrip.js";

const ROW = "flex h-7 w-full min-w-0 items-center gap-2 rounded-sm px-1 text-left text-xs outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** What the list has to say about itself, in the same words the command line prints: the level's folders, how many of
 * it are dot-named, or why there is nothing to show. */
function stateWords(listing: HostFolderListing | null, error: string | null): string {
  if (error !== null) return folderRefusalLine(error);
  if (listing === null) return "Reading the folders on this Mac.";
  const held = listing.hidden === 0 ? "" : `, ${listing.hidden} hidden`;
  return listing.folders.length === 0 ? `No folders in ${listing.dir}${held}.` : `${count(listing.folders.length, "folder")} in ${listing.dir}${held}.`;
}

export function FolderBrowser({ disabled, start, onPick }: { disabled: boolean; start?: string; onPick: (dir: string) => void }) {
  const browse = useStore(s => s.api?.hostFolders);
  const [asked, setAsked] = useState<string | undefined>(start);
  // Only the start the memory gave is fallen back on without a word; every level after it was asked for by hand.
  const [remembered, setRemembered] = useState(start !== undefined);
  const [hidden, setHidden] = useState(false);
  const [listing, setListing] = useState<HostFolderListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const goTo = (dir: string): void => {
    setRemembered(false);
    setAsked(dir);
  };

  useEffect(() => {
    if (browse === undefined) return;
    let gone = false;
    browse(asked, hidden).then(
      next => {
        if (gone) return;
        setListing(next);
        setError(null);
      },
      (e: unknown) => {
        if (gone) return;
        // The folder a last import was read from can have left the roots since; the first root is always one of them.
        if (remembered) {
          setRemembered(false);
          setAsked(undefined);
          return;
        }
        setError(errorText(e));
      },
    );
    return () => {
      gone = true;
    };
  }, [browse, asked, hidden, remembered]);

  if (browse === undefined) return null;
  const folders = listing?.folders ?? [];

  return (
    <section data-k="browse" className="flex flex-col gap-1 rounded-md border border-border/60 px-2.5 py-2">
      <div className="flex h-7 min-w-0 items-center gap-2">
        <FolderCrumbRow roots={listing?.roots ?? []} folder={listing?.dir ?? null} onPick={goTo} />
        <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={disabled || listing === null} onClick={() => listing !== null && onPick(listing.dir)} data-k="browse-pick">
          Use this folder
        </Button>
      </div>
      {/* Six rows tall whatever the level holds, so the dialog around the list never moves as it is walked. */}
      <ul className="flex h-42 flex-col overflow-y-auto">
        {folders.map(folder => (
          <li key={folder.path} className="shrink-0">
            <button type="button" className={ROW} disabled={disabled} title={folder.path} data-k="browse-folder" data-folder={folder.path} onClick={() => goTo(folder.path)}>
              {folder.repo ? <FolderGitIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
              <span className="min-w-0 truncate font-mono">{baseName(folder.path)}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="flex h-7 min-w-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
        <span data-k="browse-state" className="min-w-0 truncate" title={stateWords(listing, error)}>
          {stateWords(listing, error)}
        </span>
        {listing !== null && listing.hidden > 0 ? (
          <button type="button" className="ml-auto shrink-0 rounded-sm px-1 underline decoration-dotted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" data-k="browse-hidden" onClick={() => setHidden(!hidden)}>
            {hidden ? "hide hidden" : "show hidden"}
          </button>
        ) : null}
      </p>
    </section>
  );
}
