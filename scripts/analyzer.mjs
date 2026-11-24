export const MIN_NATURAL_CHARS = 24;
export const MIN_HANGUL_RATIO = 0.45;
export const MIN_LATIN_CHARS_FOR_DRIFT = 16;
export const ENGLISH_RUN_WORD_THRESHOLD = 8;
export const SEGMENT_MIN_NATURAL_CHARS = 40;
export const SEGMENT_MAX_HANGUL_RATIO = 0.25;

const FENCED_CODE_RE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
const BLOCKQUOTE_LINE_RE = /^[ \t]*>.*$/gm;
const INLINE_CODE_RE = /(`+)[^`\n]*?\1/g;
const DOUBLE_QUOTED_RE = /"(?:\\.|[^"\\\n])*"/g;
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s<>)"'`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/gi;
const XML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[^<>\n]*?)?\/?>/g;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s"'`<>()[\]{},;\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/g;
const UNIX_PATH_RE = /(?<=^|[\s(\[{,:;])(?:\.{1,2}|~)?\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*/g;
const RELATIVE_PATH_RE = /(?<=^|[\s(\[{,:;])[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+/g;
const LONG_FLAG_RE = /(?<=^|[\s(\[{,:;])--[A-Za-z0-9][A-Za-z0-9._-]*(?:=[^\s"'`<>()[\]{},;\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+)?/g;
const SHORT_FLAG_RE = /(?<=^|[\s(\[{,:;])-[A-Za-z](?=$|[\s)\]},;:])/g;
const DOTTED_PATH_RE = /\b[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\b/g;
const SNAKE_IDENT_RE = /\b(?:_[A-Za-z0-9_]+|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/g;
const CAMEL_IDENT_RE = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
const PASCAL_IDENT_RE = /\b(?:[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}[a-z][A-Za-z0-9]*)\b/g;

const HANGUL_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/g;
const LATIN_RE = /[A-Za-z]/g;
const PROSE_TOKEN_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+|[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function measureLanguage(text) {
  const hangulCount = countMatches(text, HANGUL_RE);
  const latinCount = countMatches(text, LATIN_RE);
  const naturalCharCount = hangulCount + latinCount;
  const hangulRatio = naturalCharCount > 0 ? hangulCount / naturalCharCount : 0;
  return { hangulCount, latinCount, naturalCharCount, hangulRatio };
}

function hasDriftedSegment(naturalText, { segmentMinNaturalChars, segmentMaxHangulRatio, minLatinCharsForDrift }) {
  const segments = new Set([
    ...naturalText.split(/\n{2,}/),
    ...naturalText.split(/\n+/),
  ]);

  for (const segment of segments) {
    const metrics = measureLanguage(segment);
    if (
      metrics.naturalCharCount >= segmentMinNaturalChars &&
      metrics.latinCount >= minLatinCharsForDrift &&
      metrics.hangulRatio <= segmentMaxHangulRatio
    ) {
      return true;
    }
  }

  return false;
}

function hasEnglishWordRun(naturalText, threshold) {
  const paragraphs = naturalText.split(/\n{2,}/);

  for (const paragraph of paragraphs) {
    let run = 0;
    const tokens = paragraph.match(PROSE_TOKEN_RE) ?? [];
    for (const token of tokens) {
      if (token.charCodeAt(0) > 127) {
        run = 0;
        continue;
      }
      run += 1;
      if (run >= threshold) {
        return true;
      }
    }
  }

  return false;
}

export function extractNaturalText(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return "";
  }

  const stripped = rawText
    .replace(/\r\n?/g, "\n")
    .replace(FENCED_CODE_RE, "\n")
    .replace(BLOCKQUOTE_LINE_RE, "")
    .replace(INLINE_CODE_RE, " ")
    .replace(DOUBLE_QUOTED_RE, " ")
    .replace(URL_RE, " ")
    .replace(XML_TAG_RE, " ")
    .replace(WINDOWS_PATH_RE, " ")
    .replace(UNIX_PATH_RE, " ")
    .replace(RELATIVE_PATH_RE, " ")
    .replace(LONG_FLAG_RE, " ")
    .replace(SHORT_FLAG_RE, " ")
    .replace(DOTTED_PATH_RE, " ")
    .replace(SNAKE_IDENT_RE, " ")
    .replace(CAMEL_IDENT_RE, " ")
    .replace(PASCAL_IDENT_RE, " ");

  return stripped
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function analyzeField(field, rawText, options = {}) {
  const {
    minNaturalChars = MIN_NATURAL_CHARS,
    minHangulRatio = MIN_HANGUL_RATIO,
    minLatinCharsForDrift = MIN_LATIN_CHARS_FOR_DRIFT,
    englishRunWordThreshold = ENGLISH_RUN_WORD_THRESHOLD,
    segmentMinNaturalChars = SEGMENT_MIN_NATURAL_CHARS,
    segmentMaxHangulRatio = SEGMENT_MAX_HANGUL_RATIO,
  } = options;

  const normalizedRaw = typeof rawText === "string" ? rawText : "";
  const naturalText = extractNaturalText(normalizedRaw);
  const metrics = measureLanguage(naturalText);
  const base = {
    field,
    rawLength: normalizedRaw.length,
    ...metrics,
  };

  if (metrics.naturalCharCount < minNaturalChars) {
    return { ...base, status: "insufficient", driftReason: "none" };
  }

  if (metrics.latinCount < minLatinCharsForDrift) {
    return { ...base, status: "korean", driftReason: "none" };
  }

  if (metrics.hangulRatio < minHangulRatio) {
    return { ...base, status: "drifted", driftReason: "low_hangul_ratio" };
  }

  if (hasDriftedSegment(naturalText, { segmentMinNaturalChars, segmentMaxHangulRatio, minLatinCharsForDrift })) {
    return { ...base, status: "drifted", driftReason: "english_segment" };
  }

  if (hasEnglishWordRun(naturalText, englishRunWordThreshold)) {
    return { ...base, status: "drifted", driftReason: "english_run" };
  }

  return { ...base, status: "korean", driftReason: "none" };
}

export function evaluatePlannerResponse({ thinking = "", content = "" } = {}, options = {}) {
  const thinkingResult = analyzeField("thinking", thinking, options);
  const contentResult = analyzeField("content", content, options);
  const driftedFields = [thinkingResult, contentResult]
    .filter((result) => result.status === "drifted")
    .map((result) => result.field);

  if (driftedFields.length > 0) {
    return {
      kind: "drifted",
      driftedFields,
      thinking: thinkingResult,
      content: contentResult,
    };
  }

  return {
    kind: "ok",
    thinking: thinkingResult,
    content: contentResult,
  };
}
