// SPDX-License-Identifier: AGPL-3.0-only
// The sheet a side question opens: the question as the person's own row, the
// crab and Asking until the answer lands, the answer as markdown, and Esc or
// Close taking the whole of it away.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AsideSheet } from "../src/components/chat/AsideSheet.js";

const q = "which folder are you in, and what did I last ask?";
const at = (k: string) => document.querySelector<HTMLElement>(`[data-k="${k}"]`);

describe("the side question's sheet", () => {
  it("shows the question as the person's row and the crab asking, then the answer in place of it", () => {
    const view = render(<AsideSheet question={q} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(at("aside-question")?.textContent).toBe(q);
    expect(at("aside-asking")?.textContent).toBe("Asking");
    expect(at("aside-asking")?.querySelector("canvas")).not.toBeNull();
    expect(at("aside-answer")).toBeNull();

    view.rerender(<AsideSheet question={q} answer={"Run `pnpm test`, and you asked why the short links 302 twice."} onClose={() => {}} />);
    expect(at("aside-asking")).toBeNull();
    expect(at("aside-answer")?.textContent).toContain("Run pnpm test, and you asked why the short links 302 twice.");
    expect(at("aside-answer")?.querySelector("code")?.textContent).toBe("pnpm test");
  });

  it("says the host's refusal where the answer would be", () => {
    render(<AsideSheet question={q} error="claude takes no side question; send it as a message and the thread keeps it" onClose={() => {}} />);
    expect(at("aside-asking")).toBeNull();
    expect(at("aside-refused")?.textContent).toBe("claude takes no side question; send it as a message and the thread keeps it");
  });

  it("closes on Esc and on Close", async () => {
    const onClose = vi.fn();
    const view = render(<AsideSheet question={q} answer="it is /root" onClose={onClose} />);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(<AsideSheet question={q} answer="it is /root" onClose={onClose} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
