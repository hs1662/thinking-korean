import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { resolveTranscriptCandidates, streamTranscriptRecords } from "../hook-io.mjs";
import { GATE_STOP_MARKER } from "../transcript/markers.mjs";
import { getToolCalls, isPreToolDenialStep, parseRawRecord, parseStepIndex } from "../transcript/steps.mjs";
import {
  AUDITOR_AGENT_NAME,
  AUDITOR_SESSION_MARKER,
  AUDIT_PASS_TAG,
  AUDIT_REJECT_TAG,
  CREATE_AS_READ_TOOL_NAMES,
  EXEC_TOOL_NAMES,
  GATE_TOOL_NAME,
  MCP_VERIFICATION_TOOL_NAMES,
  PASSING_VERDICTS,
  READ_ONLY_BINARIES,
  READ_ONLY_GIT_SUBCOMMANDS,
  READ_TOOL_NAMES,
  SUBAGENT_TOOL_NAME,
  VERDICT_HEADERS,
  VERIFICATION_BINARIES,
  WORKER_SESSION_MARKER,
  WRITE_TOOL_NAMES,
  isExemptDocOrAssetPath,
} from "./constants.mjs";

const RESULT_HEAD_MAX_CHARS = 256;
const RESULT_TAIL_MAX_CHARS = 2048;
const AUDIT_TAIL_MAX_CHARS = 4096;
const GIT_TIMEOUT_MS = 1500;
const MAX_UNWRAP_DEPTH = 2;
const MAX_UNTRACKED_COUNT_BYTES = 512 * 1024;
const SUBAGENT_CONVERSATION_ID_RE = /(?:conversationId|conversation_id|sender)\s*[:=]\s*["']?([0-9a-f-]{8,64})/i;
const SUBAGENT_SENDER_MSG_RE = /sender=([0-9a-f-]{8,64})\b/i;

const SHELL_WRAPPERS = new Set(["sudo", "time", "env", "command", "nohup"]);
const WRAPPER_FLAGS_WITH_ARG = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  sudo: new Set(["-u", "--user", "-g", "--group", "-C", "--close-from", "-h", "--host", "-p", "--prompt", "-r", "--role", "-t", "--type", "-D", "--chdir"]),
};
const SHELL_NEUTRAL_BUILTINS = new Set(["cd", "export", "set", "unset", "true", "false", "sleep", "umask"]);
const GIT_FLAGS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

