// Adapted from pingdotgg/t3code apps/web/src/terminal/ghostty/surface.ts at 57a66608 (MIT).
export { DEFAULT_TERMINAL_FONT_FAMILY, terminalFontFamily, loadTerminalFontFamily, appTerminalFontSize, terminalFontSize } from "./surface/fonts";
export type { GhosttyTerminalFont } from "./surface/fonts";
export { CONTENT_PADDING, DEFAULT_TERMINAL_PADDING, terminalBackgroundOpacity, terminalPaddingOf, shouldBlinkTerminalCursor, terminalContentOriginY, terminalScrollbarGeometry, terminalScrollbarOffsetAtPointer, terminalGridCellAt } from "./surface/layout";
export type { TerminalScrollbarGeometry } from "./surface/layout";
export { terminalLinkAtPosition, terminalLinkAtPositionWithRange, terminalLinkAtColumn } from "./surface/links";
export type { TerminalLinkWithRange } from "./surface/links";
export { isTerminalCopyShortcut, primeTerminalCopyInput, clearPrimedTerminalCopyInput, applyTerminalCopyEvent, isTerminalPasteShortcut, terminalMacCommandKeyData, isTerminalMacCommandText, isTerminalCompositionCommitInput, isTerminalCompositionKey, isTerminalAltGraphText, shouldReportTerminalMouse, resolveTerminalMouseData, resolveTerminalMouseTrackingState, terminalWheelDeltaRows, terminalWheelArrowData, isTerminalLinkPointerGesture, ghosttyMouseButton, advanceTerminalSelectionClickSequence } from "./surface/input";
export type { TerminalSelectionClickSequence, GhosttySelectionPosition } from "./surface/input";
export { GhosttyTerminalSurface } from "./surface/terminalSurface";
export type { GhosttyTerminalSurfaceOptions } from "./surface/terminalSurface";
