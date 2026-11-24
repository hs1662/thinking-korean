#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideHookAction, parseTranscriptJsonl } from "./transcript.mjs";

function defaultReadTextFile(filePath) {
  return readFileSync(filePath, "utf8");
}

function resolveTranscriptCandidates(transcriptPath) {
  if (basename(transcriptPath) === "transcript.jsonl") {
    return [join(dirname(transcriptPath), "transcript_full.jsonl"), transcriptPath];
  }
  return [transcriptPath];
}

function readTranscriptText(transcriptPath, readTextFile) {
  for (const candidatePath of resolveTranscriptCandidates(transcriptPath)) {
    try {
      const content = readTextFile(candidatePath);
      if (typeof content === "string" && content.length > 0) {
        return content;
      }
    } catch {
      continue;
    }
  }
  return "";
}

export function handlePostInvocation(stdinText, readTextFile = defaultReadTextFile) {
  if (typeof stdinText !== "string" || stdinText.trim().length === 0) {
    return {};
  }

  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return {};
  }

  const transcriptPath = payload && typeof payload === "object" ? payload.transcriptPath : "";
  if (typeof transcriptPath !== "string" || transcriptPath.trim().length === 0) {
    return {};
  }

  const rawTranscript = readTranscriptText(transcriptPath, readTextFile);
  if (rawTranscript.length === 0) {
    return {};
  }

  const steps = parseTranscriptJsonl(rawTranscript);
  const decision = decideHookAction(steps);
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
    const output = handlePostInvocation(stdinText);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.stdout.write("{}\n");
  }
}

if (isDirectExecution()) {
  runCli();
}
