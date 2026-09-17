// SPDX-License-Identifier: AGPL-3.0-only
// Served by Vite to a real browser: the new-workspace dialog in either theme
// (?theme=light) with two projects to pick from, the one on the provider
// checked so its three sizes are drawn, so a test can lay out and photograph
// the Project control, its caption and the size rows. With ?refusal=<sentence>
// the keycap is held and that sentence is its tooltip, which is the dialog
// while the image is still building; with ?projects=none the dialog has no
// project to make a workspace of.
import { createRoot } from "react-dom/client";
import type { PlaceView, ProjectView } from "@wsp/protocol";
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

const HERE: PlaceView = { id: "here", kind: "computer", name: "studio.local", default: false, shape: { cpu: 8, memMb: 16384 }, engine: "none", present: true, takesForks: false };
const HETZNER: PlaceView = { id: "p_1", kind: "computer", name: "hetzner", default: false, shape: { cpu: 2, memMb: 4096 }, engine: "docker", present: true, takesForks: true, forks: { running: 0, room: 3 } };
const ASCII: PlaceView = { id: "box", kind: "provider", name: "box", default: true, rateUsdPerHour: 0.018, sizes: SIZES, takesForks: true };

const project = (id: string, name: string, computer: string): ProjectView => ({
  id,
  name,
  computer,
  source: { kind: "git", url: `https://github.com/dev/${name}.git` },
  path: `/root/${name}`,
  createdAt: "2026-09-12T09:31:00.000Z",
});
const places = [HERE, HETZNER, ASCII];
const projects = params.get("projects") === "none" ? [] : [project("pr_1", "spoo-landing", "box"), project("pr_2", "wsp", "p_1")];

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <NewWorkspaceDialog
      initialName="workspace-3"
      places={places}
      projects={projects}
      copies={[{ place: "box", version: 1, snapshotId: "snap_box", builtAt: "2026-09-12T09:31:00.000Z" }]}
      goldenSize={{ cpu: 2, memMb: 4096 }}
      refusal={params.get("refusal")}
      onCreate={() => {}}
      onCancel={() => {}}
      onAddComputer={() => {}}
    />
  </TooltipProvider>,
);
