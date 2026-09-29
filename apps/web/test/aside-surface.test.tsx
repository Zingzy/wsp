// SPDX-License-Identifier: AGPL-3.0-only
// The side question's surface in the right panel: the question, the crab and
// Asking until the answer lands, then the answer as markdown, scrolling inside
// the panel when it runs long, and Esc or the close control taking it away.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AsideSurface } from "../src/components/chat/AsideSurface.js";

const q = "which folder are you in, and what did I last ask?";
const at = (k: string) => document.querySelector<HTMLElement>(`[data-k="${k}"]`);

describe("the side question's surface", () => {
  it("is no dialog: the question, then the crab asking, then the answer in place of it", () => {
    const view = render(<AsideSurface question={q} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(at("aside-surface")).not.toBeNull();
    expect(at("aside-surface")?.textContent).toContain("Side question");
    expect(at("aside-question")?.textContent).toBe(q);
    expect(at("aside-asking")?.textContent).toBe("Asking");
    expect(at("aside-asking")?.querySelector("canvas")).not.toBeNull();
    expect(at("aside-answer")).toBeNull();

    view.rerender(<AsideSurface question={q} answer={"Run `pnpm test`, and you asked why the short links 302 twice."} onClose={() => {}} />);
    expect(at("aside-asking")).toBeNull();
    expect(at("aside-answer")?.textContent).toContain("Run pnpm test, and you asked why the short links 302 twice.");
    expect(at("aside-answer")?.querySelector("code")?.textContent).toBe("pnpm test");
  });

  it("says the host's refusal where the answer would be", () => {
    render(<AsideSurface question={q} error="claude takes no side question; send it as a message and the thread keeps it" onClose={() => {}} />);
    expect(at("aside-asking")).toBeNull();
    expect(at("aside-refused")?.textContent).toBe("claude takes no side question; send it as a message and the thread keeps it");
  });

  it("fills the panel and scrolls a long answer inside it, the heading and close control staying put", () => {
    render(<AsideSurface question={q} answer={"line\n\n".repeat(80)} onClose={() => {}} />);
    expect(at("aside-surface")!.className).toMatch(/\bh-full\b|\bflex-1\b/);
    const body = at("aside-body")!;
    expect(body.className).toContain("overflow-y-auto");
    expect(body.className).toContain("flex-1");
  });

  it("closes on Esc and on its close control", async () => {
    const onClose = vi.fn();
    render(<AsideSurface question={q} answer="it is /root" onClose={onClose} />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close side question" }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("leaves an Esc another control already took", async () => {
    const onClose = vi.fn();
    render(<AsideSurface question={q} onClose={onClose} />);
    const taken = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    taken.preventDefault();
    await act(async () => {
      window.dispatchEvent(taken);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});
