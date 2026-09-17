// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog: a name with a default, the project the work is on,
// and the sizes that project's computer offers under it, the image's own
// checked. Enter creates, Escape cancels. The parent keys this component per
// opening so the initial name resets; a refusal shows on the creation view,
// not here.
//
// A workspace is one project's copy, so the project is the whole of the pick
// and its computer comes with it: nothing here asks where the work goes. One
// project is preselected and its control is a line of text; with none the
// control is gone and two notes say what records one. Every word under the
// control is a fact of the project's computer as the places list already
// formats it (whereCaption), so this dialog holds no second spelling of a
// rate, a count or an image version. The sizes are that computer's own, off
// the same list, since one list for every row quoted one provider's prices
// under another's name.
import { useState } from "react";
import { PLACES_WORDS, fmtPrice, fmtSize, offeredSize, sizeOffer, sizeWord, type PlaceView, type ProjectView, type SealedImageCopy, type WorkspaceSize } from "@wsp/protocol";
import { copyOn } from "../settings/image.js";
import { PROJECT_PICK_WORDS, WHERE_PICK_WORDS, placeIsFull, placeName, whereCaption } from "../settings/places.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { Radio, RadioGroup } from "../components/ui/radio-group.js";
import { Select, SelectButton, SelectItem, SelectPopup, SelectValue } from "../components/ui/select.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { cn } from "../lib/utils.js";
import { FACT } from "../settings/format.js";

/** Beyond this many rows the segmented control is too wide for the dialog, and the same words go in a select. */
const SEGMENT_CAP = 4;

