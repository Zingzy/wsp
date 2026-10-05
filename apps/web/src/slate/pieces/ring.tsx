// SPDX-License-Identifier: AGPL-3.0-only
// A ring is a meter: the same row, label and figure over the track, its formats the meter's.
import type { PieceView } from "../SlateView.js";
import { meter } from "./meter.js";

export const ring: PieceView = { ...meter, type: "ring" };
