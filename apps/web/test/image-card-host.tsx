// SPDX-License-Identifier: AGPL-3.0-only
// The Image card with its recipe and its build, as the Add a computer sheet
// draws it for a computer just added, for the computer the settings store is
// on, in the settings page's own column: a computer's page draws the image as
// one row and leaves the recipe out, so the tests and the render fixture that
// read the recipe and the build mount the card here.
import type { PlaceView } from "@wsp/protocol";
import { ScrollArea } from "../src/components/ui/scroll-area.js";
import { useImageCard } from "../src/settings/ImageCard.js";
import { Card } from "../src/settings/rows.js";
import { useSettingsAt, useSettingsContext, type SettingsContext } from "../src/settings/settingsContext.js";
import { useSettingsReads } from "../src/settings/settingsReads.js";

export function ImageCardHost() {
  useSettingsReads();
  const ctx = useSettingsContext();
  const at = useSettingsAt();
  const place = at.kind === "computer" ? ctx.places.find(p => p.id === at.id) : undefined;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div data-settings-page data-settings-at={at.kind === "computer" ? `computer:${at.id}` : ""} className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-8 pt-14 pb-12 max-sm:px-4 max-sm:pt-6">
        {place === undefined ? null : <ImageCardOf key={place.id} place={place} ctx={ctx} />}
      </div>
    </ScrollArea>
  );
}

function ImageCardOf({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const card = useImageCard(place, ctx);
  return card === undefined ? null : <Card id={card.id} head={card.head} body={card.body} />;
}
