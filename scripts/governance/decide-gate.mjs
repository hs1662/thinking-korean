import { ALLOWED_SCHEMA_REGISTERS, PASSING_VERDICTS, REGISTER_COPY } from "./constants.mjs";
import { normalizeWorkspacePath } from "./fact-ledger.mjs";
import { detectHedges } from "./hedge-detector.mjs";

function normalizeCommandText(cmd) {
  return typeof cmd === "string" ? cmd.trim().replace(/\s+/g, " ") : "";
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
  return normExec.includes(normClaim) || normClaim.includes(normExec);
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
      metrics: { hedgeHits: 0, priorRejects: 0 },
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
  const unverifiedScope = normalizeStringList(input.unverified_scope);
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
    if (!testInfra.hasTestSuite && hasValidNaClaim && unverifiedScope.length >= 1) {
      warnedRules.push("R2_STALE_VERIFICATION");
    } else {
      blockedRules.push("R2_STALE_VERIFICATION");
    }
  }

  if (hasCodeWrite && postWriteVerifications.length > 0) {
    const lastVerification = postWriteVerifications[postWriteVerifications.length - 1];
    if (!lastVerification.passed) {
      if (lastVerification.command) {
        details.failedVerifications.push(lastVerification.command);
      }
      blockedRules.push("R3_CONCEALED_FAILURE");
    } else {
      const claimsAnyPass = verificationRuns.some((run) => run.outcome === "pass");
      if (claimsAnyPass) {
        for (const run of verificationRuns) {
          if (run.outcome !== "pass") continue;
          const normClaim = normalizeCommandText(run.command);
          const matchedExecs = postWriteVerifications.filter((exec) => commandMatchesExecution(normClaim, exec.command));
          if (matchedExecs.length > 0 && !matchedExecs[matchedExecs.length - 1].passed) {
            details.failedVerifications.push(matchedExecs[matchedExecs.length - 1].command);
          }
        }
        if (details.failedVerifications.length > 0) {
          blockedRules.push("R3_CONCEALED_FAILURE");
        }
      }
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
    const matched =
      normClaim.length > 0 && postWriteExecutions.some((exec) => commandMatchesExecution(normClaim, exec.command));
    if (!matched) {
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
  if (hedge.hedgeHits >= 2 && unverifiedScope.length === 0) {
    warnedRules.push("R7_HEDGE_DETECTED");
  }

  const priorRejects = ledger.turnGateAttempts.filter((attempt) => attempt.verdict === "REJECT").length;
  const claimsAnyPass = verificationRuns.some((run) => run.outcome === "pass");

  let verdict;
  let finalBlockedRules = blockedRules;
  if (blockedRules.length > 0 && priorRejects >= 3 && unverifiedScope.length >= 1 && !claimsAnyPass) {
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
    },
  };
}
