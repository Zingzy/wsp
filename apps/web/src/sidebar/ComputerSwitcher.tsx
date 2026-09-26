// SPDX-License-Identifier: AGPL-3.0-only
// The computer filter under the project filter, one computer per row in the
// host's order, each by the name a person reads it as.
import type { PlaceView } from "@wsp/protocol";
import { MonitorIcon } from "lucide-react";
import { useMemo } from "react";
import { useStore } from "../protocol/store.js";
import { ComputerGlyph } from "../settings/ComputerGlyph.js";
import { openComputerSettings } from "../settings/openAt.js";
import { placeName } from "../settings/places.js";
import { NounSwitcher, type SwitcherRow } from "./NounSwitcher.js";
import { COMPUTER_SWITCHER_WORDS } from "./words.js";

export function ComputerSwitcher({ places, pick, onPick }: { places: readonly PlaceView[]; pick: string | null; onPick: (placeId: string | null) => void }) {
  const rows = useMemo<SwitcherRow[]>(() => places.map(place => ({ id: place.id, name: placeName(place), meta: null, glyph: <ComputerGlyph place={place} className="text-muted-foreground" /> })), [places]);
  const picked = places.find(place => place.id === pick);
  return (
    <NounSwitcher
      noun="computer"
      words={COMPUTER_SWITCHER_WORDS}
      AllGlyph={MonitorIcon}
      rows={rows}
      // The head takes the row's own ink, as a picked project's does; the menu rows stay muted.
      pick={picked === undefined ? null : { id: picked.id, name: placeName(picked), meta: null, glyph: <ComputerGlyph place={picked} /> }}
      onPick={onPick}
      onAdd={() => useStore.getState().openAddComputer()}
      onSettings={openComputerSettings}
    />
  );
}
