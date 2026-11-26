#!/usr/bin/env node

import { appendAuditRecord, readGovernanceConfig } from "./governance/audit-log.mjs";
import { DEFAULT_POLLUTION_THRESHOLDS } from "./governance/constants.mjs";
import { detectSessionRoleFromHeaderSteps, readFactLedger } from "./governance/fact-ledger.mjs";
import { markPreflightChallengeLogged, updateSessionPollutionState } from "./governance/handoff-store.mjs";
import { isDirectExecution, loadHookContext, readTranscriptSteps, runHookCli } from "./hook-io.mjs";
import { decideHookAction } from "./transcript.mjs";

export { readTranscriptSteps };

function tryLogCompletedPreflightChallenges(conversationId, ledger) {
  if (!ledger?.transcriptAvailable || ledger.sessionRole !== "main") {
    return;
  }
  const challenges = Array.isArray(ledger.turnPreflightChallenges) ? ledger.turnPreflightChallenges : [];
  const completed = challenges.filter(
    (entry) => typeof entry?.completedStepIndex === "number" && entry.completedStepIndex >= 0,
  );
  if (completed.length === 0) {
    return;
  }
  const turnUserVotes = Array.isArray(ledger.turnUserVotes) ? ledger.turnUserVotes : [];
  const codeWritten = ledger.turnCodeWrittenFiles.size > 0;

  for (const challenge of completed) {
    const voted = turnUserVotes.some(
      (vote) =>
        vote &&
        vote.answered === true &&
        vote.errored !== true &&
        typeof vote.completedStepIndex === "number" &&
        vote.completedStepIndex > challenge.completedStepIndex,
    );
    const launchIdx =
      typeof challenge.launchedStepIndex === "number" ? challenge.launchedStepIndex : challenge.completedStepIndex;
    const slotIdx = typeof challenge.slotIndex === "number" ? challenge.slotIndex : 0;
    const votePhase = voted ? "voted" : "unvoted";
    const shouldLog =
      !conversationId ||
      markPreflightChallengeLogged({
        conversationId,
        dedupKey: `${conversationId}:${ledger.turnStartStepIndex}:${launchIdx}:${slotIdx}:${votePhase}`,
      });
    if (!shouldLog) {
      continue;
    }
    appendAuditRecord({
      ts: new Date().toISOString(),
      event: "preflight_complete",
      eventType: "preflight_complete",
      conversationId,
      turnStartStepIndex: ledger.turnStartStepIndex,
      verdict: challenge.verdict,
      voted,
      codeWritten,
      challengeStepIndex: challenge.completedStepIndex,
    });
  }
}

function tryLogPostInvocationTelemetry(context, decision) {
  try {
    const { payload, transcriptPath, steps } = context;
    const rawConversationId = payload.conversationId ?? payload.conversation_id;
    const conversationId = typeof rawConversationId === "string" ? rawConversationId.trim() : "";
    const latestStep = steps[steps.length - 1];
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const ledger = transcriptPath ? readFactLedger(transcriptPath, cwd, "") : null;
    const sessionRole = ledger?.transcriptAvailable ? ledger.sessionRole : detectSessionRoleFromHeaderSteps(steps);
    const tokens = ledger?.latestTokens ?? { inputTokens: null, cacheReadTokens: null, outputTokens: null };

    let pollutionState = null;
    if (sessionRole !== "auditor" && sessionRole !== "challenger" && conversationId) {
      const cfg = readGovernanceConfig();
      const thresholds = {
        ...DEFAULT_POLLUTION_THRESHOLDS,
        ...(cfg?.pollutionThresholds && typeof cfg.pollutionThresholds === "object" ? cfg.pollutionThresholds : {}),
      };
      pollutionState = updateSessionPollutionState({
        conversationId,
        turnStartStepIndex: ledger?.turnStartStepIndex ?? 0,
        inputTokens: tokens.inputTokens,
        failedExecutionsInTurn: ledger?.turnFailedExecutionCount ?? 0,
        maxSingleFileEdits: ledger?.maxSingleFileEdits ?? 0,
        thresholds,
      });
    }

    if (sessionRole === "main" && ledger) {
      tryLogCompletedPreflightChallenges(conversationId, ledger);
    }

    appendAuditRecord({
      ts: new Date().toISOString(),
      event: "post_invocation",
      conversationId,
      stepCount: steps.length,
      latestStepIndex: typeof latestStep?.stepIndex === "number" ? latestStep.stepIndex : null,
      langAction: decision.action,
      langReason: decision.reason ?? (decision.action === "inject" ? "drifted" : "ok"),
      driftedFields: Array.isArray(decision.driftedFields) ? decision.driftedFields : [],
      pollutionAlert: Boolean(pollutionState?.pollutionAlert),
      metrics: {
        inputTokens: tokens.inputTokens,
        cacheReadTokens: tokens.cacheReadTokens,
        outputTokens: tokens.outputTokens,
      },
    });
  } catch {
  }
}

export function handlePostInvocation(stdinText, readTextFile) {
  const context = loadHookContext(stdinText, "PostInvocation", readTextFile);
  if (!context || context.steps.length === 0) {
    return {};
  }
  const { payload, steps } = context;

  const rawLastUserInput = payload.lastUserInput ?? payload.last_user_input;
  const options = typeof rawLastUserInput === "string" ? { lastUserInput: rawLastUserInput } : {};
  const decision = decideHookAction(steps, options);

  if (typeof readTextFile !== "function") {
    tryLogPostInvocationTelemetry(context, decision);
  }

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

if (isDirectExecution(import.meta.url)) {
  runHookCli(handlePostInvocation);
}
