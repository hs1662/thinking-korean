export const MIN_NATURAL_CHARS = 24;
export const MIN_HANGUL_RATIO = 0.45;
export const MIN_LATIN_CHARS_FOR_DRIFT = 16;
export const ENGLISH_RUN_WORD_THRESHOLD = 8;
export const SEGMENT_MIN_NATURAL_CHARS = 32;
export const SEGMENT_MAX_HANGUL_RATIO = 0.25;
export const SHORT_ENGLISH_PROSE_WORD_THRESHOLD = 4;

const MAX_SHORT_TOKEN_QUOTE_CHARS = 60;
const MAX_SHORT_TOKEN_QUOTE_WORDS = 4;
const MAX_ERROR_QUOTE_CHARS = 180;
const MAX_STRUCTURED_HEADING_CHARS = 100;
const MAX_CITED_TITLE_CHARS = 90;
const MAX_CITED_TITLE_WORDS = 10;
const SHORT_ENGLISH_PROSE_MAX_HANGUL = 2;
const SHORT_ENGLISH_PROSE_MAX_HANGUL_RATIO = 0.15;

const CLI_UI_HINT_LINE_RE =
  /^[ \t]*(?:[-*][ \t]+)?(?:Run|Use|Type)\s+`?\/[a-z][a-z0-9_-]*(?:[ \t]+[a-z0-9_-]+){0,3}`?[ \t]*\([^)\n]{1,40}\)[ \t]*(?:to[ \t]+[^\n]{1,60})?$/gim;
const ERROR_QUOTE_RE =
  /^(?:[A-Z][A-Za-z0-9_]*Error:|Error:|Exception:|Traceback\b|FAIL(?:ED)?\b|FATAL\b|WARN(?:ING)?\b|ERR!|ENOENT\b|EACCES\b|EPERM\b|ECONNREFUSED\b|ETIMEDOUT\b|EISDIR\b|ENOTDIR\b|SyntaxError\b|TypeError\b|ReferenceError\b|RangeError\b|AssertionError\b|Unexpected\s+(?:end|token|identifier|EOF|character)|Cannot\s+(?:read|find|resolve|open|access)\b|(?:Failed\s+to|Could\s+not|Unable\s+to)\s+(?:open|read|write|load|parse|resolve|find|locate|connect|fetch|download|upload|compile|build|start|spawn|exec(?:ute)?|run|bind|listen|create|delete|remove|rename|stat|access|import|require|install|authenticate|verify|validate|initialize|allocate|lock|unlock|mount|unlink|mkdir|chmod|chown|decode|encode|serialize|deserialize|send|receive|request|sync|checkout|push|pull|clone|merge)\b|Permission\s+denied\b|No\s+such\s+file\b|at\s+\S+\s*\([^)\n]+\))/;
const DOUBLE_QUOTED_RE = /"((?:\\.|[^"\\\n])*)"/g;
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s<>)"'`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/gi;
const XML_TAG_RE =
  /(?<![A-Za-z0-9_])<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][A-Za-z0-9:._-]*\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"'=<>`]+))*\s*\/?>/g;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s"'`<>()[\]{},;*\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/g;
