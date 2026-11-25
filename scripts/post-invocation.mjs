#!/usr/bin/env node

import { appendAuditRecord, readGovernanceConfig } from "./governance/audit-log.mjs";
import { AUDITOR_SESSION_MARKER, DEFAULT_POLLUTION_THRESHOLDS } from "./governance/constants.mjs";
import { readFactLedger, readLatestTranscriptTokens } from "./governance/fact-ledger.mjs";
import { updateSessionPollutionState } from "./governance/handoff-store.mjs";
import { isDirectExecution, loadHookContext, readTranscriptSteps, runHookCli } from "./hook-io.mjs";
import { decideHookAction } from "./transcript.mjs";

export { readTranscriptSteps };

function isAuditorSessionSteps(steps) {
  for (const step of steps) {
    if (step?.type === "USER_INPUT") {
      return typeof step.content === "string" && step.content.includes(AUDITOR_SESSION_MARKER);
    }
  }
  return false;
}

function tryUpdateSessionPollution(context, tokens) {
  try {
    const { payload, transcriptPath, steps } = context;
    if (isAuditorSessionSteps(steps)) {
      return null;
    }
    const rawConversationId = payload.conversationId ?? payload.conversation_id;
    const conversationId = typeof rawConversationId === "string" ? rawConversationId.trim() : "";
    if (!conversationId) {
      return null;
    }
    const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";
    const ledger = transcriptPath ? readFactLedger(transcriptPath, cwd, "") : null;
    if (ledger?.sessionRole === "auditor") {
      return null;
    }
    let maxSingleFileEdits = 0;
    if (ledger?.fileEditCounts instanceof Map) {
      for (const count of ledger.fileEditCounts.values()) {
        if (count > maxSingleFileEdits) {
          maxSingleFileEdits = count;
        }
      }
    }
    const cfg = readGovernanceConfig();
    const thresholds = {
      ...DEFAULT_POLLUTION_THRESHOLDS,
      ...(cfg?.pollutionThresholds && typeof cfg.pollutionThresholds === "object" ? cfg.pollutionThresholds : {}),
    };
    return updateSessionPollutionState({
      conversationId,
      inputTokens: tokens.inputTokens ?? ledger?.latestTokens?.inputTokens ?? null,
      failedExecutionsInTurn: ledger?.turnFailedExecutionCount ?? 0,
      maxSingleFileEdits,
      thresholds,
    });
  } catch {
    return null;
  }
}

function tryLogPostInvocationTelemetry(context, decision) {
  try {
    const { payload, transcriptPath, steps } = context;
    const rawConversationId = payload.conversationId ?? payload.conversation_id;
    const conversationId = typeof rawConversationId === "string" ? rawConversationId.trim() : "";
    const latestStep = steps[steps.length - 1];
    const tokens = transcriptPath
      ? readLatestTranscriptTokens(transcriptPath)
      : { inputTokens: null, cacheReadTokens: null, outputTokens: null };
    const pollutionState = tryUpdateSessionPollution(context, tokens);
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
