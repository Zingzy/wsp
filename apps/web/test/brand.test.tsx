// SPDX-License-Identifier: AGPL-3.0-only
// The brand components render the same paths the .svg files carry, and the
// favicon is the mark in a fixed zinc.
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Lockup, Mark } from "../src/brand/Brand.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const pathsOf = (svg: string) =>
  [...new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("path")].map(p => p.getAttribute("d"));
const renderedPaths = (el: HTMLElement) => [...el.querySelectorAll("path")].map(p => p.getAttribute("d"));

describe("brand", () => {
  it("the lockup is named wsp and draws lockup.svg's paths", () => {
    render(<Lockup />);
    const svg = screen.getByRole("img", { name: "wsp" });
    expect(renderedPaths(svg as unknown as HTMLElement)).toEqual(pathsOf(read("../src/brand/lockup.svg")));
  });

  it("the mark is decorative and draws mark.svg's path", () => {
    const { container } = render(<Mark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(renderedPaths(container)).toEqual(pathsOf(read("../src/brand/mark.svg")));
  });

  it("the favicon is the mark in the header's zinc, and index.html links it", () => {
    const favicon = read("../public/favicon.svg");
    expect(pathsOf(favicon)).toEqual(pathsOf(read("../src/brand/mark.svg")));
    expect(favicon).toContain('stroke="#71717a"');
    expect(favicon).not.toContain("currentColor");
    expect(read("../index.html")).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });
});
