// SPDX-License-Identifier: AGPL-3.0-only
import ChatMarkdown from "../../components/ChatMarkdown.js";
import { useAppDark } from "../../settings/theme.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";

/** The pull request pane's description, bold at 500 and code spans on the accent at radius 6. */
const PR_BODY = "pr-md [&_strong]:!font-medium [&_:not(pre)>code]:!rounded-md [&_:not(pre)>code]:!bg-accent";

export const markdown: PieceView = {
  type: "markdown",
  component: function MarkdownPiece({ props }) {
    const dark = useAppDark();
    const value = str(props["value"]);
    return value === undefined || value === "" ? null : <ChatMarkdown text={value} cwd={undefined} resolvedTheme={dark ? "dark" : "light"} restricted noImages className={PR_BODY} />;
  },
};
