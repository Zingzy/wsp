// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's Setting up section, under the thread list: one tile per
// machine on its way, in the thread tile's two rows. Row one is the
// computer's glyph and what it is doing now, with the state at the right as
// the thread tiles put it (the elapsed time in the working ink, the question
// or the alert in theirs); row two is the computer's name, with the crab at
// the end while it works. Clicking a tile opens the dialog where it was.
import { create } from "zustand";
import { Crab } from "../../components/status/Crab.js";
import { WorkingSince } from "../../components/status/WorkingSince.js";
import { SidebarMenuButton } from "../../components/ui/sidebar.js";
import { cn } from "../../lib/utils.js";
import { ComputerGlyph } from "../../settings/ComputerGlyph.js";
import { placeName } from "../../settings/places.js";
import { SectionRow } from "../../sidebar/SectionRow.js";
import { TILE_CLASS, TILE_ROW_ONE_CLASS, TILE_ROW_TWO_CLASS, TILE_TITLE_CLASS } from "../../sidebar/rowGrammar.js";
import type { SetupCard } from "./fixtures.js";
import { MARK_WORDS, StateMark } from "./StateMark.js";

interface SettingUpState {
  cards: readonly SetupCard[];
  folded: boolean;
}
export const useSettingUp = create<SettingUpState>(() => ({ cards: [], folded: false }));

function SetupTile({ card }: { card: SetupCard }) {
  const name = placeName(card.place);
  const why = `${MARK_WORDS[card.state]}: ${card.line}, ${card.at}`;
  return (
    <li data-setup-tile={card.place.id} className="min-w-0">
      <SidebarMenuButton size="sm" data-sidebar-row data-row-id={`setup:${card.place.id}`} className={TILE_CLASS} title={why}>
        <span className={TILE_ROW_ONE_CLASS}>
          <ComputerGlyph place={card.place} className="size-3" />
          <span className="min-w-0 flex-1 truncate">{card.line}</span>
          {card.state === "working" ? (
            <span data-tile-status="working" className="inline-flex shrink-0 items-center font-medium text-status-working">
              <WorkingSince since={new Date(card.startedAt).toISOString()} />
            </span>
          ) : (
            <StateMark state={card.state} why={why} className="[&_svg]:size-3" />
          )}
        </span>
        <span className={TILE_ROW_TWO_CLASS}>
          <span className={cn(TILE_TITLE_CLASS, "flex-1 text-sidebar-foreground")}>{name}</span>
          {card.state === "working" ? <Crab className="shrink-0 text-status-working" /> : null}
        </span>
      </SidebarMenuButton>
    </li>
  );
}

export function SettingUpSection() {
  const cards = useSettingUp(s => s.cards);
  const folded = useSettingUp(s => s.folded);
  if (cards.length === 0) return null;
  return (
    <li data-section="setting-up" className="mt-3 min-w-0">
      <SectionRow label="Setting up" count={cards.length} collapsed={folded} onToggle={() => useSettingUp.setState({ folded: !folded })} rowId="section:setting-up" head="setting-up" />
      {folded ? null : (
        <ul className="flex min-w-0 flex-col">
          {cards.map(card => (
            <SetupTile key={card.place.id} card={card} />
          ))}
        </ul>
      )}
    </li>
  );
}
