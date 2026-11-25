// Shared fixtures for the domain test files (node --test runs each file in its own process).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

import { PRE_TOOL_DENIAL_NEEDLE } from "../scripts/transcript.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = resolve(TEST_DIR, "..");
export const HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "post-invocation.mjs");
export const STOP_HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "stop.mjs");
export const PRE_TOOL_HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "pre-tool-use.mjs");
export const RULES_PATH = join(PLUGIN_ROOT, "rules", "AGENTS.md");
export const HOOKS_JSON_PATH = join(PLUGIN_ROOT, "hooks.json");

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export function createTempDir(prefix = "thinking-korean-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function makeStep(stepIndex, type, { thinking = "", content = "", toolCalls = [] } = {}) {
  return { stepIndex, type, thinking, content, toolCalls };
}

// GENERIC step the runtime records when the PreToolUse hook denies a tool call.
export function makeDenialStep(stepIndex, reason = "작업 단계 제목을 한국어로 바꿔라") {
  return { stepIndex, type: "GENERIC", thinking: "", content: `${PRE_TOOL_DENIAL_NEEDLE}: ${reason}`, error: "", toolCalls: [] };
}

export function toJsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function wrapAntigravityHookMessage(message, hookName = "PostInvocation") {
  return [
    "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.",
    "",
    "<SYSTEM_MESSAGE>",
    `The following system message was injected by a ${hookName} hook:`,
    message,
    "</SYSTEM_MESSAGE>",
  ].join("\n");
}

export function runHookSubprocess(scriptPath, input, { nodeArgs = [], ...spawnOptions } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, scriptPath], {
    cwd: PLUGIN_ROOT,
    input,
    encoding: "utf8",
    ...spawnOptions,
  });
}
