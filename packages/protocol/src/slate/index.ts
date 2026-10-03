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
export { SLATE_PIECES, SLATE_SOURCES, SLATE_ACTIONS } from "./kit.js";
export { slateCatalog, type SlateCatalogAnswer, type SlateCatalogAsk } from "./catalog.js";
