// SPDX-License-Identifier: AGPL-3.0-only
// The new-workspace dialog: a name with a default, where it runs, and the
// sizes the provider offers under the pick that has them, the image's own
// checked. Enter creates, Escape cancels. The parent keys this component per
// opening so the initial name resets; a refusal shows on the creation view,
// not here.
//
// Where lists the computers and providers that can hold another workspace,
// never this computer, which is already the one workspace it can be; with none
// of them the control is gone and two notes say why. Every word under the
// control is a fact of that row as the places list already formats it
// (whereCaption), so this dialog holds no second spelling of a rate, a count
// or an image version.
import { useState } from "react";
import { PLACES_WORDS, fmtRate, fmtSize, offeredSize, sizeOffer, sizeWord, type MachineSizeOffer, type PlaceView, type SealedImageCopy, type WorkspaceSize } from "@wsp/protocol";
import { copyOn } from "../settings/image.js";
import { WHERE_PICK_WORDS, isProviderPlace, placeIsFull, placeName, whereCaption, whereSegments } from "../settings/places.js";
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
  copies,
  sizes,
  goldenSize,
  refusal,
  onCreate,
  onCancel,
  onAddComputer,
}: {
  initialName: string;
  /** Every computer and provider this wsp holds, this computer first, as the places list gives them. */
  places: readonly PlaceView[];
  /** The copies of the image that are already built, so a row says whether one is there or is built first. */
  copies: readonly SealedImageCopy[];
  /** What the provider offers; none hides the size rows and the workspace takes the image's size. */
  sizes: readonly MachineSizeOffer[];
  /** The image's own size, the row checked until the person picks; null while unknown or when no image says. */
  goldenSize: WorkspaceSize | null;
  /** Why there is nothing to fork yet, which holds the keycap and stands in the caption; null when the fork can go ahead. */
  refusal: string | null;
  /** `where` is the row the person picked, by its id; `size` is the row they picked under it. */
  onCreate: (name: string, where?: string, size?: WorkspaceSize) => void;
  onCancel: () => void;
  /** Opens the road to a first computer, from the dialog that has nowhere to put a workspace. */
  onAddComputer: () => void;
}) {
  const segments = whereSegments(places);
  const [name, setName] = useState(initialName);
  const [pickedWhere, setPickedWhere] = useState<string | null>(null);
  const [picked, setPicked] = useState<WorkspaceSize | null>(null);
  const where = segments.find(p => p.id === pickedWhere) ?? segments.find(p => p.default) ?? segments[0];
  const trimmed = name.trim();
  const offers = where !== undefined && isProviderPlace(where) ? sizes : [];
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
  const held = where === undefined || reason !== null;
  const submit = (): void => {
    if (held || where === undefined) return;
    // Only a row that offers sizes carries one: a size picked for the provider and then a pick of a computer would
    // otherwise ask that computer for a shape it never offered.
    onCreate(trimmed, where.id, offers.length === 0 ? undefined : (picked ?? undefined));
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
              <Label id="new-workspace-where">{WHERE_PICK_WORDS.label}</Label>
              {where === undefined ? (
                <>
                  <p className="text-[13px] text-muted-foreground" data-k="nowhere-here">
                    {WHERE_PICK_WORDS.nowhereYet}
                  </p>
                  <p className="text-[13px] text-muted-foreground" data-k="nowhere-add">
                    {WHERE_PICK_WORDS.addOne}
                  </p>
                </>
              ) : (
                <>
                  <WherePick segments={segments} checked={where} onPick={setPickedWhere} />
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
                          <span className="tabular-nums">{fmtRate(s.rateUsdPerHour)}</span>
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
            {where === undefined && (
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

/** The rows themselves: a segmented control while they fit one line, the same words in a select beyond that. The
 * checked row is the one the person picked, else the row this wsp marks as its default. */
function WherePick({ segments, checked, onPick }: { segments: readonly PlaceView[]; checked: PlaceView; onPick: (id: string) => void }) {
  if (segments.length > SEGMENT_CAP) {
    return (
      <Select value={checked.id} onValueChange={value => { if (typeof value === "string") onPick(value); }}>
        <SelectButton size="sm" aria-labelledby="new-workspace-where" className="w-full">
          <SelectValue>{() => placeName(checked)}</SelectValue>
        </SelectButton>
        <SelectPopup>
          {segments.map(place => (
            <SelectItem key={place.id} value={place.id} data-where={place.id}>
              {placeName(place)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    );
  }
  return (
    <SegmentedControl
      aria-labelledby="new-workspace-where"
      className="self-start"
      value={checked.id}
      segments={segments.map(place => ({ value: place.id, label: placeName(place) }))}
      onChange={onPick}
    />
  );
}
