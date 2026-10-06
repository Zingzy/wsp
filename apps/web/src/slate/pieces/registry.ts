// SPDX-License-Identifier: AGPL-3.0-only
// The piece views by type, for the engine and the layout rules that read a view's flags without drawing it. Filled
// once by the views' own index, so adding a piece touches its module and the index alone.
import type { PieceView, PieceViews } from "../SlateView.js";

const views = new Map<string, PieceView>();

export function registerViews(all: PieceViews): void {
  for (const [type, view] of Object.entries(all)) views.set(type, view);
}

export const viewOf = (type: string | undefined): PieceView | undefined => (type === undefined ? undefined : views.get(type));
