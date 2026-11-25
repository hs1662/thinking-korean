import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KEPT_STEP_TYPES,
  PRE_TOOL_DENIAL_NEEDLE,
  isPreToolDenialStep,
  parseTranscriptJsonlWithStats,
} from "./transcript.mjs";
import { parseRawRecord, recordToStep } from "./transcript/steps.mjs";

const CHUNK_SIZE = 256 * 1024;
const PREFIX_SCAN_BYTES = 256;
const NEWLINE_BYTE = 0x0a;
const PROBE_MAX_BYTES = 64 * 1024;

function isAsciiWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function skipWhitespace(buf, start) {
  let i = start;
  while (i < buf.length && isAsciiWhitespace(buf[i])) {
    i += 1;
  }
  return i;
}

function createJsonBalance() {
  return { depth: 0, inString: false, escaped: false, closed: false, valid: true };
}

function advanceJsonBalance(state, buf, start, end) {
  if (!state.valid) {
    return;
  }
  for (let i = start; i < end; i += 1) {
    const b = buf[i];
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (b === 0x5c) {
        state.escaped = true;
      } else if (b === 0x22) {
        state.inString = false;
      }
      continue;
    }
    if (state.closed) {
      if (!isAsciiWhitespace(b)) {
        state.valid = false;
        return;
      }
      continue;
    }
    if (b === 0x22) {
      state.inString = true;
    } else if (b === 0x7b || b === 0x5b) {
      state.depth += 1;
    } else if (b === 0x7d || b === 0x5d) {
      state.depth -= 1;
      if (state.depth < 0) {
        state.valid = false;
        return;
      }
      if (state.depth === 0) {
        state.closed = true;
      }
    }
  }
}

function scanJsonStringEnd(buf, openQuoteIdx) {
  const len = buf.length;
  let hasEscape = false;
  for (let i = openQuoteIdx + 1; i < len; i += 1) {
    const b = buf[i];
    if (b === 0x5c) {
      hasEscape = true;
      i += 1;
      continue;
    }
    if (b === 0x22) {
      return { end: i, hasEscape };
    }
  }
  return null;
}

function classifyLinePrefix(prefixBuf) {
  const len = prefixBuf.length;
  let i = skipWhitespace(prefixBuf, 0);
  if (i >= len || prefixBuf[i] !== 0x7b) {
    return "unknown";
  }

  let depth = 0;
  let expectKeyAtDepth1 = false;

  while (i < len) {
    const b = prefixBuf[i];
    if (b === 0x22) {
      const str = scanJsonStringEnd(prefixBuf, i);
      if (!str) {
        return "unknown";
      }

      if (depth === 1 && expectKeyAtDepth1) {
        expectKeyAtDepth1 = false;
        if (str.hasEscape) {
          return "unknown";
        }
        if (str.end - i === 5 && prefixBuf.toString("latin1", i + 1, str.end) === "type") {
          let j = skipWhitespace(prefixBuf, str.end + 1);
          if (j >= len || prefixBuf[j] !== 0x3a) {
            return "unknown";
          }
          j = skipWhitespace(prefixBuf, j + 1);
          if (j >= len || prefixBuf[j] !== 0x22) {
            return "unknown";
          }
          const val = scanJsonStringEnd(prefixBuf, j);
          if (!val || val.hasEscape) {
            return "unknown";
          }
          const typeValue = prefixBuf.subarray(j + 1, val.end).toString("latin1");
          if (KEPT_STEP_TYPES.has(typeValue)) {
            return "keep";
          }
          return typeValue === "GENERIC" ? "probe" : "skip";
        }
      }

      i = str.end + 1;
      continue;
    }

    if (b === 0x7b || b === 0x5b) {
      depth += 1;
      if (depth === 1 && b === 0x7b) {
        expectKeyAtDepth1 = true;
      }
    } else if (b === 0x7d || b === 0x5d) {
      depth -= 1;
      if (depth <= 0) {
        break;
      }
    } else if (depth === 1) {
      if (b === 0x2c) {
        expectKeyAtDepth1 = true;
      } else if (b === 0x3a) {
        expectKeyAtDepth1 = false;
      }
    }

    i += 1;
  }

  return "unknown";
}

