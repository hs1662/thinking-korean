#!/usr/bin/env node

import { createInterface } from "node:readline";
import { appendAuditRecord, readGovernanceConfig, resolveSchemaRegister } from "../governance/audit-log.mjs";
import { HANDOFF_COPY, REGISTER_COPY } from "../governance/constants.mjs";
import { decideGate } from "../governance/decide-gate.mjs";
import { detectTestInfrastructure, readFactLedger, readGitLedger } from "../governance/fact-ledger.mjs";
import {
  listHandoffSnapshots,
  loadHandoffSnapshot,
  readSessionState,
  saveHandoffSnapshot,
} from "../governance/handoff-store.mjs";
import { resolveAuditEscalationMode } from "../governance/risk-classifier.mjs";
import { isDirectExecution } from "../hook-io.mjs";

const PROTOCOL_VERSION_DEFAULT = "2024-11-05";
const SERVER_INFO = { name: "hstack-gate", version: "2.1.1" };
const PUBLIC_ARG_KEYS = new Set([
  "modified_files",
  "inspected_files",
  "verification_runs",
  "unverified_scope",
  "self_assessment",
]);
const HANDOFF_ARG_KEYS = new Set([
  "action",
  "snapshot_id",
  "objective",
  "verified_facts",
  "failed_approaches",
  "remaining_tasks",
  "open_risks",
]);
const ALLOWED_OUTCOMES = new Set(["pass", "fail", "not_applicable"]);
const ALLOWED_HANDOFF_ACTIONS = new Set(["save", "load", "list"]);
const VERIFICATION_RUN_KEYS = new Set(["command", "outcome", "reason_if_na"]);

export function buildVerifyCompletionTool(register) {
  const copy = REGISTER_COPY[register] ?? REGISTER_COPY.neutral;
  return {
    name: "verify_completion",
    description: copy.toolDescription,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [
        "modified_files",
        "inspected_files",
        "verification_runs",
        "unverified_scope",
        "self_assessment",
      ],
      properties: {
        modified_files: {
          type: "array",
          items: { type: "string" },
          description: copy.paramDescriptions.modified_files,
        },
        inspected_files: {
          type: "array",
          items: { type: "string" },
          description: copy.paramDescriptions.inspected_files,
        },
        verification_runs: {
          type: "array",
          description: copy.paramDescriptions.verification_runs,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["command", "outcome"],
            properties: {
              command: {
                type: "string",
                description: "실행한 검증 명령 원문입니다.",
              },
              outcome: {
                type: "string",
                enum: ["pass", "fail", "not_applicable"],
                description: "실행 결과 구분입니다.",
              },
              reason_if_na: {
                type: "string",
                description: "해당 없음으로 보고할 때의 구체적 사유입니다.",
              },
            },
          },
        },
        unverified_scope: {
          type: "array",
          items: { type: "string" },
          description: copy.paramDescriptions.unverified_scope,
        },
        self_assessment: {
          type: "string",
          description: copy.paramDescriptions.self_assessment,
        },
      },
    },
  };
}

