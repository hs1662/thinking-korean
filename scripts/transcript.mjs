import { evaluatePlannerResponse } from "./analyzer.mjs";

export const DRIFT_MARKER = "[한국어사고:영어이탈]";
export const LEGACY_DRIFT_MARKERS = ["[thinking-korean:drift]"];
export const DEFAULT_COOLDOWN_INVOCATIONS = 2;
export const MAX_CONSECUTIVE_FAILED_THINKING = 2;

const ALL_DRIFT_MARKERS = [DRIFT_MARKER, ...LEGACY_DRIFT_MARKERS];
const SYSTEM_MESSAGE_PREAMBLE_RE = /^The following is a <SYSTEM_MESSAGE>[^\n]*\n+/;
const SYSTEM_MESSAGE_OPEN_TAG_RE = /^<SYSTEM_MESSAGE>[ \t]*\n?/;
const INVOCATION_HOOK_HEADER_RE =
  /^The following system message was injected by a (?:Post|Pre)Invocation hook:[ \t]*\n+/i;

const USER_REQUEST_BLOCK_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i;
const METADATA_BLOCK_RE = /<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/gi;

const FOREIGN_LANG_KO = "(?:영어|영문|프랑스어|독일어|스페인어|이탈리아어|포르투갈어|외국어)";
const FOREIGN_LANG_EN = "(?:english|french|german|spanish|italian|portuguese)";

const KO_NEGATED_TRANSLATION_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)?\\s*(?:번역|작성|답변|답|응답|설명|요약|정리|출력|변환|쓰|적|말)(?:하|해|은|는|을|를)?\\s*(?:지\\s*(?:말|마)|하지\\s*(?:말|마)|말고|금지)`,
);

const KO_TRANSLATION_REQUEST_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)\\s*(?:자연스럽게\\s*|간단히\\s*|정확히\\s*)?(?:번역|작성|답변|답해|답하|답장|응답|설명|요약|정리|출력|변환|바꿔|바꾸|써|적어|말해|고쳐|다시\\s*써)` +
    `|(?:영어|영문)\\s*(?:번역(?:본|문|해|하|을)?|초안(?:을)?\\s*(?:작성|써|만들))` +
    `|영문으로\\s*(?:해\\s*줘|해주세요|부탁)`,
);

const EN_NEGATED_OUTPUT_RE = new RegExp(
  `\\b(?:do\\s+not|don['’]t|never|avoid|stop)\\s+(?:\\w+\\s+){0,2}(?:translate|write|reply|respond|answer|explain|summarize|output|rewrite|draft)\\b[^\\n.!?]{0,40}\\b(?:in|into|to)\\s+${FOREIGN_LANG_EN}\\b`,
  "i",
);

const EN_TRANSLATION_REQUEST_RE = new RegExp(
  `\\btranslate\\b[^\\n.!?]{0,60}\\b(?:into|to)\\s+${FOREIGN_LANG_EN}\\b` +
    `|\\b(?:write|reply|respond|answer|explain|summarize|output|rewrite|draft)\\b[^\\n.!?]{0,40}\\bin\\s+${FOREIGN_LANG_EN}\\b` +
    `|\\b${FOREIGN_LANG_EN}\\s+translation\\b`,
  "i",
);

function parseStepIndex(raw, fallback) {
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

function extractUserRequestBody(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return "";
  }
  const blockMatch = rawText.match(USER_REQUEST_BLOCK_RE);
  if (blockMatch) {
    return blockMatch[1].trim();
  }
  return rawText.replace(METADATA_BLOCK_RE, "").trim();
}

export function isExplicitEnglishOutputRequest(rawText) {
  const body = extractUserRequestBody(rawText);
  if (body.length === 0) {
    return false;
  }
  if (KO_NEGATED_TRANSLATION_RE.test(body)) {
    return false;
  }
  if (KO_TRANSLATION_REQUEST_RE.test(body)) {
    return true;
  }
  if (EN_NEGATED_OUTPUT_RE.test(body)) {
    return false;
  }
  return EN_TRANSLATION_REQUEST_RE.test(body);
}

export function isDriftMarkerStep(step) {
  if (!step || step.type !== "SYSTEM_MESSAGE" || typeof step.content !== "string") {
    return false;
  }

  let body = step.content.replace(/\r\n?/g, "\n").trimStart();
  body = body.replace(SYSTEM_MESSAGE_PREAMBLE_RE, "").trimStart();
  body = body.replace(SYSTEM_MESSAGE_OPEN_TAG_RE, "").trimStart();
  body = body.replace(INVOCATION_HOOK_HEADER_RE, "").trimStart();

  return ALL_DRIFT_MARKERS.some((marker) => body.startsWith(marker));
}

