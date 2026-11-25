#!/usr/bin/env node

import { appendAuditRecord } from "./governance/audit-log.mjs";
import { readLatestTranscriptTokens } from "./governance/fact-ledger.mjs";
import { isDirectExecution, loadHookContext, readTranscriptSteps, runHookCli } from "./hook-io.mjs";
import { decideHookAction } from "./transcript.mjs";

export { readTranscriptSteps };

function tryLogPostInvocationTelemetry(context, decision) {
  try {
    const { payload, transcriptPath, steps } = context;
    const rawConversationId = payload.conversationId ?? payload.conversation_id;
    const conversationId = typeof rawConversationId === "string" ? rawConversationId.trim() : "";
    const latestStep = steps[steps.length - 1];
    const tokens = transcriptPath ? readLatestTranscriptTokens(transcriptPath) : { inputTokens: null, cacheReadTokens: null, outputTokens: null };
    appendAuditRecord({
      ts: new Date().toISOString(),
      event: "post_invocation",
      conversationId,
      stepCount: steps.length,
      latestStepIndex: typeof latestStep?.stepIndex === "number" ? latestStep.stepIndex : null,
      langAction: decision.action,
      langReason: decision.reason ?? (decision.action === "inject" ? "drifted" : "ok"),
      driftedFields: Array.isArray(decision.driftedFields) ? decision.driftedFields : [],
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
