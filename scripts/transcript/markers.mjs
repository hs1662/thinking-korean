import { isPreToolDenialStep } from "./steps.mjs";

export const DRIFT_MARKER = "[한국어사고:영어이탈]";
export const LEGACY_DRIFT_MARKERS = ["[thinking-korean:drift]"];
export const FIELD_TAGS = { thinking: "추론", content: "응답", ui: "화면" };

const FIELD_ORDER = ["thinking", "content", "ui"];
const TAG_TO_FIELD = new Map(Object.entries(FIELD_TAGS).map(([field, tag]) => [tag, field]));
const ALL_DRIFT_MARKERS = [DRIFT_MARKER, ...LEGACY_DRIFT_MARKERS];
const TARGET_TAG_RE = /^\[대상:([^\]\n]*)\]/;
const SYSTEM_MESSAGE_PREAMBLE_RE = /^The following is a <SYSTEM_MESSAGE>[^\n]*\n+/;
const SYSTEM_MESSAGE_OPEN_TAG_RE = /^<SYSTEM_MESSAGE>[ \t]*\n?/;
const HOOK_MESSAGE_HEADER_RE =
  /^(?:The following system message was injected by a (?:PostInvocation|PreInvocation|Stop|PreToolUse) hook:[ \t]*\n+|Stop hook blocked termination:[ \t]*)/i;

const REMINDER = "이 추론과 생각 요약은 반드시 한국어로만 작성한다.";
const UI_ITEMS = "(작업 단계 제목, 도구 요약, 역할 이름, 질문 선택지)";

// Per-field problem subject (single / combined phrasing) and directive sentence.
const FIELD_TEXT = {
  thinking: {
    single: "내부 추론과 생각 요약",
    combined: "내부 추론·생각 요약",
    directive: `한국어를 유일한 모국어로 삼아 오직 한국어로만 사고하고, 예외 없이 모든 추론 문단의 첫 문장(마지막 정리 문단 포함)에 "${REMINDER}"를 직접 적으며 전체 추론을 2에서 3문단 이내(문단당 2문장 이내)의 간결한 한국어 평서문으로 압축하라. 추론 안에 괄호 영어 병기, 코드 조각, 번호·글머리 나열, 영어 예시 문장을 쓰거나 상세 보고서를 미리 길게 초안으로 적지 말고 영어 문장이나 영어 절은 절대 쓰지 마라.`,
  },
  content: {
    single: "최종 응답",
    combined: "최종 응답",
    directive:
      "최종 응답도 사용자와 직접 대화하듯 자연스러운 한국어 문장으로 작성하고, 필요한 코드, 경로, 식별자, 명령어, 고유명사와 기술 영어 단어만 원문을 유지하며 영어 문장은 쓰지 마라.",
  },
  ui: {
    single: `도구 호출의 화면 표시 항목${UI_ITEMS}`,
    combined: `화면 표시 항목${UI_ITEMS}`,
    directive:
      "도구 스키마 예시가 영어여도 사용자 화면에 보이는 작업 단계 제목, 도구 요약, 질문 선택지를 반드시 자연스러운 한국어로 작성하고, 이미 표시된 영어 단계 목록이 있다면 한국어로 갱신하라.",
  },
};
const BASELINE_THINKING_DIRECTIVE = `모든 추론 문단의 첫 문장에 "${REMINDER}"를 직접 적고 간결한 한국어 문단으로 생각하라.`;
const FALLBACK_CONTENT_DIRECTIVE = "최종 응답도 자연스러운 한국어 문장으로 작성하라.";

function normalizeFields(fields) {
  const list = Array.isArray(fields) ? fields : [];
  return FIELD_ORDER.filter((field) => list.includes(field));
}

export function formatDriftMarker(fields = []) {
  const valid = normalizeFields(fields);
  if (valid.length === 0) {
    return DRIFT_MARKER;
  }
  return `${DRIFT_MARKER}[대상:${valid.map((field) => FIELD_TAGS[field]).join("+")}]`;
}

function describeProblem(fields) {
  if (fields.length === 0) {
    return "직전 단계에서 영어 이탈이 감지되었다.";
  }
  if (fields.length === 1) {
    return `직전 ${FIELD_TEXT[fields[0]].single}이 영어로 작성되었다.`;
  }
  const subjects = fields.map((field) => FIELD_TEXT[field].combined);
  const last = subjects.pop();
  const head = subjects.length === 1 ? subjects[0] : `${subjects.slice(0, -1).join(", ")}, ${subjects.at(-1)}`;
  return `직전 ${head}과 ${last}이 모두 영어로 작성되었다.`;
}

