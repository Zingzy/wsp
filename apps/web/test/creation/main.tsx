// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the creation screen in its failed state
// with as many log lines as the query asks for (?lines=20) in either theme
// (?theme=light), so a test can measure what jsdom cannot lay out.
import { createRoot } from "react-dom/client";
import type { Creation, CreationLine } from "../../src/protocol/store";
import { WorkspaceCreation } from "../../src/shell/WorkspaceCreation";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
const count = Number(params.get("lines") ?? "2");
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const MESSAGES = [
  "Fork of the golden image requested.",
  "Machine m1 is booting.",
  "Hostname set to beta.",
  "Waiting for the daemon to answer on its port.",
  "Daemon reachable; preparing the workspace checkout and the harness configuration directory.",
];

const lines: CreationLine[] = Array.from({ length: count }, (_, i) => ({
  stage: i === count - 1 ? "failed" : "machine-booting",
  message: i === count - 1 ? "Sandbox limit reached (2)" : MESSAGES[i % MESSAGES.length]!,
  at: new Date(Date.UTC(2026, 8, 5, 12, 31, i)).toISOString(),
  elapsedMs: 800 * (i + 1),
}));

const creation: Creation = {
  key: "creating:beta",
  name: "beta",
  workspaceId: "ws_beta",
  lines,
  failed: {
    title: "The provider refused: machine cap reached",
    detail: "Your machine provider runs a fixed number of machines at once and every slot is taken. A builder kept after a save and not in use is stopped first to make room; pause or delete a workspace to free one, then try again.",
  },
};

createRoot(document.getElementById("root")!).render(<WorkspaceCreation creation={creation} />);
