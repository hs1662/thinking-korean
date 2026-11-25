#!/usr/bin/env node

import { isDirectExecution, loadHookContext, readTranscriptSteps, runHookCli } from "./hook-io.mjs";
import { decideHookAction } from "./transcript.mjs";

export { readTranscriptSteps };

export function handlePostInvocation(stdinText, readTextFile) {
  const context = loadHookContext(stdinText, "PostInvocation", readTextFile);
  if (!context || context.steps.length === 0) {
    return {};
  }
  const { payload, steps } = context;

  const rawLastUserInput = payload.lastUserInput ?? payload.last_user_input;
  const options = typeof rawLastUserInput === "string" ? { lastUserInput: rawLastUserInput } : {};
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

if (isDirectExecution(import.meta.url)) {
  runHookCli(handlePostInvocation);
}
