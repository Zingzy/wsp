// SPDX-License-Identifier: AGPL-3.0-only
// What the app says about a computer that has stopped answering, beyond the
// state word: where the host expects it, when it last spoke, what the last dial
// said, and the button that dials it once more. Two surfaces read it, the
// Workspace pane and the computer's own row in Settings, so the reading is
// composed once in the protocol (absentRoad) and drawn here.
//
// The answer to a press lands in the slot the sentence was in, so a person
// reads one thing in one place rather than a toast that goes.
import { useState } from "react";
import { absentRoad, awayMsOf, placeDialRoad, type PlaceDialRoad, type PlaceView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { errorText } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { WHERE_WORDS } from "./format.js";

/** One dial and what it came to, for the two slots that offer it. The line is the host's own where it answered
 * and the client's where the ask itself failed, so the slot always says something a person can act on. A wsp that
 * cannot dial at all says so in that same slot rather than on the held button, since no tooltip carries a reason.
 * The road is the host's own reading of it: nothing comes back for a computer there is no road to, and the slot
 * draws no button rather than one whose only answer is that it had nowhere to dial. */
export function useDialPlace(place: Pick<PlaceView, "id" | "present" | "road">): { dial: () => void; busy: boolean; line: string | null; held: boolean; heldWhy: string | null; road: PlaceDialRoad | undefined } {
  const dialPlace = useStore(s => s.dialPlace);
  const road = placeDialRoad(place);
  const held = useStore(s => s.api?.dialPlace === undefined);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const dial = (): void => {
    setBusy(true);
    setLine(null);
    void dialPlace(place.id).then(
      answer => setLine(answer.line),
      (e: unknown) => setLine(errorText(e)),
    ).finally(() => setBusy(false));
  };
  return { dial, busy, line, held, heldWhy: held && road !== undefined ? WHERE_WORDS.cannotDial : null, road };
}

/** The button itself, drawn the same in both slots: an extra-small outline that keeps its variant while it waits
 * and changes its word, since a press that answers in its own time is not a held one. Its word is the road's, so a
 * box this host can only log in to says what the press would do. Why it is held carries no tooltip: the reason is
 * written in the slot the sentence stands in, before any pointer touches the button. */
export function DialButton({ busy, held, road, onDial }: { busy: boolean; held: boolean; road: PlaceDialRoad; onDial: () => void }) {
  return (
    <Button data-k="dial" size="xs" variant="outline" disabled={busy || held} onClick={onDial}>
      {busy ? WHERE_WORDS.dialling : WHERE_WORDS.dial[road]}
    </Button>
  );
}

/** The Workspace pane's slot: the road sentence, replaced by what the last press got, with the button beside it.
 * The prose ink and the 11 px the pane's other sentences wear, so it reads as one of them. */
export function AbsentRoadNote({ place, now }: { place: PlaceView; now: number }) {
  const { dial, busy, line, held, heldWhy, road: dialRoad } = useDialPlace(place);
  const road = absentRoad({ name: place.name, road: place.road, awayMs: awayMsOf(place, now), dialled: place.dialled });
  return (
    <div className="mt-1.5 flex items-start justify-between gap-3">
      <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground" data-k="absent-road">
        {line ?? road.sentence}
        {/* Why the button beside it cannot be pressed, in the slot the sentence stands in and before any click. */}
        {line === null && heldWhy !== null ? <span data-k="dial-held"> {heldWhy}</span> : null}
      </p>
      {dialRoad === undefined ? null : <DialButton busy={busy} held={held} road={dialRoad} onDial={dial} />}
    </div>
  );
}
