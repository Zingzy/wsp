// SPDX-License-Identifier: AGPL-3.0-only
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstRun } from "./FirstRun.js";
import { useStore } from "../protocol/store.js";
import type { BootPayload } from "@wsp/protocol";
import { useSettingsStore } from "../settings/settingsStore.js";
import { FIRST_RUN_WORDS } from "../sidebar/words.js";
import { onAddProjectRequest } from "./shellRequests.js";

const k = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[data-k=${name}]`)!;

afterEach(() => {
  cleanup();
  useStore.setState({ places: [] });
});

describe("the first run", () => {
  it("is an empty state: the title, what a project is, and one button, with no field of its own beside the line about usage counts", () => {
    useStore.setState({ places: [{ id: "here", kind: "computer", name: "studio.local", label: "zingzy's MacBook Pro", default: true }] });
    render(<FirstRun />);
    expect(k("title").textContent).toBe(FIRST_RUN_WORDS.title);
    expect(k("sentence").textContent).toBe("A project is a git repo on zingzy's MacBook Pro. Every piece of work on it gets its own copy.");
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect([...document.querySelectorAll("button")].map(b => b.dataset["k"])).toEqual(["add-project", "privacy"]);
    expect(k("add-project").textContent).toBe(FIRST_RUN_WORDS.add);
    expect(document.body.textContent).not.toMatch(/image|account|sign in|size/i);
  });

  it("says no stand-in for the computer's name before the places list has it: the sentence waits for the name", () => {
    useStore.setState({ places: [] });
    render(<FirstRun />);
    expect(k("sentence").textContent).toBe("");
    expect(document.body.textContent).not.toMatch(/this (computer|Mac)/i);
  });

  it("asks for the Add a project dialog on a click, which the sidebar answers", () => {
    const heard = vi.fn();
    const off = onAddProjectRequest(heard);
    render(<FirstRun />);
    fireEvent.click(k("add-project"));
    expect(heard).toHaveBeenCalledTimes(1);
    off();
  });

  it("says usage counts go to PostHog, and its one quiet act opens Settings on Privacy", () => {
    render(<FirstRun />);
    expect(k("product-usage").textContent).toBe("wsp sends anonymous usage counts to PostHog. Privacy settings");
    fireEvent.click(k("privacy"));
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "privacy" });
    act(() => useStore.getState().closeSettings());
  });

  it("says nothing about usage counts on a build with no key or where the host's environment holds them off", () => {
    for (const why of ["build", "env"] as const) {
      (window as unknown as { __WSP__?: BootPayload }).__WSP__ = { wsPath: "/ws", paired: true, version: "0.2.0", productUsageOff: why };
      try {
        render(<FirstRun />);
        expect(document.querySelector("[data-k=product-usage]")).toBeNull();
      } finally {
        delete (window as unknown as { __WSP__?: BootPayload }).__WSP__;
        cleanup();
      }
    }
  });
});
