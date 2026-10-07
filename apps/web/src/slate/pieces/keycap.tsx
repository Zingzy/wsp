// SPDX-License-Identifier: AGPL-3.0-only
// The button's keycap bevel for SVG marks, which box-shadow never reaches: the row 1px under the shape's top edge,
// found by moving its alpha down 1px and cutting it by the alpha moved 2px, flooded with the button's own top ink. It
// follows any outline, a diamond's slopes and a ring's arc too. Drawn once per slate; a mark names it by url().
export const KEYCAP_FILTER = "url(#slate-keycap)";

export function KeycapFilter() {
  return (
    <svg aria-hidden width="0" height="0" className="absolute">
      <filter id="slate-keycap" x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
        <feFlood style={{ floodColor: "var(--keycap-top)" }} result="ink" />
        <feOffset in="SourceAlpha" dy="1" result="down" />
        <feOffset in="SourceAlpha" dy="2" result="further" />
        <feComposite in="down" in2="further" operator="out" result="rim" />
        <feComposite in="rim" in2="SourceAlpha" operator="in" result="inside" />
        <feComposite in="ink" in2="inside" operator="in" result="line" />
        <feMerge>
          <feMergeNode in="SourceGraphic" />
          <feMergeNode in="line" />
        </feMerge>
      </filter>
    </svg>
  );
}
