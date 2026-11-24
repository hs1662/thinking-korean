#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTranscriptSteps } from "./post-invocation.mjs";
import { decideStopAction } from "./transcript.mjs";

export function handleStop(stdinText, readTextFile) {
  if (typeof stdinText !== "string" || stdinText.trim().length === 0) {
    return {};
  }

  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return {};
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  const hookEventName = payload.hookEventName;
  if (
    hookEventName !== undefined &&
    hookEventName !== null &&
    hookEventName !== "" &&
    hookEventName !== "Stop"
  ) {
    return {};
  }

  const rawTranscriptPath = payload.transcriptPath;
  const transcriptPath = typeof rawTranscriptPath === "string" ? rawTranscriptPath.trim() : "";
  if (transcriptPath.length === 0) {
    return {};
  }

  const steps = readTranscriptSteps(transcriptPath, readTextFile);
  if (steps.length === 0) {
    return {};
  }

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

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  }
}

async function runCli() {
  try {
    process.stdin.setEncoding("utf8");
    let stdinText = "";
    for await (const chunk of process.stdin) {
      stdinText += chunk;
    }
    const output = handleStop(stdinText);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
}

if (isDirectExecution()) {
  runCli();
}