export function NewWorkspaceDialog({
  initialName,
  places,
  projects,
  copies,
  goldenSize,
  refusal,
  onCreate,
  onCancel,
  onAddComputer,
}: {
  initialName: string;
  /** Every computer and provider this wsp holds, as the places list gives them; a project's row is read off it for
   * the sizes and the caption. */
  places: readonly PlaceView[];
  /** Every project this wsp holds; the work goes on one of them and the only one is already picked. */
  projects: readonly ProjectView[];
  /** The copies of the image that are already built, so a row says whether one is there or is built first. */
  copies: readonly SealedImageCopy[];
  /** The image's own size, the row checked until the person picks; null while unknown or when no image says. */
  goldenSize: WorkspaceSize | null;
  /** Why there is nothing to fork yet, which holds the keycap and stands in the caption; null when the fork can go ahead. */
  refusal: string | null;
  /** `project` is the project the work is on, by its id; `size` is the row they picked under it. */
  onCreate: (name: string, project: string, size?: WorkspaceSize) => void;
  onCancel: () => void;
  /** Opens the road to a first computer, from the dialog that has no project to make a workspace of. */
  onAddComputer: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const [picked, setPicked] = useState<WorkspaceSize | null>(null);
  const project = projects.find(p => p.id === pickedProject) ?? projects[0];
  const where = project === undefined ? undefined : places.find(p => p.id === project.computer);
  const trimmed = name.trim();
  // The row's own sizes at the row's own rates: a place that offers no pick hides the rows and the workspace takes
  // the image's size.
  const offers = where?.sizes ?? [];
  const checked = picked ?? (goldenSize !== null && offeredSize(offers, goldenSize) ? goldenSize : null);
  // The caption prices the workspace this dialog would make, so it quotes the ticked row's rate; with no row ticked
  // it passes none and the caption falls back to the place's own rate, which is that rule's one home.
  const ticked = checked === null ? undefined : sizeOffer(offers, checked);
  const caption = where === undefined ? null : whereCaption(where, copyOn(copies, where), ticked?.rateUsdPerHour);
  // In the order a person meets them: the image that is not built, then the name they have not typed, then the row
  // that is full. Each is read in the caption under Where, since this dialog waits on a field with no slot of its
  // own. With nowhere to put a workspace there is no caption to write in and no row to create on: the two notes
  // under the label are the reason, and Create is held on that alone.
  const reason = refusal !== null ? refusal : trimmed.length === 0 ? WHERE_PICK_WORDS.nameFirst : where !== undefined && placeIsFull(where) ? caption : null;
  const held = project === undefined || reason !== null;
  const submit = (): void => {
    if (held || project === undefined) return;
    // Only a computer that offers sizes carries one: a size picked for one project and then a pick of a project on
    // another computer would otherwise ask that computer for a shape it never offered.
    onCreate(trimmed, project.id, offers.length === 0 ? undefined : (picked ?? undefined));
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      {/* Anchored at its top, 160 px down, rather than centred: picking a row that offers sizes grows the card
          downward, and the name and the pick above it stay where the hand left them. The height it may grow to is
          the window minus that anchor and the viewport's own inset, so the sizes stand on screen at 1280 by 800
          instead of the grid row's half of the window cutting the card in two. */}
      <DialogPopup className="sm:row-start-1 sm:mt-36 sm:max-h-[calc(100dvh-11rem)] sm:max-w-sm sm:self-start">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={e => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>A copy of your image where you pick.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-workspace-name">Name</Label>
              <Input
                id="new-workspace-name"
                nativeInput
                autoFocus
                autoComplete="off"
                value={name}
                onChange={e => setName(e.target.value)}
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
            <div className="flex flex-col gap-2">
              <Label id="new-workspace-project">{PROJECT_PICK_WORDS.label}</Label>
              {project === undefined ? (
                <>
                  <p className="text-[13px] text-muted-foreground" data-k="no-project-here">
                    {PROJECT_PICK_WORDS.noneYet}
                  </p>
                  <p className="text-[13px] text-muted-foreground" data-k="no-project-add">
                    {PROJECT_PICK_WORDS.addOne}
                  </p>
                </>
              ) : (
                <>
                  <ProjectPick projects={projects} checked={project} onPick={setPickedProject} />
                  <span className={cn(FACT, "min-h-4")} data-k="where-caption">
                    {reason ?? caption}
                  </span>
                  {offers.length > 0 && (
                    <RadioGroup
                      aria-label="Size"
                      className="gap-1 rounded-[10px] border border-border p-2"
                      value={checked === null ? "" : sizeWord(checked)}
                      onValueChange={value => {
                        const size = offers.find(s => sizeWord(s) === value);
                        if (size !== undefined) setPicked({ cpu: size.cpu, memMb: size.memMb });
                      }}
                    >
                      {offers.map(s => (
                        <label key={sizeWord(s)} data-size={sizeWord(s)} className="flex h-9 cursor-pointer items-center gap-2.5 font-mono text-[11px] text-muted-foreground">
                          <Radio value={sizeWord(s)} />
                          <span className="flex-1 tabular-nums">{fmtSize(s)}</span>
                          <span className="tabular-nums">{fmtPrice(s.rateUsdPerHour)}</span>
                        </label>
                      ))}
                    </RadioGroup>
                  )}
                </>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            {/* With nowhere to put a workspace, Add a computer is the one road forward, so it is the loud one and
                Create stands held beside it: a held keycap is drawn as the outline, so a dialog that made this one
                the outline too would have nothing to press first. */}
            {project === undefined && (
              <Button type="button" data-k="add-computer" onClick={onAddComputer}>
                {PLACES_WORDS.addComputer}
              </Button>
            )}
            <Button type="submit" data-k="create" held={held}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The projects themselves: the one there is reads as its own name and takes no pick, since a control offering one
 * row asks a question with one answer. Beyond that a segmented control while they fit one line, and the same names
 * in a select beyond that. The checked project is the one the person picked, else the first this host holds. */
function ProjectPick({ projects, checked, onPick }: { projects: readonly ProjectView[]; checked: ProjectView; onPick: (id: string) => void }) {
  if (projects.length === 1) {
    return (
      <p className="text-[13px] text-foreground" data-project={checked.id}>
        {checked.name}
      </p>
    );
  }
  if (projects.length > SEGMENT_CAP) {
    return (
      <Select value={checked.id} onValueChange={value => { if (typeof value === "string") onPick(value); }}>
        <SelectButton size="sm" aria-labelledby="new-workspace-project" className="w-full">
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
      className="self-start"
      value={checked.id}
      segments={projects.map(project => ({ value: project.id, label: project.name }))}
      onChange={onPick}
    />
  );
}
