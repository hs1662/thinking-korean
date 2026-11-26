#!/usr/bin/env node

import { existsSync } from "node:fs";
import {
  AUDITOR_AGENT_NAME,
  AUDITOR_ROLE_LABEL,
  AUDITOR_SESSION_MARKER,
  CHALLENGER_AGENT_NAME,
  CHALLENGER_ROLE_LABEL,
  CHALLENGER_SESSION_MARKER,
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

const CHALLENGER_GUIDANCE_LINE =
  "위 작업 경로의 실제 파일과 호출 관계를 직접 읽고 사용자의 유도 전제에 동조하지 않은 채 근거(`파일:줄`) 기반 반론과 지정 판정 태그로만 보고하라.";

function classifyManagedAgent(rawTypeName) {
  if (typeof rawTypeName !== "string") {
    return null;
  }
  const normalized = rawTypeName.trim();
  if (normalized === AUDITOR_AGENT_NAME || normalized === `hstack:${AUDITOR_AGENT_NAME}`) {
    return "auditor";
  }
  if (normalized === CHALLENGER_AGENT_NAME || normalized === `hstack:${CHALLENGER_AGENT_NAME}`) {
    return "challenger";
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

const INJECTED_TAIL_LINE_RE =
  /^(?:작업 경로:|세션 기록 경로:|현재 턴 시작 스텝:|-\s*작업 디렉터리:|위 작업 경로의 실제 파일과 호출 관계를 직접 읽고)/;

function hasTrailingMarkerBlock(promptText, marker) {
  const nonEmpty = promptText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tailStart = Math.max(0, nonEmpty.length - 6);
  for (let i = tailStart; i < nonEmpty.length; i += 1) {
    if (nonEmpty[i] !== marker) {
      continue;
    }
    const rest = nonEmpty.slice(i + 1);
    if (rest.length === 0 || rest.every((line) => INJECTED_TAIL_LINE_RE.test(line))) {
      return true;
    }
  }
  return false;
}

function buildInjectedPrompt(kind, existingPrompt, { cwd, transcriptPath, turnStartStepIndex }) {
  const safePrompt = typeof existingPrompt === "string" ? existingPrompt : "";
  const marker =
    kind === "auditor"
      ? AUDITOR_SESSION_MARKER
      : kind === "challenger"
        ? CHALLENGER_SESSION_MARKER
        : WORKER_SESSION_MARKER;
  const lines = [];
  if (!hasTrailingMarkerBlock(safePrompt, marker)) {
    lines.push(marker);
  }
  if (cwd && !safePrompt.includes(`작업 경로: \`${cwd}\``)) {
    lines.push(`작업 경로: \`${cwd}\``);
  }
  if (kind === "auditor" || kind === "challenger") {
    if (transcriptPath && !safePrompt.includes(`세션 기록 경로: \`${transcriptPath}\``)) {
      lines.push(`세션 기록 경로: \`${transcriptPath}\``);
    }
    if (
      typeof turnStartStepIndex === "number" &&
      Number.isFinite(turnStartStepIndex) &&
      !safePrompt.includes(`현재 턴 시작 스텝: \`${turnStartStepIndex}\``)
    ) {
      lines.push(`현재 턴 시작 스텝: \`${turnStartStepIndex}\``);
    }
  }
  if (kind === "challenger" && !safePrompt.includes(CHALLENGER_GUIDANCE_LINE)) {
    lines.push(CHALLENGER_GUIDANCE_LINE);
  }
  if (lines.length === 0) {
    return safePrompt;
  }
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

function rewriteSubagentEntry(entry, { cwd, transcriptPath, getTurnStart }) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { matched: false, value: entry };
  }
  const kind = classifyManagedAgent(entry.TypeName ?? entry.typeName ?? entry.type_name);
  if (!kind) {
    return { matched: false, value: entry };
  }
  const roleLabel =
    kind === "auditor"
      ? AUDITOR_ROLE_LABEL
      : kind === "challenger"
        ? CHALLENGER_ROLE_LABEL
        : WORKER_ROLE_LABEL;
  const promptKey = "Prompt" in entry || !("prompt" in entry) ? "Prompt" : "prompt";
  const roleKey = "Role" in entry || !("role" in entry) ? "Role" : "role";
  return {
    matched: true,
    value: {
      ...entry,
      [roleKey]: roleLabel,
      [promptKey]: buildInjectedPrompt(kind, entry[promptKey], {
        cwd,
        transcriptPath,
        turnStartStepIndex: kind === "auditor" || kind === "challenger" ? getTurnStart() : null,
      }),
    },
  };
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

  const arrayKey = Array.isArray(args.Subagents) ? "Subagents" : Array.isArray(args.subagents) ? "subagents" : "";
  if (arrayKey) {
    let matchedAny = false;
    const rewritten = args[arrayKey].map((entry) => {
      const res = rewriteSubagentEntry(entry, { cwd, transcriptPath, getTurnStart });
      if (res.matched) {
        matchedAny = true;
      }
      return res.value;
    });
    if (!matchedAny) {
      return { decision: "allow" };
    }
    return {
      decision: "allow",
      overwrite: {
        [arrayKey]: rewritten,
      },
    };
  }

  const singleRes = rewriteSubagentEntry(args, { cwd, transcriptPath, getTurnStart });
  if (!singleRes.matched) {
    return { decision: "allow" };
  }

  const promptKey = "Prompt" in args || !("prompt" in args) ? "Prompt" : "prompt";
  const roleKey = "Role" in args || !("role" in args) ? "Role" : "role";
  return {
    decision: "allow",
    overwrite: {
      [roleKey]: singleRes.value[roleKey],
      [promptKey]: singleRes.value[promptKey],
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