function stripBomBytes(buf, isFirstLine) {
  const hasBom = isFirstLine && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return hasBom ? buf.subarray(3) : buf;
}

function readTranscriptStepsFast(filePath) {
  const fd = openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
  const prefixBuf = Buffer.allocUnsafe(PREFIX_SCAN_BYTES);

  const steps = [];
  let hasContentBytes = false;
  let validRecordCount = 0;
  let lineState = "undecided";
  let prefixLen = 0;
  let lineChunks = [];
  let lineBytes = 0;
  let skipBalance = null;
  let isFirstLine = true;

  const pushParsed = (rawLine) => {
    const parsed = parseRawRecord(rawLine);
    if (!parsed) {
      return;
    }
    const step = recordToStep(parsed, validRecordCount);
    validRecordCount += 1;
    if (step) {
      steps.push(step);
    }
  };

  const probeLine = (buf) => {
    const text = buf.toString("utf8");
    const parsed = parseRawRecord(text);
    if (!parsed) {
      return;
    }
    if (text.toLowerCase().includes(PRE_TOOL_DENIAL_NEEDLE) && isPreToolDenialStep(parsed)) {
      const step = recordToStep(parsed, validRecordCount);
      if (step) {
        steps.push(step);
      }
    }
    validRecordCount += 1;
  };

  const startSkipBalance = (buffers) => {
    skipBalance = createJsonBalance();
    for (let i = 0; i < buffers.length; i += 1) {
      const segment = i === 0 ? stripBomBytes(buffers[i], isFirstLine) : buffers[i];
      advanceJsonBalance(skipBalance, segment, 0, segment.length);
    }
  };

  const appendSegment = (view, start, end) => {
    if (lineState === "probe") {
      lineBytes += end - start;
      if (lineBytes > PROBE_MAX_BYTES) {
        lineState = "skip";
        startSkipBalance(lineChunks);
        advanceJsonBalance(skipBalance, view, start, end);
        lineChunks = [];
        return;
      }
    }
    lineChunks.push(Buffer.from(view.subarray(start, end)));
  };

  const finalizeLine = () => {
    if (lineState === "skip") {
      hasContentBytes = true;
      if (skipBalance && skipBalance.valid && skipBalance.closed && skipBalance.depth === 0 && !skipBalance.inString) {
        validRecordCount += 1;
      }
    } else if (lineState === "undecided") {
      const prefixSlice = stripBomBytes(prefixBuf.subarray(0, prefixLen), isFirstLine);
      const rawLine = prefixSlice.toString("utf8");
      if (rawLine.trim().length > 0) {
        hasContentBytes = true;
        const classification = classifyLinePrefix(prefixSlice);
        if (classification === "skip") {
          if (parseRawRecord(rawLine)) {
            validRecordCount += 1;
          }
        } else if (classification === "probe") {
          probeLine(prefixSlice);
        } else {
          pushParsed(rawLine);
        }
      }
    } else if (lineChunks.length > 0) {
      hasContentBytes = true;
      const joined = lineChunks.length === 1 ? lineChunks[0] : Buffer.concat(lineChunks);
      if (lineState === "probe") {
        probeLine(joined);
      } else {
        pushParsed(joined.toString("utf8"));
      }
    }

    isFirstLine = false;
    lineState = "undecided";
    prefixLen = 0;
    lineChunks = [];
    lineBytes = 0;
    skipBalance = null;
  };

  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, CHUNK_SIZE, null);
      if (bytesRead <= 0) {
        break;
      }
      const view = chunk.subarray(0, bytesRead);
      let pos = 0;
      while (pos < bytesRead) {
        const nlIdx = view.indexOf(NEWLINE_BYTE, pos);
        const segEnd = nlIdx !== -1 ? nlIdx : bytesRead;

        if (lineState === "undecided") {
          const copyLen = Math.min(PREFIX_SCAN_BYTES - prefixLen, segEnd - pos);
          view.copy(prefixBuf, prefixLen, pos, pos + copyLen);
          prefixLen += copyLen;
          pos += copyLen;
          if (prefixLen === PREFIX_SCAN_BYTES && (pos < segEnd || nlIdx === -1)) {
            const classification = classifyLinePrefix(stripBomBytes(prefixBuf, isFirstLine));
            lineState = classification === "skip" || classification === "probe" ? classification : "keep";
            if (lineState === "skip") {
              startSkipBalance([prefixBuf]);
            } else {
              lineChunks = [Buffer.from(prefixBuf)];
              lineBytes = PREFIX_SCAN_BYTES;
            }
          }
        }
        if (lineState === "skip") {
          advanceJsonBalance(skipBalance, view, pos, segEnd);
        } else if (lineState === "keep" || lineState === "probe") {
          appendSegment(view, pos, segEnd);
        }
        pos = segEnd;
        if (nlIdx !== -1) {
          finalizeLine();
          pos = nlIdx + 1;
        }
      }
    }
    if (prefixLen > 0 || lineChunks.length > 0 || skipBalance !== null) {
      finalizeLine();
    }
  } finally {
    closeSync(fd);
  }

  return { hasContent: hasContentBytes && (steps.length > 0 || validRecordCount > 0), steps };
}

