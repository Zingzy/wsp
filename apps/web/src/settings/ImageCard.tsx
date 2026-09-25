// SPDX-License-Identifier: AGPL-3.0-only
// The Image card on a computer's page, and under Add a computer once that
// computer is added: what stands there of your image, as imageState reads it,
// and the one press that state invites. A copy is built only on Copy, never on
// opening the page, and the time and the rate stand beside the press, since a
// build bills where it runs. The image's own first build is not started from
// here: Edit image is the door that builds it.
import { PencilIcon } from "lucide-react";
import { useState } from "react";
import { HERE_PLACE_ID, copyAsksSignIns, type PlaceView, type SealedImageView } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import type { ChipItem } from "../components/ui/chips.js";
import { Spinner } from "../components/ui/spinner.js";
import { failureOf, type Failure } from "../protocol/failure.js";
import { useGoldenFrames, useStore } from "../protocol/store.js";
import { requestNewWorkspace } from "../shell/shellRequests.js";
import { FACT, WHERE_WORDS } from "./format.js";
import { copyCost, IMAGE_WORDS } from "./image.js";
import { imageChips, imageState, type ImageState } from "./imageState.js";
import { placeName, projectOn } from "./places.js";
import { RefusalSlot } from "./sheetParts.js";
import { CARD_SURFACE, Row, type SettingsCardData, type SettingsRowData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { cn } from "../lib/utils.js";

/** The Image card under its head for one computer, drawn by the computer's page and by Add a computer once that
 * computer is added: nothing until the host has read the image, and nothing where the computer can hold none. */
export function useImageCard(place: PlaceView, ctx: SettingsContext): SettingsCardData | undefined {
  const standing = useImageStanding(place, ctx);
  if (standing === undefined) return undefined;
  const { name, state, view } = standing;
  return { id: "image", head: IMAGE_WORDS.head(name), items: [], body: <ImageCard place={place} name={name} state={state} view={view} ctx={ctx} /> };
}

/** Where your image stands on one computer, the one reading the card and the line under a held cloud key share. */
export function useImageStanding(place: PlaceView, ctx: SettingsContext): { name: string; state: ImageState; view: SealedImageView; title: string } | undefined {
  const job = useStore(s => s.initJob);
  const frames = useGoldenFrames();
  const view = ctx.reads.image;
  const state = view === null ? undefined : imageState(place, { view, job, frames });
  if (view === null || state === undefined) return undefined;
  return { name: placeName(place, place.id === HERE_PLACE_ID), state, view, title: standingTitle(state, view.image !== null) };
}

/** The title a state stands under: with no image anywhere, nothing here is a copy yet. */
function standingTitle(state: ImageState, imageExists: boolean): string {
  switch (state.kind) {
    case "none":
    case "stopped":
      return imageExists ? IMAGE_WORDS.state.notHere : IMAGE_WORDS.state.nothing;
    case "building":
      return IMAGE_WORDS.state.building;
    case "copying":
      return IMAGE_WORDS.state.copying;
    case "stale":
      return IMAGE_WORDS.state.stale;
    case "ready":
      return IMAGE_WORDS.state.ready;
  }
}

/** The one press a state invites, and why it is held where it is: said under the card, never on a hover. */
type Press = { word: string; heldWhy?: string; run?: () => void };

export function ImageCard({ place, name, state, view, ctx }: { place: PlaceView; name: string; state: ImageState; view: SealedImageView; ctx: SettingsContext }) {
  const [pressing, setPressing] = useState(false);
  const [refused, setRefused] = useState<Failure | null>(null);
  const build = ctx.api?.imageBuild;
  const image = view.image;
  const force = image !== null && copyAsksSignIns(image);
  const copy = (): void => {
    if (build === undefined) return;
    setPressing(true);
    setRefused(null);
    void build(place.id, force || undefined)
      .catch((e: unknown) => setRefused(failureOf(e)))
      .finally(() => setPressing(false));
  };
  const copyPress: Press = { word: force ? IMAGE_WORDS.copyAnyway : IMAGE_WORDS.copyHere, ...(build === undefined ? { heldWhy: WHERE_WORDS.notYet } : { run: copy }) };
  const buildPress: Press = { word: IMAGE_WORDS.buildHere, heldWhy: IMAGE_WORDS.buildHeld };
  const project = projectOn(place, ctx.projects);
  const cost = copyCost(place.rateUsdPerHour);
  const title = standingTitle(state, image !== null);

  const row = ((): { title: string; description?: string; mono?: boolean; chips?: ChipItem[]; cost?: string[]; note?: string; press?: Press; busy?: boolean } => {
    switch (state.kind) {
      case "none":
        if (image === null) return { title, description: IMAGE_WORDS.chooseAndBuild, press: buildPress };
        return { title, description: force ? IMAGE_WORDS.copyAsks(image.version) : IMAGE_WORDS.copyComes(image.version), cost, press: copyPress };
      case "building":
        return { title, description: IMAGE_WORDS.steps(state.job.progress.done, state.job.progress.total), mono: true, busy: true };
      case "copying":
        return { title, description: state.line, mono: true, busy: true };
      case "stopped":
        // A first build that stopped has no record to copy; building it again is the job's, held with its reason.
        return image === null
          ? { title, description: state.said, mono: true, press: buildPress }
          : { title, description: state.said, mono: true, cost, ...(force ? { note: IMAGE_WORDS.copyAsks(image.version) } : {}), press: { ...copyPress, word: force ? IMAGE_WORDS.copyAnyway : IMAGE_WORDS.tryAgain } };
      case "stale":
        return { title, chips: imageChips(state, ctx.now), cost, press: copyPress };
      case "ready":
        return project === undefined
          ? { title, chips: imageChips(state, ctx.now), press: { word: IMAGE_WORDS.startTask, heldWhy: IMAGE_WORDS.startHeld(name) } }
          : {
              title,
              chips: imageChips(state, ctx.now),
              press: {
                word: IMAGE_WORDS.startTask,
                run: () => {
                  useStore.getState().closeSettings();
                  requestNewWorkspace(project.id);
                },
              },
            };
    }
  })();

  const control = row.busy ? (
    <Spinner className="size-4 text-muted-foreground" />
  ) : row.press === undefined ? undefined : (
    <>
      {row.cost === undefined ? null : (
        <span data-k="image-cost" className={cn(FACT, "flex shrink-0 flex-col items-end whitespace-nowrap leading-4")}>
          {row.cost.map(line => (
            <span key={line}>{line}</span>
          ))}
        </span>
      )}
      <Button data-k="image-press" size="xs" variant="default" held={row.press.heldWhy !== undefined} disabled={pressing} onClick={row.press.run}>
        {row.press.word}
      </Button>
    </>
  );
  const waiting = row.press?.heldWhy ?? row.note;
  const stateRow: Omit<SettingsRowData, "kind"> = {
    id: "image-state",
    title: row.title,
    description: row.description ?? row.chips?.map(chip => chip.text).join(" · ") ?? "",
    mono: row.mono === true,
    ...(row.chips === undefined ? {} : { chips: row.chips }),
    ...(control === undefined ? {} : { control }),
    attrs: { "data-k": "image-state", "data-state": state.kind },
  };
  return (
    <div className="flex flex-col gap-3">
      <div className={cn(CARD_SURFACE, "flex flex-col")}>
        <Row {...stateRow} drops={row.cost !== undefined} />
      </div>
      {/* The slot stands in every state, so a refusal or a held press's reason arriving moves nothing under the card. */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <RefusalSlot k="image-refusal" {...(refused === null ? {} : { said: refused.said, ...(refused.fix === undefined ? {} : { fix: refused.fix }) })} {...(waiting === undefined ? {} : { waiting })} />
        </div>
        <Button data-k="edit-image" size="xs" variant="outline" onClick={ctx.openSetup}>
          <PencilIcon aria-hidden className="size-3.5" />
          {IMAGE_WORDS.edit}
        </Button>
      </div>
    </div>
  );
}
