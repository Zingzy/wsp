// SPDX-License-Identifier: AGPL-3.0-only
// The slate module: the document, its shorthand, its formula language, its validator, its kit and its sketch, one
// module the host and the renderer both run.
export * from "./types.js";
export { SLATE_LIMITS } from "./limits.js";
export { SLATE_CODES, SLATE_WARNINGS, slateProblem, type SlateCode } from "./problems.js";
export { getSlateState, setSlateState, parseSlateStatePath } from "./state.js";
export { parseSlateExpression, evaluateSlateExpression, evaluateSlateFormat, slateDependencies, slatePropDependencies, resolveSlateProp, parseSlateFormat, checkSlateExpression, slateTruthy, slateText, slatePathText, SLATE_FUNCTIONS, type SlateFormatPart, type SlateCheckScope, type SlateType } from "./expr.js";
export { compileSlate, compileSlatePatch, printSlate } from "./shorthand.js";
export { validateSlate } from "./validate.js";
export { applySlatePatch } from "./patch.js";
export { sketchSlate } from "./sketch.js";
export { SLATE_PIECES, SLATE_SOURCES, SLATE_ACTIONS, SLATE_TONES, SLATE_LATER_ACTIONS, SLATE_LATER_PIECES, SLATE_RESERVED_PROPS, SLATE_RESERVED_WORDS, slateFlags, slateSourcePaths, slateShapeText, type SlatePieceModule, type SlatePropSpec, type SlatePropType, type SlateItemSpec, type SlateSketchView, type SlateSourceModule, type SlateShape, type SlateActionModule } from "./kit.js";
export { slateCatalog, type SlateCatalogAnswer, type SlateCatalogAsk } from "./catalog.js";
