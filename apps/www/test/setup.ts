// SPDX-License-Identifier: AGPL-3.0-only
// jsdom has no WebGL, IntersectionObserver or matchMedia; the dither canvas asks for all three and stays blank without them.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

if (typeof IntersectionObserver === "undefined") {
  class InertIntersectionObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.IntersectionObserver = InertIntersectionObserver as unknown as typeof IntersectionObserver;
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
