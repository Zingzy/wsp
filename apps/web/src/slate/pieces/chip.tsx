// SPDX-License-Identifier: AGPL-3.0-only
import { Chip } from "../../components/ui/chips.js";
import type { PieceView } from "../SlateView.js";
import { SlateIcon } from "./icon.js";
import { str } from "./look.js";

export const chip: PieceView = {
  type: "chip",
  component: ({ props }) => {
    const text = str(props["value"]);
    if (text === undefined || text === "") return null;
    return (
      <span className="inline-flex min-w-0">
        <Chip item={{ text, glyph: <SlateIcon name={props["icon"]} className="size-3" /> }} />
      </span>
    );
  },
};
