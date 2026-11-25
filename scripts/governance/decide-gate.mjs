import { ALLOWED_SCHEMA_REGISTERS, PASSING_VERDICTS, REGISTER_COPY } from "./constants.mjs";
import { classifyCommand, normalizeWorkspacePath, splitShellSegments } from "./fact-ledger.mjs";
import { detectHedges } from "./hedge-detector.mjs";

const BARE_RUNTIME_LAUNCHERS = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "python",
  "python3",
  "cargo",
  "go",
  "sh",
  "bash",
  "agy",
  "bun",
  "deno",
]);

function normalizeCommandText(cmd) {
  return typeof cmd === "string" ? cmd.trim().replace(/\s+/g, " ") : "";
}

function isBareRuntimeLauncher(normCmd) {
  return !normCmd.includes(" ") && BARE_RUNTIME_LAUNCHERS.has(normCmd);
}

function extractVerificationSegments(cmd) {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    return [];
  }
  const segments = [];
  for (const seg of splitShellSegments(cmd)) {
    const norm = normalizeCommandText(seg);
    if (norm.length > 0 && classifyCommand(norm) === "verification") {
      segments.push(norm);
    }
  }
  return segments;
}

function segmentResolvedBy(failedSeg, passedSeg) {
  if (failedSeg.length === 0 || passedSeg.length === 0) {
    return false;
  }
  if (failedSeg === passedSeg) {
    return true;
  }
  if (isBareRuntimeLauncher(passedSeg)) {
    return false;
  }
  return failedSeg.startsWith(`${passedSeg} `);
}

function isCommandResolvedBy(failedCmd, passedCmd) {
  const failedNorm = normalizeCommandText(failedCmd);
  const passedNorm = normalizeCommandText(passedCmd);
  if (failedNorm.length === 0 || passedNorm.length === 0) {
    return false;
  }
  if (segmentResolvedBy(failedNorm, passedNorm)) {
    return true;
  }
  const failedSegments = extractVerificationSegments(failedCmd);
  const passedSegments = extractVerificationSegments(passedCmd);
  if (failedSegments.length === 0 || passedSegments.length === 0) {
    return false;
  }
  return failedSegments.every((failedSeg) => passedSegments.some((passedSeg) => segmentResolvedBy(failedSeg, passedSeg)));
}

function extractExecutionVerificationSegments(exec) {
  const candidates =
    Array.isArray(exec?.subCommands) && exec.subCommands.length > 0 ? exec.subCommands : [exec?.command ?? ""];
  const segments = [];
  for (const cmd of candidates) {
    for (const seg of extractVerificationSegments(cmd)) {
      segments.push(seg);
    }
  }
  return segments;
}

function isExecutionResolvedBy(failedExec, passedExec) {
  if (isCommandResolvedBy(failedExec?.command, passedExec?.command)) {
    return true;
  }
  const failedSegments = extractExecutionVerificationSegments(failedExec);
  const passedSegments = extractExecutionVerificationSegments(passedExec);
  if (failedSegments.length > 0 && passedSegments.length > 0) {
    return failedSegments.every((failedSeg) => passedSegments.some((passedSeg) => segmentResolvedBy(failedSeg, passedSeg)));
  }
  const hasSubCommands = Array.isArray(failedExec?.subCommands) && failedExec.subCommands.length > 0;
  return Boolean(
    !hasSubCommands &&
      failedExec?.toolName &&
      passedExec?.toolName &&
      failedExec.toolName === passedExec.toolName &&
      failedSegments.length === 0,
  );
}

function normalizePathList(items, cwd, gitRoot) {
  if (!Array.isArray(items)) {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const normalized = normalizeWorkspacePath(item, cwd, gitRoot);
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

const FILLER_UNVERIFIED_RE =
  /^(?:없음|없습니다|없어요|해당\s*없음|해당\s*사항\s*없음|특이\s*사항\s*없음|누락\s*없음|누락된\s*항목\s*없음|제외\s*항목\s*없음|미검증\s*항목\s*없음|미검증\s*범위\s*없음|별도\s*없음|별도\s*제한\s*없음|추가\s*없음|none|n\/a|na|nil|null|nothing|no\s+gaps|no\s+issues)(?:\s*(?:\([^()]*\)|\[[^[\]]*\]))*[.!?,;:~·\s]*$/i;

export function isFillerUnverifiedEntry(entry) {
  if (typeof entry !== "string") {
    return true;
  }
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return true;
  }
  return FILLER_UNVERIFIED_RE.test(trimmed);
}

function normalizeStringList(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter((item) => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function normalizeVerificationRuns(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      command: typeof item.command === "string" ? item.command.trim() : "",
      outcome: typeof item.outcome === "string" ? item.outcome.trim() : "",
      reason_if_na: typeof item.reason_if_na === "string" ? item.reason_if_na.trim() : "",
    }));
}

