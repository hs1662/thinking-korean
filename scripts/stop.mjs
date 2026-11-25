#!/usr/bin/env node

import { isDirectExecution, loadHookContext, runHookCli } from "./hook-io.mjs";
import { decideStopAction } from "./transcript.mjs";

export function handleStop(stdinText, readTextFile) {
  const context = loadHookContext(stdinText, "Stop", readTextFile);
  if (!context || context.steps.length === 0) {
    return {};
  }
  const { payload, steps } = context;

  const decision = decideStopAction(steps, {
    lastUserInput: payload.lastUserInput,
    continuationActive: payload.continuationActive === true,
    terminationReason:
      typeof payload.terminationReason === "string" ? payload.terminationReason.trim() : "",
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