export function buildManageHandoffTool() {
  return {
    name: "manage_handoff",
    description: HANDOFF_COPY.toolDescription,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["save", "load", "list"],
          description: HANDOFF_COPY.actionDescription,
        },
        snapshot_id: {
          type: "string",
          description: HANDOFF_COPY.snapshotIdDescription,
        },
        objective: {
          type: "string",
          description: HANDOFF_COPY.objectiveDescription,
        },
        verified_facts: {
          type: "array",
          items: { type: "string" },
          description: HANDOFF_COPY.verifiedFactsDescription,
        },
        failed_approaches: {
          type: "array",
          items: { type: "string" },
          description: HANDOFF_COPY.failedApproachesDescription,
        },
        remaining_tasks: {
          type: "array",
          items: { type: "string" },
          description: HANDOFF_COPY.remainingTasksDescription,
        },
        open_risks: {
          type: "array",
          items: { type: "string" },
          description: HANDOFF_COPY.openRisksDescription,
        },
      },
    },
  };
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validatePublicArgs(publicArgs) {
  const errors = [];
  const unknownKeys = Object.keys(publicArgs).filter((key) => !PUBLIC_ARG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`허용되지 않은 입력 필드가 포함되었습니다: ${unknownKeys.map((k) => `\`${k}\``).join(", ")}`);
  }
  if (!isStringArray(publicArgs.modified_files)) {
    errors.push("수정 파일 목록은 문자열 배열로 전달해야 합니다.");
  }
  if (!isStringArray(publicArgs.inspected_files)) {
    errors.push("열람 파일 목록은 문자열 배열로 전달해야 합니다.");
  }
  if (!Array.isArray(publicArgs.verification_runs)) {
    errors.push("검증 실행 목록은 객체 배열로 전달해야 합니다.");
  } else {
    for (let i = 0; i < publicArgs.verification_runs.length; i += 1) {
      const item = publicArgs.verification_runs[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`검증 실행 목록 ${i + 1}번째 항목이 올바른 객체 형식이 아닙니다.`);
        continue;
      }
      const extraRunKeys = Object.keys(item).filter((key) => !VERIFICATION_RUN_KEYS.has(key));
      if (extraRunKeys.length > 0) {
        errors.push(`검증 실행 목록 ${i + 1}번째 항목에 허용되지 않은 필드가 있습니다: ${extraRunKeys.map((k) => `\`${k}\``).join(", ")}`);
      }
      if (typeof item.command !== "string") {
        errors.push(`검증 실행 목록 ${i + 1}번째 항목의 실행 명령은 문자열이어야 합니다.`);
      }
      if (typeof item.outcome !== "string" || !ALLOWED_OUTCOMES.has(item.outcome)) {
        errors.push(`검증 실행 목록 ${i + 1}번째 항목의 결과 구분이 올바르지 않습니다.`);
      }
      if (item.reason_if_na !== undefined && typeof item.reason_if_na !== "string") {
        errors.push(`검증 실행 목록 ${i + 1}번째 항목의 미적용 사유는 문자열이어야 합니다.`);
      }
    }
  }
  if (!isStringArray(publicArgs.unverified_scope)) {
    errors.push("미검증 범위 목록은 문자열 배열로 전달해야 합니다.");
  }
  if (typeof publicArgs.self_assessment !== "string") {
    errors.push("자가 평가 설명은 문자열로 전달해야 합니다.");
  }
  return errors;
}

function validateHandoffArgs(publicArgs) {
  const errors = [];
  const unknownKeys = Object.keys(publicArgs).filter((key) => !HANDOFF_ARG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    errors.push(`허용되지 않은 입력 필드가 포함되었습니다: ${unknownKeys.map((k) => `\`${k}\``).join(", ")}`);
  }
  if (typeof publicArgs.action !== "string" || !ALLOWED_HANDOFF_ACTIONS.has(publicArgs.action)) {
    errors.push("핸드오프 동작은 `save`, `load`, `list` 가운데 하나여야 합니다.");
    return errors;
  }
  if (publicArgs.snapshot_id !== undefined && typeof publicArgs.snapshot_id !== "string") {
    errors.push("스냅샷 식별자는 문자열로 전달해야 합니다.");
  }
  if (publicArgs.action === "save") {
    if (typeof publicArgs.objective !== "string" || publicArgs.objective.trim().length === 0) {
      errors.push("저장 시 작업 목표는 비어 있지 않은 문자열로 전달해야 합니다.");
    }
    if (!isStringArray(publicArgs.verified_facts)) {
      errors.push("저장 시 확인된 사실 목록은 문자열 배열로 전달해야 합니다.");
    }
    if (!isStringArray(publicArgs.failed_approaches)) {
      errors.push("저장 시 실패 접근 목록은 문자열 배열로 전달해야 합니다.");
    }
    if (!isStringArray(publicArgs.remaining_tasks)) {
      errors.push("저장 시 남은 작업 목록은 문자열 배열로 전달해야 합니다.");
    }
    if (publicArgs.open_risks !== undefined && !isStringArray(publicArgs.open_risks)) {
      errors.push("열린 위험 목록은 문자열 배열로 전달해야 합니다.");
    }
  }
  return errors;
}

function buildValidationRejectionReceipt(register, errors) {
  const copy = REGISTER_COPY[register] ?? REGISTER_COPY.neutral;
  return [
    copy.headers.REJECT,
    "완료 검증 입력 형식이 올바르지 않아 대조를 진행할 수 없습니다. 아래 항목을 바로잡아 다시 호출해 주세요.",
    ...errors.map((err) => `- ${err}`),
  ].join("\n");
}

function buildHandoffErrorText(errors) {
  return [
    "[핸드오프 처리 오류]",
    "핸드오프 입력 형식을 확인해 주세요.",
    ...errors.map((err) => `- ${err}`),
  ].join("\n");
}

function makeRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function makeRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function createMcpServerHandler(options = {}) {
  const dataDir = options.dataDir;
  const schemaRegister = options.register ?? resolveSchemaRegister(dataDir);
  const verifyTool = buildVerifyCompletionTool(schemaRegister);
  const handoffTool = buildManageHandoffTool();

  function extractSession(safeArgs) {
    const { _session, toolSummary: _ignoredToolSummary, ...publicArgs } = safeArgs;
    const sessionObj = _session && typeof _session === "object" && !Array.isArray(_session) ? _session : null;
    return {
      publicArgs,
      sessionObj,
      conversationId: typeof sessionObj?.conversationId === "string" ? sessionObj.conversationId.trim() : "",
      transcriptPath: typeof sessionObj?.transcriptPath === "string" ? sessionObj.transcriptPath.trim() : "",
      cwd: typeof sessionObj?.cwd === "string" ? sessionObj.cwd.trim() : "",
    };
  }

  function handleVerifyCompletion(rawArgs) {
    const safeArgs = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
    const { publicArgs, sessionObj, conversationId, transcriptPath, cwd } = extractSession(safeArgs);

    const validationErrors = validatePublicArgs(publicArgs);
    if (validationErrors.length > 0) {
      return {
        content: [{ type: "text", text: buildValidationRejectionReceipt(schemaRegister, validationErrors) }],
        isError: false,
      };
    }

    const skipNoSession = () => {
      const decision = decideGate(publicArgs, { sessionMissing: true, register: schemaRegister });
      appendAuditRecord(
        {
          ts: new Date().toISOString(),
          event: "gate_verify",
          eventType: "gate_verify",
          conversationId,
          turnStartStepIndex: 0,
          attemptInTurn: 1,
          schemaRegister,
          verdict: decision.verdict,
          riskTier: decision.risk.tier,
          blockedRules: decision.blockedRules,
          warnedRules: decision.warnedRules,
          metrics: {
            ...decision.metrics,
            inputTokens: null,
            cacheReadTokens: null,
            outputTokens: null,
          },
        },
        dataDir,
      );
      return {
        content: [{ type: "text", text: decision.receiptText }],
        isError: false,
      };
    };

    if (!sessionObj || transcriptPath.length === 0) {
      return skipNoSession();
    }

    const gitLedger = readGitLedger(cwd);
    const ledger = readFactLedger(transcriptPath, cwd, gitLedger.gitRoot || "");
    if (!ledger.transcriptAvailable) {
      return skipNoSession();
    }
    const testInfra = detectTestInfrastructure(cwd, gitLedger.gitRoot || null);
    const governanceConfig = readGovernanceConfig(dataDir);
    const auditEscalation = resolveAuditEscalationMode(dataDir, governanceConfig);
    const sessionState = conversationId ? readSessionState(conversationId, dataDir) : null;
    const pollutionAlert = Boolean(sessionState?.pollutionAlert);

    const decision = decideGate(publicArgs, {
      ledger,
      gitLedger,
      testInfra,
      cwd,
      register: schemaRegister,
      sessionMissing: false,
      governanceConfig,
      auditEscalation,
      pollutionAlert,
    });

    const completedPriorAttempts = ledger.turnGateAttempts.filter((attempt) => attempt.verdict !== "UNKNOWN").length;
    const attemptInTurn = completedPriorAttempts + 1;

    appendAuditRecord(
      {
        ts: new Date().toISOString(),
        event: "gate_verify",
        eventType: "gate_verify",
        conversationId,
        turnStartStepIndex: ledger.turnStartStepIndex,
        attemptInTurn,
        sessionRole: ledger.sessionRole,
        schemaRegister,
        verdict: decision.verdict,
        riskTier: decision.risk.tier,
        riskReasons: decision.risk.reasons,
        auditVerdict: decision.auditVerdict,
        blockedRules: decision.blockedRules,
        warnedRules: decision.warnedRules,
        metrics: {
          ...decision.metrics,
          inputTokens: ledger.latestTokens.inputTokens,
          cacheReadTokens: ledger.latestTokens.cacheReadTokens,
          outputTokens: ledger.latestTokens.outputTokens,
          writtenCount: ledger.turnWrittenFiles.size,
          codeWrittenCount: ledger.turnCodeWrittenFiles.size,
          readCount: ledger.sessionReadFiles.size,
          verificationExecCount: ledger.turnExecutions.filter((exec) => exec.kind === "verification").length,
        },
      },
      dataDir,
    );

    return {
      content: [{ type: "text", text: decision.receiptText }],
      isError: false,
    };
  }

  function handleManageHandoff(rawArgs) {
    const safeArgs = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
    const { publicArgs, conversationId, transcriptPath, cwd } = extractSession(safeArgs);

    const validationErrors = validateHandoffArgs(publicArgs);
    if (validationErrors.length > 0) {
      return {
        content: [{ type: "text", text: buildHandoffErrorText(validationErrors) }],
        isError: false,
      };
    }

    if (!cwd) {
      return {
        content: [
          {
            type: "text",
            text: buildHandoffErrorText([
              "세션 작업 경로 정보가 전달되지 않아 핸드오프를 처리할 수 없습니다. 전처리 훅 설정을 확인해 주세요.",
            ]),
          },
        ],
        isError: false,
      };
    }

    const effectiveCwd = cwd;
    const gitLedger = readGitLedger(effectiveCwd);

    if (publicArgs.action === "save") {
      const ledger = transcriptPath ? readFactLedger(transcriptPath, effectiveCwd, gitLedger.gitRoot || "") : null;
      const { snapshot, workspaceKey, prunedCount } = saveHandoffSnapshot({
        input: publicArgs,
        ledger,
        gitLedger,
        cwd: effectiveCwd,
        conversationId,
        dataDir,
      });

      appendAuditRecord(
        {
          ts: new Date().toISOString(),
          event: "handoff_save",
          eventType: "handoff_save",
          conversationId,
          workspaceKey,
          snapshotId: snapshot.snapshotId,
          unverifiedWarningCount: snapshot.unverifiedWarnings.length,
          prunedCount,
        },
        dataDir,
      );

      const lines = [
        "[핸드오프 저장 완료]",
        `현재 세션의 핵심 사실과 작업 공간 근거를 스냅샷 \`${snapshot.snapshotId}\` 으로 저장했습니다.`,
        `- 작업 공간 키: \`${workspaceKey}\``,
        `- 기준 브랜치/커밋: \`${snapshot.machineEvidence.gitBranch || "미확인"}\` / \`${snapshot.machineEvidence.gitHead || "없음"}\``,
        `- 저장된 항목: 사실 ${snapshot.verifiedFacts.length}건, 실패 접근 ${snapshot.failedApproaches.length}건, 남은 작업 ${snapshot.remainingTasks.length}건`,
      ];
      if (snapshot.unverifiedWarnings.length > 0) {
        lines.push("주의(미확인 주장 감지):");
        for (const warn of snapshot.unverifiedWarnings) {
          lines.push(`- ${warn}`);
        }
      }
      lines.push("새 세션에서 `/hstack-handoff load` 를 실행하면 저장된 인수인계서를 바로 복원할 수 있습니다.");

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        isError: false,
      };
    }

    if (publicArgs.action === "load") {
      const loaded = loadHandoffSnapshot({
        snapshotId: publicArgs.snapshot_id ?? "",
        cwd: effectiveCwd,
        gitLedger,
        dataDir,
      });

      appendAuditRecord(
        {
          ts: new Date().toISOString(),
          event: "handoff_load",
          eventType: "handoff_load",
          conversationId,
          workspaceKey: loaded.workspaceKey,
          snapshotId: loaded.ok ? loaded.snapshot.snapshotId : publicArgs.snapshot_id ?? "",
          found: loaded.ok,
          treeChanged: Boolean(loaded.treeChanged),
        },
        dataDir,
      );

      if (!loaded.ok) {
        return {
          content: [{ type: "text", text: `[핸드오프 불러오기 실패]\n${loaded.error}` }],
          isError: false,
        };
      }

      return {
        content: [{ type: "text", text: loaded.formattedText }],
        isError: false,
      };
    }

    const { workspaceKey, items } = listHandoffSnapshots({
      cwd: effectiveCwd,
      gitLedger,
      dataDir,
    });
    if (items.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `[핸드오프 스냅샷 목록]\n현재 작업 공간(\`${workspaceKey}\`)에 저장된 스냅샷이 없습니다.`,
          },
        ],
        isError: false,
      };
    }

    const lines = [
      `[핸드오프 스냅샷 목록] (작업 공간: \`${workspaceKey}\`, 최근 ${items.length}건)`,
      ...items.map((item) => `- \`${item.snapshotId}\` (${item.savedAt}) — ${item.objective || "목표 미기재"}`),
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      isError: false,
    };
  }

  return function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return makeRpcError(null, -32600, "Invalid Request");
    }

    const { id, method, params } = message;
    const isNotification = id === undefined;

    if (typeof method !== "string" || method.length === 0) {
      return isNotification ? null : makeRpcError(id, -32600, "Invalid Request");
    }

    if (method === "notifications/initialized" || isNotification) {
      return null;
    }

    if (method === "initialize") {
      const protocolVersion =
        typeof params?.protocolVersion === "string" && params.protocolVersion.trim().length > 0
          ? params.protocolVersion.trim()
          : PROTOCOL_VERSION_DEFAULT;
      return makeRpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    if (method === "ping") {
      return makeRpcResult(id, {});
    }

    if (method === "tools/list") {
      return makeRpcResult(id, { tools: [verifyTool, handoffTool] });
    }

    if (method === "tools/call") {
      const toolName = typeof params?.name === "string" ? params.name : "";
      if (toolName === "verify_completion") {
        try {
          return makeRpcResult(id, handleVerifyCompletion(params?.arguments));
        } catch (err) {
          const errorMessage = err?.message ?? String(err);
          process.stderr.write(`[hstack-gate] verify_completion error: ${errorMessage}\n`);
          const fallback = decideGate({}, { sessionMissing: true, register: schemaRegister });
          appendAuditRecord(
            {
              ts: new Date().toISOString(),
              event: "gate_verify",
              eventType: "gate_verify",
              conversationId: "",
              turnStartStepIndex: 0,
              attemptInTurn: 1,
              schemaRegister,
              verdict: "SKIPPED_NO_SESSION",
              blockedRules: fallback.blockedRules,
              warnedRules: fallback.warnedRules,
              error: errorMessage,
            },
            dataDir,
          );
          return makeRpcResult(id, {
            content: [{ type: "text", text: fallback.receiptText }],
            isError: false,
          });
        }
      }

      if (toolName === "manage_handoff") {
        try {
          return makeRpcResult(id, handleManageHandoff(params?.arguments));
        } catch (err) {
          const errorMessage = err?.message ?? String(err);
          process.stderr.write(`[hstack-gate] manage_handoff error: ${errorMessage}\n`);
          return makeRpcResult(id, {
            content: [
              {
                type: "text",
                text: "[핸드오프 처리 오류]\n스냅샷 처리 중 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
              },
            ],
            isError: false,
          });
        }
      }

      return makeRpcError(id, -32602, `Unknown tool: ${toolName}`);
    }

    return makeRpcError(id, -32601, `Method not found: ${method}`);
  };
}

export function startMcpStdioServer(options = {}) {
  const handleMessage = createMcpServerHandler(options);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      process.stdout.write(`${JSON.stringify(makeRpcError(null, -32700, "Parse error"))}\n`);
      return;
    }
    const response = handleMessage(parsed);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });

  rl.on("error", (err) => {
    process.stderr.write(`[hstack-gate] stdin error: ${err?.message ?? String(err)}\n`);
  });
}

if (isDirectExecution(import.meta.url)) {
  startMcpStdioServer();
}
