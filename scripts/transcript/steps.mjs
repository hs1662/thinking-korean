export const KEPT_STEP_TYPES = new Set(["PLANNER_RESPONSE", "SYSTEM_MESSAGE", "USER_INPUT"]);
export const PRE_TOOL_DENIAL_NEEDLE = "tool call denied by pre-tool hook";

export function parseStepIndex(raw, fallback) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

export function getToolCalls(step) {
  if (!step || typeof step !== "object") {
    return [];
  }
  if (Array.isArray(step.toolCalls)) {
    return step.toolCalls;
  }
  if (Array.isArray(step.tool_calls)) {
    return step.tool_calls;
  }
  return [];
}

const DENIAL_ERROR_RE = /^(?:Encountered error in (?:step|tool) execution:\s*)?tool call denied by pre-tool hook\b/i;
const DENIAL_CONTENT_LINE_RE = /^(?:Encountered error in (?:step|tool) execution:\s*)?tool call denied by pre-tool hook(?::|\b)/i;

// Only a record whose error, or an own content line, starts with the denial sentence counts; a tool output
// that merely quotes the needle (for example a file read of this module) must not.
export function isPreToolDenialStep(step) {
  if (!step || typeof step !== "object" || step.type !== "GENERIC") {
    return false;
  }
  const error = typeof step.error === "string" ? step.error.trim() : "";
  if (error.toLowerCase().startsWith(PRE_TOOL_DENIAL_NEEDLE) || DENIAL_ERROR_RE.test(error)) {
    return true;
  }
  const status = typeof step.status === "string" ? step.status : "";
  if ((status !== "" && status !== "ERROR") || typeof step.content !== "string") {
    return false;
  }
  return step.content.split(/\r?\n/).some((line) => DENIAL_CONTENT_LINE_RE.test(line.trim()));
}

// Call indexes of a PLANNER_RESPONSE whose result GENERIC is a PreToolUse denial. The k-th result GENERIC
// belongs to the k-th tool call; step indexes keep that mapping when non-denial GENERICs were not parsed.
export function deniedToolCallIndexes(steps, plannerPos) {
  const denied = new Set();
  const planner = steps[plannerPos];
  const base = planner && Number.isFinite(planner.stepIndex) ? planner.stepIndex : null;
  let ordinal = 0;
  let skipped = 0;
  for (let j = plannerPos + 1; j < steps.length; j += 1) {
    const next = steps[j];
    if (!next || typeof next !== "object") {
      continue;
    }
    if (next.type === "PLANNER_RESPONSE" || next.type === "USER_INPUT") {
      break;
    }
    if (next.type !== "GENERIC") {
      skipped += 1;
      continue;
    }
    const offset = base !== null && Number.isFinite(next.stepIndex) ? next.stepIndex - base - 1 - skipped : -1;
    if (isPreToolDenialStep(next)) {
      denied.add(offset >= ordinal ? offset : ordinal);
    }
    ordinal += 1;
  }
  return denied;
}

function parseRawRecord(line) {
  if (typeof line !== "string") {
    return null;
  }
  const trimmed = line.replace(/^\uFEFF/, "").trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
    return null;
  }
  return parsed;
}

function isTrackedTranscriptRecord(parsed) {
  return KEPT_STEP_TYPES.has(parsed.type) || isPreToolDenialStep(parsed);
}

function recordToStep(parsed, fallbackStepIndex) {
  if (!isTrackedTranscriptRecord(parsed)) {
    return null;
  }

  const rawIndex = parsed.step_index !== undefined ? parsed.step_index : parsed.stepIndex;
  return {
    stepIndex: parseStepIndex(rawIndex, fallbackStepIndex),
    type: parsed.type,
    thinking: typeof parsed.thinking === "string" ? parsed.thinking : "",
    content: typeof parsed.content === "string" ? parsed.content : "",
    error: typeof parsed.error === "string" ? parsed.error : "",
    status: typeof parsed.status === "string" ? parsed.status : "",
    toolCalls: getToolCalls(parsed),
  };
}

export function parseTranscriptLine(line, fallbackStepIndex = 0) {
  const parsed = parseRawRecord(line);
  return parsed ? recordToStep(parsed, fallbackStepIndex) : null;
}

export function parseTranscriptJsonlWithStats(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return { steps: [], validRecordCount: 0 };
  }

  const steps = [];
  let validRecordCount = 0;
  for (const line of rawText.split(/\r?\n/)) {
    const parsed = parseRawRecord(line);
    if (!parsed) {
      continue;
    }
    const step = recordToStep(parsed, validRecordCount);
    validRecordCount += 1;
    if (step) {
      steps.push(step);
    }
  }
  return { steps, validRecordCount };
}

export function parseTranscriptJsonl(rawText) {
  return parseTranscriptJsonlWithStats(rawText).steps;
}
