// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the new-workspace dialog in either theme
// (?theme=light) with two rows to pick from, the provider's checked so its
// three sizes are drawn, so a test can lay out and photograph the Where
// control, its caption and the size rows. With ?refusal=<sentence> the keycap is held and
// that sentence is its tooltip, which is the dialog while the image is still
// building; with ?places=none the dialog has nowhere to put a workspace.
import { createRoot } from "react-dom/client";
import type { PlaceView } from "@wsp/protocol";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { NewWorkspaceDialog } from "../../src/sidebar/NewWorkspaceDialog";
import "../../src/index.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.classList.toggle("dark", params.get("theme") !== "light");

const SIZES = [
  { cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 },
  { cpu: 2, memMb: 8192, rateUsdPerHour: 0.15 },
  { cpu: 4, memMb: 16_384, rateUsdPerHour: 0.29 },
];

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, shape: { cpu: 8, memMb: 16384 }, docker: false, present: true };
const HETZNER: PlaceView = { id: "p_1", kind: "computer", name: "hetzner", default: false, shape: { cpu: 2, memMb: 4096 }, docker: true, present: true, forks: { running: 0, room: 3 } };
const ASCII: PlaceView = { id: "box", kind: "provider", name: "box", default: true, rateUsdPerHour: 0.018 };

const places = params.get("places") === "none" ? [HERE] : [HERE, HETZNER, ASCII];

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <NewWorkspaceDialog
      initialName="workspace-3"
      places={places}
      copies={[{ place: "box", version: 1, snapshotId: "snap_box", builtAt: "2026-09-12T09:31:00.000Z" }]}
      sizes={SIZES}
      goldenSize={{ cpu: 2, memMb: 4096 }}
      refusal={params.get("refusal")}
      onCreate={() => {}}
      onCancel={() => {}}
      onAddComputer={() => {}}
    />
  </TooltipProvider>,
);