export function parseTranscriptLine(line, fallbackStepIndex = 0) {
  if (typeof line !== "string") {
    return null;
  }
  const trimmed = line.trim();
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

  const rawIndex = parsed.step_index !== undefined ? parsed.step_index : parsed.stepIndex;
  const stepIndex = parseStepIndex(rawIndex, fallbackStepIndex);

  return {
    stepIndex,
    type: parsed.type,
    thinking: typeof parsed.thinking === "string" ? parsed.thinking : "",
    content: typeof parsed.content === "string" ? parsed.content : "",
  };
}

export function parseTranscriptJsonl(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return [];
  }

  const steps = [];
  for (const line of rawText.split(/\r?\n/)) {
    const step = parseTranscriptLine(line, steps.length);
    if (step) {
      steps.push(step);
    }
  }

  return steps;
}

export function buildCorrectionMessage(driftedFields = []) {
  const fields = Array.isArray(driftedFields) ? driftedFields : [];
  const hasThinking = fields.includes("thinking");
  const hasContent = fields.includes("content");

  if (hasThinking && hasContent) {
    return `${DRIFT_MARKER} 직전 내부 추론·사고 요약과 최종 응답이 모두 영어로 작성되었다. 내부 사고에 영문 식별자·파일명·영어 단어가 섞이면 사고 요약 전체가 영어로 전환된다. 다음 단계부터는 내부 추론 속에 영문 알파벳을 단 한 글자도 쓰지 말고 파일명·함수명·원칙명까지 모두 순수 한국어 뜻이나 한글 음차로 바꿔서 생각하며, 최종 사용자 응답의 모든 설명 문장도 처음부터 끝까지 한국어로 작성하라. 영문 원문과 식별자는 오직 도구 호출 인자와 최종 답변의 코드·경로·식별자·오류 인용에서만 사용하라.`;
  }

  if (hasContent) {
    return `${DRIFT_MARKER} 직전 최종 응답이 영어로 작성되었다. 다음 단계부터는 사용자에게 전달하는 최종 응답의 모든 설명 문장을 처음부터 끝까지 한국어로 작성하고, 내부 추론과 사고 요약에도 영문 알파벳을 섞지 말고 순수 한국어로만 생각하라. 코드·파일 경로·식별자·명령어·원문 오류 로그만 도구 호출 인자와 최종 답변에서 원문을 유지하라.`;
  }

  if (hasThinking) {
    return `${DRIFT_MARKER} 직전 내부 추론과 사고 요약이 영어로 작성되었다. 내부 사고에 영문 식별자·파일명·영어 단어가 섞이면 사고 요약 전체가 영어로 전환된다. 다음 단계부터는 내부 추론 속에 영문 알파벳을 단 한 글자도 쓰지 말고 파일명·함수명·원칙명까지 모두 순수 한국어 뜻이나 한글 음차로 바꿔서 생각하라. 영문 원문과 식별자는 오직 도구 호출 인자와 최종 답변에서만 사용하라.`;
  }

  return `${DRIFT_MARKER} 직전 단계에서 영어 이탈이 감지되었다. 다음 단계부터는 내부 추론과 사고 요약에 영문 알파벳을 단 한 글자도 쓰지 말고 순수 한국어 뜻이나 한글 음차로 생각하며, 최종 응답도 처음부터 끝까지 한국어로 작성하라. 영문 원문과 식별자는 오직 도구 호출 인자와 최종 답변의 코드·경로·식별자·오류 인용에서만 사용하라.`;
}

function createFieldTracker() {
  return {
    hasPendingMarker: false,
    markerFailed: false,
    responsesSinceMarker: 0,
    consecutiveFailed: 0,
  };
}

function resetFieldTracker(tracker) {
  tracker.hasPendingMarker = false;
  tracker.markerFailed = false;
  tracker.responsesSinceMarker = 0;
  tracker.consecutiveFailed = 0;
}

function isFieldCapped(field, tracker, maxConsecutiveFailedThinking) {
  return field === "thinking" && tracker.consecutiveFailed >= maxConsecutiveFailedThinking;
}

function requiredCooldownFor(tracker, baseCooldown) {
  if (baseCooldown <= 0) {
    return 0;
  }
  const exponent = Math.max(0, tracker.consecutiveFailed - 1);
  return baseCooldown * 2 ** exponent;
}

function isFieldInCooldown(tracker, baseCooldown) {
  if (!tracker.hasPendingMarker) {
    return false;
  }
  return tracker.responsesSinceMarker <= requiredCooldownFor(tracker, baseCooldown);
}

function getActionableFields(driftedFields, trackers, baseCooldown, maxConsecutiveFailedThinking) {
  return driftedFields.filter((field) => {
    const tracker = trackers[field];
    if (!tracker) {
      return false;
    }
    if (isFieldCapped(field, tracker, maxConsecutiveFailedThinking)) {
      return false;
    }
    return !isFieldInCooldown(tracker, baseCooldown);
  });
}

