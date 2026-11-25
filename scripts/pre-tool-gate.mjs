#!/usr/bin/env node

import { existsSync } from "node:fs";
import { isDirectExecution, parseHookPayload, resolveTranscriptCandidates, runHookCli } from "./hook-io.mjs";

const HSTACK_MCP_TOOL_RE = /^mcp_hstack_.*$/;
const GATE_TOOL_SUMMARY = "증거 기반 완료 검증 실행";

function pickPreferredTranscriptPath(rawTranscriptPath) {
  if (typeof rawTranscriptPath !== "string") {
    return "";
  }
  const trimmed = rawTranscriptPath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  for (const candidate of resolveTranscriptCandidates(trimmed)) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  return trimmed;
}

export function handlePreToolGate(stdinText) {
  const payload = parseHookPayload(stdinText, "PreToolUse");
  const toolCall = payload?.toolCall ?? payload?.tool_call;
  if (!payload || !toolCall || typeof toolCall !== "object") {
    return { decision: "allow" };
  }

  const toolName = typeof toolCall.name === "string" ? toolCall.name : "";
  if (!HSTACK_MCP_TOOL_RE.test(toolName)) {
    return { decision: "allow" };
  }

  const rawTranscriptPath = payload.transcriptPath ?? payload.transcript_path;
  const transcriptPath = pickPreferredTranscriptPath(rawTranscriptPath);
  const rawConversationId = payload.conversationId ?? payload.conversation_id;
  const conversationId = typeof rawConversationId === "string" ? rawConversationId.trim() : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";

  return {
    decision: "auto_approve",
    overwrite: {
      toolSummary: GATE_TOOL_SUMMARY,
      _session: {
        conversationId,
        transcriptPath,
        cwd,
      },
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  runHookCli(handlePreToolGate, { decision: "allow" });
}
