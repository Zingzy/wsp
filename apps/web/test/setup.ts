// SPDX-License-Identifier: AGPL-3.0-only
// jsdom gaps the terminal surface needs filled. The renderer paints through a
// Canvas 2D context and sizes the grid from measureText, so the stub answers
// with finite metrics; ResizeObserver, document.fonts and FontFace do not
// exist in jsdom; matchMedia drives DPR and reduced-motion tracking. The
// libghostty wasm arrives through Vite ?url imports, which resolve to served
// paths here, so fetch reads those two vendored files from disk instead.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const metrics = { width: 8, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3 };
const ctx2d = new Proxy({} as Record<string | symbol, unknown>, {
  get(target, key) {
    if (key in target) return target[key];
    if (key === "measureText") return () => metrics;
    if (key === "getImageData") return () => ({ data: [0, 0, 0, 255] });
    return () => undefined;
  },
  set(target, key, value) {
    target[key] = value;
    return true;
  },
});
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

// Base UI's scroll area calls getAnimations on its viewport; with the stub in
// place Base UI would also wait for animations before unmounting a dialog, so
// its own switch keeps that path synchronous, as it is with no getAnimations.
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
  (globalThis as { BASE_UI_ANIMATIONS_DISABLED?: boolean }).BASE_UI_ANIMATIONS_DISABLED = true;
}

if (typeof ResizeObserver === "undefined") {
  class InertResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = InertResizeObserver as unknown as typeof ResizeObserver;
}

if (typeof document !== "undefined" && !("fonts" in document)) {
  Object.defineProperty(document, "fonts", {
    value: {
      add: () => {},
      load: async () => [],
      check: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

if (typeof FontFace === "undefined") {
  class InertFontFace {
    async load(): Promise<this> {
      return this;
    }
  }
  globalThis.FontFace = InertFontFace as unknown as typeof FontFace;
}

// jsdom's URL resolves relative references against the page origin, so the path is built with node:path.
const vendorDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/terminal/ghostty/vendor");
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const wasm = /\/([^/?#]+\.wasm)(?:[?#].*)?$/.exec(url);
  if (wasm) {
    const bytes = readFileSync(resolve(vendorDir, wasm[1]!));
    return Promise.resolve(new Response(bytes, { headers: { "content-type": "application/wasm" } }));
  }
  return realFetch(input, init);
}) as typeof fetch;

// The kit's sidebar persists its open state through the Cookie Store API,
// which jsdom does not ship; toggling it in a test needs a sink.
(globalThis as { cookieStore?: unknown }).cookieStore ??= { set: async () => {} };
