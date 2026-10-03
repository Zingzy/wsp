// SPDX-License-Identifier: AGPL-3.0-only
// Add a cloud, on the Computers page itself: each provider by its key, then
// the image on each cloud whose key this window saved, the card its own page
// draws. A computer of the person's own is added in Add a computer's dialog.
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PROVIDER_KEY_WORDS, placeBuildsNoImageLine, type InitSetup, type PlaceView } from "@wsp/protocol";
import { useStore } from "../protocol/store.js";
import { FACT } from "./format.js";
import { IMAGE_WORDS } from "./image.js";
import { useImageCard, useImageStanding } from "./ImageCard.js";
import { isProviderPlace, placeName } from "./places.js";
import { Card } from "./rows.js";
import { useSettingsContext } from "./settingsContext.js";
import { ProviderKey } from "./ProviderKey.js";
import { cloudsOffered } from "./providers.js";

/** Where an add goes on to: the image on the computer just added, as the card its own page draws, or the one line
 * saying it takes none. Getting here builds nothing; a copy is built on the card's press alone. */
function ImageNext({ place }: { place: PlaceView }) {
  const card = useImageCard(place, useSettingsContext());
  if (place.buildsImages === false) {
    return (
      <p data-k="no-image-here" className="text-[13px] leading-5 text-muted-foreground">
        {placeBuildsNoImageLine(placeName(place))}
      </p>
    );
  }
  return card === undefined ? null : <Card id={card.id} head={card.head} body={card.body} />;
}

/** One road's flow under the name AddComputer draws over it, the action in the foot. */
function RoadBody({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return (
    <>
      <div className="flex flex-col gap-6">{children}</div>
      {foot === undefined ? null : <footer className="flex items-center gap-3 border-border border-t pt-5">{foot}</footer>}
    </>
  );
}

/** Under a key the host held before this window: where that cloud's image stands, opening the cloud's page, whose
 * card is the one a key saved here draws under the list. */
function HeldImage({ place }: { place: PlaceView }) {
  const ctx = useSettingsContext();
  const standing = useImageStanding(place, ctx);
  if (standing === undefined) return null;
  return (
    <button type="button" data-k="held-image" className="mt-3 flex items-center gap-2.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:text-foreground/80" onClick={() => ctx.go({ kind: "computer", id: place.id })}>
      <span>{IMAGE_WORDS.head(standing.name)}</span>
      <span className={FACT}>{standing.title}</span>
      <ChevronRightIcon aria-hidden className="ms-auto size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** The providers by key, then the image on each cloud whose key this window saved, once the host lists it. */
function CloudRoad({ setup }: { setup: InitSetup | null }) {
  const places = useStore(s => s.places);
  const [kept, setKept] = useState<readonly string[]>([]);
  const onKept = (id: string) => (yes: boolean) => setKept(ids => [...ids.filter(k => k !== id), ...(yes ? [id] : [])]);
  const added = places.filter(p => isProviderPlace(p) && kept.includes(p.id));
  return (
    <RoadBody>
      <div className="flex flex-col divide-y divide-border">
        {cloudsOffered(setup).map(id => {
          const words = PROVIDER_KEY_WORDS[id];
          if (words === undefined) return null;
          const listed = places.find(p => isProviderPlace(p) && p.id === id);
          return (
            <ProviderKey key={id} id={id} words={words} held={setup?.keys[id] === true} kept={kept.includes(id)} onKept={onKept(id)}>
              {setup?.keys[id] === true && !kept.includes(id) && listed !== undefined ? <HeldImage place={listed} /> : null}
            </ProviderKey>
          );
        })}
      </div>
      {added.map(place => (
        <ImageNext key={place.id} place={place} />
      ))}
    </RoadBody>
  );
}

/** The road Add a cloud opens on; a computer of the person's own has its own dialog. */
export type AddRoad = "cloud";

/** The cloud road's panel, scrolled into view as it opens. */
export function AddComputer({ setup }: { setup: InitSetup | null; road?: AddRoad | null }) {
  const asked = useStore(s => s.addComputerOpen);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  useEffect(() => {
    if (asked) useStore.getState().closeAddComputer();
  }, [asked]);
  return (
    <div ref={root} className="flex flex-col gap-6" data-k="add-computer">
      <section data-k="road-cloud" className="flex flex-col gap-6 motion-safe:animate-[road-in_200ms_ease-out]">
        <CloudRoad setup={setup} />
      </section>
    </div>
  );
}
