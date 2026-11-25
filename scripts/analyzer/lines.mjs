// One-pass line model: each natural-text line is classified and stripped exactly once.
import {
  KOREAN_LINE_MIN_HANGUL,
  KOREAN_LINE_MIN_TOKENS,
  MAX_CITED_TITLE_CHARS,
  MAX_CITED_TITLE_WORDS,
  MAX_EMBEDDED_TERM_WORDS,
  MAX_STRUCTURED_HEADING_CHARS,
  SHORT_ENGLISH_PROSE_MAX_HANGUL,
  SHORT_ENGLISH_PROSE_MAX_HANGUL_RATIO,
} from "./constants.mjs";
import {
  EMBEDDED_LATIN_SPAN_RE,
  ENGLISH_CONTRACTION_RE,
  FUNCTION,
  HANGUL_RE,
  HANGUL_TOKEN_RE,
  HAS_HANGUL_RE,
  IMPERATIVE,
  PROSE_OPENER_RE,
  SENTENCE_BOUNDARY_RE,
  countEnglishWords,
  countMatches,
  englishWords,
  hasEnglishProseFunctionWord,
  hasEnglishSentenceFiniteWord,
  hasWordFlag,
  measureLanguage,
} from "./lexicon.mjs";

const TABLE_SEPARATOR_LINE_RE = /^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?[ \t]*$/;
const BULLET_PREFIX_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING_PREFIX_RE = /^[ \t]*#{1,6}[ \t]+/;
const CITED_BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const CITED_DOUBLE_QUOTE_RE = /"([^"\n]+)"/g;
const CITED_CURLY_QUOTE_RE = /[“「『]([^”」』\n]+)[”」』]/g;
const CITED_PAREN_RE = /\(([^()\n]+)\)/g;
const KEY_VALUE_LABEL_LINE_RE = /^[ \t]*[A-Za-z][A-Za-z0-9_ -]{1,30}:[ \t]*[^\n]{1,60}$/;

function countEnglishFunctionWords(words) {
  return words.filter((word) => ENGLISH_CONTRACTION_RE.test(word) || hasWordFlag(word.toLowerCase(), FUNCTION)).length;
}

const CITED_PROSE_SUBJECT_RE = /^(?:it|this|that|these|those|there)$/i;
const CITED_IMPERATIVE_DETERMINER_RE = /^(?:the|a|an|this|that|these|those|it|them|my|our|your|all|every)$/;
const CITED_TITLE_PREP_RE = /^(?:in|on|at|to|of|for|from|with|by|as|or|and|vs|without|under|over|into|about|between|through|after|before|via)$/;

function isShortCitedTitle(rawInner) {
  const inner = rawInner.trim();
  if (inner.length === 0 || inner.length > MAX_CITED_TITLE_CHARS || HAS_HANGUL_RE.test(inner)) {
    return false;
  }
  const words = englishWords(inner);
  if (words.length === 0 || words.length > MAX_CITED_TITLE_WORDS) {
    return false;
  }
  if (SENTENCE_BOUNDARY_RE.test(inner) || PROSE_OPENER_RE.test(inner)) {
    return false;
  }
  if (words.length >= 4 && hasEnglishSentenceFiniteWord(words)) {
    return false;
  }
  if (words.length >= 3) {
    const rest = words.slice(1);
    const isImperativeDet =
      (rest[0] === rest[0].toLowerCase() || (rest[0].length >= 2 && rest[0] === rest[0].toUpperCase())) &&
      CITED_IMPERATIVE_DETERMINER_RE.test(rest[0].toLowerCase());
    if (hasWordFlag(words[0].toLowerCase(), IMPERATIVE) && isImperativeDet) {
      return false;
    }
    if (CITED_PROSE_SUBJECT_RE.test(words[0])) {
      const nonPrepLowerCount = rest.filter((word) => word === word.toLowerCase() && !CITED_TITLE_PREP_RE.test(word)).length;
      if ((rest[0] === rest[0].toLowerCase() && !CITED_TITLE_PREP_RE.test(rest[0])) || nonPrepLowerCount >= 2) {
        return false;
      }
    }
  }
  if (words.length >= 6 && countEnglishFunctionWords(words) >= 2) {
    return false;
  }
  return true;
}

