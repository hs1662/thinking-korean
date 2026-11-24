import { evaluatePlannerResponse } from "./analyzer.mjs";

export const DRIFT_MARKER = "[thinking-korean:drift]";
export const DEFAULT_COOLDOWN_INVOCATIONS = 2;

const FIELD_LABELS = {
  thinking: "내부 추론(thinking)",
  content: "최종 응답(content)",
};

function isDriftMarkerStep(step) {
  return step.type === "SYSTEM_MESSAGE" && step.content.includes(DRIFT_MARKER);
}

export function parseTranscriptJsonl(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return [];
  }

  const steps = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
      continue;
    }

    const stepIndex = typeof parsed.step_index === "number"
      ? parsed.step_index
      : typeof parsed.stepIndex === "number"
        ? parsed.stepIndex
        : steps.length;

    steps.push({
      stepIndex,
      type: parsed.type,
      thinking: typeof parsed.thinking === "string" ? parsed.thinking : "",
      content: typeof parsed.content === "string" ? parsed.content : "",
    });
  }

  return steps;
}

export function buildCorrectionMessage(driftedFields) {
  const labels = driftedFields.map((field) => FIELD_LABELS[field] ?? field);
  const target = labels.length > 0 ? labels.join(" 및 ") : "응답";
  return `${DRIFT_MARKER} 직전 단계의 ${target}에서 영어 서술이 감지되었다. 다음 단계부터는 처음 한 단어부터 마지막 한 단어까지 내부 추론(thinking)과 최종 응답(content)을 모두 한국어로 작성하라. 코드, 파일 경로, 식별자, 명령어, 원문 오류 로그만 원문을 유지한다.`;
}

export function decideHookAction(steps, options = {}) {
  const { cooldownInvocations = DEFAULT_COOLDOWN_INVOCATIONS, ...analyzerOptions } = options;

  let latestPlannerIndex = -1;
  let latestPlannerStep = null;
  let lastMarkerIndex = -1;
  let plannerResponsesSinceLastMarker = 0;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (isDriftMarkerStep(step)) {
      lastMarkerIndex = i;
      plannerResponsesSinceLastMarker = 0;
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") {
      latestPlannerIndex = i;
      latestPlannerStep = step;
      if (lastMarkerIndex !== -1) {
        plannerResponsesSinceLastMarker += 1;
      }
    }
  }

  if (!latestPlannerStep) {
    return { action: "noop", reason: "no_planner_response" };
  }

  if (lastMarkerIndex > latestPlannerIndex) {
    return { action: "noop", reason: "already_covered" };
  }

  const evaluation = evaluatePlannerResponse(latestPlannerStep, analyzerOptions);
  if (evaluation.kind === "ok") {
    return { action: "noop", reason: "ok" };
  }

  if (lastMarkerIndex !== -1 && plannerResponsesSinceLastMarker <= cooldownInvocations) {
    return { action: "noop", reason: "cooldown_active" };
  }

  return {
    action: "inject",
    stepIndex: latestPlannerStep.stepIndex,
    driftedFields: evaluation.driftedFields,
    message: buildCorrectionMessage(evaluation.driftedFields),
  };
}
