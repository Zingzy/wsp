// SPDX-License-Identifier: AGPL-3.0-only
// A waiting step that shows its work: while this computer is read, the card
// fills row by row with what the read found, the app's spinner beside the row
// being read and a mono word in the slot once it is done. The rows are the
// job's own, so nothing here fakes progress.
import { CLOUD_SETUP_WORDS, type InitJob } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { CARD, META, NAME, ROW, ROW_LINE, RowState, Slot } from "./rows.js";
import { SetupScreen } from "./SetupScreen.js";

export function SetupFacts({ job, refusal }: { job: InitJob | null; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.reading;
  const rows = job?.rows ?? [];
  return (
    <SetupScreen k="reading" label={words.label} headline={words.headline} top={words.top} refusal={refusal}>
      {rows.length > 0 ? (
        <ul className={CARD} aria-label={words.headline}>
          {rows.map(row => (
            <li key={row.id} data-k="row" data-row={row.id} data-state={row.state} className={cn(ROW, ROW_LINE)}>
              <span className={NAME}>{row.label}</span>
              {row.detail !== undefined ? <span className={cn(META, "min-w-0 truncate")}>{row.detail}</span> : null}
              <Slot>
                <RowState state={row.state} />
              </Slot>
            </li>
          ))}
        </ul>
      ) : null}
    </SetupScreen>
  );
}
