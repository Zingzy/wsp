// SPDX-License-Identifier: AGPL-3.0-only
// Add a project: one source on one computer. A folder is always this
// computer's, so nothing asks where; a repository address on a wsp that holds a
// second computer grows one pick, and that pick appearing is what says which
// road the source takes. No branch field, no seed menu and no sentence under
// the field: the base is the remote's default branch and what a copy carries is
// the runtime's own business. The refusal slot under the field stands from the
// first paint, so the runtime's sentence arriving moves nothing.
import { useState, type KeyboardEvent } from "react";
import { sourceKind, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { Sheet, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { RefusalSlot } from "../settings/sheetParts.js";
import { placeName, placeTakesWorkspaces } from "../settings/places.js";
import { FIELD, FIELD_LABEL } from "./cloud-setup/rows.js";
import { ADD_PROJECT_WORDS } from "./words.js";

/** Whether this word names a repository rather than a folder on this computer. A word that names neither yet, or
 * nothing at all, is a folder as far as the sheet is concerned: the pick appears when the person has typed enough
 * for the road to be known, and the runtime's own sentence refuses whatever it cannot read. */
function namesRepository(word: string): boolean {
  try {
    return sourceKind(word.trim()) === "git";
  } catch {
    return false;
  }
}

export function AddProjectSheet({ onClose }: { onClose: () => void }) {
  const addProject = useStore(s => s.addProject);
  const canAdd = useStore(s => s.api?.projectsAdd !== undefined);
  const places = useStore(s => s.places);
  const [source, setSource] = useState("");
  const [on, setOn] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Every computer a project can be cloned onto: the computer this host runs on holds folders, and a repository
  // address is cloned on a computer that runs workspaces.
  const elsewhere = places.filter(placeTakesWorkspaces);
  const asking = namesRepository(source) && elsewhere.length > 0;
  const computer = on ?? elsewhere[0]?.id ?? null;
  const held = !canAdd || source.trim() === "" || adding;

  const add = async (): Promise<void> => {
    if (held) return;
    setAdding(true);
    setRefusal(null);
    try {
      await addProject(source.trim(), asking && computer !== null ? computer : undefined);
      onClose();
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Sheet open onOpenChange={open => (open ? undefined : onClose())}>
      <SheetPopup side="right" variant="inset" data-k="add-project">
        <SheetHeader>
          <SheetTitle data-k="title">{ADD_PROJECT_WORDS.title}</SheetTitle>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="add-project-source" className={FIELD_LABEL}>
              {ADD_PROJECT_WORDS.source}
            </label>
            <Input
              id="add-project-source"
              data-k="source"
              nativeInput
              autoFocus
              autoComplete="off"
              spellCheck={false}
              size="compact"
              className={FIELD}
              value={source}
              disabled={adding}
              onChange={e => {
                setSource(e.target.value);
                setRefusal(null);
              }}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void add();
              }}
            />
            <RefusalSlot k="add-project-refusal" {...(refusal === null ? {} : { said: refusal })} />
          </div>
          {asking ? (
            <div className="flex flex-col gap-2">
              <span className={FIELD_LABEL} id="add-project-computer">
                {ADD_PROJECT_WORDS.computer}
              </span>
              <SegmentedControl
                aria-labelledby="add-project-computer"
                className="self-start"
                value={computer ?? ""}
                segments={elsewhere.map(place => ({ value: place.id, label: nameOf(places, place) }))}
                onChange={setOn}
              />
            </div>
          ) : null}
        </SheetPanel>
        <SheetFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {ADD_PROJECT_WORDS.cancel}
          </Button>
          <Button type="button" data-k="add" held={held} onClick={() => void add()}>
            {ADD_PROJECT_WORDS.add}
          </Button>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

/** What a row of the places list is called here, by the one reading every surface names a computer through. */
const nameOf = (places: readonly PlaceView[], place: PlaceView): string => placeName(place, place === places[0]);
