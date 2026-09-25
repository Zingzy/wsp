// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Privacy: what this wsp asks of a service outside the person's
// computers, each as one switch.
import { DEFAULT_PREFERENCES, type Preferences, type PreferencesPatch } from "@wsp/protocol";
import { Switch } from "../components/ui/switch.js";
import { PRIVACY_WORDS } from "./format.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

export const PRIVACY_DEFAULTS: PreferencesPatch = { serverIcons: DEFAULT_PREFERENCES.serverIcons };

export const privacyOffDefaults = (p: Preferences): boolean => p.serverIcons !== DEFAULT_PREFERENCES.serverIcons;

export function privacyCards(ctx: SettingsContext): SettingsCardData[] {
  const { preferences, setPreferences } = ctx;
  return [
    {
      id: "asks",
      items: [
        {
          kind: "row",
          id: "server-icons",
          title: PRIVACY_WORDS.serverIcons,
          description: PRIVACY_WORDS.serverIconsDescription,
          control: <Switch data-k="server-icons" aria-label={PRIVACY_WORDS.serverIcons} checked={preferences.serverIcons} onCheckedChange={serverIcons => setPreferences({ serverIcons })} />,
        },
      ],
    },
  ];
}
