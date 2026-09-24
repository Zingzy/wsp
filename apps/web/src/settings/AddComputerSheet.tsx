// SPDX-License-Identifier: AGPL-3.0-only
// Add a computer: one side sheet, one field. The host logs in over ssh as the
// person's own terminal would, installs wsp on the box, runs the recipe there
// and waits for the box to dial back, reporting each step as it reaches it.
//
// One road, so nothing here picks one. Every state is read off facts rather
// than set by hand: the plan's lines off the installer as it reports them, the
// joined screen off the computer the install answered with. The code road a
// computer already running the wsp app takes is the command line's, which
// prints the join line; no screen here asks anybody to type a code.
import { useState, type KeyboardEvent } from "react";
import { PLACES_WORDS, PLACE_INSTALL, PlaceAddStep, placeAddSheetWord, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Kbd } from "../components/ui/kbd.js";
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetPopup, SheetTitle } from "../components/ui/sheet.js";
import { cn, errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import type { InstallStage } from "../protocol/client.js";
import { FIELD_LABEL, LONE_FIELD } from "../sidebar/cloud-setup/rows.js";
import { ADD_COMPUTER_WORDS, FACT } from "./format.js";
import { ComputerRow } from "./computers.js";
import { RefusalSlot, RoadLines, type RoadLine } from "./sheetParts.js";

const WORDS = PLACES_WORDS.sheet;
const MINE = ADD_COMPUTER_WORDS;

/** What a step of the plan carries in its fact slot: what wsp's own files weigh on the box, which the step's own
 * words leave out. A step the installer answered with a note of its own carries that instead. */
const PLAN_FACTS: Partial<Record<PlaceAddStep, string>> = { wsp: PLACE_INSTALL.weight };

/** The road's lines, one per step of the installer: the stage reported for that step where one has arrived, and
 * the step's own line, in the words the sheet gives it, where none has. One list for the plan a person reads
 * before Add and for the run after it, so pressing Add fills the lines in rather than taking them away, and a
 * line's words are the step's in both. */
function planLines(stages: readonly InstallStage[]): RoadLine[] {
  return PlaceAddStep.options.map(step => {
    const reported = stages.find(stage => stage.step === step);
    const fact = reported?.fact ?? PLAN_FACTS[step];
    return {
      word: reported?.word ?? placeAddSheetWord(step, "running"),
      state: reported?.state ?? "waiting",
      ...(fact === undefined ? {} : { fact }),
    };
  });
}

export function AddComputerSheet({ onClose, now = () => Date.now() }: { onClose: () => void; now?: () => number }) {
  const api = useStore(s => s.api);
  const [login, setLogin] = useState("");
  const [refusal, setRefusal] = useState<{ said: string; fix?: string } | null>(null);
  const [stages, setStages] = useState<InstallStage[] | null>(null);
  /** The computer the installer handed back, which is what this road finishes on. */
  const [installed, setInstalled] = useState<PlaceView | null>(null);
  const add = (): void => {
    if (login.trim() === "" || api?.addComputerOverSsh === undefined) return;
    setRefusal(null);
    setStages([]);
    // Once the login stood, a refusal is the box's own sentence and the login fix would point the wrong way.
    let loggedIn = false;
    api
      // A stage sent again for the same step is that line moving on, so the list is keyed by the step rather than
      // by its words, which a step changes when it is done.
      .addComputerOverSsh({ address: login.trim() }, stage => {
        if (stage.step === "connect" && stage.state === "done") loggedIn = true;
        setStages(held => [...(held ?? []).filter(s => s.step !== stage.step), stage]);
      })
      .then(
        place => setInstalled(place),
        (e: unknown) => {
          setStages(null);
          setRefusal({ said: errorText(e), ...(loggedIn ? {} : { fix: MINE.refusedFix }) });
        },
      );
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === "Enter") add();
  };

  const running = stages !== null && installed === null;
  const title = installed === null ? WORDS.title : WORDS.joinedTitle(installed.name);
  // The road's own sentence, and after it what a closed lid does to work already running there, which is the
  // question this sheet is opened with. One description rather than a second paragraph beside it: the sheet names
  // its description to a screen reader, and a second one would take that name off this sentence.
  const description = `${installed === null ? WORDS.description : MINE.runsWorkspaces} ${WORDS.whileAsleep}`;
  const footNote = installed !== null ? undefined : running ? { word: MINE.running } : { kbd: "↵", word: MINE.adds };
  const held = login.trim() === "" ? MINE.loginFirst : api?.addComputerOverSsh === undefined ? MINE.noRoad : undefined;

  return (
    <Sheet open onOpenChange={open => (open ? undefined : onClose())}>
      <SheetPopup side="right" variant="inset" data-k="add-computer">
        <SheetHeader>
          <SheetTitle data-k="title">{title}</SheetTitle>
          <SheetDescription data-k="description">{description}</SheetDescription>
        </SheetHeader>
        <SheetPanel className="flex flex-col gap-4">
          {installed !== null ? (
            <div data-k="joined-row">
              <ComputerRow place={installed} now={now()} />
            </div>
          ) : (
            // The field stays where it is once Add is pressed, holding the login it was given and dimmed: a field
            // that left the tree took the focus with it and drew the ring round the whole sheet, and the row that
            // stood in for it was a second shape for one fact.
            <>
              <div data-k="login-field" className="flex min-w-0 flex-col gap-2">
                <label htmlFor="add-computer-login" className={FIELD_LABEL}>
                  {MINE.login}
                </label>
                <Input
                  id="add-computer-login"
                  data-k="login"
                  nativeInput
                  autoFocus
                  size="compact"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  disabled={running}
                  value={login}
                  placeholder={MINE.loginPlaceholder}
                  // Only when it is true: the input's own rule matches the attribute being there at all, so a
                  // field carrying aria-invalid="false" would draw the destructive border.
                  {...(refusal === null ? {} : { "aria-invalid": true })}
                  onChange={e => setLogin(e.target.value)}
                  onKeyDown={key}
                  className={cn(LONE_FIELD, "min-w-0")}
                />
              </div>
              <RefusalSlot k="ssh-refusal" {...(refusal === null ? (held === undefined ? {} : { waiting: held }) : refusal)} />
            </>
          )}
          {/* The plan and the run are one list in one place, so Add fills the lines in under the hand rather than
              swapping them for another list. */}
          <RoadLines lines={planLines(stages ?? [])} k="plan" />
          {installed === null ? null : <p className="text-[13px] text-muted-foreground">{MINE.named}</p>}
        </SheetPanel>
        <SheetFooter className="items-center sm:justify-between">
          <span data-k="foot-note" className={cn(FACT, "mr-auto")}>
            {footNote === undefined ? "" : (
              <>
                {footNote.kbd === undefined ? null : <Kbd className="mr-1.5">{footNote.kbd}</Kbd>}
                {footNote.word}
              </>
            )}
          </span>
          {/* One word in every state, and the honest one: this button closes the sheet, which is all it does
              before Add is pressed too. An install under way keeps going without the sheet, which the note at the
              other end of the footer says. */}
          <Button variant="outline" onClick={onClose}>
            {WORDS.close}
          </Button>
          {installed === null ? (
            // Three parts in the footer in both states, the same three: a footer that swapped Add away while the
            // install ran moved the button beside it. The reason it is held stands in the slot under the field it
            // waits on; the keycap's own drawing is the button's.
            <Button data-k="ssh-add" held={running || held !== undefined} onClick={add}>
              {MINE.add}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}