const EXIT_CODE_FAIL_RE = /exit\s+code[:\s]+[1-9]\d*/i;
const TAP_FAIL_ZERO_RE = /(?:^|\n)[ \t]*(?:#|ℹ)[ \t]*fail[ \t]+0\b/m;
const TAP_FAIL_NONZERO_RE = /(?:^|\n)[ \t]*(?:#|ℹ)[ \t]*fail[ \t]+[1-9]\d*\b/m;
const RUN_CHECKS_FAIL_HEADER_RE = /^Checks:\s+\d+\/\d+\s+passed,\s+(?:[1-9]\d*\s+failed|[1-9]\d*\s+not run)\b/m;
const RUN_CHECKS_ALL_PASSED_HEADER_RE = /^Checks:\s+(\d+)\/\1\s+passed\b(?!,\s*[1-9]\d*\s+(?:failed|not run)\b)/m;
const RUN_CHECKS_FAIL_BLOCK_RE = /^##\s+\[(?:FAIL|NOT RUN)\]/m;
const PASSING_TEST_LINE_RE = /^\s*(?:ok\s+\d+|ok\b|✔|✓|#\s*Subtest:|▶)/;
const FAILURE_LINE_PATTERNS = [
  EXIT_CODE_FAIL_RE,
  /^\s*(?:Error:\s*)?Command failed\b/i,
  /^\s*(?:AssertionError\b|[\w$.]*AssertionError\b)/,
  /^\s*FAIL\b/,
  /(?:^|[ \t#ℹ])fail[ \t]+[1-9]\d*\b/i,
];

const PRE_TOOL_NOTICE_PREFIX = "A pre-tool hook changed the arguments";
const VERDICT_HEADER_ENTRIES = [
  [VERDICT_HEADERS.REJECT_NEUTRAL, "REJECT"],
  [VERDICT_HEADERS.REJECT_AUDIT, "REJECT"],
  [VERDICT_HEADERS.PASS_WITH_AUDIT_DEGRADATION, "PASS_WITH_AUDIT_DEGRADATION"],
  [VERDICT_HEADERS.PASS_WITH_DEGRADATION, "PASS_WITH_DEGRADATION"],
  [VERDICT_HEADERS.PASS_WITH_WARNING, "PASS_WITH_WARNING"],
  [VERDICT_HEADERS.PASS, "PASS"],
  [VERDICT_HEADERS.ESCALATE_AUDIT_REQUIRED, "ESCALATE_AUDIT_REQUIRED"],
  [VERDICT_HEADERS.SKIPPED_NO_SESSION, "SKIPPED_NO_SESSION"],
];

const TEST_INFRA_EXACT_FILES = ["pytest.ini", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile"];
const TEST_INFRA_CONFIG_PREFIXES = ["vitest.config.", "jest.config."];

function toPosix(rawPath) {
  return rawPath.replace(/\\/g, "/");
}

function stripTrailingSlashes(p) {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function isAbsolutePosix(p) {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

function relativizeAgainstBase(normPath, rawBase) {
  if (typeof rawBase !== "string" || rawBase.trim().length === 0) {
    return null;
  }
  const normBase = stripTrailingSlashes(posix.normalize(toPosix(rawBase.trim())));
  if (!normBase || !isAbsolutePosix(normBase)) {
    return null;
  }
  const caseFold = /^[A-Za-z]:\//.test(normBase);
  const cmpPath = caseFold ? normPath.toLowerCase() : normPath;
  const cmpBase = caseFold ? normBase.toLowerCase() : normBase;
  if (cmpPath === cmpBase) {
    return ".";
  }
  if (cmpPath.startsWith(`${cmpBase}/`)) {
    return normPath.slice(normBase.length + 1);
  }
  return null;
}

function tryRealpath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return null;
  }
  try {
    return realpathSync(rawPath.trim());
  } catch {
    return null;
  }
}

function collectBaseVariants(rawBase) {
  if (typeof rawBase !== "string" || rawBase.trim().length === 0) {
    return [];
  }
  const trimmed = rawBase.trim();
  const real = tryRealpath(trimmed);
  return real && real !== trimmed ? [trimmed, real] : [trimmed];
}

function relativizeAgainstAnyBase(normPath, bases) {
  for (const base of bases) {
    const rel = relativizeAgainstBase(normPath, base);
    if (rel !== null) {
      return rel;
    }
  }
  return null;
}

export function normalizeWorkspacePath(rawPath, cwd = "", gitRoot = "") {
  if (typeof rawPath !== "string") {
    return "";
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  let normalized = posix.normalize(toPosix(trimmed));
  const gitBases = collectBaseVariants(gitRoot);
  const cwdBases = collectBaseVariants(cwd);
  if (isAbsolutePosix(normalized)) {
    const rel = relativizeAgainstAnyBase(normalized, gitBases) ?? relativizeAgainstAnyBase(normalized, cwdBases);
    if (rel !== null) {
      normalized = rel;
    }
  } else if (cwdBases.length > 0 && gitBases.length > 0) {
    let cwdRel = null;
    for (const cwdCandidate of cwdBases) {
      cwdRel = relativizeAgainstAnyBase(stripTrailingSlashes(posix.normalize(toPosix(cwdCandidate))), gitBases);
      if (cwdRel !== null) {
        break;
      }
    }
    if (cwdRel && cwdRel !== ".") {
      const alreadyGitRootRelative =
        !normalized.startsWith("../") &&
        gitRoot &&
        existsSync(gitRoot) &&
        !existsSync(join(cwd, normalized)) &&
        existsSync(join(gitRoot, normalized));
      if (!alreadyGitRootRelative) {
        normalized = posix.normalize(`${cwdRel}/${normalized}`);
      }
    }
  }
  normalized = normalized.replace(/^\.\//, "");
  return stripTrailingSlashes(normalized);
}

export function splitShellSegments(commandLine) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < commandLine.length) {
        i += 1;
        current += commandLine[i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < commandLine.length) {
      current += ch + commandLine[i + 1];
      i += 1;
      continue;
    }
    const next = commandLine[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      segments.push(current);
      current = "";
      i += 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function tokenizeSegment(segment) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        i += 1;
        current += segment[i];
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function hasUnquotedFileRedirection(segment) {
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      i += 1;
      continue;
    }
    if (ch === ">") {
      let j = i + 1;
      if (segment[j] === ">") {
        j += 1;
      }
      if (segment[j] === "&") {
        let k = j + 1;
        while (k < segment.length && /\d/.test(segment[k])) {
          k += 1;
        }
        if (k > j + 1 || segment[j + 1] === "-") {
          i = k - 1;
          continue;
        }
      }
      while (j < segment.length && /\s/.test(segment[j])) {
        j += 1;
      }
      const rest = segment.slice(j);
      if (/^\/dev\/null(?:\s|$)/.test(rest)) {
        i = j + "/dev/null".length - 1;
        continue;
      }
      return true;
    }
  }
  return false;
}

function classifySingleSegment(segment) {
  const cleaned = segment.trim().replace(/^[(!\s]+/, "");
  if (cleaned.length === 0) {
    return "empty";
  }
  const hasFileRedirect = hasUnquotedFileRedirection(cleaned);
  const tokens = tokenizeSegment(cleaned);
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === "!" || tok === "(" || ENV_ASSIGN_RE.test(tok)) {
      idx += 1;
      continue;
    }
    if (SHELL_WRAPPERS.has(tok)) {
      const valueFlags = WRAPPER_FLAGS_WITH_ARG[tok];
      idx += 1;
      while (idx < tokens.length) {
        const arg = tokens[idx];
        if (arg === "--") {
          idx += 1;
          break;
        }
        if (valueFlags && valueFlags.has(arg)) {
          idx += 2;
          continue;
        }
        if (arg.startsWith("-") && arg.length > 1) {
          idx += 1;
          continue;
        }
        if (tok === "env" && ENV_ASSIGN_RE.test(arg)) {
          idx += 1;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  if (idx >= tokens.length) {
    return "empty";
  }

  const rawBin = tokens[idx];
  const baseBin = posix.basename(toPosix(rawBin));

  if (baseBin === "git") {
    let subIdx = idx + 1;
    while (subIdx < tokens.length) {
      const arg = tokens[subIdx];
      if (GIT_FLAGS_WITH_ARG.has(arg)) {
        subIdx += 2;
        continue;
      }
      if (arg.startsWith("-")) {
        subIdx += 1;
        continue;
      }
      break;
    }
    const subcommand = tokens[subIdx] ?? "";
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) && !hasFileRedirect) {
      return "read_only";
    }
    return "other";
  }

  if (READ_ONLY_BINARIES.has(baseBin) || SHELL_NEUTRAL_BUILTINS.has(baseBin)) {
    return hasFileRedirect ? "other" : "read_only";
  }
  if (VERIFICATION_BINARIES.has(baseBin) || rawBin.startsWith("./") || rawBin.startsWith("../")) {
    return "verification";
  }
  return "other";
}

export function classifyCommand(commandLine) {
  if (typeof commandLine !== "string" || commandLine.trim().length === 0) {
    return "read_only";
  }
  const segments = splitShellSegments(commandLine);
  let sawVerification = false;
  let sawOther = false;
  for (const seg of segments) {
    const kind = classifySingleSegment(seg);
    if (kind === "verification") {
      sawVerification = true;
    } else if (kind === "other") {
      sawOther = true;
    }
  }
  if (sawVerification) {
    return "verification";
  }
  return sawOther ? "other" : "read_only";
}

export function inferExecutionFailure(result) {
  if (!result || typeof result !== "object") {
    return false;
  }
  if (result.status === "ERROR") {
    return true;
  }
  if (typeof result.error === "string" && result.error.trim().length > 0) {
    return true;
  }
  const head = typeof result.head === "string" ? result.head : "";
  const tail = typeof result.tail === "string" ? result.tail : typeof result.content === "string" ? result.content : "";
  if (head.length === 0 && tail.length === 0) {
    return false;
  }
  if (
    RUN_CHECKS_FAIL_HEADER_RE.test(head) ||
    RUN_CHECKS_FAIL_HEADER_RE.test(tail) ||
    RUN_CHECKS_FAIL_BLOCK_RE.test(head) ||
    RUN_CHECKS_FAIL_BLOCK_RE.test(tail)
  ) {
    return true;
  }
  if (RUN_CHECKS_ALL_PASSED_HEADER_RE.test(head) || RUN_CHECKS_ALL_PASSED_HEADER_RE.test(tail)) {
    return false;
  }
  if (tail.length === 0) {
    return false;
  }
  if (EXIT_CODE_FAIL_RE.test(tail)) {
    return true;
  }
  if (TAP_FAIL_NONZERO_RE.test(tail)) {
    return true;
  }
  if (TAP_FAIL_ZERO_RE.test(tail)) {
    return false;
  }
  for (const line of tail.split(/\r?\n/)) {
    if (PASSING_TEST_LINE_RE.test(line)) {
      continue;
    }
    if (FAILURE_LINE_PATTERNS.some((pattern) => pattern.test(line))) {
      return true;
    }
  }
  return false;
}

function unwrapSerialized(value, depth = 0) {
  if (typeof value !== "string" || depth >= MAX_UNWRAP_DEPTH) {
    return value;
  }
  const trimmed = value.trim();
  const first = trimmed.charAt(0);
  if (first !== "{" && first !== "[" && first !== '"') {
    return value;
  }
  try {
    return unwrapSerialized(JSON.parse(trimmed), depth + 1);
  } catch {
    return value;
  }
}

function asObject(value) {
  const unwrapped = unwrapSerialized(value);
  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped) ? unwrapped : null;
}

function asArray(value) {
  const unwrapped = unwrapSerialized(value);
  return Array.isArray(unwrapped) ? unwrapped : null;
}

function pickString(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].trim().length > 0) {
      return obj[key].trim();
    }
  }
  return "";
}

export function extractToolPaths(call, cwd = "", gitRoot = "") {
  if (!call || typeof call !== "object") {
    return { readPaths: [], writePaths: [] };
  }
  const name = typeof call.name === "string" ? call.name : "";
  const args = asObject(call.args);
  if (!args) {
    return { readPaths: [], writePaths: [] };
  }

  const readPaths = [];
  const writePaths = [];
  const pushNorm = (target, raw, baseCwd = cwd) => {
    const normalized = normalizeWorkspacePath(raw, baseCwd, gitRoot);
    if (normalized.length > 0) {
      target.push(normalized);
    }
  };

  if (READ_TOOL_NAMES.has(name)) {
    const raw = pickString(args, ["Path", "path", "AbsolutePath", "absolute_path", "file_path"]);
    pushNorm(readPaths, raw);
  } else if (name === "mcp_agy-fast_fast_apply_edits") {
    const baseCwd = pickString(args, ["cwd"]) || cwd;
    for (const rawEdit of asArray(args.edits) ?? []) {
      const edit = asObject(rawEdit);
      if (!edit) {
        continue;
      }
      const raw = pickString(edit, ["path", "Path"]);
      pushNorm(writePaths, raw, baseCwd);
      if (edit.create !== undefined) {
        pushNorm(readPaths, raw, baseCwd);
      }
    }
  } else if (WRITE_TOOL_NAMES.has(name)) {
    const raw = pickString(args, ["Path", "path", "TargetFile", "target_file", "AbsolutePath", "absolute_path"]);
    pushNorm(writePaths, raw);
    if (CREATE_AS_READ_TOOL_NAMES.has(name)) {
      pushNorm(readPaths, raw);
    }
  }

  return { readPaths, writePaths };
}

function extractCommandLine(call) {
  const args = asObject(call?.args);
  if (!args) {
    return "";
  }
  return pickString(args, ["CommandLine", "commandLine", "command"]);
}

export function extractMcpCheckCommands(call) {
  const args = asObject(call?.args);
  if (!args) {
    return { commands: [], labels: [] };
  }
  const commands = [];
  const labels = [];
  const rawList = asArray(args.commands) ?? asArray(args.checks);
  if (rawList) {
    for (const rawItem of rawList) {
      if (typeof rawItem === "string") {
        const trimmed = rawItem.trim();
        if (trimmed.length > 0) {
          commands.push(trimmed);
        }
        continue;
      }
      const item = asObject(rawItem);
      if (!item) {
        continue;
      }
      const cmd = pickString(item, ["command", "CommandLine", "commandLine"]);
      if (cmd.length > 0) {
        commands.push(cmd);
      }
      const label = pickString(item, ["name", "label"]);
      if (label.length > 0) {
        labels.push(label);
      }
    }
  } else {
    const single = pickString(args, ["command", "CommandLine", "commandLine"]);
    if (single.length > 0) {
      commands.push(single);
    }
  }
  return { commands, labels };
}

function classifyMcpCheckCommands(commands) {
  if (commands.length === 0) {
    return "verification";
  }
  return commands.some((cmd) => classifyCommand(cmd) !== "read_only") ? "verification" : "read_only";
}

function extractHead(content) {
  if (typeof content !== "string" || content.length === 0) {
    return "";
  }
  if (content.length <= RESULT_HEAD_MAX_CHARS) {
    return content;
  }
  let end = RESULT_HEAD_MAX_CHARS;
  const code = content.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return content.slice(0, end);
}

function extractTail(content, maxChars = RESULT_TAIL_MAX_CHARS) {
  if (typeof content !== "string") {
    return "";
  }
  if (content.length <= maxChars) {
    return content;
  }
  let start = content.length - maxChars;
  const code = content.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff && start + 1 < content.length) {
    start += 1;
  }
  return content.slice(start);
}

export function extractSubagentTypeNames(call) {
  const args = asObject(call?.args);
  if (!args) {
    return [];
  }
  const names = [];
  const topType = pickString(args, ["TypeName", "typeName", "type_name", "subagent_type"]);
  if (topType.length > 0) {
    names.push(topType);
  }
  const subagents = asArray(args.Subagents ?? args.subagents);
  if (subagents) {
    for (const rawItem of subagents) {
      const item = asObject(rawItem);
      if (!item) {
        continue;
      }
      const itemType = pickString(item, ["TypeName", "typeName", "type_name", "subagent_type"]);
      if (itemType.length > 0) {
        names.push(itemType);
      }
    }
  }
  return names;
}

function isAuditorTypeName(typeName) {
  return typeName === AUDITOR_AGENT_NAME || typeName === `hstack:${AUDITOR_AGENT_NAME}`;
}

export function parseAuditVerdictFromText(fullContent, { status = "", error = "" } = {}) {
  const normStatus = typeof status === "string" ? status.trim().toUpperCase() : "";
  const normError = typeof error === "string" ? error.trim() : "";
  if (normStatus === "ERROR" || normStatus === "FAILED" || normError.length > 0) {
    return "ERROR";
  }
  if (typeof fullContent !== "string" || fullContent.trim().length === 0) {
    return "MISSING_VERDICT";
  }
  const tail = extractTail(fullContent, AUDIT_TAIL_MAX_CHARS);
  const lines = tail
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith(PRE_TOOL_NOTICE_PREFIX));

  if (lines.length === 0) {
    return "MISSING_VERDICT";
  }

  const stripEdgeDecoration = (line) => line.replace(/^[*_`\s]+|[*_`\s]+$/g, "");
  const lastLine = stripEdgeDecoration(lines[lines.length - 1]);
  if (lastLine === AUDIT_PASS_TAG) {
    return "PASS";
  }
  if (lastLine === AUDIT_REJECT_TAG) {
    return "REJECT";
  }

  const scanStart = Math.max(0, lines.length - 4);
  for (let i = lines.length - 1; i >= scanStart; i -= 1) {
    const candidate = stripEdgeDecoration(lines[i]);
    if (candidate === AUDIT_PASS_TAG) {
      return "PASS";
    }
    if (candidate === AUDIT_REJECT_TAG) {
      return "REJECT";
    }
  }

  return "MISSING_VERDICT";
}

function extractSubagentConversationId(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }
  const match = text.match(SUBAGENT_CONVERSATION_ID_RE);
  return match ? match[1] : "";
}

function isAsyncSubagentLaunchAck(text) {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  return (
    SUBAGENT_CONVERSATION_ID_RE.test(text) &&
    !text.includes(AUDIT_PASS_TAG) &&
    !text.includes(AUDIT_REJECT_TAG)
  );
}

function detectSessionRoleFromUserInput(content) {
  if (typeof content !== "string" || content.length === 0) {
    return "main";
  }
  if (content.includes(AUDITOR_SESSION_MARKER)) {
    return "auditor";
  }
  if (content.includes(WORKER_SESSION_MARKER)) {
    return "worker";
  }
  return "main";
}

export function readLatestTranscriptTokens(transcriptPath) {
  const empty = { inputTokens: null, cacheReadTokens: null, outputTokens: null };
  if (typeof transcriptPath !== "string" || transcriptPath.trim().length === 0) {
    return empty;
  }
  const TAIL_BYTES = 64 * 1024;
  for (const candidatePath of resolveTranscriptCandidates(transcriptPath.trim())) {
    let fd = null;
    try {
      fd = openSync(candidatePath, "r");
      const size = fstatSync(fd).size;
      if (size <= 0) {
        continue;
      }
      const readLen = Math.min(size, TAIL_BYTES);
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = readSync(fd, buf, 0, readLen, size - readLen);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i].trim();
        if (!line.includes("PLANNER_RESPONSE")) {
          continue;
        }
        const parsed = parseRawRecord(line);
        if (parsed && parsed.type === "PLANNER_RESPONSE") {
          const tokens = extractLatestTokens(parsed);
          if (tokens) {
            return tokens;
          }
        }
      }
      return empty;
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
        }
      }
    }
  }
  return empty;
}

