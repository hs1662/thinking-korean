// UI label rules: analyzeUiTexts and isEnglishUiEntry.
import {
  MIN_LATIN_CHARS_FOR_DRIFT,
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
  englishWords,
  hasEnglishProseFunctionWord,
  hasEnglishSentenceFiniteWord,
  hasWordFlag,
  isUpperStopword,
  measureLanguage,
} from "./lexicon.mjs";
import { extractNaturalText } from "./stripper.mjs";

const KOREAN_LABEL_PREFIX_RE = /^\s*(?:\d+\s*)?[가-힣]{1,6}(?:\s+[가-힣]{1,4})?(?:\s*\d+)?\s*[:：\-–]\s*/;
const TOKEN_EDGE_PUNCT_RE = /^[("'“‘[{<]+|[)"'”’\]}>,.;:!?]+$/g;
const VERSION_TOKEN_RE = /^v?\d+(?:\.(?:\d+|[xX*]))*\+?$/; // 18, 5.x, v1.2.3
const ACRONYM_TOKEN_RE = /^[A-Z][A-Z0-9]+s?$/; // CSS, LTS, APIs, S3
const TITLE_TOKEN_RE = /^[A-Z][A-Za-z0-9]*(?:[.+#-][A-Za-z0-9]+)*[+#]*$/; // React, GitHub, Next.js, C++
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

// Function words / finite verbs / contractions; ALL-CAPS tokens count only when they spell a stopword.
function hasProseSignal(words) {
  const caps = words.filter(isAllCaps);
  const plain = words.filter((word) => !isAllCaps(word));
  return (
    caps.some(isUpperStopword) || hasEnglishProseFunctionWord(plain) || hasEnglishSentenceFiniteWord(plain)
  );
}

// One lowercase function word (not a finite verb/pronoun) between two proper-name tokens,
// e.g. "Visual Studio Code for Web". Only allowed behind a Korean label.
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

// Rule A: a label body with no Korean at all. Word cues come only from plain word tokens, so
// identifiers such as `update_steps` or `NO_TOOL_CALL` stay neutral.
function isEnglishLabelDrift(text, { allowConnector = false } = {}) {
  if (measureLanguage(text).latinCount < UI_MIN_LATIN_CHARS_FOR_DRIFT || englishWords(text).length < 2) {
    return false;
  }
  // Nothing natural left after stripping code, paths, hints and error quotes: not prose.
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
  if (lowercaseWords >= 2 || (lowercaseWords >= 1 && hasImperative)) {
    return true;
  }
  if (counted.every(isProperToken)) {
    return false;
  }
  // Remaining mixes (Title Case + lowercase noun, identifiers + words) count as drift.
  return true;
}

// Rule B (mixed Korean text): only a real English clause of 4+ words drifts.
function hasEnglishClauseInMixedText(natural) {
  if (measureLanguage(natural).latinCount < MIN_LATIN_CHARS_FOR_DRIFT) {
    return false;
  }
  for (const span of natural.match(EMBEDDED_LATIN_SPAN_RE) ?? []) {
    const words = englishWords(span);
    if (words.length < SHORT_ENGLISH_PROSE_WORD_THRESHOLD) {
      continue;
    }
    if (PROSE_OPENER_RE.test(span) || hasEnglishProseFunctionWord(words) || hasEnglishSentenceFiniteWord(words)) {
      return true;
    }
    // Imperative clause: a sentence/comma piece of 4+ words opening with a command verb.
    const isCommandClause = span.split(/[.!?,]/).some((clause) => {
      const clauseWords = englishWords(clause);
      return clauseWords.length >= SHORT_ENGLISH_PROSE_WORD_THRESHOLD && hasWordFlag(lowerOf(clauseWords[0]), IMPERATIVE);
    });
    if (isCommandClause) {
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
    return isEnglishLabelDrift(rawText);
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
