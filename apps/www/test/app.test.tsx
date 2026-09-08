// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { INSTALL } from "../src/links";

describe("the landing page", () => {
  it("renders the promise, the install command and the three verbs", () => {
    render(<App />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Give every agent");
    expect(screen.getAllByText(INSTALL).length).toBeGreaterThanOrEqual(2);
    for (const verb of ["wsp init", "wsp fork", "wsp thread"]) {
      expect(screen.getAllByText(verb).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("copies the install command to the clipboard and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<App />);
    const [button] = screen.getAllByRole("button", { name: `Copy ${INSTALL}` });
    fireEvent.click(button!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(INSTALL));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Copied" }).length).toBe(1));
  });

  it("carries no em-dash anywhere a visitor reads", () => {
    const { container } = render(<App />);
    expect(container.textContent).not.toContain("—");
  });
});