function parseGateVerdictFromText(fullContent) {
  if (typeof fullContent !== "string" || fullContent.length === 0) {
    return "UNKNOWN";
  }
  for (const rawLine of fullContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(PRE_TOOL_NOTICE_PREFIX)) {
      continue;
    }
    for (const [header, verdict] of VERDICT_HEADER_ENTRIES) {
      if (line.startsWith(header)) {
        return verdict;
      }
    }
  }
  return "UNKNOWN";
}

function extractTokenNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function extractLatestTokens(parsed) {
  const usage = parsed.usage ?? parsed.tokenUsage ?? parsed.token_usage ?? parsed;
  const inputTokens = extractTokenNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const cacheReadTokens = extractTokenNumber(usage, [
    "cacheReadTokens",
    "cache_read_tokens",
    "cachedInputTokens",
    "cached_input_tokens",
  ]);
  const outputTokens = extractTokenNumber(usage, [
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
  ]);
  if (inputTokens === null && cacheReadTokens === null && outputTokens === null) {
    return null;
  }
  return { inputTokens, cacheReadTokens, outputTokens };
}

function createEmptyLedger(transcriptAvailable = false) {
  return {
    transcriptAvailable,
    sessionRole: "main",
    sessionReadFiles: new Set(),
    turnStartStepIndex: 0,
    turnWrittenFiles: new Set(),
    turnCodeWrittenFiles: new Set(),
    lastWriteStepIndex: -1,
    lastCodeWriteStepIndex: -1,
    turnExecutions: [],
    turnFailedExecutionCount: 0,
    fileEditCounts: new Map(),
    turnGateAttempts: [],
    turnSubagentAudits: [],
    latestTokens: { inputTokens: null, cacheReadTokens: null, outputTokens: null },
    gateBlockedThisTurn: false,
  };
}

