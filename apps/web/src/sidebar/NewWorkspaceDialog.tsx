// SPDX-License-Identifier: AGPL-3.0-only
// New workspace asks one thing: what are you working on. The answer names the
// workspace; it is not the first message, and the composer waits for the ask.
// Everything else is a default: the project is the one there is, or the one
// whose plus was pressed, and the branch, the size and the image are the
// runtime's own business. Enter creates, Escape cancels. The parent keys this
// component per opening so the field resets; a refusal shows on the creation
// view, not here, since the runtime is the one that knows.
//
// Under the lines the slot says where the work lands, in the protocol's own
// words, so this dialog holds no second spelling of a computer's name or of
// what a copy's ports are; a Create pressed with no answer says why there.
import { useState } from "react";
import { portsWord, type PlaceView, type ProjectView , type WorkspaceLanding } from "@wsp/protocol";
import { PROJECT_PICK_WORDS, landingName } from "../settings/places.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogLine,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Spaced } from "../components/ui/spaced.js";
import { Select, SelectButton, SelectItem, SelectPopup, SelectValue } from "../components/ui/select.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { RefusalSlot } from "../settings/sheetParts.js";
import { NEW_WORKSPACE, SAY_THE_WORK, WORK_GHOST, WORK_QUESTION } from "./words.js";

/** Beyond this many rows the segmented control is too wide for the dialog, and the same words go in a select. */
const SEGMENT_CAP = 4;

export function NewWorkspaceDialog({
  projects,
  landings,
  places,
  picked,
  onCreate,
  onCancel,
}: {
  /** Every project this wsp holds; the work goes on one of them and the only one is already picked. */
  projects: readonly ProjectView[];
  /** Where a workspace of each project lands, by the project's id, as the host answered; a project it has not
   * answered for yet has no line under the pick rather than a guessed one. */
  landings: Readonly<Record<string, WorkspaceLanding | null>>;
  /** Every computer this wsp holds, so the line under the pick names one the way every other surface names it. */
  places: readonly PlaceView[];
  /** The project whose plus was pressed; with none the first project this host holds is picked. */
  picked: string | null;
  onCreate: (name: string, project: string) => void;
  onCancel: () => void;
}) {
  const [work, setWork] = useState("");
  const [pickedProject, setPickedProject] = useState<string | null>(picked);
  const [tried, setTried] = useState(false);
  const project = projects.find(p => p.id === pickedProject) ?? projects[0];
  const trimmed = work.trim();
  const held = project === undefined || trimmed.length === 0;
  const landing = project === undefined ? null : landings[project.id] ?? null;
  const submit = (): void => {
    if (held || project === undefined) {
      setTried(true);
      return;
    }
    onCreate(trimmed, project.id);
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      {/* Anchored at its top, 160 px down, rather than centred: a dialog that stands where the hand left it is one a
          second opening does not move. */}
      <DialogPopup className="sm:row-start-1 sm:mt-36 sm:max-h-[calc(100dvh-11rem)] sm:self-start">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={e => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{NEW_WORKSPACE}</DialogTitle>
          </DialogHeader>
          <DialogPanel className="pt-1 pb-0">
            <DialogLine>
              <Label htmlFor="new-workspace-work" className="shrink-0">{WORK_QUESTION}</Label>
              <div className="w-52 min-w-0">
                <Input
                  id="new-workspace-work"
                  nativeInput
                  autoFocus
                  autoComplete="off"
                  placeholder={WORK_GHOST}
                  value={work}
                  onChange={e => {
                    setWork(e.target.value);
                    setTried(false);
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submit();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      onCancel();
                    }
                  }}
                />
              </div>
            </DialogLine>
            <DialogLine>
              <Label id="new-workspace-project" className="shrink-0">{PROJECT_PICK_WORDS.label}</Label>
              {project === undefined ? (
                <p className="min-w-0 truncate text-[13px] text-muted-foreground" data-k="no-project-here" title={PROJECT_PICK_WORDS.noneYet}>
                  {PROJECT_PICK_WORDS.noneYet}
                </p>
              ) : (
                <ProjectPick projects={projects} checked={project} onPick={setPickedProject} />
              )}
            </DialogLine>
            {/* The slot is there from the first paint, so the landing arriving, or the reason Create is held, moves
                nothing under it. */}
            <RefusalSlot
              k="new-workspace-slot"
              {...(tried && held && project !== undefined ? { waiting: SAY_THE_WORK } : {})}
              note={<span data-k="landing">{landing === null ? "" : <Spaced parts={landsLine(places, landing)} />}</span>}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" data-k="create" held={held}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Where the work lands: the computer, and what a copy there has for a network, both in the protocol's own words.
 * No road word: which road the next workspace of this project takes is the runtime's own rule, and the row reads
 * it off the record the create answers with. */
export function landsLine(places: readonly PlaceView[], landing: WorkspaceLanding): string[] {
  const name = landingName(places, landing);
  return [name, portsWord(landing.capabilities, undefined, name)].filter(part => part !== "");
}

/** The projects themselves: the one there is reads as its own name and takes no pick, since a control offering one
 * row asks a question with one answer. Beyond that a segmented control while they fit one line, and the same names
 * in a select beyond that. The checked project is the one the person picked, else the first this host holds. */
function ProjectPick({ projects, checked, onPick }: { projects: readonly ProjectView[]; checked: ProjectView; onPick: (id: string) => void }) {
  if (projects.length === 1) {
    return (
      <p className="min-w-0 truncate text-sm text-foreground" data-project={checked.id}>
        {checked.name}
      </p>
    );
  }
  if (projects.length > SEGMENT_CAP) {
    return (
      <Select value={checked.id} onValueChange={value => { if (typeof value === "string") onPick(value); }}>
        <SelectButton size="sm" aria-labelledby="new-workspace-project" className="w-52">
          <SelectValue>{() => checked.name}</SelectValue>
        </SelectButton>
        <SelectPopup>
          {projects.map(project => (
            <SelectItem key={project.id} value={project.id} data-project={project.id}>
              {project.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  return (
    <SegmentedControl
      aria-labelledby="new-workspace-project"
      value={checked.id}
      segments={projects.map(project => ({ value: project.id, label: project.name }))}
      onChange={onPick}
    />
  );
}