export function decideHookAction(steps, options = {}) {
  const {
    cooldownInvocations = DEFAULT_COOLDOWN_INVOCATIONS,
    maxConsecutiveFailedThinking = MAX_CONSECUTIVE_FAILED_THINKING,
    lastUserInput,
    ...analyzerOptions
  } = options;

  if (!Array.isArray(steps) || steps.length === 0) {
    return { action: "noop", reason: "no_planner_response" };
  }

  const trackers = {
    thinking: createFieldTracker(),
    content: createFieldTracker(),
  };

  let latestPlannerIndex = -1;
  let latestPlannerStep = null;
  let latestEvaluation = null;
  let lastMarkerIndex = -1;
  let currentContentExempt = false;
  let latestPlannerContentExempt = false;
  let lastActionableDriftedFields = [];
  let lastEffectiveDriftedFields = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step !== "object") {
      continue;
    }

    if (step.type === "USER_INPUT") {
      currentContentExempt = isExplicitEnglishOutputRequest(step.content);
      continue;
    }

    if (isDriftMarkerStep(step)) {
      lastMarkerIndex = i;
      const targets =
        lastActionableDriftedFields.length > 0
          ? lastActionableDriftedFields
          : lastEffectiveDriftedFields.length > 0
            ? lastEffectiveDriftedFields
            : ["thinking", "content"];
      for (const field of targets) {
        const tracker = trackers[field];
        if (!tracker || isFieldCapped(field, tracker, maxConsecutiveFailedThinking)) {
          continue;
        }
        tracker.hasPendingMarker = true;
        tracker.markerFailed = false;
        tracker.responsesSinceMarker = 0;
      }
      lastActionableDriftedFields = [];
      lastEffectiveDriftedFields = [];
      continue;
    }

    if (step.type !== "PLANNER_RESPONSE") {
      continue;
    }

    const evaluation = evaluatePlannerResponse(
      {
        thinking: typeof step.thinking === "string" ? step.thinking : "",
        content: typeof step.content === "string" ? step.content : "",
      },
      analyzerOptions,
    );

    latestPlannerIndex = i;
    latestPlannerStep = step;
    latestEvaluation = evaluation;
    latestPlannerContentExempt = currentContentExempt;

    const effectiveDrifted = [];
    for (const field of ["thinking", "content"]) {
      const tracker = trackers[field];
      const fieldResult = evaluation[field];
      const isExemptContent = field === "content" && currentContentExempt;

      if (tracker.hasPendingMarker) {
        tracker.responsesSinceMarker += 1;
      }

      if (isExemptContent) {
        continue;
      }

      if (fieldResult.status === "korean") {
        resetFieldTracker(tracker);
      } else if (fieldResult.status === "drifted") {
        effectiveDrifted.push(field);
        if (tracker.hasPendingMarker && !tracker.markerFailed) {
          tracker.markerFailed = true;
          tracker.consecutiveFailed += 1;
        }
      }
    }

    lastEffectiveDriftedFields = effectiveDrifted;
    lastActionableDriftedFields = getActionableFields(
      effectiveDrifted,
      trackers,
      cooldownInvocations,
      maxConsecutiveFailedThinking,
    );
  }

  if (!latestPlannerStep || !latestEvaluation) {
    return { action: "noop", reason: "no_planner_response" };
  }

  if (lastMarkerIndex > latestPlannerIndex) {
    return { action: "noop", reason: "already_covered" };
  }

  const finalContentExempt =
    typeof lastUserInput === "string" && lastUserInput.trim().length > 0
      ? isExplicitEnglishOutputRequest(lastUserInput)
      : latestPlannerContentExempt;

  const finalDriftedFields = (latestEvaluation.kind === "drifted" ? latestEvaluation.driftedFields : []).filter(
    (field) => !(field === "content" && finalContentExempt),
  );

  if (finalDriftedFields.length === 0) {
    return { action: "noop", reason: "ok" };
  }

  const actionableFields = getActionableFields(
    finalDriftedFields,
    trackers,
    cooldownInvocations,
    maxConsecutiveFailedThinking,
  );

  if (actionableFields.length === 0) {
    const onlyThinkingCapped =
      finalDriftedFields.length === 1 &&
      finalDriftedFields[0] === "thinking" &&
      isFieldCapped("thinking", trackers.thinking, maxConsecutiveFailedThinking);
    if (onlyThinkingCapped) {
      return { action: "noop", reason: "thinking_cap_reached" };
    }
    return { action: "noop", reason: "cooldown_active" };
  }

  return {
    action: "inject",
    stepIndex: latestPlannerStep.stepIndex,
    driftedFields: actionableFields,
    message: buildCorrectionMessage(actionableFields),
  };
}