export function buildCorrectionMessage(driftedFields = []) {
  const fields = normalizeFields(driftedFields);
  const directives = [];
  if (fields.includes("thinking")) {
    directives.push(FIELD_TEXT.thinking.directive);
  } else if (fields.length === 0 || fields.includes("content")) {
    directives.push(BASELINE_THINKING_DIRECTIVE);
  }
  for (const field of ["content", "ui"]) {
    if (fields.includes(field)) {
      directives.push(FIELD_TEXT[field].directive);
    }
  }
  if (fields.length === 0) {
    directives.push(FALLBACK_CONTENT_DIRECTIVE);
  }
  return `${formatDriftMarker(fields)} ${describeProblem(fields)} 다음 단계부터는 ${directives.join(" ")}`;
}

export function buildPreToolDenyMessage() {
  return `${formatDriftMarker(["ui"])} 작업 단계 제목과 화면 표시 항목이 영어로 작성되었다. 모든 항목 제목과 선택지를 자연스러운 한국어로 바꿔서 같은 도구를 즉시 다시 호출하라.`;
}

// Fallback for unstructured (legacy) marker bodies without a [대상:…] tag.
function legacyInferFields(body) {
  const fields = new Set();
  const segments = body.split(/[.\n]+/);
  if (
    /내부 추론과 (?:생각|사고) 요약이 영어로|내부 추론·(?:생각|사고) 요약/.test(body) ||
    segments.some((segment) => /\bdrifted\b/i.test(segment) && /\bthinking\b/i.test(segment))
  ) {
    fields.add("thinking");
  }
  if (
    body.includes("직전 최종 응답이 영어로") ||
    body.includes("최종 응답이 모두 영어로") ||
    body.includes("최종 응답도 영어로") ||
    segments.some((segment) => /\bdrifted\b/i.test(segment) && /\bcontent\b/i.test(segment))
  ) {
    fields.add("content");
  }
  if (body.includes("화면 표시 항목") || body.includes("작업 단계 제목") || body.includes("도구 표시 텍스트")) {
    fields.add("ui");
  }
  return FIELD_ORDER.filter((field) => fields.has(field));
}

function parseTargetTag(rest) {
  const match = rest.match(TARGET_TAG_RE);
  if (!match) {
    return null;
  }
  const fields = new Set();
  for (const tag of match[1].split("+")) {
    const field = TAG_TO_FIELD.get(tag.trim());
    if (field) {
      fields.add(field);
    }
  }
  return FIELD_ORDER.filter((field) => fields.has(field));
}

function detectSourceHook(rawHeader) {
  const header = rawHeader.toLowerCase();
  if (header.includes("stop")) {
    return "Stop";
  }
  if (header.includes("postinvocation")) {
    return "PostInvocation";
  }
  if (header.includes("preinvocation")) {
    return "PreInvocation";
  }
  if (header.includes("pretooluse")) {
    return "PreToolUse";
  }
  return "unknown";
}

export function parseDriftMarkerStep(step) {
  if (isPreToolDenialStep(step)) {
    return { marker: DRIFT_MARKER, sourceHook: "PreToolUse", fields: ["ui"], structured: true };
  }
  if (!step || step.type !== "SYSTEM_MESSAGE" || typeof step.content !== "string") {
    return null;
  }

  let body = step.content.replace(/\r\n?/g, "\n").trimStart();
  body = body.replace(SYSTEM_MESSAGE_PREAMBLE_RE, "").trimStart();
  body = body.replace(SYSTEM_MESSAGE_OPEN_TAG_RE, "").trimStart();

  let sourceHook = "unknown";
  const headerMatch = body.match(HOOK_MESSAGE_HEADER_RE);
  if (headerMatch) {
    sourceHook = detectSourceHook(headerMatch[0]);
    body = body.slice(headerMatch[0].length).trimStart();
  }

  const matchedMarker = ALL_DRIFT_MARKERS.find((marker) => body.startsWith(marker));
  if (!matchedMarker) {
    return null;
  }

  const tagged = parseTargetTag(body.slice(matchedMarker.length));
  if (tagged) {
    return { marker: matchedMarker, sourceHook, fields: tagged, structured: true };
  }
  return { marker: matchedMarker, sourceHook, fields: legacyInferFields(body), structured: false };
}

export function isDriftMarkerStep(step) {
  return parseDriftMarkerStep(step) !== null;
}
