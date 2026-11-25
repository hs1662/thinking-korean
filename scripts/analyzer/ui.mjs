import {
  SHORT_ENGLISH_PROSE_WORD_THRESHOLD,
  UI_MAX_PROPER_NAME_WORDS,
  UI_MIN_LATIN_CHARS_FOR_DRIFT,
} from "./constants.mjs";
import {
  EMBEDDED_LATIN_SPAN_RE,
  FINITE,
  FUNCTION,
  HAS_HANGUL_RE,
  IMPERATIVE,
  PROSE_OPENER_RE,
  UI_TASK_OR_ROLE,
  englishWords,
  hasEnglishProseFunctionWord,
  hasEnglishSentenceFiniteWord,
  hasWordFlag,
  isUpperStopword,
  measureLanguage,
} from "./lexicon.mjs";
import { extractNaturalText } from "./stripper.mjs";

const KOREAN_LABEL_PREFIX_RE = /^\s*(?:\d+\s*)?[가-힣]{1,6}(?:\s+[가-힣]{1,6}){0,2}(?:\s*\d+)?\s*[:：\-–]\s*/;
const TOKEN_EDGE_PUNCT_RE = /^[("'“‘[{<]+|(?<![)"'”’\]}>,.;:!?])[)"'”’\]}>,.;:!?]+$/g;
const VERSION_TOKEN_RE = /^v?\d+(?:\.(?:\d+|[xX*]))*\+?$/;
const ACRONYM_TOKEN_RE = /^[A-Z][A-Z0-9]+s?$/;
const TITLE_TOKEN_RE = /^[A-Z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9]+)*[+#]*$/;
const LOWER_WORD_TOKEN_RE = /^[a-z]+(?:['’][a-z]+)?$/;
const PLAIN_WORD_TOKEN_RE = /^[A-Za-z]+(?:['’][A-Za-z]+)?$/;

const lowerOf = (word) => word.toLowerCase();
const isPlainWord = (token) => token !== undefined && PLAIN_WORD_TOKEN_RE.test(token);
const isAllCaps = (word) => word.length >= 2 && word === word.toUpperCase();

function isProperToken(token) {
  return VERSION_TOKEN_RE.test(token) || ACRONYM_TOKEN_RE.test(token) || TITLE_TOKEN_RE.test(token);
}

function labelTokens(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(TOKEN_EDGE_PUNCT_RE, ""))
    .filter((token) => /[A-Za-z0-9]/.test(token));
}

function hasProseSignal(words) {
  const caps = words.filter(isAllCaps);
  const plain = words.filter((word) => !isAllCaps(word));
  return (
    caps.some(isUpperStopword) || hasEnglishProseFunctionWord(plain) || hasEnglishSentenceFiniteWord(plain)
  );
}

function findInteriorConnector(tokens) {
  const candidates = [];
  for (let i = 1; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (
      LOWER_WORD_TOKEN_RE.test(token) &&
      hasWordFlag(token, FUNCTION) &&
      !hasWordFlag(token, FINITE) &&
      isProperToken(tokens[i - 1]) &&
      isProperToken(tokens[i + 1])
    ) {
      candidates.push(i);
    }
  }
  return candidates.length === 1 ? candidates[0] : -1;
}

function isEnglishLabelDrift(text, { allowConnector = false } = {}) {
  if (measureLanguage(text).latinCount < UI_MIN_LATIN_CHARS_FOR_DRIFT || englishWords(text).length < 2) {
    return false;
  }
  if (englishWords(extractNaturalText(text)).length === 0) {
    return false;
  }
  const tokens = labelTokens(text);
  if (PROSE_OPENER_RE.test(text.trim()) || (isPlainWord(tokens[0]) && hasWordFlag(lowerOf(tokens[0]), IMPERATIVE))) {
    return true;
  }

  const connectorIndex = allowConnector ? findInteriorConnector(tokens) : -1;
  const counted = tokens.filter((_token, i) => i !== connectorIndex);
  const plainWords = counted.filter(isPlainWord);
  if (hasProseSignal(plainWords) || counted.length > UI_MAX_PROPER_NAME_WORDS) {
    return true;
  }

  const lowercaseWords = counted.filter((token) => LOWER_WORD_TOKEN_RE.test(token)).length;
  const hasImperative = plainWords.some((word) => hasWordFlag(lowerOf(word), IMPERATIVE));
  const hasTaskOrRole = plainWords.some((word) => hasWordFlag(lowerOf(word), UI_TASK_OR_ROLE));
  if (lowercaseWords >= 2 || hasImperative || hasTaskOrRole) {
    return true;
  }
  if (counted.every(isProperToken)) {
    return false;
  }
  return true;
}

const MIN_IMPERATIVE_CLAUSE_WORDS = 3;

function isImperativeCommandClause(span) {
  return span.split(/[.!?,]/).some((clause) => {
    const clauseWords = englishWords(clause);
    if (clauseWords.length < MIN_IMPERATIVE_CLAUSE_WORDS || !hasWordFlag(lowerOf(clauseWords[0]), IMPERATIVE)) {
      return false;
    }
    if (clauseWords.length >= SHORT_ENGLISH_PROSE_WORD_THRESHOLD) {
      return true;
    }
    const lowerRestCount = clauseWords.slice(1).filter((word) => LOWER_WORD_TOKEN_RE.test(word)).length;
    return lowerRestCount >= 2 || hasEnglishProseFunctionWord(clauseWords) || hasEnglishSentenceFiniteWord(clauseWords);
  });
}

function hasEnglishClauseInMixedText(natural) {
  if (measureLanguage(natural).latinCount < UI_MIN_LATIN_CHARS_FOR_DRIFT) {
    return false;
  }
  for (const span of natural.match(EMBEDDED_LATIN_SPAN_RE) ?? []) {
    const words = englishWords(span);
    if (words.length >= SHORT_ENGLISH_PROSE_WORD_THRESHOLD) {
      if (PROSE_OPENER_RE.test(span) || hasEnglishProseFunctionWord(words) || hasEnglishSentenceFiniteWord(words)) {
        return true;
      }
    } else if (words.length < MIN_IMPERATIVE_CLAUSE_WORDS) {
      continue;
    }
    if (isImperativeCommandClause(span)) {
      return true;
    }
  }
  return false;
}

function isEnglishUiEntry(rawText) {
  if (!HAS_HANGUL_RE.test(rawText)) {
    return isEnglishLabelDrift(rawText);
  }
  const prefix = rawText.match(KOREAN_LABEL_PREFIX_RE);
  if (prefix) {
    const body = rawText.slice(prefix[0].length);
    if (!HAS_HANGUL_RE.test(body)) {
      return isEnglishLabelDrift(body, { allowConnector: true });
    }
  }
  const natural = extractNaturalText(rawText);
  if (!HAS_HANGUL_RE.test(natural)) {
    return isEnglishLabelDrift(natural);
  }
  return hasEnglishClauseInMixedText(natural);
}

function uiResult(rawLength, metrics, status, driftReason, driftedEntries) {
  return { field: "ui", rawLength, ...metrics, status, driftReason, driftedEntries };
}

export function analyzeUiTexts(entries = []) {
  const list = Array.isArray(entries)
    ? entries.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];

  if (list.length === 0) {
    const empty = { hangulCount: 0, latinCount: 0, naturalCharCount: 0, hangulRatio: 0 };
    return uiResult(0, empty, "insufficient", "none", []);
  }

  const rawLength = list.join("\n").length;
  const metrics = measureLanguage(list.map((item) => extractNaturalText(item)).join("\n"));
  const driftedEntries = list.filter((item) => isEnglishUiEntry(item));

  if (driftedEntries.length > 0) {
    return uiResult(rawLength, metrics, "drifted", "english_ui_text", driftedEntries);
  }
  if (metrics.hangulCount >= 4) {
    return uiResult(rawLength, metrics, "korean", "none", []);
  }
  return uiResult(rawLength, metrics, "insufficient", "none", []);
}
