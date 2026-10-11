// SPDX-License-Identifier: AGPL-3.0-only
// This computer with one project whose folder holds conversations its agents kept outside wsp: three Claude Code
// conversations from a terminal, one of them still open there, and two Codex threads, one of them wsp's own. What
// the palette's page of a project's conversations, a pick held on its New thread page and the confirm for one open
// in another app are photographed on.
import { HERE_PLACE_ID as HERE } from "@wsp/protocol";
import { project, store } from "../fixture-kit.mjs";

export default {
  build: () => store({ projects: [project("spoo", HERE, 60 * 20)], workspaces: [] }),
  repos: ["spoo"],
  conversations: () => [
    { agent: "claude", project: "spoo", id: "2025c1a0-0000-4aaa-8bbb-000000000001", title: "Short links redirect twice", firstPrompt: "Why do the short links 302 twice before they land?", branch: "fix/double-redirect", minutes: 12, bytes: 1_310_720, live: true },
    { agent: "codex", project: "spoo", id: "codex-cart-rounding", title: "Cart total rounding", firstPrompt: "round the cart total once, at the end", branch: "main", minutes: 95, bytes: 404_480 },
    { agent: "claude", project: "spoo", id: "2025c1a0-0000-4aaa-8bbb-000000000002", firstPrompt: "Add a QR code to every short link page", branch: "feat/qr-codes", minutes: 60 * 5, bytes: 3_250_585 },
    { agent: "codex", project: "spoo", id: "codex-clicks-migration", firstPrompt: "write the migration for the clicks table", branch: "main", minutes: 60 * 26, bytes: 88_064, wsp: true },
    { agent: "claude", project: "spoo", id: "2025c1a0-0000-4aaa-8bbb-000000000003", title: "Pricing page copy", firstPrompt: "Tighten the pricing page copy, three tiers", branch: "main", minutes: 60 * 24 * 3, bytes: 742_400 },
  ],
};
