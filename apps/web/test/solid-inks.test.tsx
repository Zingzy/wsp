// SPDX-License-Identifier: AGPL-3.0-only
// The translucent window sets --background transparent in dark Mac settings and the inline panel, so an ink that
// has to show there over a fill takes a solid theme token. jsdom computes no Tailwind colours, so these pin classes.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "../src/components/ui/checkbox.js";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "../src/components/ui/menu.js";

describe("inks over a fill", () => {
  it("a checked neutral checkbox draws its tick in the chrome's solid ground, not the page's background", () => {
    const { container } = render(<Checkbox tone="neutral" aria-label="pick" checked onCheckedChange={() => {}} />);
    const tick = container.querySelector('[data-slot="checkbox-indicator"]')!;
    expect(tick.className).toMatch(/\btext-\(--app-chrome-background\)/);
    expect(tick.className).not.toMatch(/\btext-background\b/);
  });

  it("a menu's switch draws its knob in the theme's foreground, and in the primary's pair when on", () => {
    render(
      <Menu open>
        <MenuTrigger>open</MenuTrigger>
        <MenuPopup>
          <MenuCheckboxItem variant="switch" checked>
            sound
          </MenuCheckboxItem>
        </MenuPopup>
      </Menu>,
    );
    const knob = screen.getByRole("menuitemcheckbox").querySelector("span.pointer-events-none")!;
    expect(knob.className).toMatch(/(^|\s)bg-foreground(\s|$)/);
    expect(knob.className).toMatch(/in-\[\[data-slot=menu-checkbox-item\]\[data-checked\]\]:bg-primary-foreground/);
    expect(knob.className).not.toMatch(/(^|\s)bg-background(\s|$)/);
  });
});
