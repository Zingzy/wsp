// SPDX-License-Identifier: AGPL-3.0-only
// jsdom gaps that xterm's browser services need filled: matchMedia drives its
// DPR tracking. Rendering fidelity is out of scope here (browser pass).
// xterm's color parser probes a 2d context and falls back when it is missing;
// a static stub keeps jsdom's "not implemented" noise out of test output.
const ctx2d = {
  fillStyle: "#000000",
  fillRect: () => {},
  getImageData: () => ({ data: [0, 0, 0, 255] }),
  measureText: () => ({ width: 8 }),
};
HTMLCanvasElement.prototype.getContext = ((type: string) =>
  type === "2d" ? (ctx2d as unknown as CanvasRenderingContext2D) : null) as typeof HTMLCanvasElement.prototype.getContext;

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
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

// jsdom has no ResizeObserver; the virtualized timeline observes its viewport
// and tool-group lists to size them. Nothing resizes in tests, so a stub with
// no callbacks is the honest shape.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom has no Web Animations API; Base UI's scroll area polls
// getAnimations on its viewport after a scroll settles.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}
