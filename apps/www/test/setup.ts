// SPDX-License-Identifier: AGPL-3.0-only
// jsdom has no canvas, IntersectionObserver, ResizeObserver or matchMedia; the field asks for all four and stays blank without them.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

if (typeof IntersectionObserver === "undefined") {
  class InertIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.IntersectionObserver = InertIntersectionObserver as unknown as typeof IntersectionObserver;
}

if (typeof ResizeObserver === "undefined") {
  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = InertResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// A browser starts a parsed video's `muted` from its attribute and hydration checks the two agree; jsdom keeps them apart.
Object.defineProperty(HTMLMediaElement.prototype, "muted", {
  configurable: true,
  get(this: HTMLMediaElement) {
    return this.hasAttribute("muted");
  },
  set(this: HTMLMediaElement, on: boolean) {
    this.toggleAttribute("muted", on);
  },
});
