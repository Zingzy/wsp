// SPDX-License-Identifier: AGPL-3.0-only
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TodoCard } from "../src/components/chat/TodoCard.js";

const steps = [
  { text: "Read the ticket", state: "done" as const },
  { text: "Write the red test", state: "done" as const },
  { text: "Make it pass", state: "working" as const },
  { text: "Run the suite", state: "pending" as const },
  { text: "Open the pull request", state: "pending" as const },
];

describe("the step list", () => {
  it("heads the list in the section caps with the count done, one 14px row per step, and no tone", () => {
    const { container } = render(<TodoCard steps={steps} />);
    const header = container.querySelector<HTMLElement>("[data-todo-header]")!;
    expect([...header.children].map(c => c.textContent)).toEqual(["Steps", "2 of 5 done"]);
    const caps = header.children[0] as HTMLElement;
    for (const word of ["font-mono", "uppercase", "text-[11px]", "tracking-[0.12em]", "text-muted-foreground"]) expect(caps.className).toContain(word);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-todo-step]")];
    expect(rows.map(r => [r.textContent, r.dataset["todoStep"]])).toEqual(steps.map(s => [s.text, s.state]));
    for (const row of rows) expect(row.className).toContain("text-sm");
    // Done rows are muted and carry the check; the working row is the one at weight 500; pending rows are muted.
    expect(rows[0]!.className).toContain("text-muted-foreground");
    expect(rows[0]!.querySelector("svg")).not.toBeNull();
    expect(rows[2]!.className).toContain("font-medium");
    expect(rows[2]!.className).toContain("text-foreground");
    expect(rows[2]!.querySelector("svg")).toBeNull();
    expect(rows[3]!.className).toContain("text-muted-foreground");
    expect(rows[3]!.className).not.toContain("font-medium");
    // No colour stands for a state.
    expect(container.innerHTML).not.toMatch(/status-|text-success|text-warning|bg-/);
  });
});