const UNIX_PATH_RE =
  /(?<=^|[\s(\[{,:;*_'"`])(?:\.{1,2}|~)?\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?/g;
const RELATIVE_PATH_RE =
  /(?<=^|[\s(\[{,:;*_'"`])(?:[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+\/?|[A-Za-z0-9._@+-]+\/)(?=$|[\s)\]},;:*_'"`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3])/g;
const LONG_FLAG_RE =
  /(?<=^|[\s(\[{,:;*_'"`])--[A-Za-z0-9][A-Za-z0-9._-]*(?:=[^\s"'`<>()[\]{},;*\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+)?/g;
const SHORT_FLAG_RE =
  /(?<=^|[\s(\[{,:;*_'"`])-[A-Za-z](?=$|[\s)\]},;:*_'"`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3])/g;
const DOTFILE_RE =
  /(?<=^|[\s(\[{,:;*_'"`])\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?=$|[\s)\]},;:*_'"`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3])/g;
const DOTTED_PATH_RE = /\b[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\b/g;
const SNAKE_IDENT_RE = /\b(?:_[A-Za-z0-9_]+|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/g;
const KEBAB_IDENT_RE = /(?<![A-Za-z0-9_-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_-])/g;
const CAMEL_IDENT_RE = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
const PASCAL_IDENT_RE = /\b(?:[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}[a-z][A-Za-z0-9]*)\b/g;
const UPPER_RUN_RE = /\b[A-Z]{2,}(?:[0-9]+[A-Z]*)*(?:[ \t]+[A-Z]{2,}(?:[0-9]+[A-Z]*)*)*\b/g;

const UPPER_PROSE_STOPWORDS = new Set([
  "ABOUT",
  "AFTER",
  "ALL",
  "ALSO",
  "AND",
  "ANY",
  "ARE",
  "BEEN",
  "BEFORE",
  "BUT",
  "CAN",
  "CHECK",
  "COULD",
  "DID",
  "DOES",
  "EACH",
  "ELSE",
  "FIRST",
  "FOR",
  "FROM",
  "HAS",
  "HAVE",
  "HELLO",
  "HERE",
  "HOW",
  "INTO",
  "JUST",
  "LAST",
  "LET",
  "MAY",
  "MORE",
  "MUST",
  "NEXT",
  "NOT",
  "NOW",
  "ONLY",
  "OUR",
  "OVER",
  "PLEASE",
  "SHOULD",
  "SOME",
  "SORRY",
  "STOP",
  "THANK",
  "THAT",
  "THE",
  "THEM",
  "THEN",
  "THEY",
  "THIS",
  "VERY",
  "WAIT",
  "WAS",
  "WERE",
  "WHAT",
  "WHEN",
  "WHO",
  "WHY",
  "WILL",
  "WITH",
  "WOULD",
  "YOUR",
]);

const HANGUL_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/g;
const HAS_HANGUL_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]/;
const LATIN_RE = /[A-Za-z]/g;
const ENGLISH_WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const PROSE_TOKEN_RE = /[\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+|[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const TABLE_SEPARATOR_LINE_RE = /^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?[ \t]*$/;
const BULLET_PREFIX_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING_PREFIX_RE = /^[ \t]*#{1,6}[ \t]+/;
const BLOCKQUOTE_PREFIX_RE = /^[ \t]*>/;
const BLOCKQUOTE_STRIP_RE = /^[ \t]*(?:>[ \t]?)+/;
const HARD_RUN_SPLIT_RE = /[|;:·•→←↔⇒]+/;
const LIST_ITEM_SPLIT_RE = /(?:,|[ \t]+(?:\/|\+|&)[ \t]+)/;
const CITED_BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const CITED_DOUBLE_QUOTE_RE = /"([^"\n]+)"/g;
const CITED_CURLY_QUOTE_RE = /[“「『]([^”」』\n]+)[”」』]/g;
const CITED_PAREN_RE = /\(([^()\n]+)\)/g;
const PROSE_OPENER_RE =
  /^(?:i\s+(?:will|would|should|need|can|could|have|had|am|was|think|believe|see|found|checked|want|try)|i['’](?:ll|m|ve|d)\b|let\s+me\b|let['’]s\b|we\s+(?:need|should|can|will|must|have)\b|you\s+(?:can|should|need|will|must|may)\b|now\s+(?:i|let|we|the)\b|wait\b|okay\b|ok\b|sure\b|sorry\b|please\b|thank\b|here\s+(?:is|are)\b|this\s+(?:is|was|will|means|shows|looks)\b|that\s+(?:is|was|will|means)\b|it\s+(?:is|was|will|seems|looks)\b|there\s+(?:is|are|was|were)\b|the\s+(?:user|agent|model|system|file|code|error|issue|bug|previous|next|first|second)\b|(?:could|would|should|did|does|do|will|may|might)\s+not\b|(?:can|don|won|didn|doesn|couldn|wouldn|shouldn)['’]t\b|cannot\b|failed\s+to\b|unable\s+to\b)/i;

function isErrorQuote(text) {
  return text.length > 0 && text.length <= MAX_ERROR_QUOTE_CHARS && ERROR_QUOTE_RE.test(text);
}

function isShortCitedTitle(rawInner) {
  const inner = rawInner.trim();
  if (inner.length === 0 || inner.length > MAX_CITED_TITLE_CHARS) {
    return false;
  }
  if (HAS_HANGUL_RE.test(inner)) {
    return false;
  }
  const wordCount = countEnglishWords(inner);
  if (wordCount === 0 || wordCount > MAX_CITED_TITLE_WORDS) {
    return false;
  }
  if (/[A-Za-z]{2,}[.!?][ \t]+[A-Za-z]/.test(inner)) {
    return false;
  }
  if (PROSE_OPENER_RE.test(inner)) {
    return false;
  }
  return true;
}

function stripShortCitedTitlesOnKoreanLine(line) {
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

function isShortEnglishProseMetrics(metrics) {
  return (
    metrics.hangulCount <= SHORT_ENGLISH_PROSE_MAX_HANGUL ||
    metrics.hangulRatio <= SHORT_ENGLISH_PROSE_MAX_HANGUL_RATIO
  );
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function countEnglishWords(text) {
  return countMatches(text, ENGLISH_WORD_RE);
}

function measureLanguage(text) {
  const hangulCount = countMatches(text, HANGUL_RE);
  const latinCount = countMatches(text, LATIN_RE);
  const naturalCharCount = hangulCount + latinCount;
  const hangulRatio = naturalCharCount > 0 ? hangulCount / naturalCharCount : 0;
  return { hangulCount, latinCount, naturalCharCount, hangulRatio };
}

function stripFencedCodeBlocks(text) {
  const lines = text.split("\n");
  const out = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (const line of lines) {
    if (!inFence) {
      const openMatch = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
      if (openMatch) {
        const marker = openMatch[1];
        const info = openMatch[2];
        const ch = marker[0];
        if (!info.includes(ch)) {
          inFence = true;
          fenceChar = ch;
          fenceLen = marker.length;
          out.push("");
          continue;
        }
      }
      out.push(line);
      continue;
    }

    const closeMatch = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
      inFence = false;
      fenceChar = "";
      fenceLen = 0;
      out.push("");
    }
  }

  return out.join("\n");
}

function stripInlineCodeLine(line) {
  if (!line.includes("`")) {
    return line;
  }

  const runs = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] === "`") {
      let j = i + 1;
      while (j < line.length && line[j] === "`") {
        j += 1;
      }
      runs.push({ start: i, end: j, len: j - i });
      i = j;
    } else {
      i += 1;
    }
  }

  const indicesByLen = new Map();
  for (let idx = 0; idx < runs.length; idx += 1) {
    const len = runs[idx].len;
    let list = indicesByLen.get(len);
    if (!list) {
      list = [];
      indicesByLen.set(len, list);
    }
    list.push(idx);
  }

  const cursorByLen = new Map();
  let result = "";
  let pos = 0;

  for (let idx = 0; idx < runs.length; idx += 1) {
    const run = runs[idx];
    if (run.start < pos) {
      continue;
    }

    const list = indicesByLen.get(run.len);
    let cursor = cursorByLen.get(run.len) ?? 0;
    while (cursor < list.length && list[cursor] <= idx) {
      cursor += 1;
    }
    cursorByLen.set(run.len, cursor);

    if (cursor < list.length) {
      const closeRun = runs[list[cursor]];
      result += line.slice(pos, run.start);
      result += " ";
      pos = closeRun.end;
      cursorByLen.set(run.len, cursor + 1);
    }
  }

  result += line.slice(pos);
  return result;
}

function stripInlineCode(text) {
  if (!text.includes("`")) {
    return text;
  }
  return text.split("\n").map(stripInlineCodeLine).join("\n");
}

function stripBlockquotes(text) {
  const lines = text.split("\n");
  const out = [];
  let quoteLines = [];

  const flushQuoteLines = () => {
    if (quoteLines.length === 0) {
      return;
    }
    const unfenced = stripFencedCodeBlocks(quoteLines.join("\n"));
    for (const rawInner of unfenced.split("\n")) {
      const inner = rawInner.trim();
      if (inner.length === 0 || isErrorQuote(inner)) {
        out.push("");
      } else {
        out.push(inner);
      }
    }
    quoteLines = [];
  };

  for (const line of lines) {
    if (BLOCKQUOTE_PREFIX_RE.test(line)) {
      quoteLines.push(line.replace(BLOCKQUOTE_STRIP_RE, ""));
    } else {
      flushQuoteLines();
      out.push(line);
    }
  }
  flushQuoteLines();

  return out.join("\n");
}

function stripDoubleQuotes(text) {
  return text.replace(DOUBLE_QUOTED_RE, (_full, rawInner) => {
    const inner = rawInner.trim();
    if (inner.length === 0) {
      return " ";
    }
    if (HAS_HANGUL_RE.test(inner)) {
      return ` ${inner} `;
    }
    if (isErrorQuote(inner)) {
      return " ";
    }
    if (inner.length <= MAX_SHORT_TOKEN_QUOTE_CHARS && countEnglishWords(inner) <= MAX_SHORT_TOKEN_QUOTE_WORDS) {
      return " ";
    }
    return ` "${inner}" `;
  });
}

function stripTechnicalAcronyms(text) {
  return text.replace(UPPER_RUN_RE, (match) => {
    const words = match.split(/[ \t]+/);
    if (words.length >= 4) {
      return match;
    }
    if (words.length >= 2 && words.some((word) => UPPER_PROSE_STOPWORDS.has(word))) {
      return match;
    }
    return words
      .map((word) => (word.length <= 8 && !UPPER_PROSE_STOPWORDS.has(word) ? " " : word))
      .join(" ");
  });
}

function isStructuredNonProseLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (TABLE_SEPARATOR_LINE_RE.test(trimmed)) {
    return true;
  }
  if (HEADING_PREFIX_RE.test(trimmed) && trimmed.length <= MAX_STRUCTURED_HEADING_CHARS) {
    const body = trimmed.replace(HEADING_PREFIX_RE, "").trim();
    if (!/[A-Za-z]{2,}[.!?][ \t]+[A-Za-z]/.test(body)) {
      return true;
    }
  }

  const pipeCount = countMatches(trimmed, /\|/g);
  if (pipeCount >= 2) {
    const cells = trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|");
    if (cells.every((cell) => countEnglishWords(cell) <= 4)) {
      return true;
    }
  }

  if (BULLET_PREFIX_RE.test(trimmed)) {
    const body = trimmed.replace(BULLET_PREFIX_RE, "");
    if (!HAS_HANGUL_RE.test(body) && countEnglishWords(body) <= 3) {
      return true;
    }
  }

  const commaCount = countMatches(trimmed, /,/g);
  if (commaCount >= 2 && !HAS_HANGUL_RE.test(trimmed)) {
    const items = trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    if (items.length >= 3 && items.every((item) => countEnglishWords(item) <= 3)) {
      return true;
    }
  }

  return false;
}

function hasDriftedSegment(
  naturalText,
  { segmentMinNaturalChars, segmentMaxHangulRatio, minLatinCharsForDrift, shortEnglishProseWordThreshold },
) {
  const paragraphs = naturalText.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const proseLines = paragraph
      .split("\n")
      .filter((line) => !isStructuredNonProseLine(line))
      .map(stripShortCitedTitlesOnKoreanLine);
    if (proseLines.length === 0) {
      continue;
    }
    const metrics = measureLanguage(proseLines.join("\n"));
    if (
      metrics.naturalCharCount >= segmentMinNaturalChars &&
      metrics.latinCount >= minLatinCharsForDrift &&
      metrics.hangulRatio <= segmentMaxHangulRatio
    ) {
      return true;
    }
  }

  let shortEnglishProseLineCount = 0;
  for (const line of naturalText.split(/\n+/)) {
    if (isStructuredNonProseLine(line)) {
      continue;
    }
    const evalLine = stripShortCitedTitlesOnKoreanLine(line);
    const metrics = measureLanguage(evalLine);
    if (
      metrics.naturalCharCount >= segmentMinNaturalChars &&
      metrics.latinCount >= minLatinCharsForDrift &&
      metrics.hangulRatio <= segmentMaxHangulRatio
    ) {
      return true;
    }
    if (
      isShortEnglishProseMetrics(metrics) &&
      metrics.latinCount >= minLatinCharsForDrift &&
      countEnglishWords(evalLine) >= shortEnglishProseWordThreshold
    ) {
      shortEnglishProseLineCount += 1;
      if (shortEnglishProseLineCount >= 2) {
        return true;
      }
    }
  }

  return false;
}

function hasEnglishWordRun(naturalText, threshold) {
  for (const line of naturalText.split("\n")) {
    if (isStructuredNonProseLine(line)) {
      continue;
    }
    const evalLine = stripShortCitedTitlesOnKoreanLine(line);
    const hardChunks = evalLine.split(HARD_RUN_SPLIT_RE);
    for (const hardChunk of hardChunks) {
      const listParts = hardChunk.split(LIST_ITEM_SPLIT_RE);
      let run = 0;

      for (let i = 0; i < listParts.length; i += 1) {
        const part = listParts[i];
        const tokens = part.match(PROSE_TOKEN_RE) ?? [];
        const englishCountInPart = tokens.reduce(
          (count, token) => count + (token.charCodeAt(0) <= 127 ? 1 : 0),
          0,
        );
        const isShortListItem = i > 0 && englishCountInPart <= 3;

        if (isShortListItem) {
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

        if (englishCountInPart <= 3) {
          run = 0;
        }
      }
    }
  }

  return false;
}

function countNonStructuredEnglishWords(naturalText) {
  let words = 0;
  for (const line of naturalText.split("\n")) {
    if (isStructuredNonProseLine(line)) {
      continue;
    }
    words += countEnglishWords(line);
  }
  return words;
}

export function extractNaturalText(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return "";
  }

  const normalized = rawText.replace(/\r\n?/g, "\n");
  const withoutFences = stripFencedCodeBlocks(normalized);
  const withoutHints = withoutFences.replace(CLI_UI_HINT_LINE_RE, "");
  const withoutInline = stripInlineCode(stripBlockquotes(withoutHints));
  const withoutXmlAndUrls = withoutInline.replace(URL_RE, " ").replace(XML_TAG_RE, " ");
  const withoutQuotes = stripDoubleQuotes(withoutXmlAndUrls);
  const withoutTechnical = withoutQuotes
    .replace(WINDOWS_PATH_RE, " ")
    .replace(UNIX_PATH_RE, " ")
    .replace(RELATIVE_PATH_RE, " ")
    .replace(LONG_FLAG_RE, " ")
    .replace(SHORT_FLAG_RE, " ")
    .replace(DOTFILE_RE, " ")
    .replace(DOTTED_PATH_RE, " ")
    .replace(SNAKE_IDENT_RE, " ")
    .replace(KEBAB_IDENT_RE, " ")
    .replace(CAMEL_IDENT_RE, " ")
    .replace(PASCAL_IDENT_RE, " ");

  const stripped = stripTechnicalAcronyms(withoutTechnical);

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
    shortEnglishProseWordThreshold = SHORT_ENGLISH_PROSE_WORD_THRESHOLD,
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
    if (
      isShortEnglishProseMetrics(metrics) &&
      metrics.latinCount >= minLatinCharsForDrift &&
      countNonStructuredEnglishWords(naturalText) >= shortEnglishProseWordThreshold
    ) {
      return { ...base, status: "drifted", driftReason: "short_english_prose" };
    }
    return { ...base, status: "insufficient", driftReason: "none" };
  }

  if (metrics.latinCount < minLatinCharsForDrift) {
    return { ...base, status: "korean", driftReason: "none" };
  }

  if (metrics.hangulRatio < minHangulRatio) {
    const proseLines = naturalText
      .split("\n")
      .filter((line) => !isStructuredNonProseLine(line))
      .map(stripShortCitedTitlesOnKoreanLine);
    const proseMetrics = proseLines.length > 0 ? measureLanguage(proseLines.join("\n")) : null;
    const proseIsKorean =
      proseMetrics !== null &&
      proseMetrics.hangulCount >= minNaturalChars &&
      proseMetrics.hangulRatio >= minHangulRatio;
    if (!proseIsKorean) {
      return { ...base, status: "drifted", driftReason: "low_hangul_ratio" };
    }
  }

  if (
    hasDriftedSegment(naturalText, {
      segmentMinNaturalChars,
      segmentMaxHangulRatio,
      minLatinCharsForDrift,
      shortEnglishProseWordThreshold,
    })
  ) {
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
