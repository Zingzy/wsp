// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerQueue } from "./ComposerQueue";

const rows = [
  { id: "a", prompt: "what model are you?" },
  { id: "b", prompt: "and the context window?" },
];

function mount(over: Partial<Parameters<typeof ComposerQueue>[0]> = {}) {
  const handlers = { onEdit: vi.fn(), onRemove: vi.fn() };
  const view = render(<ComposerQueue rows={rows} files={{}} next={null} {...handlers} {...over} />);
  return { ...handlers, view };
}

const cards = () => [...document.querySelectorAll<HTMLElement>("[data-queued-id]")];

describe("ComposerQueue", () => {
  it("renders nothing for an empty queue", () => {
    const { container } = render(<ComposerQueue rows={[]} files={{}} next={null} onEdit={() => {}} onRemove={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists one card per message in order, its words as text, marked queued, with an edit and a remove", () => {
    const { onEdit, onRemove } = mount();
    expect(cards().map(card => card.querySelector("[data-queued-text]")?.textContent)).toEqual(["what model are you?", "and the context window?"]);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.getAllByText("Queued")).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[1]!);
    expect(onEdit).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove queued message" })[0]!);
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("offers no send-now control on a card: Ctrl+Enter in the box is the one road to send now", () => {
    mount();
    expect(screen.queryByRole("button", { name: /send now/i })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows each card's files by name, an image by its thumbnail", () => {
    mount({
      files: {
        b: [
          { id: "f1", name: "notes.md", mediaType: "text/markdown", bytes: "", size: 7 },
          { id: "f2", name: "shot.png", mediaType: "image/png", bytes: "", size: 9, url: "blob:shot" },
        ],
      },
    });
    const [first, second] = cards();
    expect(first!.querySelector("[data-queued-file]")).toBeNull();
    expect(second!.querySelector('[data-queued-file="notes.md"]')?.textContent).toContain("notes.md");
    expect(second!.querySelector<HTMLImageElement>('[data-queued-file="shot.png"] img')?.getAttribute("src")).toBe("blob:shot");
  });

  it("marks the card going next while a send-now is out, and leaves the rest queued", () => {
    mount({ next: "b" });
    expect(cards()[1]!.textContent).toContain("Next");
    expect(screen.getAllByText("Queued")).toHaveLength(1);
  });
});
