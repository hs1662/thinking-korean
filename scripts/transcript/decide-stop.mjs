import { evaluatePlannerResponse } from "../analyzer.mjs";
import { isExplicitEnglishOutputRequest } from "./english-request.mjs";
import { buildCorrectionMessage, parseDriftMarkerStep } from "./markers.mjs";
import { getToolCalls } from "./steps.mjs";

export function markerCoversContent(parsedMarker) {
  if (!parsedMarker) {
    return false;
  }
  if (parsedMarker.sourceHook === "Stop") {
    return true;
  }
  if (parsedMarker.fields.length === 0) {
    return true;
  }
  return parsedMarker.fields.includes("content");
}

export function decideStopAction(steps, options = {}) {
  const {
    lastUserInput,
    continuationActive = false,
    terminationReason = "",
    ...analyzerOptions
  } = options;

  if (continuationActive === true) {
    return { action: "noop", reason: "continuation_active" };
  }
  if (terminationReason !== "NO_TOOL_CALL") {
    return { action: "noop", reason: "non_normal_termination" };
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    return { action: "noop", reason: "no_planner_response" };
  }

  let currentContentExempt = false;
  let latestPlannerIndex = -1;
  let latestPlannerStep = null;
  let latestPlannerContentExempt = false;
  let lastContentMarkerIndex = -1;
  let sawStopRetryTriggerInTurn = false;
  let nonEmptyContentPlannersAfterTrigger = 0;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step !== "object") {
      continue;
    }

    if (step.type === "USER_INPUT") {
      currentContentExempt = isExplicitEnglishOutputRequest(step.content);
      sawStopRetryTriggerInTurn = false;
      nonEmptyContentPlannersAfterTrigger = 0;
      // A planner response from a previous turn must never be judged for the new turn.
      latestPlannerIndex = -1;
      latestPlannerStep = null;
      continue;
    }

    const parsedMarker = parseDriftMarkerStep(step);
    if (parsedMarker && markerCoversContent(parsedMarker)) {
      lastContentMarkerIndex = i;
      if (parsedMarker.sourceHook === "Stop" || getToolCalls(latestPlannerStep).length === 0) {
        sawStopRetryTriggerInTurn = true;
      }
      continue;
    }

    if (step.type === "PLANNER_RESPONSE") {
      latestPlannerIndex = i;
      latestPlannerStep = step;
      latestPlannerContentExempt = currentContentExempt;
      if (sawStopRetryTriggerInTurn && typeof step.content === "string" && step.content.trim().length > 0) {
        nonEmptyContentPlannersAfterTrigger += 1;
      }
    }
  }

  if (!latestPlannerStep) {
    return { action: "noop", reason: "no_planner_response" };
  }
  if (nonEmptyContentPlannersAfterTrigger >= 1) {
    return { action: "noop", reason: "stop_retry_cap_reached" };
  }

  const finalContentExempt =
    typeof lastUserInput === "string" && lastUserInput.trim().length > 0
      ? isExplicitEnglishOutputRequest(lastUserInput)
      : latestPlannerContentExempt;
  if (finalContentExempt) {
    return { action: "noop", reason: "content_exempt" };
  }

  const evaluation = evaluatePlannerResponse(
    {
      thinking: "",
      content: typeof latestPlannerStep.content === "string" ? latestPlannerStep.content : "",
    },
    analyzerOptions,
  );

  if (evaluation.content.status === "drifted") {
    const alreadyCoveredByPostHook = lastContentMarkerIndex > latestPlannerIndex;
    return {
      action: "continue",
      stepIndex: latestPlannerStep.stepIndex,
      alreadyCoveredByPostHook,
      reasonMessage: alreadyCoveredByPostHook ? "" : buildCorrectionMessage(["content"]),
    };
  }

  return { action: "noop", reason: "ok" };
}
