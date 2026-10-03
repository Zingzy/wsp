// SPDX-License-Identifier: AGPL-3.0-only
import ChatMarkdown from "../../components/ChatMarkdown.js";
import { useAppDark } from "../../settings/theme.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";

export const markdown: PieceView = {
  type: "markdown",
  component: function MarkdownPiece({ props }) {
    const dark = useAppDark();
    const value = str(props["value"]);
    return value === undefined || value === "" ? null : <ChatMarkdown text={value} cwd={undefined} resolvedTheme={dark ? "dark" : "light"} restricted className="text-sm" />;
  },
};
