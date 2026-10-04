// SPDX-License-Identifier: AGPL-3.0-only
// The slate module of schema 2: the document and its values, the JSX-like form, the formula language, the
// validator, the batch, the kit's registries, the sketch and the catalog, one module the host and the renderer both
// run. Live values are keyed by name without the $; paths are "$name[.field|[index]]".
export * from "./types.js";
export { SLATE_LIMITS } from "./limits.js";
export { SLATE_CODES, SLATE_WARNINGS, slateProblem, nearest as slateNearest, type SlateCode } from "./problems.js";
export { parseSlateOwnPath, slateOwnPathText, getSlateValue, setSlateValue, slateStep, slateEqual } from "./paths.js";
export {
  parseSlateExpression, evaluateSlateExpression, evaluateSlateFormat, slateDependencies, slatePropDependencies, resolveSlateProp,
  parseSlateFormat, checkSlateExpression, slateTruthy, slateText, slateWord, slatePathText, walkSlateExpr, SLATE_FUNCTIONS, SLATE_PIPE_STEPS,
  type SlateExpr, type SlateEvalContext, type SlateFormatPart, type SlateCheckScope, type SlateType, type SlateTypeName,
} from "./expr.js";
export { SLATE_PIECES, SLATE_TONES, SLATE_ITEM_KINDS, SLATE_RESERVED_PROPS, type SlatePieceModule, type SlatePropSpec, type SlatePropType, type SlateItemSpec, type SlateSketchView } from "./kit.js";
export { SLATE_ICONS, isSlateIcon, nearestSlateIcon, type SlateIcon } from "./icons.js";
export { SLATE_SOURCES, slateSourceType, slateShapeText, slateShapeType, slateIsSeries, type SlateSourceModule, type SlateShape } from "./sources.js";
export { SLATE_STEPS, type SlateStepModule } from "./steps.js";
export { parseSlate, parseSlatePatch, printSlate, compileSlateText } from "./syntax.js";
export { validateSlate, validateDocument, type SlateLines } from "./validate.js";
export { applySlatePatch, carrySlateValues, slateStartValues } from "./patch.js";
export { runSlateBatch, type SlateBatchResult, type SlateBatchContext, type SlateBatchSend, type SlateBatchWindowStep, type SlateWriter } from "./batch.js";
export { sketchSlate, type SlateSketchContext } from "./sketch.js";
export { slateCatalog, slateTokens, SLATE_RULES } from "./catalog.js";
export { SLATE_EXAMPLES } from "./examples.js";
