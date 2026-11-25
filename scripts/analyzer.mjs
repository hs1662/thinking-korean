// Public facade: re-exports the analyzer modules and combines them per planner response.
import { analyzeField } from "./analyzer/prose-rules.mjs";
import { analyzeUiTexts } from "./analyzer/ui.mjs";

export {
  ENGLISH_RUN_WORD_THRESHOLD,
  MIN_HANGUL_RATIO,
  MIN_LATIN_CHARS_FOR_DRIFT,
  MIN_NATURAL_CHARS,
  SEGMENT_MAX_HANGUL_RATIO,
  SEGMENT_MIN_NATURAL_CHARS,
  SHORT_ENGLISH_PROSE_WORD_THRESHOLD,
} from "./analyzer/constants.mjs";
export { extractNaturalText } from "./analyzer/stripper.mjs";
export { analyzeField, analyzeUiTexts };

export function evaluatePlannerResponse({ thinking = "", content = "", uiTexts = [] } = {}, options = {}) {
  const thinkingResult = analyzeField("thinking", thinking, options);
  const contentResult = analyzeField("content", content, options);
  const uiResult = analyzeUiTexts(uiTexts);
  const driftedFields = [thinkingResult, contentResult, uiResult]
    .filter((result) => result.status === "drifted")
    .map((result) => result.field);

  if (driftedFields.length > 0) {
    return {
      kind: "drifted",
      driftedFields,
      thinking: thinkingResult,
      content: contentResult,
      ui: uiResult,
    };
  }

  return {
    kind: "ok",
    thinking: thinkingResult,
    content: contentResult,
    ui: uiResult,
  };
}
