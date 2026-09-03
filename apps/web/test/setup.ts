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

// The kit's sidebar persists its open state through the Cookie Store API,
// which jsdom does not ship; toggling it in a test needs a sink.
(globalThis as { cookieStore?: unknown }).cookieStore ??= { set: async () => {} };
