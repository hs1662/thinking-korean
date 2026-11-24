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

const KO_REQUEST_NOUN_ACTION = "(?:번역|작성|답변|답장|응답|설명|요약|정리|출력|변환|표현|교정)";
const KO_REQUEST_NOUN_ENDING =
  "(?:해\\s*(?:줘|줘요|주세요|주실래요|주실\\s*수|줄래|줄래요|줄\\s*수|주십시오|주시기|주길|라|달라|보여\\s*줘|보여주세요)|해주세요|해줘|해라|하라|하시오|하십시오|하세요|하길\\s*바라|하기\\s*바라|하기를\\s*바라|하길\\s*원해|하기\\s*원해|하기를\\s*원해|(?:[을를]\\s*|\\s+)(?:원해|원해요|원합니다|바라|바래|바랍니다)|(?:[을를]\\s*|\\s*)부탁(?:해|해요|합니다|드립니다|드려요)?|해(?=$|[.!?,])|해요(?=$|[.!?,\\s]))";
const KO_REQUEST_VERB_CONJ =
  "(?:(?:답해|바꿔|바꾸어|써|적어|말해|고쳐|다시\\s*써|만들어)(?:\\s*(?:줘|줘요|주세요|주실래요|줄래|줄래요|주십시오|주길|달라|라)|(?=$|[.!?,])|요(?=$|[.!?,\\s]))|(?:답하|바꾸|쓰|적|말하|고치|만들)(?:라|세요|시오|십시오|길\\s*바라|기\\s*바라|기를\\s*바라|길\\s*원해|기\\s*원해|기를\\s*원해)|(?:해\\s*(?:줘|줘요|주세요|주실래요|줄래|줄래요|주십시오|달라|라)|해주세요|해줘|해라|부탁(?:해|해요|합니다|드립니다|드려요)?))";

const KO_NEGATED_TRANSLATION_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)?\\s*(?:[가-힣A-Za-z0-9]+\\s+){0,2}(?:번역|작성|답변|답|답장|응답|설명|요약|정리|출력|변환|쓰|적|말|표현|바꾸|하)(?:하|해|은|는|을|를)?\\s*(?:지\\s*(?:말|마|않)|하지\\s*(?:말|마|않)|하면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|면\\s*안\\s*(?:돼|되|됨|됩니다|돼요)|말고|금지|대신)` +
    `|${FOREIGN_LANG_KO}(?:으로|로)?\\s*(?:말고|대신|아닌|아니라)`,
);

const KO_DESCRIPTIVE_OR_COMPLAINT_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)\\s*(?:번역|작성|답변|답|답장|응답|설명|요약|정리|출력|변환|표현|쓰|적|말|나오|생각|추론|처리|표시|생성)(?:하|해)?(?:되어|되|된|되는|됐|했|하는\\s*(?:거|것|지|데|중)|하고\\s*있|나오|았|었|잖아|는데|는지)`,
);

const KO_KOREAN_OUTPUT_REQUEST_RE =
  /(?:한국어|한글|국문)로\s*(?:[가-힣A-Za-z0-9]+\s+){0,2}(?:요약|분석|고쳐|말해|답변|답해|답하|응답|설명|작성|정리|번역|출력|써|바꿔|해\s*줘|해주세요|해줘)/;

const KO_INTERMEDIATE_BLOCKLIST_RE =
  /(?:되어|되는|됐|했|하는|하고|하면|말고|대신|안\s*돼|안\s*되|버그|오류|문제|이슈|현상|원인|한국어|한글|국문|된\s*(?:파일|문서|글|코드|내용|텍스트))/;

const KO_LANG_RO_REQUEST_RE = new RegExp(
  `${FOREIGN_LANG_KO}(?:으로|로)\\s*((?:[가-힣A-Za-z0-9,·-]+\\s+){0,4})(?:${KO_REQUEST_NOUN_ACTION}${KO_REQUEST_NOUN_ENDING}|${KO_REQUEST_VERB_CONJ})`,
  "g",
);

const KO_NOUN_MODIFIER_REQUEST_RE = new RegExp(
  `(?:영어|영문)\\s+(?:[가-힣A-Za-z0-9]+\\s+){0,2}(?:번역(?:본|문)?|초안|버전|이메일|메일|문장|답장|요약(?:본|문)?)(?:을|를)?\\s*(?:(?:작성|번역|출력|제공|생성)${KO_REQUEST_NOUN_ENDING}|(?:만들어|써|적어|보여|해)\\s*(?:줘|줘요|주세요|줄래|라|달라)|해주세요|해줘|해라|부탁(?:해|해요|합니다|드립니다|드려요)?)`,
);

