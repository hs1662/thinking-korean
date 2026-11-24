#!/usr/bin/env node

import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideHookAction, parseTranscriptJsonl, parseTranscriptLine } from "./transcript.mjs";

const CHUNK_SIZE = 256 * 1024;
const PREFIX_SCAN_BYTES = 256;
const NEWLINE_BYTE = 0x0a;
const INTERESTING_TYPES = new Set(["PLANNER_RESPONSE", "SYSTEM_MESSAGE", "USER_INPUT"]);

function isAsciiWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
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
  let i = 0;
  while (i < len && isAsciiWhitespace(prefixBuf[i])) {
    i += 1;
  }
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
        const keyStart = i + 1;
        const keyLen = str.end - keyStart;
        if (str.hasEscape) {
          return "unknown";
        }
        const isTypeKey =
          keyLen === 4 &&
          prefixBuf[keyStart] === 0x74 &&
          prefixBuf[keyStart + 1] === 0x79 &&
          prefixBuf[keyStart + 2] === 0x70 &&
          prefixBuf[keyStart + 3] === 0x65;

        if (isTypeKey) {
          let j = str.end + 1;
          while (j < len && isAsciiWhitespace(prefixBuf[j])) {
            j += 1;
          }
          if (j >= len || prefixBuf[j] !== 0x3a) {
            return "unknown";
          }
          j += 1;
          while (j < len && isAsciiWhitespace(prefixBuf[j])) {
            j += 1;
          }
          if (j >= len || prefixBuf[j] !== 0x22) {
            return "unknown";
          }
          const val = scanJsonStringEnd(prefixBuf, j);
          if (!val || val.hasEscape) {
            return "unknown";
          }
          const typeValue = prefixBuf.subarray(j + 1, val.end).toString("latin1");
          return INTERESTING_TYPES.has(typeValue) ? "keep" : "skip";
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

function readTranscriptStepsFast(filePath) {
  const fd = openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(CHUNK_SIZE);
  const prefixBuf = Buffer.allocUnsafe(PREFIX_SCAN_BYTES);

  const steps = [];
  let totalBytes = 0;
  let lineIndex = 0;
  let lineState = "undecided";
  let prefixLen = 0;
  let lineChunks = [];

  const finalizeLine = () => {
    if (lineState === "undecided") {
      if (prefixLen > 0) {
        const prefixSlice = prefixBuf.subarray(0, prefixLen);
        if (classifyLinePrefix(prefixSlice) !== "skip") {
          const step = parseTranscriptLine(prefixSlice.toString("utf8"), lineIndex);
          if (step) {
            steps.push(step);
          }
        }
      }
    } else if (lineState === "keep" && lineChunks.length > 0) {
      const rawLine =
        lineChunks.length === 1
          ? lineChunks[0].toString("utf8")
          : Buffer.concat(lineChunks).toString("utf8");
      const step = parseTranscriptLine(rawLine, lineIndex);
      if (step) {
        steps.push(step);
      }
    }

    lineIndex += 1;
    lineState = "undecided";
    prefixLen = 0;
    lineChunks = [];
  };

  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, CHUNK_SIZE, null);
      if (bytesRead <= 0) {
        break;
      }
      totalBytes += bytesRead;

      const view = chunk.subarray(0, bytesRead);
      let pos = 0;
      while (pos < bytesRead) {
        const nlIdx = view.indexOf(NEWLINE_BYTE, pos);
        const segEnd = nlIdx !== -1 ? nlIdx : bytesRead;

        if (lineState === "skip") {
          pos = segEnd;
        } else if (lineState === "undecided") {
          const remainingPrefix = PREFIX_SCAN_BYTES - prefixLen;
          const segLen = segEnd - pos;
          const copyLen = Math.min(remainingPrefix, segLen);
          view.copy(prefixBuf, prefixLen, pos, pos + copyLen);
          prefixLen += copyLen;
          pos += copyLen;

          if (prefixLen === PREFIX_SCAN_BYTES && pos < segEnd) {
            const classification = classifyLinePrefix(prefixBuf);
            if (classification === "skip") {
              lineState = "skip";
              pos = segEnd;
            } else {
              lineState = "keep";
              lineChunks = [Buffer.from(prefixBuf), Buffer.from(view.subarray(pos, segEnd))];
              pos = segEnd;
            }
          } else if (prefixLen === PREFIX_SCAN_BYTES && nlIdx === -1) {
            const classification = classifyLinePrefix(prefixBuf);
            if (classification === "skip") {
              lineState = "skip";
            } else {
              lineState = "keep";
              lineChunks = [Buffer.from(prefixBuf)];
            }
          }
        } else {
          if (segEnd > pos) {
            lineChunks.push(Buffer.from(view.subarray(pos, segEnd)));
          }
          pos = segEnd;
        }

        if (nlIdx !== -1) {
          finalizeLine();
          pos = nlIdx + 1;
        }
      }
    }

    if (prefixLen > 0 || lineChunks.length > 0) {
      finalizeLine();
    }
  } finally {
    closeSync(fd);
  }

  return { hasBytes: totalBytes > 0, steps };
}

function resolveTranscriptCandidates(transcriptPath) {
  if (basename(transcriptPath) === "transcript.jsonl") {
    return [join(dirname(transcriptPath), "transcript_full.jsonl"), transcriptPath];
  }
  return [transcriptPath];
}

export function readTranscriptSteps(transcriptPath, readTextFile) {
  for (const candidatePath of resolveTranscriptCandidates(transcriptPath)) {
    try {
      if (typeof readTextFile === "function") {
        const content = readTextFile(candidatePath);
        if (typeof content === "string" && content.length > 0) {
          return parseTranscriptJsonl(content);
        }
        continue;
      }

      const result = readTranscriptStepsFast(candidatePath);
      if (result.hasBytes) {
        return result.steps;
      }
    } catch {
      continue;
    }
  }
  return [];
}

export function handlePostInvocation(stdinText, readTextFile) {
  if (typeof stdinText !== "string" || stdinText.trim().length === 0) {
    return {};
  }

  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return {};
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const hookEventName = payload.hookEventName;
  if (
    hookEventName !== undefined &&
    hookEventName !== null &&
    hookEventName !== "" &&
    hookEventName !== "PostInvocation"
  ) {
    return {};
  }

  const rawTranscriptPath = payload.transcriptPath;
  const transcriptPath = typeof rawTranscriptPath === "string" ? rawTranscriptPath.trim() : "";
  if (transcriptPath.length === 0) {
    return {};
  }

  const steps = readTranscriptSteps(transcriptPath, readTextFile);
  if (steps.length === 0) {
    return {};
  }

  const options =
    typeof payload.lastUserInput === "string" ? { lastUserInput: payload.lastUserInput } : {};
  const decision = decideHookAction(steps, options);
  if (decision.action !== "inject") {
    return {};
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: decision.message,
        },
      },
    ],
  };
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  }
}

async function runCli() {
  try {
    process.stdin.setEncoding("utf8");
    let stdinText = "";
    for await (const chunk of process.stdin) {
      stdinText += chunk;
    }
    const output = handlePostInvocation(stdinText);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
}

if (isDirectExecution()) {
  runCli();
}
