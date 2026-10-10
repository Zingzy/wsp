// SPDX-License-Identifier: AGPL-3.0-only
// Settings > General's Logs card: the desktop app's Open logs, asked of the
// shell, and nothing where no shell can open the folder.
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GENERAL_WORDS } from "../src/settings/format.js";
import { descriptionOf, mountSettings, resetSettings, rowOf, settingsApi, settle } from "./settings-harness.js";
import { lastNotice } from "./notice-text.js";

beforeEach(() => {
  resetSettings();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  delete window.wsp;
});

const general = async (): Promise<void> => {
  mountSettings({ api: settingsApi({ editorList: async () => [] }).api, at: { kind: "group", group: "general" } });
  await settle();
};

describe("Settings > General's logs", () => {
  it("in the desktop app, Open logs asks the shell to open the folder", async () => {
    const openLogs = vi.fn(async () => {});
    window.wsp = { openLogs };
    await general();
    expect(rowOf("app-logs")?.querySelector("[data-settings-title]")?.textContent).toBe(GENERAL_WORDS.appLogs);
    expect(descriptionOf("app-logs")).toBe(GENERAL_WORDS.appLogsDescription);
    fireEvent.click(rowOf("app-logs")!.querySelector<HTMLElement>("[data-k=open-logs]")!);
    expect(openLogs).toHaveBeenCalledOnce();
  });

  it("a folder the shell could not open is said as a notice", async () => {
    window.wsp = { openLogs: async () => Promise.reject(new Error("no file manager to open /home/dev/.wsp/logs")) };
    await general();
    fireEvent.click(rowOf("app-logs")!.querySelector<HTMLElement>("[data-k=open-logs]")!);
    await settle();
    expect(lastNotice()).toContain("no file manager to open /home/dev/.wsp/logs");
  });

  it("draws no row in a browser tab, or in a shell from before the app kept a log", async () => {
    await general();
    expect(rowOf("app-logs")).toBeNull();
    cleanup();
    window.wsp = { loginStart: async () => true };
    await general();
    expect(rowOf("app-logs")).toBeNull();
  });
});
