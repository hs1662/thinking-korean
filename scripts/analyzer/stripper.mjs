import { MAX_ERROR_QUOTE_CHARS, MAX_SHORT_TOKEN_QUOTE_CHARS, MAX_SHORT_TOKEN_QUOTE_WORDS } from "./constants.mjs";
import { HAS_HANGUL_RE, PROSE_OPENER_RE, englishWords, hasEnglishProseFunctionWord, isUpperStopword } from "./lexicon.mjs";

const CLI_UI_HINT_LINE_RE =
  /^[ \t]*(?:[-*][ \t]+)?(?:Run|Use|Type)\s+`?\/[a-z][a-z0-9_-]*(?:[ \t]+[a-z0-9_-]+){0,3}`?[ \t]*\([^)\n]{1,40}\)[ \t]*(?:to[ \t]+[^\n]{1,60})?$/gim;
// Exact single-line boilerplate emitted by the server-side thought summarizer (never model-authored prose).
const SUMMARIZER_BOILERPLATE_LINE_RE = /^[ \t]*I['’]m thinking through how to approach this\.[ \t]*$/gm;
const ERROR_QUOTE_RE =
  /^(?:[A-Z][A-Za-z0-9_]*Error:|Error:|Exception:|Traceback\b|FAIL(?:ED)?\b|FATAL\b|WARN(?:ING)?\b|ERR!|ENOENT\b|EACCES\b|EPERM\b|ECONNREFUSED\b|ETIMEDOUT\b|EISDIR\b|ENOTDIR\b|SyntaxError\b|TypeError\b|ReferenceError\b|RangeError\b|AssertionError\b|Unexpected\s+(?:end|token|identifier|EOF|character)|Cannot\s+(?:read|find|resolve|open|access)\b|(?:Failed\s+to|Could\s+not|Unable\s+to)\s+(?:open|read|write|load|parse|resolve|find|locate|connect|fetch|download|upload|compile|build|start|spawn|exec(?:ute)?|run|bind|listen|create|delete|remove|rename|stat|access|import|require|install|authenticate|verify|validate|initialize|allocate|lock|unlock|mount|unlink|mkdir|chmod|chown|decode|encode|serialize|deserialize|send|receive|request|sync|checkout|push|pull|clone|merge)\b|Permission\s+denied\b|No\s+such\s+file\b|at\s+\S+\s*\([^)\n]+\))/;
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s<>)"'`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/gi;
const XML_TAG_RE =
  /(?<![A-Za-z0-9_])<\/?[A-Za-z][A-Za-z0-9:_-]*(?:\s+[A-Za-z_:][A-Za-z0-9:._-]*\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"'=<>`]+))*\s*\/?>/g;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s"'`<>()[\]{},;*\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+/g;
const UNIX_PATH_RE =
  /(?<=^|[\s(\[{,:;*_'"`])(?:\.{1,2}|~)?\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?/g;
const RELATIVE_PATH_RE =
  /(?<=^|[\s(\[{,:;*'"`])[A-Za-z0-9._@+-]+\/(?:[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?)?(?=$|[\s)\]},;:*_'"`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3])/g;
const LONG_FLAG_RE =
  /(?<=^|[\s(\[{,:;*_'"`])--[A-Za-z0-9][A-Za-z0-9._-]*(?:=[^\s"'`<>()[\]{},;*\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3]+)?/g;
const SHORT_FLAG_RE =
  /(?<=^|[\s(\[{,:;*_'"`])-[A-Za-z](?=$|[\s)\]},;:*_'"`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3])/g;
const DOTFILE_RE =
  /(?<=^|[\s(\[{,:;*'"`])\.[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*(?=$|[\s)\]},;:*_'"`\u1100-\u11FF\u3131-\u318E\uAC00-\uD7A3])/g;
const DOTTED_PATH_RE = /(?<![A-Za-z0-9_-])[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\b/g;
const SNAKE_IDENT_RE = /\b(?:_[A-Za-z0-9_]+|[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+)\b/g;
const KEBAB_IDENT_RE = /(?<![A-Za-z0-9_-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_-])/g;
const CAMEL_IDENT_RE = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
const PASCAL_IDENT_RE = /\b(?:[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z]{2,}[a-z][A-Za-z0-9]*)\b/g;
const UPPER_RUN_RE = /\b[A-Z]{2,}(?:[0-9]+[A-Z]+)*[0-9]*(?:[ \t]+[A-Z]{2,}(?:[0-9]+[A-Z]+)*[0-9]*)*\b/g;
const BLOCKQUOTE_PREFIX_RE = /^[ \t]*>/;
const BLOCKQUOTE_STRIP_RE = /^[ \t]*(?:>[ \t]?)+/;
const TECHNICAL_TOKEN_RES = [
  WINDOWS_PATH_RE,
  UNIX_PATH_RE,
  RELATIVE_PATH_RE,
  LONG_FLAG_RE,
  SHORT_FLAG_RE,
  DOTFILE_RE,
  DOTTED_PATH_RE,
  SNAKE_IDENT_RE,
  KEBAB_IDENT_RE,
  CAMEL_IDENT_RE,
  PASCAL_IDENT_RE,
];

export function isErrorQuote(text) {
  return text.length > 0 && text.length <= MAX_ERROR_QUOTE_CHARS && ERROR_QUOTE_RE.test(text);
}

export function stripFencedCodeBlocks(text) {
  const out = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fencedLines = [];

  for (const line of text.split("\n")) {
    if (!inFence) {
      const openMatch = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
      if (openMatch && !openMatch[2].includes(openMatch[1][0])) {
        inFence = true;
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        fencedLines = [line];
        continue;
      }
      out.push(line);
      continue;
    }

    const closeMatch = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
      inFence = false;
      fenceChar = "";
      fenceLen = 0;
      fencedLines = [];
      out.push("", "");
    } else {
      fencedLines.push(line);
    }
  }

  if (inFence && fencedLines.length > 0) {
    out.push(...fencedLines);
  }

  return out.join("\n");
}

function isEscapedBacktick(line, index) {
  let backslashes = 0;
  for (let k = index - 1; k >= 0 && line[k] === "\\"; k -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function stripInlineCodeBlock(block) {
  if (!block.includes("`")) {
    return block;
  }

  const runs = [];
  for (let i = 0; i < block.length; ) {
    if (block[i] !== "`") {
      i += 1;
      continue;
    }
    if (isEscapedBacktick(block, i)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < block.length && block[j] === "`") {
      j += 1;
    }
    runs.push({ start: i, end: j, len: j - i });
    i = j;
  }

  const indicesByLen = new Map();
  runs.forEach((run, idx) => {
    if (!indicesByLen.has(run.len)) {
      indicesByLen.set(run.len, []);
    }
    indicesByLen.get(run.len).push(idx);
  });

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
      result += block.slice(pos, run.start);
      result += " ";
      pos = closeRun.end;
      cursorByLen.set(run.len, cursor + 1);
    }
  }

  result += block.slice(pos);
  return result;
}

const INLINE_BLOCK_SINGLE_LINE_RE = /^[ \t]*(?:#{1,6}(?:[ \t]|$)|\|.*\|[ \t]*$)/;
const INLINE_BLOCK_START_RE = /^[ \t]*(?:[-*+][ \t]+|\d+[.)][ \t]+|>)/;

function splitInlineCodeBlocks(text) {
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };
  for (const line of text.split("\n")) {
    if (line.trim().length === 0 || INLINE_BLOCK_SINGLE_LINE_RE.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    if (INLINE_BLOCK_START_RE.test(line)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return blocks;
}

export function stripInlineCode(text) {
  if (!text.includes("`")) {
    return text;
  }
  return splitInlineCodeBlocks(text).map(stripInlineCodeBlock).join("\n");
}

export function stripBlockquotes(text) {
  const out = [];
  let quoteLines = [];

  const flushQuoteLines = () => {
    if (quoteLines.length === 0) {
      return;
    }
    for (const rawInner of stripFencedCodeBlocks(quoteLines.join("\n")).split("\n")) {
      const inner = rawInner.trim();
      out.push(inner.length === 0 || isErrorQuote(inner) ? "" : inner);
    }
    quoteLines = [];
  };

  for (const line of text.split("\n")) {
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

function replaceDoubleQuotedSpan(rawInner) {
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
  const words = englishWords(inner);
  if (
    inner.length <= MAX_SHORT_TOKEN_QUOTE_CHARS &&
    words.length <= MAX_SHORT_TOKEN_QUOTE_WORDS &&
    !PROSE_OPENER_RE.test(inner) &&
    !hasEnglishProseFunctionWord(words)
  ) {
    return " ";
  }
  return ` "${inner}" `;
}

export function stripDoubleQuotes(text) {
  if (!text.includes('"')) {
    return text;
  }

  let out = "";
  let copyStart = 0;
  let quoteStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      if (i + 1 < text.length && text[i + 1] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (ch === "\n") {
      quoteStart = -1;
      continue;
    }
    if (ch === '"') {
      if (quoteStart === -1) {
        quoteStart = i;
      } else {
        out += text.slice(copyStart, quoteStart);
        out += replaceDoubleQuotedSpan(text.slice(quoteStart + 1, i));
        copyStart = i + 1;
        quoteStart = -1;
      }
    }
  }

  if (copyStart === 0) {
    return text;
  }
  return out + text.slice(copyStart);
}

export function stripTechnicalAcronyms(text) {
  return text.replace(UPPER_RUN_RE, (match) => {
    const words = match.split(/[ \t]+/);
    if (words.length >= 4) {
      return match;
    }
    if (words.length >= 2 && words.some(isUpperStopword)) {
      return match;
    }
    return words.map((word) => (word.length <= 8 && !isUpperStopword(word) ? " " : word)).join(" ");
  });
}

export function stripPathsFlagsAndIdentifiers(text) {
  return TECHNICAL_TOKEN_RES.reduce((acc, regex) => acc.replace(regex, " "), text);
}

export function stripSummarizerBoilerplate(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return "";
  }
  return rawText.replace(/\r\n?/g, "\n").replace(SUMMARIZER_BOILERPLATE_LINE_RE, "");
}

export function extractNaturalText(rawText) {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return "";
  }

  const normalized = rawText.replace(/\r\n?/g, "\n");
  const withoutHints = stripFencedCodeBlocks(normalized).replace(CLI_UI_HINT_LINE_RE, "");
  const withoutInline = stripInlineCode(stripBlockquotes(withoutHints));
  const withoutXmlAndUrls = withoutInline.replace(URL_RE, " ").replace(XML_TAG_RE, " ");
  const withoutTechnical = stripPathsFlagsAndIdentifiers(stripDoubleQuotes(withoutXmlAndUrls));

  return stripTechnicalAcronyms(withoutTechnical)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