export function stripShortCitedTitlesOnKoreanLine(line) {
  if (!HAS_HANGUL_RE.test(line)) {
    return line;
  }
  const replaceIfTitle = (full, inner) => (isShortCitedTitle(inner) ? "; " : full);
  let cleaned = line
    .replace(CITED_BOLD_RE, replaceIfTitle)
    .replace(CITED_DOUBLE_QUOTE_RE, replaceIfTitle)
    .replace(CITED_CURLY_QUOTE_RE, replaceIfTitle);
  for (let pass = 0; pass < 2; pass += 1) {
    const next = cleaned.replace(CITED_PAREN_RE, replaceIfTitle);
    if (next === cleaned) {
      break;
    }
    cleaned = next;
  }
  return cleaned;
}

function isKoreanSentenceLine(line) {
  return (
    countMatches(line, HANGUL_RE) >= KOREAN_LINE_MIN_HANGUL &&
    countMatches(line, HANGUL_TOKEN_RE) >= KOREAN_LINE_MIN_TOKENS
  );
}

function isStandaloneEnglishSentenceSpan(line, offset, matchLength, wordCount) {
  if (wordCount < 2) {
    return false;
  }
  const before = line.slice(0, offset).trimEnd();
  const after = line.slice(offset + matchLength).trimStart();
  return (before.length === 0 || /[.!?]$/.test(before)) && /^[.!?]/.test(after);
}

function isEmbeddedTermPart(part, words) {
  return (
    words.length > 0 &&
    words.length <= MAX_EMBEDDED_TERM_WORDS &&
    !PROSE_OPENER_RE.test(part) &&
    !hasEnglishProseFunctionWord(words)
  );
}

export function stripEmbeddedTermsOnKoreanLine(line) {
  if (!isKoreanSentenceLine(line)) {
    return line;
  }
  return line.replace(EMBEDDED_LATIN_SPAN_RE, (span, offset) => {
    if (/[.!?]/.test(span)) {
      return span;
    }
    const allWords = englishWords(span);
    if (allWords.length === 0 || isStandaloneEnglishSentenceSpan(line, offset, span.length, allWords.length)) {
      return span;
    }
    const parts = span.split(/,[ \t]*/).filter(Boolean);
    if (parts.length > 1) {
      const partWordLists = parts.map(englishWords);
      const multiWordParts = partWordLists.filter((words) => words.length >= 2).length;
      if (multiWordParts >= 2 && allWords.length >= 6) {
        return span;
      }
      return parts.every((part, i) => isEmbeddedTermPart(part, partWordLists[i])) ? " " : span;
    }
    return isEmbeddedTermPart(span, allWords) ? " " : span;
  });
}

export function isShortEnglishProseMetrics(metrics) {
  return (
    metrics.hangulCount <= SHORT_ENGLISH_PROSE_MAX_HANGUL ||
    metrics.hangulRatio <= SHORT_ENGLISH_PROSE_MAX_HANGUL_RATIO
  );
}

function isShortEnglishProseItem(item) {
  const trimmed = item.trim();
  if (trimmed.length === 0) {
    return false;
  }
  const words = englishWords(trimmed);
  if (words.length === 0) {
    return false;
  }
  return PROSE_OPENER_RE.test(trimmed) || (words.length >= 2 && hasEnglishProseFunctionWord(words));
}

function isStructuredHeading(trimmed) {
  if (!HEADING_PREFIX_RE.test(trimmed) || trimmed.length > MAX_STRUCTURED_HEADING_CHARS) {
    return false;
  }
  const body = trimmed.replace(HEADING_PREFIX_RE, "").trim();
  const words = englishWords(body);
  if (
    SENTENCE_BOUNDARY_RE.test(body) ||
    PROSE_OPENER_RE.test(body) ||
    (words.length >= 5 && hasEnglishSentenceFiniteWord(words))
  ) {
    return false;
  }
  if (words.length >= 6 && countEnglishFunctionWords(words) >= 3) {
    return false;
  }
  return true;
}