const EN_NEGATED_OUTPUT_RE = new RegExp(
  `\\b(?:do\\s+not|don['’]t|never|avoid|stop|quit)\\s+(?:[a-z]+\\s+){0,2}(?:translat(?:e|ing)|writ(?:e|ing)|repl(?:y|ying)|respond(?:ing)?|answer(?:ing)?|explain(?:ing)?|summariz(?:e|ing)|output(?:ting)?|rewrit(?:e|ing)|draft(?:ing)?|speak(?:ing)?|talk(?:ing)?|us(?:e|ing))\\b[^.!?\n,;]{0,40}\\b(?:(?:in|into|to)\\s+)?${FOREIGN_LANG_EN}\\b` +
    `|\\b(?:in|into|to)\\s+${FOREIGN_LANG_EN}\\s+instead\\s+of\\b` +
    `|\\binstead\\s+of\\b[^.!?\n,;]{0,30}\\b${FOREIGN_LANG_EN}\\b` +
    `|\\bnot\\s+(?:in|into|to)\\s+${FOREIGN_LANG_EN}\\b` +
    `|\\bnot\\s+(?:an?\\s+)?${FOREIGN_LANG_EN}\\s+(?:translation|version|response|reply)\\b`,
  "i",
);

const EN_NARRATIVE_COMPLAINT_RE =
  /\b(?:kept|keeps|tried|trying|continues?|continued|started|began|seems?\s+to|tends?\s+to|why\s+(?:did|do|does|is|are|was|were))\b/i;

const EN_ACTION_BODY =
  `(?:translate\\b[^.!?\n]{0,60}\\b(?:into|to)\\s+${FOREIGN_LANG_EN}\\b` +
  `|(?:write|reply|respond|answer|explain|summarize|output|rewrite|draft|compose|phrase|express|say|give|provide|return|produce)\\b[^.!?\n]{0,50}\\bin\\s+${FOREIGN_LANG_EN}\\b` +
  `|(?:give|provide|write|draft|output|return|produce|show|make)\\b[^.!?\n]{0,40}\\b(?:an?\\s+)?${FOREIGN_LANG_EN}\\s+(?:translation|version|draft|response|reply|summary)\\b)`;

const EN_IMPERATIVE_REQUEST_RE = new RegExp(
  `(?:^|(?:[,;]\\s*|\\b(?:and|then|so)\\s+))(?:(?:please|kindly|just|now|only|always)\\s+)*${EN_ACTION_BODY}`,
  "i",
);

const EN_POLITE_REQUEST_RE = new RegExp(
  `\\b(?:can\\s+you|could\\s+you|would\\s+you|will\\s+you|please|i\\s+(?:want|need|would\\s+like)(?:\\s+you)?\\s+to|i['’]d\\s+like(?:\\s+you)?\\s+to)\\s+(?:(?:please|kindly|just)\\s+)*${EN_ACTION_BODY}`,
  "i",
);

const EN_DIRECT_TRANSLATION_NOUN_RE = new RegExp(
  `^\\s*(?:please\\s+)?(?:an?\\s+)?${FOREIGN_LANG_EN}\\s+translation(?:\\s+(?:please|only))?\\s*[:.]?$`,
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

function hasValidKoreanEnglishRequest(sentence) {
  if (KO_NEGATED_TRANSLATION_RE.test(sentence)) {
    return false;
  }
  if (KO_DESCRIPTIVE_OR_COMPLAINT_RE.test(sentence)) {
    return false;
  }
  if (KO_KOREAN_OUTPUT_REQUEST_RE.test(sentence)) {
    return false;
  }

  KO_LANG_RO_REQUEST_RE.lastIndex = 0;
  let match;
  while ((match = KO_LANG_RO_REQUEST_RE.exec(sentence)) !== null) {
    const intermediate = (match[1] ?? "").trim();
    if (intermediate.length === 0 || !KO_INTERMEDIATE_BLOCKLIST_RE.test(intermediate)) {
      return true;
    }
  }

  return KO_NOUN_MODIFIER_REQUEST_RE.test(sentence);
}

function hasValidEnglishRequest(sentence) {
  if (EN_NEGATED_OUTPUT_RE.test(sentence)) {
    return false;
  }
  if (EN_NARRATIVE_COMPLAINT_RE.test(sentence)) {
    return false;
  }
  return (
    EN_IMPERATIVE_REQUEST_RE.test(sentence) ||
    EN_POLITE_REQUEST_RE.test(sentence) ||
    EN_DIRECT_TRANSLATION_NOUN_RE.test(sentence)
  );
}

export function isExplicitEnglishOutputRequest(rawText) {
  const body = extractUserRequestBody(rawText);
  if (body.length === 0) {
    return false;
  }
  if (KO_NEGATED_TRANSLATION_RE.test(body)) {
    return false;
  }

  const sentences = body
    .split(/[.!?\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (sentences.length === 0) {
    return false;
  }

  let hasPositiveRequest = false;
  for (const sentence of sentences) {
    if (hasValidKoreanEnglishRequest(sentence) || hasValidEnglishRequest(sentence)) {
      hasPositiveRequest = true;
      break;
    }
  }
  if (!hasPositiveRequest) {
    return false;
  }

  return !KO_KOREAN_OUTPUT_REQUEST_RE.test(body);
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
