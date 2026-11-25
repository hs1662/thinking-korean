import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { resolveTranscriptCandidates, streamTranscriptRecords } from "../hook-io.mjs";
import { getToolCalls, isPreToolDenialStep, parseRawRecord, parseStepIndex } from "../transcript/steps.mjs";
import {
  CREATE_AS_READ_TOOL_NAMES,
  EXEC_TOOL_NAMES,
  GATE_BLOCK_MARKER,
  GATE_TOOL_NAME,
  PASSING_VERDICTS,
  READ_ONLY_BINARIES,
  READ_ONLY_GIT_SUBCOMMANDS,
  READ_TOOL_NAMES,
  VERDICT_HEADERS,
  VERIFICATION_BINARIES,
  WRITE_TOOL_NAMES,
  isExemptDocOrAssetPath,
} from "./constants.mjs";

const RESULT_TAIL_MAX_CHARS = 2048;
const GIT_TIMEOUT_MS = 1500;
const MAX_UNWRAP_DEPTH = 2;

const SHELL_WRAPPERS = new Set(["sudo", "time", "env", "command", "nohup"]);
const SHELL_NEUTRAL_BUILTINS = new Set(["cd", "export", "set", "unset", "true", "false", "sleep", "umask"]);
const GIT_FLAGS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

