// SPDX-License-Identifier: AGPL-3.0-only
// Settings > About: the two halves of one release that can run apart, one
// line each, and the road to the next release under them. A browser tab has
// no shell half and shows the host's line alone.
import { Button } from "../components/ui/button.js";
import { RELEASES } from "../../../../packages/wspx/scripts/bundles.mjs";
import { ABOUT_WORDS } from "./format.js";
import type { SettingsCardData, SettingsLineData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

export function aboutCards(ctx: SettingsContext): SettingsCardData[] {
  const { inShell, app, host } = ctx.shell;
  const lines: SettingsLineData[] = [
    ...(inShell ? [{ kind: "line" as const, id: "app-version", label: ABOUT_WORDS.app, value: app ?? ABOUT_WORDS.unknown, hover: ABOUT_WORDS.appHover, attrs: { "data-k": "app-version" } }] : []),
    { kind: "line", id: "host-version", label: ABOUT_WORDS.host, value: host ?? ABOUT_WORDS.unknown, hover: ABOUT_WORDS.hostHover, attrs: { "data-k": "host-version" } },
  ];
  return [
    {
      id: "about",
      items: lines,
      under: (
        <Button size="xs" variant="outline" data-k="releases" onClick={() => window.open(RELEASES, "_blank", "noopener,noreferrer")}>
          {ABOUT_WORDS.releases}
        </Button>
      ),
    },
  ];
}
