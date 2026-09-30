// SPDX-License-Identifier: AGPL-3.0-only
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerQueue, QUEUE_WORDS } from "./ComposerQueue";

const rows = [
  { id: "a", prompt: "what model are you?\nand which version" },
  { id: "b", prompt: "and the context window?" },
];

function mount(over: Partial<Parameters<typeof ComposerQueue>[0]> = {}) {
  const handlers = { onEdit: vi.fn(), onRemove: vi.fn() };
  const view = render(<ComposerQueue rows={rows} files={{}} next={null} waiting={null} {...handlers} {...over} />);
  return { ...handlers, view };
}

const queued = () => [...document.querySelectorAll<HTMLElement>("[data-queued-id]")];
/** What the queue says, to the eye and to a screen reader: its text and every accessible name it gives. */
const said = (): string => [document.body.textContent ?? "", ...[...document.querySelectorAll("[aria-label]")].map(el => el.getAttribute("aria-label") ?? "")].join("\n");

describe("ComposerQueue", () => {
  it("renders nothing for an empty queue", () => {
    const { container } = render(<ComposerQueue rows={[]} files={{}} next={null} waiting={null} onEdit={() => {}} onRemove={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("is one quiet row for one message: the count, its first line, and Edit and Cancel in words", () => {
    const { onEdit, onRemove } = mount({ rows: [rows[0]!] });
    const row = queued()[0]!;
    expect(row.querySelector("[data-queued-word]")?.textContent).toBe("1 message waiting");
    expect(row.querySelector("[data-queued-text]")?.textContent).toBe("what model are you?");
    expect([...row.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Edit", "Cancel"]);
    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    expect(onEdit).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
    expect(onRemove).toHaveBeenCalledWith("a");
    // Sans in a quiet ink, no box around it, and none of the machine's words.
    expect(document.body.innerHTML).not.toMatch(/font-mono|border-border|bg-card/);
    expect(said()).not.toMatch(/process|turn|exits/i);
  });

  it("says every word, the ones a screen reader reads included, from the one table", () => {
    const words = new Set(Object.values(QUEUE_WORDS).flatMap(w => (typeof w === "string" ? [w as string] : [])));
    mount({ files: { a: [{ id: "f1", name: "notes.md", mediaType: "text/markdown", bytes: "", size: 7 }] } });
    const labels = [...document.querySelectorAll("[aria-label]")].map(el => el.getAttribute("aria-label")!);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter(label => !words.has(label))).toEqual([]);
    expect(said()).not.toMatch(/process|turn|exits/i);
  });

  it("says how many wait for several, and opens to the list, each with its own Edit and Cancel", () => {
    const { onEdit, onRemove } = mount();
    const summary = document.querySelector<HTMLElement>("summary")!;
    expect(summary.querySelector("[data-queued-word]")?.textContent).toBe("2 messages waiting");
    expect(summary.textContent).toContain("what model are you?");
    const list = document.querySelector<HTMLDetailsElement>("details")!;
    expect(list.open).toBe(false);
    fireEvent.click(summary);
    expect(list.open).toBe(true);
    // Open, the head's line is said once, on its own row, not again on the summary.
    expect(summary.querySelector("[data-queued-head]")!.className).toContain("group-open/queue:invisible");
    expect(queued().map(r => r.querySelector("[data-queued-text]")?.textContent)).toEqual(["what model are you?", "and the context window?"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[1]!);
    expect(onEdit).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel queued message" })[0]!);
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("offers no send-now control: Ctrl+Enter in the box is the one road to send now", () => {
    mount();
    expect(screen.queryByRole("button", { name: /send now/i })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows a message's files by name, an image by its thumbnail", () => {
    mount({
      files: {
        b: [
          { id: "f1", name: "notes.md", mediaType: "text/markdown", bytes: "", size: 7 },
          { id: "f2", name: "shot.png", mediaType: "image/png", bytes: "", size: 9, url: "blob:shot" },
        ],
      },
    });
    const [first, second] = queued();
    expect(first!.querySelector("[data-queued-file]")).toBeNull();
    expect(second!.querySelector('[data-queued-file="notes.md"]')?.textContent).toContain("notes.md");
    expect(second!.querySelector<HTMLImageElement>('[data-queued-file="shot.png"] img')?.getAttribute("src")).toBe("blob:shot");
  });

  it("says the message a send-now took is going now, in place of the count", () => {
    mount({ rows: [rows[0]!], next: "a" });
    expect(queued()[0]!.querySelector("[data-queued-word]")?.textContent).toBe(QUEUE_WORDS.sending);
    mount({ next: "a" });
    expect(document.querySelectorAll("summary [data-queued-word]")[0]!.textContent).toBe(QUEUE_WORDS.sending);
  });

  it("keeps why it waits while the workspace is being made on the count's hover", () => {
    mount({ rows: [rows[0]!], waiting: "Sends once beta is up" });
    expect(document.querySelector("[data-queued-word]")!.getAttribute("title")).toBe("Sends once beta is up");
  });
});
