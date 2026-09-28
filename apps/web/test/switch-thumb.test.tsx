// SPDX-License-Identifier: AGPL-3.0-only
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Switch } from "../src/components/ui/switch.js";

describe("a switch", () => {
  it("draws its knob in its theme's solid ink, on or off, since the window's background is transparent", () => {
    const { container } = render(<Switch aria-label="sound" checked onCheckedChange={() => {}} />);
    const thumb = container.querySelector('[data-slot="switch-thumb"]')!;
    expect(thumb.className).toMatch(/\bdata-checked:bg-primary-foreground\b/);
    expect(thumb.className).not.toMatch(/\bbg-background\b/);
  });
});
