import { evaluatePlannerResponse } from "../analyzer.mjs";
import { isExplicitEnglishOutputRequest } from "./english-request.mjs";
import { buildCorrectionMessage, parseDriftMarkerStep } from "./markers.mjs";
import { getToolCalls } from "./steps.mjs";
import {
  DEFAULT_COOLDOWN_INVOCATIONS,
  MAX_CONSECUTIVE_FAILED_THINKING,
  MAX_CONSECUTIVE_FAILED_UI,
  createFieldTracker,
  getActionableFields,
  isFieldCapped,
  resetFieldTracker,
} from "./trackers.mjs";
import { extractUiTextsFromToolCalls } from "./ui-extractor.mjs";

const FIELDS = ["thinking", "content", "ui"];

function evaluateStep(step, analyzerOptions) {
  return evaluatePlannerResponse(
    {
      thinking: typeof step.thinking === "string" ? step.thinking : "",
      content: typeof step.content === "string" ? step.content : "",
      uiTexts: extractUiTextsFromToolCalls(getToolCalls(step)),
    },
    analyzerOptions,
  );
}

// Reverse scan: latest PLANNER_RESPONSE of the current turn, its USER_INPUT, and the markers that follow it.
function scanLatestTurn(steps) {
  let plannerIdx = -1;
  let userIdx = -1;
  const trailingMarkers = [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (!step || typeof step !== "object") {
      continue;
    }
    if (plannerIdx === -1) {
      if (step.type === "USER_INPUT") {
        return { plannerIdx: -1, userIdx: i, trailingMarkers };
      }
      if (step.type === "PLANNER_RESPONSE") {
        plannerIdx = i;
        continue;
      }
      const marker = parseDriftMarkerStep(step);
      if (marker) {
        trailingMarkers.push(marker);
      }
    } else if (step.type === "USER_INPUT") {
      userIdx = i;
      break;
    }
  }
  return { plannerIdx, userIdx, trailingMarkers };
}

function markerTargets(parsedMarker, lastActionable, lastEffective) {
  if (parsedMarker.fields.length > 0) {
    return parsedMarker.fields;
  }
  if (lastActionable.length > 0) {
    return lastActionable;
  }
  if (lastEffective.length > 0) {
    return lastEffective;
  }
  return ["thinking", "content"];
}

function replayTrackers(steps, ctx) {
  const { caps, cooldownInvocations, analyzerOptions, cachedIdx, cachedEval } = ctx;
  const trackers = { thinking: createFieldTracker(), content: createFieldTracker(), ui: createFieldTracker() };
  let currentContentExempt = false;
  let lastActionable = [];
  let lastEffective = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step !== "object") {
      continue;
    }
    if (step.type === "USER_INPUT") {
      currentContentExempt = isExplicitEnglishOutputRequest(step.content);
      continue;
    }

    const parsedMarker = parseDriftMarkerStep(step);
    if (parsedMarker) {
      for (const field of markerTargets(parsedMarker, lastActionable, lastEffective)) {
        const tracker = trackers[field];
        if (!tracker || isFieldCapped(field, tracker, caps)) {
          continue;
        }
        tracker.hasPendingMarker = true;
        tracker.markerFailed = false;
        tracker.responsesSinceMarker = 0;
      }
      lastActionable = [];
      lastEffective = [];
      continue;
    }

    if (step.type !== "PLANNER_RESPONSE") {
      continue;
    }

    const evaluation = i === cachedIdx ? cachedEval : evaluateStep(step, analyzerOptions);
    const effectiveDrifted = [];
    for (const field of FIELDS) {
      const tracker = trackers[field];
      if (tracker.hasPendingMarker) {
        tracker.responsesSinceMarker += 1;
      }
      if (field === "content" && currentContentExempt) {
        continue;
      }
      const status = evaluation[field].status;
      if (status === "korean") {
        resetFieldTracker(tracker);
      } else if (status === "drifted") {
        effectiveDrifted.push(field);
        if (tracker.hasPendingMarker && !tracker.markerFailed) {
          tracker.markerFailed = true;
          tracker.consecutiveFailed += 1;
        }
      }
    }
    lastEffective = effectiveDrifted;
    lastActionable = getActionableFields(effectiveDrifted, trackers, cooldownInvocations, caps);
  }
  return trackers;
}

export function decideHookAction(steps, options = {}) {
  const {
    cooldownInvocations = DEFAULT_COOLDOWN_INVOCATIONS,
    maxConsecutiveFailedThinking = MAX_CONSECUTIVE_FAILED_THINKING,
    maxConsecutiveFailedUi = MAX_CONSECUTIVE_FAILED_UI,
    lastUserInput,
    ...analyzerOptions
  } = options;

  if (!Array.isArray(steps) || steps.length === 0) {
    return { action: "noop", reason: "no_planner_response" };
  }

  // Fast path: inspect only the latest PLANNER_RESPONSE so long clean sessions avoid O(N) re-evaluation.
  const { plannerIdx, userIdx, trailingMarkers } = scanLatestTurn(steps);
  if (plannerIdx === -1) {
    return { action: "noop", reason: "no_planner_response" };
  }
  // A trailing marker without field information (legacy) covers everything.
  if (trailingMarkers.some((marker) => marker.fields.length === 0)) {
    return { action: "noop", reason: "already_covered" };
  }

  const latestStep = steps[plannerIdx];
  const contentExempt =
    typeof lastUserInput === "string" && lastUserInput.trim().length > 0
      ? isExplicitEnglishOutputRequest(lastUserInput)
      : userIdx !== -1
        ? isExplicitEnglishOutputRequest(steps[userIdx].content)
        : false;
  const latestEval = evaluateStep(latestStep, analyzerOptions);
  const drifted = (latestEval.kind === "drifted" ? latestEval.driftedFields : []).filter(
    (field) => !(field === "content" && contentExempt),
  );

  // Fields already corrected by markers after the latest planner (PreToolUse denials, earlier injections).
  const coveredFields = new Set(trailingMarkers.flatMap((marker) => marker.fields));
  const uncovered = drifted.filter((field) => !coveredFields.has(field));
  if (uncovered.length === 0) {
    return trailingMarkers.length > 0 ? { action: "noop", reason: "already_covered" } : { action: "noop", reason: "ok" };
  }

  const caps = { maxConsecutiveFailedThinking, maxConsecutiveFailedUi };
  const trackers = replayTrackers(steps, {
    caps,
    cooldownInvocations,
    analyzerOptions,
    cachedIdx: plannerIdx,
    cachedEval: latestEval,
  });

  const actionableFields = getActionableFields(uncovered, trackers, cooldownInvocations, caps);
  if (actionableFields.length === 0) {
    if (uncovered.length === 1 && uncovered[0] === "thinking" && isFieldCapped("thinking", trackers.thinking, caps)) {
      return { action: "noop", reason: "thinking_cap_reached" };
    }
    if (uncovered.length === 1 && uncovered[0] === "ui" && isFieldCapped("ui", trackers.ui, caps)) {
      return { action: "noop", reason: "ui_cap_reached" };
    }
    return { action: "noop", reason: "cooldown_active" };
  }

  return {
    action: "inject",
    stepIndex: latestStep.stepIndex,
    driftedFields: actionableFields,
    message: buildCorrectionMessage(actionableFields),
  };
}
