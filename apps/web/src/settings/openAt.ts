// SPDX-License-Identifier: AGPL-3.0-only
import { useStore } from "../protocol/store.js";
import { useSettingsStore } from "./settingsStore.js";

/** One project's page in Settings, where its glyph and hue are picked: the switcher's gear and the row's menu both. */
export function openProjectSettings(projectId: string): void {
  useSettingsStore.getState().go({ kind: "project", id: projectId });
  useStore.getState().openSettings();
}