function isKeyValueLabel(trimmed) {
  if (!KEY_VALUE_LABEL_LINE_RE.test(trimmed) || HAS_HANGUL_RE.test(trimmed)) {
    return false;
  }
  const words = englishWords(trimmed);
  return (
    words.length <= 5 &&
    !PROSE_OPENER_RE.test(trimmed) &&
    !hasEnglishProseFunctionWord(words) &&
    !hasEnglishSentenceFiniteWord(words)
  );
}

function isShortCellTableRow(trimmed) {
  if (countMatches(trimmed, /\|/g) < 2) {
    return false;
  }
  const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.every((cell) => englishWords(cell).length <= 4 && !PROSE_OPENER_RE.test(cell.trim()));
}

function isShortTokenBullet(trimmed) {
  if (!BULLET_PREFIX_RE.test(trimmed)) {
    return false;
  }
  const body = trimmed.replace(BULLET_PREFIX_RE, "");
  return !HAS_HANGUL_RE.test(body) && countEnglishWords(body) <= 3 && !isShortEnglishProseItem(body);
}

function isShortTokenCommaList(trimmed) {
  if (countMatches(trimmed, /,/g) < 2 || HAS_HANGUL_RE.test(trimmed)) {
    return false;
  }
  const items = trimmed.split(",").map((item) => item.trim()).filter(Boolean);
  return (
    items.length >= 3 && items.every((item) => countEnglishWords(item) <= 3 && !isShortEnglishProseItem(item))
  );
}

export function isStructuredNonProseLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    TABLE_SEPARATOR_LINE_RE.test(trimmed) ||
    isStructuredHeading(trimmed) ||
    isKeyValueLabel(trimmed) ||
    isShortCellTableRow(trimmed) ||
    isShortTokenBullet(trimmed) ||
    isShortTokenCommaList(trimmed)
  );
}

function makeLine(text, paragraph) {
  const structured = isStructuredNonProseLine(text);
  const cache = {};
  const memo = (key, compute) => (key in cache ? cache[key] : (cache[key] = compute()));
  return {
    text,
    paragraph,
    structured,
    get cited() {
      return memo("cited", () => stripShortCitedTitlesOnKoreanLine(text));
    },
    get prose() {
      return memo("prose", () => stripEmbeddedTermsOnKoreanLine(this.cited));
    },
    get proseMetrics() {
      return memo("proseMetrics", () => measureLanguage(this.prose));
    },
    get proseWordCount() {
      return memo("proseWordCount", () => countEnglishWords(this.prose));
    },
  };
}

// Splits natural text once. `paragraph` increments at every blank-line boundary.
export function buildAnalyzedLines(naturalText) {
  const lines = [];
  let paragraph = 0;
  let previousBlank = false;
  for (const text of naturalText.split("\n")) {
    const blank = text.length === 0;
    if (blank && !previousBlank && lines.length > 0) {
      paragraph += 1;
    }
    previousBlank = blank;
    lines.push(makeLine(text, paragraph));
  }
  return lines;
}

export function proseLinesOf(lines) {
  return lines.filter((line) => !line.structured);
}

// Additive metrics over prose lines (equal to measuring their "\n"-joined text).
export function sumProseMetrics(proseLines) {
  let hangulCount = 0;
  let latinCount = 0;
  let wordCount = 0;
  for (const line of proseLines) {
    hangulCount += line.proseMetrics.hangulCount;
    latinCount += line.proseMetrics.latinCount;
    wordCount += line.proseWordCount;
  }
  const naturalCharCount = hangulCount + latinCount;
  const hangulRatio = naturalCharCount > 0 ? hangulCount / naturalCharCount : 0;
  return { hangulCount, latinCount, naturalCharCount, hangulRatio, wordCount };
}
