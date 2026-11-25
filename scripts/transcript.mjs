// Public facade: re-exports only. Implementation lives in scripts/transcript/*.mjs.
export {
  KEPT_STEP_TYPES,
  PRE_TOOL_DENIAL_NEEDLE,
  getToolCalls,
  isPreToolDenialStep,
  parseTranscriptJsonl,
  parseTranscriptJsonlWithStats,
  parseTranscriptLine,
} from "./transcript/steps.mjs";
export { isExplicitEnglishOutputRequest } from "./transcript/english-request.mjs";
export {
  PRE_TOOL_USE_UI_TOOLS,
  extractUiTextsFromToolCall,
  extractUiTextsFromToolCalls,
} from "./transcript/ui-extractor.mjs";
export {
  DRIFT_MARKER,
  LEGACY_DRIFT_MARKERS,
  buildCorrectionMessage,
  formatDriftMarker,
  isDriftMarkerStep,
  parseDriftMarkerStep,
} from "./transcript/markers.mjs";
export {
  DEFAULT_COOLDOWN_INVOCATIONS,
  MAX_CONSECUTIVE_FAILED_THINKING,
  MAX_CONSECUTIVE_FAILED_UI,
} from "./transcript/trackers.mjs";
export { decideHookAction } from "./transcript/decide-post.mjs";
export { decideStopAction } from "./transcript/decide-stop.mjs";
export { decidePreToolUseAction } from "./transcript/decide-pre-tool.mjs";
