// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/terminal/ghostty/surface.ts at 57a66608 (MIT).
import type { GhosttyScrollbar } from "../core";
import { uniformPadding, type GhosttyCellMetrics, type TerminalPadding } from "../renderer";

export const CONTENT_PADDING = 4;
export const DEFAULT_TERMINAL_PADDING: TerminalPadding = uniformPadding(CONTENT_PADDING);
const MIN_SCROLLBAR_THUMB_HEIGHT = 18;

/** The window background's opacity clamped to Ghostty's range; absent or unreadable is opaque. */
export function terminalBackgroundOpacity(opacity?: number): number {
  if (opacity === undefined || !Number.isFinite(opacity)) return 1;
  return Math.max(0, Math.min(1, opacity));
}

/** The padding the surface lays the grid in; absent, four on every side. */
export const terminalPaddingOf = (padding?: TerminalPadding): TerminalPadding => padding ?? DEFAULT_TERMINAL_PADDING;

/**
 * Whether the cursor should keep toggling. An unfocused surface draws a steady
 * hollow cursor instead of blinking, and a reduced-motion reader gets a steady
 * cursor too rather than a permanently animating element.
 */
export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion;
}

/**
 * Vertical origin of the grid inside the mount. While content is shorter than
 * the viewport the grid sits at the top like a fresh terminal. Once scrollback
 * exists the prompt lives on the bottom row, so the grid anchors to the bottom
 * edge instead: the sub-row remainder moves above row 0 and resizing within a
 * row boundary keeps the prompt pinned instead of snapping up and down.
 */
export function terminalContentOriginY(
  mountHeight: number,
  padding: Pick<TerminalPadding, "top" | "bottom">,
  rows: number,
  cellHeight: number,
  anchorBottom: boolean,
): number {
  if (!anchorBottom) return padding.top;
  const slack = mountHeight - padding.top - padding.bottom - rows * cellHeight;
  return padding.top + Math.max(0, slack);
}

export interface TerminalScrollbarGeometry {
  readonly thumbHeight: number;
  readonly thumbTop: number;
  readonly maxOffset: number;
}

export function terminalScrollbarGeometry(
  state: GhosttyScrollbar,
  trackHeight: number,
): TerminalScrollbarGeometry | null {
  const total = Math.max(0, state.total);
  const len = Math.max(0, Math.min(state.len, total));
  const maxOffset = Math.max(0, total - len);
  if (trackHeight <= 0 || len <= 0 || maxOffset === 0) return null;
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, (trackHeight * len) / total),
  );
  const travel = Math.max(0, trackHeight - thumbHeight);
  const offset = Math.max(0, Math.min(state.offset, maxOffset));
  return {
    thumbHeight,
    thumbTop: travel * (offset / maxOffset),
    maxOffset,
  };
}

export function terminalScrollbarOffsetAtPointer(
  state: GhosttyScrollbar,
  trackHeight: number,
  pointerY: number,
  pointerOffset: number,
): number {
  const geometry = terminalScrollbarGeometry(state, trackHeight);
  if (geometry === null) return 0;
  const travel = Math.max(0, trackHeight - geometry.thumbHeight);
  if (travel === 0) return 0;
  const thumbTop = Math.max(0, Math.min(pointerY - pointerOffset, travel));
  return Math.round((thumbTop / travel) * geometry.maxOffset);
}

export function terminalGridCellAt(options: {
  bounds: { left: number; top: number };
  clientX: number;
  clientY: number;
  cols: number;
  rows: number;
  metrics: Pick<GhosttyCellMetrics, "width" | "height">;
  padding: number;
  originY: number;
}): { x: number; y: number } | null {
  const { bounds, clientX, clientY, cols, rows, metrics, padding, originY } = options;
  const gridX = clientX - bounds.left - padding;
  const gridY = clientY - bounds.top - originY;
  if (gridX < 0 || gridY < 0 || gridX >= cols * metrics.width || gridY >= rows * metrics.height) {
    return null;
  }
  return {
    x: Math.floor(gridX / metrics.width),
    y: Math.floor(gridY / metrics.height),
  };
}