function scanTranscriptToLedger(filePath, cwd, gitRoot) {
  const ledger = createEmptyLedger(true);
  let pendingCalls = [];
  let seenFirstUserInput = false;
  const asyncAuditsByConversationId = new Map();

  const resetTurn = (stepIndex) => {
    ledger.turnStartStepIndex = stepIndex;
    ledger.turnWrittenFiles = new Set();
    ledger.turnCodeWrittenFiles = new Set();
    ledger.lastWriteStepIndex = -1;
    ledger.lastCodeWriteStepIndex = -1;
    ledger.turnExecutions = [];
    ledger.turnFailedExecutionCount = 0;
    ledger.fileEditCounts = new Map();
    ledger.turnGateAttempts = [];
    ledger.turnSubagentAudits = [];
    ledger.gateBlockedThisTurn = false;
    pendingCalls = [];
    asyncAuditsByConversationId.clear();
  };

  const peekNeedsGeneric = () => {
    const nextPending = pendingCalls[0];
    return Boolean(
      nextPending &&
        (nextPending.kind === "exec" || nextPending.kind === "gate" || nextPending.kind === "audit_subagent"),
    );
  };

  const result = streamTranscriptRecords(
    filePath,
    (prefixType, lineBuf, recordIndex) => {
      if (lineBuf === null) {
        if (prefixType === "USER_INPUT" || prefixType === "PLANNER_RESPONSE" || prefixType === "SYSTEM_MESSAGE" || prefixType === null) {
          return true;
        }
        if (prefixType === "GENERIC") {
          return peekNeedsGeneric();
        }
        return false;
      }

      const parsed = parseRawRecord(lineBuf.toString("utf8"));
      if (!parsed) {
        return false;
      }

      const rawIndex = parsed.step_index !== undefined ? parsed.step_index : parsed.stepIndex;
      const stepIndex = parseStepIndex(rawIndex, recordIndex);

      if (parsed.type === "USER_INPUT") {
        if (!seenFirstUserInput) {
          seenFirstUserInput = true;
          ledger.sessionRole = detectSessionRoleFromUserInput(
            typeof parsed.content === "string" ? parsed.content : "",
          );
        }
        resetTurn(stepIndex);
        return true;
      }

      if (parsed.type === "SYSTEM_MESSAGE") {
        const msgContent = typeof parsed.content === "string" ? parsed.content : "";
        if (msgContent.includes(GATE_STOP_MARKER)) {
          ledger.gateBlockedThisTurn = true;
        }
        if (asyncAuditsByConversationId.size > 0 && msgContent.length > 0) {
          const senderMatch = msgContent.match(SUBAGENT_SENDER_MSG_RE);
          const senderId = senderMatch ? senderMatch[1] : "";
          const tracked = senderId ? asyncAuditsByConversationId.get(senderId) : null;
          if (tracked) {
            tracked.stepIndex = Math.max(tracked.stepIndex, stepIndex);
            tracked.tail = extractTail(msgContent, AUDIT_TAIL_MAX_CHARS);
            tracked.verdict = parseAuditVerdictFromText(msgContent);
            if (tracked.verdict === "PASS" || tracked.verdict === "REJECT") {
              asyncAuditsByConversationId.delete(senderId);
            }
          }
        }
        return true;
      }

      if (parsed.type === "PLANNER_RESPONSE") {
        pendingCalls = [];
        const tokens = extractLatestTokens(parsed);
        if (tokens) {
          ledger.latestTokens = tokens;
        }

        for (const call of getToolCalls(parsed)) {
          const name = typeof call?.name === "string" ? call.name : "";
          const { readPaths, writePaths } = extractToolPaths(call, cwd, gitRoot);
          for (const p of readPaths) {
            ledger.sessionReadFiles.add(p);
          }
          for (const p of writePaths) {
            ledger.turnWrittenFiles.add(p);
            ledger.fileEditCounts.set(p, (ledger.fileEditCounts.get(p) ?? 0) + 1);
            ledger.lastWriteStepIndex = stepIndex;
            if (!isExemptDocOrAssetPath(p)) {
              ledger.turnCodeWrittenFiles.add(p);
              ledger.lastCodeWriteStepIndex = stepIndex;
            }
          }

          if (EXEC_TOOL_NAMES.has(name)) {
            const command = extractCommandLine(call);
            const entry = {
              stepIndex,
              command,
              kind: classifyCommand(command),
              passed: true,
              status: "",
              error: "",
              tail: "",
            };
            ledger.turnExecutions.push(entry);
            pendingCalls.push({ kind: "exec", entry });
          } else if (MCP_VERIFICATION_TOOL_NAMES.has(name)) {
            const { commands, labels } = extractMcpCheckCommands(call);
            const entry = {
              stepIndex,
              toolName: name,
              command: commands.join(" && ") || name,
              subCommands: commands,
              checkLabels: labels,
              kind: classifyMcpCheckCommands(commands),
              passed: true,
              status: "",
              error: "",
              tail: "",
            };
            ledger.turnExecutions.push(entry);
            pendingCalls.push({ kind: "exec", entry });
          } else if (name === GATE_TOOL_NAME) {
            const entry = {
              stepIndex,
              verdict: "UNKNOWN",
              passed: false,
            };
            ledger.turnGateAttempts.push(entry);
            pendingCalls.push({ kind: "gate", entry });
          } else if (name === SUBAGENT_TOOL_NAME) {
            const typeNames = extractSubagentTypeNames(call);
            if (typeNames.some(isAuditorTypeName)) {
              const entry = {
                stepIndex,
                typeName: AUDITOR_AGENT_NAME,
                verdict: "MISSING_VERDICT",
                conversationId: "",
                tail: "",
              };
              ledger.turnSubagentAudits.push(entry);
              pendingCalls.push({ kind: "audit_subagent", entry });
            } else {
              pendingCalls.push({ kind: "other" });
            }
          } else if (READ_TOOL_NAMES.has(name)) {
            pendingCalls.push({ kind: "read" });
          } else {
            pendingCalls.push({ kind: "other" });
          }
        }
        return true;
      }

      if (parsed.type === "GENERIC") {
        const pending = pendingCalls.shift();
        if (!pending) {
          return true;
        }
        const status = typeof parsed.status === "string" ? parsed.status : "";
        const error = typeof parsed.error === "string" ? parsed.error : "";

        if (pending.kind === "exec") {
          const tail = extractTail(parsed.content);
          const head = pending.entry.toolName ? extractHead(parsed.content) : "";
          const hasFailBlock =
            Boolean(pending.entry.toolName) &&
            typeof parsed.content === "string" &&
            RUN_CHECKS_FAIL_BLOCK_RE.test(parsed.content);
          pending.entry.status = status;
          pending.entry.error = error;
          pending.entry.tail = tail;
          pending.entry.passed =
            !isPreToolDenialStep(parsed) &&
            !hasFailBlock &&
            !inferExecutionFailure({ status, error, head, tail });
          if (!pending.entry.passed) {
            ledger.turnFailedExecutionCount += 1;
          }
        } else if (pending.kind === "gate") {
          const verdict = parseGateVerdictFromText(typeof parsed.content === "string" ? parsed.content : "");
          pending.entry.verdict = verdict;
          pending.entry.passed = PASSING_VERDICTS.has(verdict);
        } else if (pending.kind === "audit_subagent") {
          const rawText = typeof parsed.content === "string" ? parsed.content : "";
          pending.entry.tail = extractTail(rawText, AUDIT_TAIL_MAX_CHARS);
          const convId = extractSubagentConversationId(rawText);
          if (convId) {
            pending.entry.conversationId = convId;
          }
          if (isPreToolDenialStep(parsed)) {
            pending.entry.verdict = "ERROR";
          } else {
            const directVerdict = parseAuditVerdictFromText(rawText, { status, error });
            if (directVerdict === "PASS" || directVerdict === "REJECT" || directVerdict === "ERROR") {
              pending.entry.verdict = directVerdict;
            } else if (convId && isAsyncSubagentLaunchAck(rawText)) {
              pending.entry.verdict = "MISSING_VERDICT";
              asyncAuditsByConversationId.set(convId, pending.entry);
            } else {
              pending.entry.verdict = directVerdict;
            }
          }
        }
        return true;
      }

      return true;
    },
    {
      onSkipped(prefixType, isValid) {
        if (prefixType === "GENERIC" && isValid && pendingCalls.length > 0) {
          pendingCalls.shift();
        }
      },
    },
  );

  if (!result.hasContent) {
    return null;
  }
  return ledger;
}

