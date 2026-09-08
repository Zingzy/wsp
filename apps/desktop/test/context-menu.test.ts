// SPDX-License-Identifier: AGPL-3.0-only
// The native context menu from the page's items: one row each in the page's
// order, a separator where the group changes, disabled rows dimmed with their
// refusal as hover text and the chord in Electron's spelling, and the answer
// the popup gives back: the row clicked, or null when the menu closed on
// nothing. Only the page's own shape is accepted off the wire. The workspace
// menu the smoke expects is derived from the page's registry through that same
// builder, so it is checked here that the derivation is the registry's order.
import type { ContextMenuItem, WorkspaceView } from "@wsp/protocol";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { chooseFrom, contextMenuTemplate, parseContextMenuItems } from "../src/context-menu.js";
import { WORKSPACE_WORDS } from "../../web/src/actions/format.js";
import { workspaceActions, workspaceTarget } from "../../web/src/actions/workspaceActions.js";
import { SEPARATOR, workspaceMenuShape } from "./workspace-menu.js";

const ITEMS: ContextMenuItem[] = [
  { id: "phase", label: "Pause workspace", group: "state", enabled: true },
  { id: "rebuild", label: "Rebuild machine", group: "state", enabled: false, refusal: "Rebuild replaces a gone or zombie machine; this one answers" },
  { id: "open-terminal", label: "Open terminal", group: "open", enabled: true, shortcut: "⌘J", accelerator: "CommandOrControl+J" },
  { id: "forget", label: "Forget workspace", group: "remove", enabled: false, refusal: "Only a workspace whose machine is gone can be forgotten; this one is running", destructive: true },
];

const clickOf = (template: MenuItemConstructorOptions[], label: string) => template.find(row => row.label === label)!.click!;
const fakeClick = (): [MenuItem: import("electron").MenuItem, window: undefined, event: import("electron").KeyboardEvent] => [{} as import("electron").MenuItem, undefined, {} as import("electron").KeyboardEvent];

describe("contextMenuTemplate", () => {
  it("keeps the page's order, parts the groups with separators, dims a refused row with its refusal as hover text and carries the accelerator", () => {
    const choose = vi.fn();
    const template = contextMenuTemplate(ITEMS, choose);
    expect(template.map(row => row.type === "separator" ? "---" : `${row.label}${row.enabled === false ? " (off)" : ""}`)).toEqual([
      "Pause workspace",
      "Rebuild machine (off)",
      "---",
      "Open terminal",
      "---",
      "Forget workspace (off)",
    ]);
    expect(template[1]).toMatchObject({ enabled: false, toolTip: "Rebuild replaces a gone or zombie machine; this one answers" });
    expect(template[0]).not.toHaveProperty("toolTip");
    expect(template[0]).not.toHaveProperty("accelerator");
    expect(template[3]).toMatchObject({ accelerator: "CommandOrControl+J" });
    clickOf(template, "Open terminal")(...fakeClick());
    expect(choose).toHaveBeenCalledWith("open-terminal");
  });
});

describe("chooseFrom", () => {
  it("answers with the row clicked", async () => {
    const chosen = chooseFrom(ITEMS, (template, _onClose) => {
      clickOf(template, "Pause workspace")(...fakeClick());
    });
    await expect(chosen).resolves.toBe("phase");
  });

  it("answers null when the menu closed on nothing", async () => {
    await expect(chooseFrom(ITEMS, (_template, onClose) => onClose())).resolves.toBeNull();
  });

  it("a click that lands after the close still wins: the close waits a turn for it", async () => {
    const chosen = chooseFrom(ITEMS, (template, onClose) => {
      onClose();
      clickOf(template, "Open terminal")(...fakeClick());
    });
    await expect(chosen).resolves.toBe("open-terminal");
  });
});

describe("parseContextMenuItems", () => {
  it("accepts the page's items and refuses anything else off the wire", () => {
    expect(parseContextMenuItems(ITEMS)).toEqual(ITEMS);
    expect(() => parseContextMenuItems("nope")).toThrow("menu:context: not a list of items");
    expect(() => parseContextMenuItems([{ id: 1, label: "x", group: "g", enabled: true }])).toThrow("menu:context: not a list of items");
    expect(() => parseContextMenuItems([{ id: "x", label: "x", group: "g", enabled: true, refusal: 3 }])).toThrow("menu:context: not a list of items");
  });
});

describe("the workspace menu the smoke expects", () => {
  const RUNNING: WorkspaceView = {
    id: "ws_a",
    name: "first",
    machineId: "m_ws_a",
    phase: "running",
    golden: "snap_g",
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  it("is the workspace registry's own words in its own order, with a separator wherever the group changes", () => {
    const target = workspaceTarget(RUNNING, null);
    const shape = workspaceMenuShape(RUNNING);
    expect(shape.filter(row => row !== SEPARATOR)).toEqual(workspaceActions.map(entry => entry.title(target)));
    const groups = workspaceActions.map(entry => entry.group);
    expect(shape.filter(row => row === SEPARATOR)).toHaveLength(groups.filter((group, i) => i > 0 && groups[i - 1] !== group).length);
    // Read straight through, so a separator in the wrong place is a failure and not only a wrong count. The words
    // are named by key from the one table that holds them, never spelled again here.
    expect(shape).toEqual([
      WORKSPACE_WORDS.pause,
      WORKSPACE_WORDS.rebuild,
      SEPARATOR,
      WORKSPACE_WORDS.newThread,
      WORKSPACE_WORDS.openTerminal,
      WORKSPACE_WORDS.openBrowser,
      WORKSPACE_WORDS.openMachine,
      SEPARATOR,
      WORKSPACE_WORDS.importProject,
      WORKSPACE_WORDS.exportProject,
      SEPARATOR,
      WORKSPACE_WORDS.rename,
      WORKSPACE_WORDS.colour,
      WORKSPACE_WORDS.icon,
      WORKSPACE_WORDS.fork,
      SEPARATOR,
      WORKSPACE_WORDS.copyId,
      SEPARATOR,
      WORKSPACE_WORDS.forget,
    ]);
  });

  it("follows the registry: an action added to it lands in the shape without this file or the smoke changing", () => {
    const before = workspaceMenuShape(RUNNING);
    const added = [...workspaceActions, { ...workspaceActions[0]!, id: "invented", group: "invented", title: () => "Invented" }];
    const target = workspaceTarget(RUNNING, null);
    const shape = contextMenuTemplate(
      added.map(entry => ({ id: entry.id, label: entry.title(target), group: entry.group, enabled: true })),
      () => {},
    ).map(row => (row.type === "separator" ? SEPARATOR : String(row.label)));
    expect(shape).toEqual([...before, SEPARATOR, "Invented"]);
  });
});