function resolveCopy(register) {
  const key = ALLOWED_SCHEMA_REGISTERS.has(register) ? register : "neutral";
  return REGISTER_COPY[key];
}

function buildRuleLine(rule, details, copy) {
  const builder = copy.ruleMessages[rule];
  if (!builder) {
    return "";
  }
  if (rule === "R1_UNREAD_INSPECTED") return builder(details.unreadInspected);
  if (rule === "R2_STALE_VERIFICATION") return builder();
  if (rule === "R3_CONCEALED_FAILURE") return builder(details.failedVerifications);
  if (rule === "R4_UNREPORTED_MODIFIED") return builder(details.unreportedModified);
  if (rule === "R5_FABRICATED_COMMAND") return builder(details.fabricatedCommands);
  if (rule === "R6_PHANTOM_MODIFIED") return builder(details.phantomModified);
  if (rule === "R7_HEDGE_DETECTED") return builder(details.hedgeHits);
  return "";
}

export function formatGateReceipt({ verdict, blockedRules = [], warnedRules = [], details = {}, register = "neutral" }) {
  const copy = resolveCopy(register);
  const header = copy.headers[verdict] ?? copy.headers.REJECT;
  const lines = [header, copy.summaries[verdict] ?? copy.summaries.REJECT];

  if (verdict === "PASS_WITH_DEGRADATION") {
    lines.push(`- ${copy.degradedNotice}`);
    for (const rule of details.degradedFromBlockedRules ?? []) {
      const msg = buildRuleLine(rule, details, copy);
      if (msg) lines.push(`- ${msg}`);
    }
  } else {
    for (const rule of blockedRules) {
      const msg = buildRuleLine(rule, details, copy);
      if (msg) lines.push(`- ${msg}`);
    }
  }

  for (const rule of warnedRules) {
    const msg = buildRuleLine(rule, details, copy);
    if (msg) lines.push(`- 주의: ${msg}`);
  }

  return lines.join("\n");
}

function commandMatchesExecution(normClaim, execCommand) {
  const normExec = normalizeCommandText(execCommand);
  if (normClaim.length === 0 || normExec.length === 0) {
    return false;
  }
  if (normExec === normClaim) {
    return true;
  }
  const allowPrefixMatch = !isBareRuntimeLauncher(normClaim);
  const execSegments = splitShellSegments(execCommand).map(normalizeCommandText).filter(Boolean);
  for (const seg of execSegments) {
    if (seg === normClaim) {
      return true;
    }
    if (allowPrefixMatch && seg.startsWith(`${normClaim} `)) {
      return true;
    }
  }
  return allowPrefixMatch && normExec.startsWith(`${normClaim} `);
}

function mcpToolAliases(toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) {
    return [];
  }
  const aliases = [toolName];
  if (toolName === "mcp_agy-fast_fast_run_checks") {
    aliases.push("fast_run_checks", "run_checks");
  }
  return aliases;
}

function claimMatchesExecution(normClaim, exec) {
  if (normClaim.length === 0 || !exec) {
    return false;
  }
  if (commandMatchesExecution(normClaim, exec.command)) {
    return true;
  }
  if (Array.isArray(exec.subCommands)) {
    for (const subCmd of exec.subCommands) {
      if (commandMatchesExecution(normClaim, subCmd)) {
        return true;
      }
    }
  }
  if (typeof exec.toolName === "string" && exec.toolName.length > 0) {
    for (const alias of mcpToolAliases(exec.toolName)) {
      if (normClaim === alias) {
        return true;
      }
    }
  }
  if (Array.isArray(exec.checkLabels)) {
    for (const label of exec.checkLabels) {
      if (typeof label === "string" && normalizeCommandText(label) === normClaim) {
        return true;
      }
    }
  }
  return false;
}

