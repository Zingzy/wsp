// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the new-workspace dialog in either theme
// (?theme=light) over the two sizes a Starter account offers, the golden's
// own checked, so a test can lay out and photograph the size row. With
// ?refusal=<sentence> the keycap is held and that sentence is its tooltip,
// which is the dialog while the image is still building.
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { NewWorkspaceDialog } from "../../src/sidebar/NewWorkspaceDialog";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const SIZES = [
  { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
  { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
];

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <NewWorkspaceDialog initialName="workspace-3" sizes={SIZES} goldenSize={{ cpu: 2, memMb: 4096 }} refusal={params.get("refusal")} onCreate={() => {}} onCancel={() => {}} />
  </TooltipProvider>,
);
