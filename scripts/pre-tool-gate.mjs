#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  AUDITOR_AGENT_NAME,
  AUDITOR_ROLE_LABEL,
  AUDITOR_SESSION_MARKER,
  HANDOFF_TOOL_NAME,
  SUBAGENT_TOOL_NAME,
  WORKER_AGENT_NAME,
  WORKER_ROLE_LABEL,
  WORKER_SESSION_MARKER,
} from "./governance/constants.mjs";
import { readFactLedger } from "./governance/fact-ledger.mjs";
import { isDirectExecution, parseHookPayload, resolveTranscriptCandidates, runHookCli } from "./hook-io.mjs";

const HSTACK_MCP_TOOL_RE = /^mcp_hstack_.*$/;
const GATE_TOOL_SUMMARY = "증거 기반 완료 검증 실행";
const HANDOFF_TOOL_SUMMARY = "팩트 증류 컨텍스트 핸드오프 처리";

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

function classifyManagedAgent(rawTypeName) {
  if (typeof rawTypeName !== "string") {
    return null;
  }
  const normalized = rawTypeName.trim();
  if (normalized === AUDITOR_AGENT_NAME || normalized === `hstack:${AUDITOR_AGENT_NAME}`) {
    return "auditor";
  }
  if (normalized === WORKER_AGENT_NAME || normalized === `hstack:${WORKER_AGENT_NAME}`) {
    return "worker";
  }
  return null;
}

function appendContextBlock(promptText, lines) {
  const base = typeof promptText === "string" ? promptText.trimEnd() : "";
  const block = lines.join("\n");
  if (base.length === 0) {
    return block;
  }
  return `${base}\n\n${block}`;
}

function buildInjectedPrompt(kind, existingPrompt, { cwd, transcriptPath, turnStartStepIndex }) {
  const safePrompt = typeof existingPrompt === "string" ? existingPrompt : "";
  if (kind === "auditor") {
    if (safePrompt.includes(AUDITOR_SESSION_MARKER)) {
      return safePrompt;
    }
    const lines = [AUDITOR_SESSION_MARKER];
    if (cwd) lines.push(`작업 경로: \`${cwd}\``);
    if (transcriptPath) lines.push(`세션 기록 경로: \`${transcriptPath}\``);
    if (typeof turnStartStepIndex === "number" && Number.isFinite(turnStartStepIndex)) {
      lines.push(`현재 턴 시작 스텝: \`${turnStartStepIndex}\``);
    }
    return appendContextBlock(safePrompt, lines);
  }
  if (safePrompt.includes(WORKER_SESSION_MARKER)) {
    return safePrompt;
  }
  const lines = [WORKER_SESSION_MARKER];
  if (cwd) lines.push(`작업 경로: \`${cwd}\``);
  return appendContextBlock(safePrompt, lines);
}

function resolveTurnStartStepIndex(transcriptPath, cwd) {
  if (!transcriptPath) {
    return 0;
  }
  try {
    const ledger = readFactLedger(transcriptPath, cwd, "");
    return ledger.transcriptAvailable ? ledger.turnStartStepIndex : 0;
  } catch {
    return 0;
  }
}

function handleSubagentPreTool(toolCall, { cwd, transcriptPath }) {
  const args = toolCall.args && typeof toolCall.args === "object" && !Array.isArray(toolCall.args) ? toolCall.args : null;
  if (!args) {
    return { decision: "allow" };
  }

  let turnStartCache = null;
  const getTurnStart = () => {
    if (turnStartCache === null) {
      turnStartCache = resolveTurnStartStepIndex(transcriptPath, cwd);
    }
    return turnStartCache;
  };

  if (Array.isArray(args.Subagents)) {
    let matchedAny = false;
    const rewritten = args.Subagents.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const kind = classifyManagedAgent(entry.TypeName ?? entry.typeName ?? entry.type_name);
      if (!kind) {
        return entry;
      }
      matchedAny = true;
      const roleLabel = kind === "auditor" ? AUDITOR_ROLE_LABEL : WORKER_ROLE_LABEL;
      const promptKey = "Prompt" in entry || !("prompt" in entry) ? "Prompt" : "prompt";
      const roleKey = "Role" in entry || !("role" in entry) ? "Role" : "role";
      return {
        ...entry,
        [roleKey]: roleLabel,
        [promptKey]: buildInjectedPrompt(kind, entry[promptKey], {
          cwd,
          transcriptPath,
          turnStartStepIndex: kind === "auditor" ? getTurnStart() : null,
        }),
      };
    });

    if (!matchedAny) {
      return { decision: "allow" };
    }
    return {
      decision: "allow",
      overwrite: {
        Subagents: rewritten,
      },
    };
  }

  const kind = classifyManagedAgent(args.TypeName ?? args.typeName ?? args.type_name);
  if (!kind) {
    return { decision: "allow" };
  }

  const roleLabel = kind === "auditor" ? AUDITOR_ROLE_LABEL : WORKER_ROLE_LABEL;
  const existingPrompt = typeof args.Prompt === "string" ? args.Prompt : typeof args.prompt === "string" ? args.prompt : "";
  const injectedPrompt = buildInjectedPrompt(kind, existingPrompt, {
    cwd,
    transcriptPath,
    turnStartStepIndex: kind === "auditor" ? getTurnStart() : null,
  });

  return {
    decision: "allow",
    overwrite: {
      Role: roleLabel,
      Prompt: injectedPrompt,
    },
  };
}

export function handlePreToolGate(stdinText) {
  const payload = parseHookPayload(stdinText, "PreToolUse");
  const toolCall = payload?.toolCall ?? payload?.tool_call;
  if (!payload || !toolCall || typeof toolCall !== "object") {
    return { decision: "allow" };
  }

  const toolName = typeof toolCall.name === "string" ? toolCall.name : "";
  const rawTranscriptPath = payload.transcriptPath ?? payload.transcript_path;
  const transcriptPath = pickPreferredTranscriptPath(rawTranscriptPath);
  const rawConversationId = payload.conversationId ?? payload.conversation_id;
  const conversationId = typeof rawConversationId === "string" ? rawConversationId.trim() : "";
  const cwd = typeof payload.cwd === "string" ? payload.cwd.trim() : "";

  if (toolName === SUBAGENT_TOOL_NAME) {
    return handleSubagentPreTool(toolCall, { cwd, transcriptPath });
  }

  if (!HSTACK_MCP_TOOL_RE.test(toolName)) {
    return { decision: "allow" };
  }

  const toolSummary = toolName === HANDOFF_TOOL_NAME ? HANDOFF_TOOL_SUMMARY : GATE_TOOL_SUMMARY;

  return {
    decision: "auto_approve",
    overwrite: {
      toolSummary,
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
