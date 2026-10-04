// SPDX-License-Identifier: AGPL-3.0-only
// The renderer's half of the catalog: one view per core piece type, by type. The protocol's SLATE_PIECES is the
// other half and the registry test holds the two to the same keys.
import type { PieceViews } from "../SlateView.js";
import { bars } from "./bars.js";
import { button } from "./button.js";
import { chart } from "./chart.js";
import { diagram } from "./diagram.js";
import { chip } from "./chip.js";
import { choices } from "./choices.js";
import { checklist } from "./checklist.js";
import { column } from "./column.js";
import { empty } from "./empty.js";
import { facts } from "./facts.js";
import { grid } from "./grid.js";
import { heading } from "./heading.js";
import { input } from "./input.js";
import { markdown } from "./markdown.js";
import { meter } from "./meter.js";
import { number } from "./number.js";
import { output } from "./output.js";
import { ring } from "./ring.js";
import { row } from "./row.js";
import { section } from "./section.js";
import { select } from "./select.js";
import { sparkline } from "./sparkline.js";
import { status } from "./status.js";
import { table } from "./table.js";
import { text } from "./text.js";
import { toggle } from "./toggle.js";

export const SLATE_VIEWS: PieceViews = Object.fromEntries(
  [column, row, grid, section, heading, text, markdown, number, meter, ring, chart, diagram, sparkline, bars, status, chip, facts, table, checklist, output, button, input, select, choices, toggle, empty].map(view => [view.type, view]),
);
