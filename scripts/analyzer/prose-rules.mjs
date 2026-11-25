import {
  ENGLISH_RUN_WORD_THRESHOLD,
  MIN_HANGUL_RATIO,
  MIN_LATIN_CHARS_FOR_DRIFT,
  MIN_NATURAL_CHARS,
  PROSE_FALLBACK_MIN_HANGUL,
  SEGMENT_MAX_HANGUL_RATIO,
  SEGMENT_MIN_NATURAL_CHARS,
  SHORT_ENGLISH_PROSE_WORD_THRESHOLD,
} from "./constants.mjs";
import {
  PROSE_OPENER_RE,
  PROSE_TOKEN_RE,
  hasEnglishProseFunctionWord,
  hasEnglishSentenceFiniteWord,
  measureLanguage,
} from "./lexicon.mjs";
import { buildAnalyzedLines, isShortEnglishProseMetrics, proseLinesOf, sumProseMetrics } from "./lines.mjs";
import { extractNaturalText, stripSummarizerBoilerplate } from "./stripper.mjs";

const HARD_RUN_SPLIT_RE = /[|;:·•→←↔⇒]+/;
const LIST_ITEM_SPLIT_RE = /(?:,|[ \t]+(?:\/|\+|&)[ \t]+)/;

function isDriftedSegmentMetrics(metrics, { segmentMinNaturalChars, segmentMaxHangulRatio, minLatinCharsForDrift }) {
  return (
    metrics.naturalCharCount >= segmentMinNaturalChars &&
    metrics.latinCount >= minLatinCharsForDrift &&
    metrics.hangulRatio <= segmentMaxHangulRatio
  );
}

function hasDriftedSegment(lines, thresholds) {
  const byParagraph = new Map();
  for (const line of proseLinesOf(lines)) {
    if (!byParagraph.has(line.paragraph)) {
      byParagraph.set(line.paragraph, []);
    }
    byParagraph.get(line.paragraph).push(line);
  }
  for (const paragraphLines of byParagraph.values()) {
    if (isDriftedSegmentMetrics(sumProseMetrics(paragraphLines), thresholds)) {
      return true;
    }
  }

  const { minLatinCharsForDrift, shortEnglishProseWordThreshold } = thresholds;
  let shortEnglishProseLineCount = 0;
  for (const line of proseLinesOf(lines)) {
    const metrics = line.proseMetrics;
    if (isDriftedSegmentMetrics(metrics, thresholds)) {
      return true;
    }
    if (
      isShortEnglishProseMetrics(metrics) &&
      metrics.latinCount >= minLatinCharsForDrift &&
      line.proseWordCount >= shortEnglishProseWordThreshold
    ) {
      shortEnglishProseLineCount += 1;
      if (shortEnglishProseLineCount >= 2) {
        return true;
      }
    }
  }

  return false;
}

function hasEnglishRunInPart(listParts, threshold) {
  let run = 0;
  for (let i = 0; i < listParts.length; i += 1) {
    const part = listParts[i];
    const tokens = part.match(PROSE_TOKEN_RE) ?? [];
    const englishTokensInPart = tokens.filter((token) => token.charCodeAt(0) <= 127);
    const englishCountInPart = englishTokensInPart.length;
    const partHasProseCue =
      PROSE_OPENER_RE.test(part.trim()) ||
      hasEnglishProseFunctionWord(englishTokensInPart) ||
      hasEnglishSentenceFiniteWord(englishTokensInPart);
    const isShortTokenItem = englishCountInPart <= 3 && !partHasProseCue;

    if (i > 0 && isShortTokenItem) {
      run = 0;
    }
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
    if (isShortTokenItem) {
      run = 0;
    }
  }
  return false;
}

function hasEnglishWordRun(lines, threshold) {
  for (const line of proseLinesOf(lines)) {
    for (const hardChunk of line.cited.split(HARD_RUN_SPLIT_RE)) {
      if (hasEnglishRunInPart(hardChunk.split(LIST_ITEM_SPLIT_RE), threshold)) {
        return true;
      }
    }
  }
  return false;
}

export function analyzeField(field, rawText, options = {}) {
  const {
    minNaturalChars = MIN_NATURAL_CHARS,
    minHangulRatio = MIN_HANGUL_RATIO,
    minLatinCharsForDrift = MIN_LATIN_CHARS_FOR_DRIFT,
    englishRunWordThreshold = ENGLISH_RUN_WORD_THRESHOLD,
    segmentMinNaturalChars = SEGMENT_MIN_NATURAL_CHARS,
    segmentMaxHangulRatio = SEGMENT_MAX_HANGUL_RATIO,
    shortEnglishProseWordThreshold = SHORT_ENGLISH_PROSE_WORD_THRESHOLD,
  } = options;

  const normalizedRaw = typeof rawText === "string" ? rawText : "";
  const preparedRaw = field === "thinking" ? stripSummarizerBoilerplate(normalizedRaw) : normalizedRaw;
  const naturalText = extractNaturalText(preparedRaw);
  const metrics = measureLanguage(naturalText);
  const base = { field, rawLength: normalizedRaw.length, ...metrics };
  const lines = buildAnalyzedLines(naturalText);

  if (metrics.naturalCharCount < minNaturalChars) {
    if (metrics.latinCount >= minLatinCharsForDrift) {
      const proseMetrics = sumProseMetrics(proseLinesOf(lines));
      if (
        proseMetrics.wordCount >= shortEnglishProseWordThreshold &&
        (proseMetrics.latinCount >= minLatinCharsForDrift || isShortEnglishProseMetrics(metrics))
      ) {
        return { ...base, status: "drifted", driftReason: "short_english_prose" };
      }
    }
    return { ...base, status: "insufficient", driftReason: "none" };
  }

  if (metrics.latinCount < minLatinCharsForDrift) {
    return { ...base, status: "korean", driftReason: "none" };
  }

  if (metrics.hangulRatio < minHangulRatio) {
    const proseLines = proseLinesOf(lines);
    const proseMetrics = proseLines.length > 0 ? sumProseMetrics(proseLines) : null;
    const proseIsKorean =
      proseMetrics !== null &&
      proseMetrics.hangulRatio >= minHangulRatio &&
      (proseMetrics.hangulCount >= minNaturalChars ||
        (proseMetrics.hangulCount >= PROSE_FALLBACK_MIN_HANGUL && proseMetrics.latinCount < minLatinCharsForDrift));
    if (!proseIsKorean) {
      return { ...base, status: "drifted", driftReason: "low_hangul_ratio" };
    }
  }

  const segmentThresholds = {
    segmentMinNaturalChars,
    segmentMaxHangulRatio,
    minLatinCharsForDrift,
    shortEnglishProseWordThreshold,
  };
  if (hasDriftedSegment(lines, segmentThresholds)) {
    return { ...base, status: "drifted", driftReason: "english_segment" };
  }

  if (hasEnglishWordRun(lines, englishRunWordThreshold)) {
    return { ...base, status: "drifted", driftReason: "english_run" };
  }

  return { ...base, status: "korean", driftReason: "none" };
}
