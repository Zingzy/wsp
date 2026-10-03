// SPDX-License-Identifier: AGPL-3.0-only
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";

export const empty: PieceView = {
  type: "empty",
  component: ({ props, children }) => {
    const body = str(props["body"]);
    return (
      <Empty className="gap-3 p-4 md:p-6">
        <EmptyHeader>
          <EmptyTitle>{str(props["title"])}</EmptyTitle>
          {body === undefined ? null : <EmptyDescription>{body}</EmptyDescription>}
        </EmptyHeader>
        {children}
      </Empty>
    );
  },
};
