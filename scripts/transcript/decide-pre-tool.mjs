import { analyzeUiTexts } from "../analyzer.mjs";
import { buildPreToolDenyMessage } from "./markers.mjs";
import { deniedToolCallIndexes, getToolCalls } from "./steps.mjs";
import { PRE_TOOL_USE_UI_TOOLS, extractUiTextsFromToolCall } from "./ui-extractor.mjs";

// koreanPassed: a Korean call of the tool whose own result GENERIC (same call index) is not a denial.
function classifyToolCalls(calls, toolName, deniedIndexes) {
  let drifted = false;
  let koreanPassed = false;
  calls.forEach((call, k) => {
    if (!call || call.name !== toolName) {
      return;
    }
    const status = analyzeUiTexts(extractUiTextsFromToolCall(call)).status;
    if (status === "drifted") {
      drifted = true;
    } else if (status === "korean" && !deniedIndexes.has(k)) {
      koreanPassed = true;
    }
  });
  return { drifted, koreanPassed };
}

function countPriorDriftedToolAttemptsInCurrentTurn(steps, toolName) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 0;
  }
  let turnStart = 0;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i] && steps[i].type === "USER_INPUT") {
      turnStart = i + 1;
      break;
    }
  }

  let attempts = 0;
  for (let i = turnStart; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || step.type !== "PLANNER_RESPONSE") {
      continue;
    }
    const { drifted, koreanPassed } = classifyToolCalls(getToolCalls(step), toolName, deniedToolCallIndexes(steps, i));
    if (drifted) {
      attempts += 1;
    } else if (koreanPassed) {
      // A Korean call of the same tool that went through resets the retry budget for later English attempts.
      attempts = 0;
    }
  }
  return attempts;
}

export function decidePreToolUseAction(toolCall, steps = [], options = {}) {
  if (!toolCall || typeof toolCall !== "object" || typeof toolCall.name !== "string") {
    return { action: "allow", reason: "invalid_tool_call" };
  }

  const toolName = toolCall.name;
  if (!PRE_TOOL_USE_UI_TOOLS.has(toolName)) {
    return { action: "allow", reason: "non_ui_tool" };
  }

  const analysis = analyzeUiTexts(extractUiTextsFromToolCall(toolCall));
  if (analysis.status !== "drifted") {
    return { action: "allow", reason: "ok" };
  }

  // Without a readable transcript the per-turn retry cap cannot be enforced, so fail open.
  if (options && options.transcriptAvailable === false) {
    return { action: "allow", reason: "retry_cap_unavailable" };
  }

  // Stateless per-turn retry cap: the current PLANNER_RESPONSE invoking this tool may already be logged
  // in transcript_full.jsonl as attempt 1, so allow once >= 2 drifted attempts appear in the same turn.
  if (countPriorDriftedToolAttemptsInCurrentTurn(steps, toolName) >= 2) {
    return { action: "allow", reason: "pre_tool_retry_cap_reached" };
  }

  return {
    action: "deny",
    toolName,
    driftedEntries: analysis.driftedEntries,
    message: buildPreToolDenyMessage(),
  };
}