export function resolveTranscriptCandidates(transcriptPath) {
  if (basename(transcriptPath) === "transcript.jsonl") {
    return [join(dirname(transcriptPath), "transcript_full.jsonl"), transcriptPath];
  }
  return [transcriptPath];
}

function readTranscript(transcriptPath, readTextFile) {
  let available = false;
  for (const candidatePath of resolveTranscriptCandidates(transcriptPath)) {
    try {
      let result;
      if (typeof readTextFile === "function") {
        const content = readTextFile(candidatePath);
        if (typeof content !== "string" || content.trim().length === 0) {
          continue;
        }
        const parsed = parseTranscriptJsonlWithStats(content);
        result = { hasContent: parsed.validRecordCount > 0, steps: parsed.steps };
      } else {
        result = readTranscriptStepsFast(candidatePath);
      }
      if (result.steps.length > 0) {
        return { steps: result.steps, available: true };
      }
      available = available || result.hasContent;
    } catch {
      continue;
    }
  }
  return { steps: [], available };
}

export function readTranscriptSteps(transcriptPath, readTextFile) {
  return readTranscript(transcriptPath, readTextFile).steps;
}

export function parseHookPayload(stdinText, expectedEventName) {
  if (typeof stdinText !== "string" || stdinText.trim().length === 0) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const name = payload.hookEventName ?? payload.hook_event_name;
  if (expectedEventName && name !== undefined && name !== null && name !== "" && name !== expectedEventName) {
    return null;
  }
  return payload;
}

export function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return fileURLToPath(moduleUrl) === resolve(process.argv[1]);
  }
}

export function loadHookContext(stdinText, eventName, readTextFile) {
  const payload = parseHookPayload(stdinText, eventName);
  if (!payload) return null;
  const rawPath = payload.transcriptPath ?? payload.transcript_path;
  const transcriptPath = typeof rawPath === "string" ? rawPath.trim() : "";
  const { steps, available } =
    transcriptPath.length > 0 ? readTranscript(transcriptPath, readTextFile) : { steps: [], available: false };
  return { payload, transcriptPath, steps, transcriptAvailable: available };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

export async function runHookCli(handler, fallbackOutput = {}) {
  let output;
  try {
    process.stdin.setEncoding("utf8");
    let stdinText = "";
    for await (const chunk of process.stdin) stdinText += chunk;
    output = handler(stdinText);
  } catch {
    output = fallbackOutput;
  }
  process.stdout.write(`${JSON.stringify(isPlainObject(output) ? output : fallbackOutput)}\n`);
}