export function readFactLedger(transcriptPath, cwd = "", gitRoot = "") {
  if (typeof transcriptPath !== "string" || transcriptPath.trim().length === 0) {
    return createEmptyLedger(false);
  }
  for (const candidatePath of resolveTranscriptCandidates(transcriptPath.trim())) {
    try {
      const ledger = scanTranscriptToLedger(candidatePath, cwd, gitRoot);
      if (ledger) {
        return ledger;
      }
    } catch {
      continue;
    }
  }
  return createEmptyLedger(false);
}

function countTextFileLinesLightweight(absPath) {
  let fd;
  try {
    fd = openSync(absPath, "r");
    const size = fstatSync(fd).size;
    if (size === 0) {
      return 0;
    }
    const readBytes = Math.min(size, MAX_UNTRACKED_COUNT_BYTES);
    const buf = Buffer.allocUnsafe(readBytes);
    const actual = readSync(fd, buf, 0, readBytes, 0);
    let lines = 0;
    for (let i = 0; i < actual; i += 1) {
      if (buf[i] === 0x00) {
        return 0;
      }
      if (buf[i] === 0x0a) {
        lines += 1;
      }
    }
    if (actual > 0 && buf[actual - 1] !== 0x0a) {
      lines += 1;
    }
    return lines;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}

function parseNumstatOutput(output, gitRoot, diffNumstat) {
  if (typeof output !== "string" || output.length === 0) {
    return;
  }
  for (const line of output.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    const added = /^\d+$/.test(parts[0]) ? Number(parts[0]) : 0;
    const deleted = /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0;
    const rawPath = parts.slice(2).join("\t");
    const relPath = normalizeWorkspacePath(rawPath, gitRoot, gitRoot);
    if (!relPath) {
      continue;
    }
    const prev = diffNumstat.get(relPath);
    if (prev) {
      prev.added += added;
      prev.deleted += deleted;
    } else {
      diffNumstat.set(relPath, { added, deleted });
    }
  }
}

export function readGitLedger(cwd) {
  const empty = {
    gitAvailable: false,
    gitRoot: null,
    gitDirtyFiles: new Set(),
    diffNumstat: new Map(),
    gitBranch: "",
    gitHead: "",
  };
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return empty;
  }
  const deadline = Date.now() + GIT_TIMEOUT_MS;
  const remainingTimeout = () => Math.max(100, deadline - Date.now());
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: remainingTimeout(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!gitRoot) {
      return empty;
    }

    const statusOut = execFileSync("git", ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-uall", "-z"], {
      cwd: gitRoot,
      timeout: remainingTimeout(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const gitDirtyFiles = new Set();
    const untrackedFiles = [];
    const tokens = statusOut.split("\0");
    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i];
      if (entry.length < 4) {
        continue;
      }
      const x = entry[0];
      const y = entry[1];
      const path1 = normalizeWorkspacePath(entry.slice(3), gitRoot, gitRoot);
      if (path1) {
        gitDirtyFiles.add(path1);
        if (x === "?" && y === "?") {
          untrackedFiles.push(path1);
        }
      }
      if (x === "R" || x === "C" || y === "R" || y === "C") {
        i += 1;
        const oldPath = i < tokens.length ? normalizeWorkspacePath(tokens[i], gitRoot, gitRoot) : "";
        if (oldPath) {
          gitDirtyFiles.add(oldPath);
        }
      }
    }

    const diffNumstat = new Map();
    if (Date.now() < deadline) {
      try {
        const numstatOut = execFileSync("git", ["-c", "core.quotepath=false", "diff", "--numstat", "HEAD"], {
          cwd: gitRoot,
          timeout: remainingTimeout(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        parseNumstatOutput(numstatOut, gitRoot, diffNumstat);
      } catch {
        for (const diffArgs of [
          ["-c", "core.quotepath=false", "diff", "--numstat", "--cached"],
          ["-c", "core.quotepath=false", "diff", "--numstat"],
        ]) {
          if (Date.now() >= deadline) {
            break;
          }
          try {
            const out = execFileSync("git", diffArgs, {
              cwd: gitRoot,
              timeout: remainingTimeout(),
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            });
            parseNumstatOutput(out, gitRoot, diffNumstat);
          } catch {
          }
        }
      }
    }

    for (const relPath of untrackedFiles) {
      if (isExemptDocOrAssetPath(relPath) || diffNumstat.has(relPath)) {
        continue;
      }
      const lines = countTextFileLinesLightweight(join(gitRoot, relPath));
      if (lines > 0) {
        diffNumstat.set(relPath, { added: lines, deleted: 0 });
      }
    }

    let gitBranch = "";
    let gitHead = "";
    if (Date.now() < deadline) {
      try {
        gitBranch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
          cwd: gitRoot,
          timeout: remainingTimeout(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        gitBranch = "HEAD";
      }
    }
    if (Date.now() < deadline) {
      try {
        gitHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: gitRoot,
          timeout: remainingTimeout(),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        gitHead = "";
      }
    }

    return { gitAvailable: true, gitRoot, gitDirtyFiles, diffNumstat, gitBranch, gitHead };
  } catch {
    return empty;
  }
}

function scanTestInfraDir(dir, indicators) {
  if (!dir || !existsSync(dir)) {
    return;
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const testScript = typeof pkg?.scripts?.test === "string" ? pkg.scripts.test.trim() : "";
      if (testScript.length > 0 && !/no test specified/i.test(testScript)) {
        indicators.add("package.json:scripts.test");
      }
    } catch {
    }
  }

  for (const testDir of ["test", "tests"]) {
    if (existsSync(join(dir, testDir))) {
      indicators.add(`${testDir}/`);
    }
  }

  for (const exact of TEST_INFRA_EXACT_FILES) {
    if (existsSync(join(dir, exact))) {
      indicators.add(exact);
    }
  }

  try {
    for (const entry of readdirSync(dir)) {
      if (TEST_INFRA_CONFIG_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
        indicators.add(entry);
      }
    }
  } catch {
  }
}

export function detectTestInfrastructure(cwd, gitRoot = null) {
  const indicators = new Set();
  const roots = new Set();
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    roots.add(cwd.trim());
  }
  if (typeof gitRoot === "string" && gitRoot.trim().length > 0) {
    roots.add(gitRoot.trim());
  }
  for (const root of roots) {
    scanTestInfraDir(root, indicators);
  }
  return {
    hasTestSuite: indicators.size > 0,
    indicators: [...indicators],
  };
}