export function decideGate(input = {}, context = {}) {
  const register = ALLOWED_SCHEMA_REGISTERS.has(context.register) ? context.register : "neutral";
  const cwd = typeof context.cwd === "string" ? context.cwd : "";
  const gitLedger = context.gitLedger ?? { gitAvailable: false, gitRoot: null, gitDirtyFiles: new Set() };
  const gitRoot = typeof gitLedger.gitRoot === "string" ? gitLedger.gitRoot : "";
  const testInfra = context.testInfra ?? { hasTestSuite: false, indicators: [] };

  const details = {
    unreadInspected: [],
    failedVerifications: [],
    unreportedModified: [],
    fabricatedCommands: [],
    phantomModified: [],
    hedgeHits: 0,
    hedgeMatches: [],
    degradedFromBlockedRules: [],
  };

  const rawUnverifiedScope = normalizeStringList(input.unverified_scope);
  const effectiveUnverifiedScope = rawUnverifiedScope.filter((entry) => !isFillerUnverifiedEntry(entry));
  const fillerUnverifiedCount = rawUnverifiedScope.length - effectiveUnverifiedScope.length;

  if (context.sessionMissing) {
    const verdict = "SKIPPED_NO_SESSION";
    const receiptText = formatGateReceipt({ verdict, blockedRules: [], warnedRules: [], details, register });
    return {
      verdict,
      passed: PASSING_VERDICTS.has(verdict),
      blockedRules: [],
      warnedRules: [],
      details,
      receiptText,
      metrics: {
        hedgeHits: 0,
        priorRejects: 0,
        unverifiedScopeCount: effectiveUnverifiedScope.length,
        fillerUnverifiedCount,
      },
    };
  }

  const ledger = context.ledger ?? {
    sessionReadFiles: new Set(),
    turnWrittenFiles: new Set(),
    turnCodeWrittenFiles: new Set(),
    lastWriteStepIndex: -1,
    lastCodeWriteStepIndex: -1,
    turnExecutions: [],
    turnGateAttempts: [],
  };

  const reportedModified = normalizePathList(input.modified_files, cwd, gitRoot);
  const reportedModifiedSet = new Set(reportedModified);
  const reportedInspected = normalizePathList(input.inspected_files, cwd, gitRoot);
  const verificationRuns = normalizeVerificationRuns(input.verification_runs);
  const selfAssessment = typeof input.self_assessment === "string" ? input.self_assessment : "";

  const blockedRules = [];
  const warnedRules = [];

  for (const file of reportedInspected) {
    if (!ledger.sessionReadFiles.has(file)) {
      details.unreadInspected.push(file);
    }
  }
  if (details.unreadInspected.length > 0) {
    blockedRules.push("R1_UNREAD_INSPECTED");
  }

  const hasCodeWrite = ledger.lastCodeWriteStepIndex !== -1;
  const postWriteExecutions = hasCodeWrite
    ? ledger.turnExecutions.filter((exec) => exec.stepIndex > ledger.lastCodeWriteStepIndex)
    : ledger.turnExecutions;
  const postWriteVerifications = hasCodeWrite
    ? postWriteExecutions.filter((exec) => exec.kind === "verification")
    : [];

  if (hasCodeWrite && postWriteVerifications.length === 0) {
    const hasValidNaClaim = verificationRuns.some(
      (run) => run.outcome === "not_applicable" && run.reason_if_na.length > 0,
    );
    if (!testInfra.hasTestSuite && hasValidNaClaim && effectiveUnverifiedScope.length >= 1) {
      warnedRules.push("R2_STALE_VERIFICATION");
    } else {
      blockedRules.push("R2_STALE_VERIFICATION");
    }
  }

  if (hasCodeWrite && postWriteVerifications.length > 0) {
    const unresolvedFailures = [];
    for (let i = 0; i < postWriteVerifications.length; i += 1) {
      const exec = postWriteVerifications[i];
      if (exec.passed) {
        continue;
      }
      let resolvedByLaterPass = false;
      for (let j = i + 1; j < postWriteVerifications.length; j += 1) {
        const later = postWriteVerifications[j];
        if (!later.passed) {
          continue;
        }
        if (isExecutionResolvedBy(exec, later)) {
          resolvedByLaterPass = true;
          break;
        }
      }
      if (!resolvedByLaterPass) {
        unresolvedFailures.push(exec.command || "(검증 명령)");
      }
    }

    const lastVerification = postWriteVerifications[postWriteVerifications.length - 1];
    if (lastVerification && !lastVerification.passed) {
      const lastCmd = lastVerification.command || "(검증 명령)";
      if (!unresolvedFailures.includes(lastCmd)) {
        unresolvedFailures.push(lastCmd);
      }
    }

    if (unresolvedFailures.length > 0) {
      for (const cmd of unresolvedFailures) {
        if (!details.failedVerifications.includes(cmd)) {
          details.failedVerifications.push(cmd);
        }
      }
      blockedRules.push("R3_CONCEALED_FAILURE");
    }
  }

  for (const writtenFile of ledger.turnWrittenFiles) {
    if (gitLedger.gitAvailable && !gitLedger.gitDirtyFiles.has(writtenFile)) {
      continue;
    }
    if (!reportedModifiedSet.has(writtenFile)) {
      details.unreportedModified.push(writtenFile);
    }
  }
  if (details.unreportedModified.length > 0) {
    blockedRules.push("R4_UNREPORTED_MODIFIED");
  }

  for (const run of verificationRuns) {
    if (run.outcome !== "pass") {
      continue;
    }
    const normClaim = normalizeCommandText(run.command);
    const matchingExecs =
      normClaim.length > 0
        ? postWriteExecutions.filter((exec) => exec.kind !== "read_only" && claimMatchesExecution(normClaim, exec))
        : [];
    const matchedPass = matchingExecs.some((exec) => exec.passed === true);
    const coveredByR3Failure =
      hasCodeWrite &&
      blockedRules.includes("R3_CONCEALED_FAILURE") &&
      matchingExecs.some((exec) => exec.kind === "verification" && !exec.passed);
    if (!matchedPass && !coveredByR3Failure) {
      details.fabricatedCommands.push(run.command || "(비어 있는 명령)");
    }
  }
  if (details.fabricatedCommands.length > 0) {
    blockedRules.push("R5_FABRICATED_COMMAND");
  }

  for (const reportedFile of reportedModified) {
    if (!ledger.turnWrittenFiles.has(reportedFile) && !gitLedger.gitDirtyFiles.has(reportedFile)) {
      details.phantomModified.push(reportedFile);
    }
  }
  if (details.phantomModified.length > 0) {
    if (ledger.turnWrittenFiles.size === 0 && gitLedger.gitAvailable) {
      blockedRules.push("R6_PHANTOM_MODIFIED");
    } else {
      warnedRules.push("R6_PHANTOM_MODIFIED");
    }
  }

  const hedge = detectHedges(selfAssessment);
  details.hedgeHits = hedge.hedgeHits;
  details.hedgeMatches = hedge.matches;
  if (hedge.hedgeHits >= 2 && effectiveUnverifiedScope.length === 0) {
    warnedRules.push("R7_HEDGE_DETECTED");
  }

  const priorRejects = ledger.turnGateAttempts.filter((attempt) => attempt.verdict === "REJECT").length;
  const claimsAnyPass = verificationRuns.some((run) => run.outcome === "pass");

  let verdict;
  let finalBlockedRules = blockedRules;
  if (blockedRules.length > 0 && priorRejects >= 3 && effectiveUnverifiedScope.length >= 1 && !claimsAnyPass) {
    verdict = "PASS_WITH_DEGRADATION";
    details.degradedFromBlockedRules = [...blockedRules];
    finalBlockedRules = [];
  } else if (blockedRules.length > 0) {
    verdict = "REJECT";
  } else if (warnedRules.length > 0) {
    verdict = "PASS_WITH_WARNING";
  } else {
    verdict = "PASS";
  }

  const receiptText = formatGateReceipt({
    verdict,
    blockedRules: finalBlockedRules,
    warnedRules,
    details,
    register,
  });

  return {
    verdict,
    passed: PASSING_VERDICTS.has(verdict),
    blockedRules: finalBlockedRules,
    warnedRules,
    details,
    receiptText,
    metrics: {
      hedgeHits: hedge.hedgeHits,
      priorRejects,
      unverifiedScopeCount: effectiveUnverifiedScope.length,
      fillerUnverifiedCount,
    },
  };
}
