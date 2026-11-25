#!/usr/bin/env node

import { isDirectExecution, loadHookContext, runHookCli } from "./hook-io.mjs";
import { decideStopAction } from "./transcript.mjs";

export function handleStop(stdinText, readTextFile) {
  const context = loadHookContext(stdinText, "Stop", readTextFile);
  if (!context || context.steps.length === 0) {
    return {};
  }
  const { payload, steps } = context;

  const rawTerminationReason = payload.terminationReason ?? payload.termination_reason;
  const decision = decideStopAction(steps, {
    lastUserInput: payload.lastUserInput ?? payload.last_user_input,
    continuationActive: (payload.continuationActive ?? payload.continuation_active) === true,
    terminationReason: typeof rawTerminationReason === "string" ? rawTerminationReason.trim() : "",
  });

  if (decision.action !== "continue") {
    return {};
  }

  if (decision.reasonMessage) {
    return {
      decision: "continue",
      reason: decision.reasonMessage,
    };
  }

  return {
    decision: "continue",
  };
}

if (isDirectExecution(import.meta.url)) {
  runHookCli(handleStop);
}
