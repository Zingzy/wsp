// SPDX-License-Identifier: AGPL-3.0-only
// The bell at the right of the header row and the list of notices it opens:
// the unread count, the rows newest first at one height, the read on open and
// Clear all.
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/components/DiffWorkerPoolProvider.js", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { useStore } from "../src/protocol/store.js";
import { FIRST_PAGE, useSettingsStore } from "../src/settings/settingsStore.js";
import { AppShell } from "../src/shell/AppShell.js";
import { BELL_WORDS } from "../src/notices/NoticesBell.js";
import { addNotice, useNotices } from "../src/notices/store.js";

beforeEach(() => {
  window.localStorage.clear();
  useStore.setState({ api: null, conn: "live", capabilities: null, workspaces: [], statuses: {}, selectedId: null, sessions: {}, ready: false, settingsOpen: false, places: [], projects: [], preferences: DEFAULT_PREFERENCES });
  act(() => useNotices.getState().clear());
  useSettingsStore.setState({ at: FIRST_PAGE });
});

afterEach(() => {
  act(() => useNotices.getState().clear());
});

const mount = () =>
  render(
    <AppShell>
      <div>center content</div>
    </AppShell>,
  );
const bell = (): HTMLElement => document.querySelector<HTMLElement>("[data-k=notices-bell]")!;
const count = (): HTMLElement | null => bell().querySelector<HTMLElement>("[data-k=notices-unread]");
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>("[data-notices-list] [data-notice-row]")];

describe("the notices bell", () => {
  it.each([false, true])("stands at the right end of the header row, Settings open %s", settingsOpen => {
    useStore.setState({ settingsOpen });
    mount();
    const header = document.querySelector<HTMLElement>("[data-shell-center] header")!;
    expect(header.contains(bell())).toBe(true);
    const buttons = [...header.querySelectorAll("button")];
    expect(buttons.at(-1)).toBe(bell());
  });

  it("shows no count at zero, and the unread count in tabular figures once notices arrive", () => {
    mount();
    expect(count()).toBeNull();
    expect(bell().getAttribute("aria-label")).toBe(BELL_WORDS.label);
    act(() => {
      for (const text of ["one", "two", "three"]) addNotice({ kind: "note", text });
    });
    expect(count()!.textContent).toBe("3");
    expect(count()!.className).toContain("tabular-nums");
    expect(bell().getAttribute("aria-label")).toBe(BELL_WORDS.unread(3));
  });

  it("lists every notice newest first in rows of one height, the toast long gone, and opening reads them", async () => {
    mount();
    act(() => {
      addNotice({ kind: "error", text: "spoo was not paused: the provider refused", where: "spoo" });
      addNotice({ kind: "done", text: "Image sealed", action: { word: "Open", run: () => {} } });
      addNotice({ kind: "note", text: "A newer wsp is out" });
      useNotices.getState().dismiss(useNotices.getState().toasts[0]!);
    });
    fireEvent.click(bell());
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map(r => r.querySelector("[data-notice-row-text]")!.textContent)).toEqual(["A newer wsp is out", "Image sealed", "spoo was not paused: the provider refused"]);
    expect(new Set(rows().map(r => r.className.split(" ").find(c => /^h-\d+$/.test(c))))).toEqual(new Set(["h-18"]));
    expect(rows().every(r => r.querySelector("[data-notice-row-action]") !== null)).toBe(true);
    expect(rows()[1]!.querySelector("[data-notice-row-action] button")!.textContent).toBe("Open");
    expect(useNotices.getState().unread).toBe(0);
    expect(count()).toBeNull();
  });

  it("runs a row's action and shuts the list", async () => {
    mount();
    const run = vi.fn();
    act(() => void addNotice({ kind: "error", text: "pricing page stopped before it replied", action: { word: "Open", run } }));
    fireEvent.click(bell());
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(rows()[0]!.querySelector("[data-notice-row-action] button")!);
    expect(run).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.querySelector("[data-notices-list]")).toBeNull());
  });

  it("Clear all leaves Nothing yet, which is also what it says before any notice", async () => {
    mount();
    fireEvent.click(bell());
    await waitFor(() => expect(document.querySelector("[data-k=notices-empty]")?.textContent).toBe(BELL_WORDS.empty));
    expect(document.querySelector("[data-k=notices-clear]")).toBeNull();
    act(() => {
      addNotice({ kind: "note", text: "one" });
      addNotice({ kind: "note", text: "two" });
    });
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(document.querySelector<HTMLElement>("[data-k=notices-clear]")!);
    await waitFor(() => expect(document.querySelector("[data-k=notices-empty]")?.textContent).toBe(BELL_WORDS.empty));
    expect(rows()).toHaveLength(0);
    expect(useNotices.getState().notices).toEqual([]);
  });
});
