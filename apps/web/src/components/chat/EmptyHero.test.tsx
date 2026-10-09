// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeroField } from "./EmptyHero";

describe("HeroField", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for frames while it stands and gives back its frame and its size watch when it leaves", () => {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(el: Element) {
          observed.push(el);
        }
        disconnect = disconnect;
        unobserve() {}
      },
    );
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    const requested = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 7);
    const cancelled = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const { container, unmount } = render(<HeroField />);
    expect(requested).toHaveBeenCalled();
    expect(observed).toEqual([container.querySelector("canvas")]);
    unmount();
    expect(cancelled).toHaveBeenCalledWith(7);
    expect(disconnect).toHaveBeenCalled();
  });

  it("asks for no frame while it is off screen", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly seen: IntersectionObserverCallback) {}
        observe(target: Element) {
          this.seen([{ target, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    const requested = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(<HeroField />);
    expect(requested).not.toHaveBeenCalled();
  });

  it("paints once and asks for no frames under reduced motion", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
    const requested = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    render(<HeroField />);
    expect(requested).not.toHaveBeenCalled();
  });
});
