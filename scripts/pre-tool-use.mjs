#!/usr/bin/env node

import { isDirectExecution, loadHookContext, runHookCli } from "./hook-io.mjs";
import { decidePreToolUseAction } from "./transcript.mjs";

export function handlePreToolUse(stdinText, readTextFile) {
  const context = loadHookContext(stdinText, "PreToolUse", readTextFile);
  const toolCall = context?.payload.toolCall ?? context?.payload.tool_call;
  if (!context || !toolCall || typeof toolCall !== "object") {
    return { decision: "allow" };
  }

  // Without readable transcript steps the per-turn retry cap cannot be enforced, so fail open.
  const options = context.steps.length === 0 ? { transcriptAvailable: false } : {};
  const decision = decidePreToolUseAction(toolCall, context.steps, options);
  if (decision.action !== "deny") {
    return { decision: "allow" };
  }

  return {
    decision: "deny",
    reason: decision.message,
  };
}

if (isDirectExecution(import.meta.url)) {
  runHookCli(handlePreToolUse, { decision: "allow" });
}
