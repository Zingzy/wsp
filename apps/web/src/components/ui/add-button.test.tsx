// SPDX-License-Identifier: AGPL-3.0-only
// The one Add: the outline keycap with the plus before its word, the primary
// for a sheet's Add, a spinner in the plus's place while it runs, and held the
// way every keycap is held.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddButton } from "./add-button.js";

afterEach(cleanup);

const button = (name: string): HTMLButtonElement => screen.getByRole("button", { name }) as HTMLButtonElement;
const classes = (name: string): string[] => button(name).className.split(" ");

describe("the shared Add button", () => {
  it("is the outline keycap marked as the Add, the plus before its word", () => {
    render(<AddButton>Add a computer</AddButton>);
    const add = button("Add a computer");
    expect(add.hasAttribute("data-add-button")).toBe(true);
    expect(add.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(add.firstElementChild?.getAttribute("class")).toContain("lucide-plus");
    expect(add.textContent).toBe("Add a computer");
    expect(classes("Add a computer")).toEqual(expect.arrayContaining(["border-input"]));
    expect(classes("Add a computer")).not.toContain("bg-primary");
  });

  it("is the 32 px keycap with a 6 px gap and 13 px words, and the row's xs where asked", () => {
    render(
      <>
        <AddButton>Add a cloud</AddButton>
        <AddButton size="xs">Add a variable</AddButton>
      </>,
    );
    expect(classes("Add a cloud")).toEqual(expect.arrayContaining(["sm:h-8", "gap-1.5", "sm:text-[13px]"]));
    expect(classes("Add a variable")).toEqual(expect.arrayContaining(["sm:h-6", "gap-1", "sm:text-xs"]));
    expect(classes("Add a variable")).not.toContain("gap-1.5");
  });

  it("is the primary for a sheet's Add, and presses", () => {
    const press = vi.fn();
    render(
      <AddButton primary onClick={press}>
        Add
      </AddButton>,
    );
    expect(classes("Add")).toContain("bg-primary");
    fireEvent.click(button("Add"));
    expect(press).toHaveBeenCalledOnce();
  });

  it("holds as every keycap holds, and a spinner stands in the plus's place while it runs", () => {
    render(
      <AddButton primary held busy>
        Adding
      </AddButton>,
    );
    const add = button("Adding");
    expect(add.disabled).toBe(true);
    expect(add.hasAttribute("data-held")).toBe(true);
    expect(add.querySelector("[data-k=adding-spinner]")).not.toBeNull();
    expect(add.querySelector(".lucide-plus")).toBeNull();
  });
});