const FAILURE_PATTERNS = [
  /exit\s+code[:\s]+[1-9]\d*/i,
  /Command failed/i,
  /AssertionError/,
  /^\s*FAIL\b/m,
  /fail\s+[1-9]\d*/i,
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

export function normalizeWorkspacePath(rawPath, cwd = "", gitRoot = "") {
  if (typeof rawPath !== "string") {
    return "";
  }
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  let normalized = posix.normalize(toPosix(trimmed));
  if (isAbsolutePosix(normalized)) {
    const rel = relativizeAgainstBase(normalized, gitRoot) ?? relativizeAgainstBase(normalized, cwd);
    if (rel !== null) {
      normalized = rel;
    }
  } else if (cwd && gitRoot) {
    const cwdRel = relativizeAgainstBase(stripTrailingSlashes(posix.normalize(toPosix(cwd.trim()))), gitRoot);
    if (cwdRel && cwdRel !== "." && !normalized.startsWith("../")) {
      normalized = posix.normalize(`${cwdRel}/${normalized}`);
    }
  }
  normalized = normalized.replace(/^\.\//, "");
  return stripTrailingSlashes(normalized);
}

function splitShellSegments(commandLine) {
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

function classifySingleSegment(segment) {
  const cleaned = segment.trim().replace(/^[(!\s]+/, "");
  if (cleaned.length === 0) {
    return "empty";
  }
  const tokens = tokenizeSegment(cleaned);
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === "!" || tok === "(" || ENV_ASSIGN_RE.test(tok) || SHELL_WRAPPERS.has(tok)) {
      idx += 1;
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
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
      return "read_only";
    }
    return "other";
  }

  if (READ_ONLY_BINARIES.has(baseBin) || SHELL_NEUTRAL_BUILTINS.has(baseBin)) {
    return "read_only";
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
  const tail = typeof result.tail === "string" ? result.tail : typeof result.content === "string" ? result.content : "";
  if (tail.length === 0) {
    return false;
  }
  return FAILURE_PATTERNS.some((pattern) => pattern.test(tail));
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

function extractTail(content) {
  if (typeof content !== "string") {
    return "";
  }
  return content.length <= RESULT_TAIL_MAX_CHARS ? content : content.slice(-RESULT_TAIL_MAX_CHARS);
}

function parseGateVerdictFromText(text) {
  if (typeof text !== "string" || text.length === 0) {
    return "UNKNOWN";
  }
  if (text.includes(VERDICT_HEADERS.PASS_WITH_DEGRADATION)) {
    return "PASS_WITH_DEGRADATION";
  }
  if (text.includes(VERDICT_HEADERS.PASS_WITH_WARNING)) {
    return "PASS_WITH_WARNING";
  }
  if (text.includes(VERDICT_HEADERS.PASS)) {
    return "PASS";
  }
  if (text.includes(VERDICT_HEADERS.SKIPPED_NO_SESSION)) {
    return "SKIPPED_NO_SESSION";
  }
  if (text.includes(VERDICT_HEADERS.REJECT_NEUTRAL) || text.includes(VERDICT_HEADERS.REJECT_AUDIT)) {
    return "REJECT";
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
    sessionReadFiles: new Set(),
    turnStartStepIndex: 0,
    turnWrittenFiles: new Set(),
    turnCodeWrittenFiles: new Set(),
    lastWriteStepIndex: -1,
    lastCodeWriteStepIndex: -1,
    turnExecutions: [],
    turnGateAttempts: [],
    latestTokens: { inputTokens: null, cacheReadTokens: null, outputTokens: null },
    gateBlockedThisTurn: false,
  };
}

function scanTranscriptToLedger(filePath, cwd, gitRoot) {
  const ledger = createEmptyLedger(true);
  let pendingCalls = [];

  const resetTurn = (stepIndex) => {
    ledger.turnStartStepIndex = stepIndex;
    ledger.turnWrittenFiles = new Set();
    ledger.turnCodeWrittenFiles = new Set();
    ledger.lastWriteStepIndex = -1;
    ledger.lastCodeWriteStepIndex = -1;
    ledger.turnExecutions = [];
    ledger.turnGateAttempts = [];
    ledger.gateBlockedThisTurn = false;
    pendingCalls = [];
  };

  const peekNeedsGeneric = () => {
    const nextPending = pendingCalls[0];
    return Boolean(nextPending && (nextPending.kind === "exec" || nextPending.kind === "gate"));
  };

  const result = streamTranscriptRecords(filePath, (prefixType, lineBuf, recordIndex) => {
    if (lineBuf === null) {
      if (prefixType === "USER_INPUT" || prefixType === "PLANNER_RESPONSE" || prefixType === "SYSTEM_MESSAGE" || prefixType === null) {
        return true;
      }
      if (prefixType === "GENERIC") {
        if (peekNeedsGeneric()) {
          return true;
        }
        if (pendingCalls.length > 0) {
          pendingCalls.shift();
        }
        return false;
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
      resetTurn(stepIndex);
      return true;
    }

    if (parsed.type === "SYSTEM_MESSAGE") {
      if (typeof parsed.content === "string" && parsed.content.includes(GATE_BLOCK_MARKER)) {
        ledger.gateBlockedThisTurn = true;
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
        } else if (name === GATE_TOOL_NAME) {
          const entry = {
            stepIndex,
            verdict: "UNKNOWN",
            passed: false,
            blockedRules: [],
            rawTail: "",
          };
          ledger.turnGateAttempts.push(entry);
          pendingCalls.push({ kind: "gate", entry });
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
      const tail = extractTail(parsed.content);

      if (pending.kind === "exec") {
        pending.entry.status = status;
        pending.entry.error = error;
        pending.entry.tail = tail;
        pending.entry.passed = !isPreToolDenialStep(parsed) && !inferExecutionFailure({ status, error, tail });
      } else if (pending.kind === "gate") {
        const verdict = parseGateVerdictFromText(tail);
        pending.entry.verdict = verdict;
        pending.entry.passed = PASSING_VERDICTS.has(verdict);
        pending.entry.rawTail = tail;
      }
      return true;
    }

    return true;
  });

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

function unquoteGitPath(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function readGitLedger(cwd) {
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    return { gitAvailable: false, gitRoot: null, gitDirtyFiles: new Set() };
  }
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!gitRoot) {
      return { gitAvailable: false, gitRoot: null, gitDirtyFiles: new Set() };
    }

    const statusOut = execFileSync("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: gitRoot,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const gitDirtyFiles = new Set();
    for (const rawLine of statusOut.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.length < 4) {
        continue;
      }
      const payload = line.slice(3);
      const renameSep = payload.indexOf(" -> ");
      if (renameSep !== -1) {
        const oldPath = normalizeWorkspacePath(unquoteGitPath(payload.slice(0, renameSep)), gitRoot, gitRoot);
        const newPath = normalizeWorkspacePath(unquoteGitPath(payload.slice(renameSep + 4)), gitRoot, gitRoot);
        if (oldPath) gitDirtyFiles.add(oldPath);
        if (newPath) gitDirtyFiles.add(newPath);
      } else {
        const filePath = normalizeWorkspacePath(unquoteGitPath(payload), gitRoot, gitRoot);
        if (filePath) gitDirtyFiles.add(filePath);
      }
    }

    return { gitAvailable: true, gitRoot, gitDirtyFiles };
  } catch {
    return { gitAvailable: false, gitRoot: null, gitDirtyFiles: new Set() };
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
      // ignore malformed package.json
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
    // ignore unreadable directory
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
