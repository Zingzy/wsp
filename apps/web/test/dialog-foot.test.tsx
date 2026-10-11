// SPDX-License-Identifier: AGPL-3.0-only
// The shared dialogs every confirm and sheet in the app is built on: their foot holds the buttons and no
// keycap, and Esc still closes them.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscardDialog } from "../src/diffs/DiscardDialog.js";
import { SnoozeDialog } from "../src/sidebar/SnoozeDialog.js";

afterEach(cleanup);

describe("the shared alert dialog", () => {
  it("draws no keycap in its foot, and Esc closes it", async () => {
    const onClose = vi.fn();
    render(<DiscardDialog name="src/app.ts" deletes={false} onDiscard={async () => {}} onClose={onClose} />);
    const dialog = await screen.findByRole("alertdialog");
    const foot = dialog.querySelector('[data-slot="alert-dialog-footer"]');
    expect(foot).not.toBeNull();
    expect(dialog.querySelector("kbd")).toBeNull();
    expect([...foot!.children].map(child => child.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe("the shared plain dialog", () => {
  it("draws no keycap in its foot, and Esc closes it", async () => {
    const onCancel = vi.fn();
    render(<SnoozeDialog onSnooze={() => {}} onCancel={onCancel} />);
    const dialog = await screen.findByRole("dialog");
    const foot = dialog.querySelector('[data-slot="dialog-footer"]');
    expect(foot).not.toBeNull();
    expect(dialog.querySelector("kbd")).toBeNull();
    expect([...foot!.children].map(child => child.tagName)).toEqual(["BUTTON", "BUTTON"]);
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
