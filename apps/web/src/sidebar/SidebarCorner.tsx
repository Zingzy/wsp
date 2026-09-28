// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's bottom-left corner: a row of icon buttons, Settings first, its
// chord on the tooltip. Settings stands here whatever else the corner holds,
// so it is never reachable only by a chord nobody was told about.
import { SettingsIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useStore } from "../protocol/store.js";
import { SETTINGS_WORDS } from "../settings/format.js";
import { useShortcutLabel } from "../shell/useKeybindings.js";

export function SidebarCorner() {
  const openSettings = useStore(s => s.openSettings);
  const chord = useShortcutLabel("settings.toggle");
  return (
    <div data-sidebar-corner className="flex items-center gap-1 px-0.5">
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost-muted" size="icon-sm" data-k="settings-row" aria-label={SETTINGS_WORDS.title} onClick={openSettings} />}>
          <SettingsIcon aria-hidden />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {SETTINGS_WORDS.title}
          {chord === null ? null : <span className="ms-2 font-mono text-muted-foreground">{chord}</span>}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
