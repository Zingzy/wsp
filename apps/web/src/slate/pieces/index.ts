// SPDX-License-Identifier: AGPL-3.0-only
// The renderer's half of the catalog: one view per core piece type, by type. The protocol's SLATE_PIECES is the
// other half and the registry test holds the two to the same keys.
import type { PieceViews } from "../SlateView.js";
import { button } from "./button.js";
import { column } from "./column.js";
import { empty } from "./empty.js";
import { facts } from "./facts.js";
import { input } from "./input.js";
import { markdown } from "./markdown.js";
import { meter } from "./meter.js";
import { number } from "./number.js";
import { row } from "./row.js";
import { section } from "./section.js";
import { table } from "./table.js";
import { text } from "./text.js";

export const SLATE_VIEWS: PieceViews = Object.fromEntries(
  [column, row, section, text, markdown, number, meter, facts, table, button, input, empty].map(view => [view.type, view]),
);
