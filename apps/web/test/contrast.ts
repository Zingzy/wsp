// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from "playwright";

/** WCAG contrast between two opaque colours, for pairs a test already holds rather than reads off an element. */
export const wcagContrast = (a: readonly number[], b: readonly number[]): number => {
  const lum = (rgb: readonly number[]): number => {
    const f = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

/** WCAG contrast of each element's text over what it sits on, translucent layers composited up to the first opaque one. */
export const textContrast = (page: Page, selector: string): Promise<number[]> =>
  page.locator(selector).evaluateAll(els =>
    els.map(el => {
      // Chromium reports colours mixed in oklch as color(srgb ...); a canvas pixel reads any of them as 8-bit rgba.
      const ctx = document.createElement("canvas").getContext("2d")!;
      const parse = (c: string): number[] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = c;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return [r!, g!, b!, a! / 255];
      };
      const over = (top: number[], under: number[]): number[] => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!));
      const layers: number[][] = [];
      for (let n: Element | null = el; n !== null && layers.at(-1)?.[3] !== 1; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3]! > 0) layers.push(c);
      }
      const bg = layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255]);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const lum = (rgb: number[]): number => {
        const f = (v: number): number => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(rgb[0]!) + 0.7152 * f(rgb[1]!) + 0.0722 * f(rgb[2]!);
      };
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [number, number];
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    }),
  );
