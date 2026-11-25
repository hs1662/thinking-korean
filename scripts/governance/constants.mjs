import { posix } from "node:path";

export const GATE_TOOL_NAME = "mcp_hstack_gate_verify_completion";
export const HANDOFF_TOOL_NAME = "mcp_hstack_gate_manage_handoff";
export const SUBAGENT_TOOL_NAME = "invoke_subagent";

export const AUDITOR_AGENT_NAME = "hstack-auditor";
export const WORKER_AGENT_NAME = "hstack-worker";
export const AUDITOR_ROLE_LABEL = "독립 코드 감사관";
export const WORKER_ROLE_LABEL = "팩트 기반 격리 작업자";
export const AUDITOR_SESSION_MARKER = "[hstack:독립감사]";
export const WORKER_SESSION_MARKER = "[hstack:격리작업]";
export const AUDIT_PASS_TAG = "[감사 판정: 통과]";
export const AUDIT_REJECT_TAG = "[감사 판정: 반려]";

export const PASSING_VERDICTS = new Set([
  "PASS",
  "PASS_WITH_WARNING",
  "PASS_WITH_DEGRADATION",
  "PASS_WITH_AUDIT_DEGRADATION",
  "SKIPPED_NO_SESSION",
]);

export const ALLOWED_AUDIT_ESCALATION_MODES = new Set(["auto", "manual", "off"]);

export const DEFAULT_RISK_THRESHOLDS = {
  minCodeFiles: 4,
  minChangedLines: 150,
};

export const DEFAULT_POLLUTION_THRESHOLDS = {
  inputTokensWarning: 120_000,
  failedExecutionsInTurn: 4,
  repeatedFileEditChurn: 5,
};

export const DEFAULT_SENSITIVE_PATTERNS = [
  /(^|\/)auth(\/|$)/i,
  /(^|\/)security(\/|$)/i,
  /(^|\/)crypto(\/|$)/i,
  /(^|\/)permission/i,
  /token/i,
  /session/i,
  /rbac/i,
  /oauth/i,
  /jwt/i,
  /(^|\/)migrations?(\/|$)/i,
  /\.sql$/i,
  /schema\.(prisma|sql|graphql|json)$/i,
  /(^|\/)deploy(\/|$)/i,
  /(^|\/)infra(\/|$)/i,
  /(^|\/)Dockerfile(\.[^/]+)?$/i,
  /(^|\/)docker-compose/i,
  /^\.github\/workflows\//i,
  /^hooks\.json$/i,
  /^mcp_config\.json$/i,
  /^scripts\/mcp\//i,
  /^scripts\/governance\//i,
];

export const RISK_REASON_LABELS = {
  sensitive_path: "민감 경로 변경",
  large_file_count: "다수 코드 파일 변경",
  large_diff_lines: "대규모 코드 변경량",
};

export const POLLUTION_WARNING_LINE =
  "[컨텍스트 열화 주의] 현재 세션의 토큰 누적이나 반복 수정이 높습니다. 작업이 더 이어진다면 팩트 증류 핸드오프로 핵심 사실만 저장하고 새 세션으로 전환하는 것을 권장합니다.";

export const HANDOFF_COPY = {
  toolDescription:
    "현재 세션의 검증된 팩트와 남은 작업을 기계 근거와 결합해 저장하거나, 저장된 인수인계서를 불러오거나 목록을 조회합니다.",
  actionDescription: "수행할 핸드오프 동작입니다. 저장, 불러오기, 목록 조회 가운데 실행할 항목을 선택합니다.",
  snapshotIdDescription: "불러올 스냅샷 식별자입니다. 생략하면 현재 작업 공간에 저장된 최신 스냅샷을 불러옵니다.",
  objectiveDescription: "현재 세션에서 달성하려는 최종 작업 목표를 자연스러운 한국어 한두 문장으로 요약합니다.",
  verifiedFactsDescription: "파일을 직접 열어 읽거나 명령을 실행해 근거와 함께 확인한 사실 목록입니다.",
  failedApproachesDescription: "이미 시도했으나 실패했거나 폐기한 접근 방식과 그 원인을 정리한 목록입니다.",
  remainingTasksDescription: "다음 세션에서 이어받아 곧바로 수행해야 할 남은 작업 항목을 정리한 목록입니다.",
  openRisksDescription: "아직 완전히 해소되지 않은 위험 요소와 작업 시 주의할 제약 사항 목록입니다.",
  staleTreeWarning: "[작업 트리 변동 감지] 저장 시점 이후 작업 공간의 커밋 또는 변경 파일 상태가 달라졌습니다. 최신 파일 상태를 먼저 다시 확인하세요.",
};

export const DOC_ASSET_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".rst",
  ".adoc",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
]);

export const READ_TOOL_NAMES = new Set(["read_file", "view_file"]);

export const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "mcp_agy-fast_fast_apply_edits",
]);

export const CREATE_AS_READ_TOOL_NAMES = new Set(["write_file", "write_to_file"]);

export const EXEC_TOOL_NAMES = new Set(["run_command"]);

export const MCP_VERIFICATION_TOOL_NAMES = new Set(["mcp_agy-fast_fast_run_checks"]);

export const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
]);

export const READ_ONLY_BINARIES = new Set([
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "rg",
  "grep",
  "find",
  "wc",
  "echo",
  "stat",
  "which",
  "tree",
  "file",
]);

export const VERIFICATION_BINARIES = new Set([
  "node",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bun",
  "deno",
  "pytest",
  "python",
  "python3",
  "cargo",
  "go",
  "make",
  "tsc",
  "tsx",
  "eslint",
  "biome",
  "oxlint",
  "vitest",
  "jest",
  "playwright",
  "cypress",
  "agy",
  "sh",
  "bash",
  "mvn",
  "gradle",
  "dotnet",
  "rspec",
  "phpunit",
  "ctest",
  "ruff",
  "mypy",
  "flake8",
]);

export const ALLOWED_SCHEMA_REGISTERS = new Set(["neutral", "audit"]);

export const VERDICT_HEADERS = {
  PASS: "[완료 검증 통과]",
  PASS_WITH_WARNING: "[완료 검증 통과(주의)]",
  PASS_WITH_DEGRADATION: "[완료 검증 통과(제한)]",
  PASS_WITH_AUDIT_DEGRADATION: "[완료 검증 통과(감사 제한)]",
  ESCALATE_AUDIT_REQUIRED: "[독립 감사 필요]",
  SKIPPED_NO_SESSION: "[완료 검증 생략]",
  REJECT_NEUTRAL: "[검증 반려]",
  REJECT_AUDIT: "[감사 기각]",
};

export function isExemptDocOrAssetPath(relPath) {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    return false;
  }
  const normalized = relPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "docs" || normalized.startsWith("docs/")) {
    return true;
  }
  const base = posix.basename(normalized);
  if (base === "LICENSE") {
    return true;
  }
  const ext = posix.extname(base).toLowerCase();
  return ext.length > 0 && DOC_ASSET_EXTENSIONS.has(ext);
}

function formatCodeList(items) {
  return items.map((item) => `\`${item}\``).join(", ");
}

const NEUTRAL_RULE_MESSAGES = {
  R1_UNREAD_INSPECTED: (files) =>
    `직접 읽은 기록이 없는 파일을 점검 목록에 포함했습니다: ${formatCodeList(files)}`,
  R2_STALE_VERIFICATION: () =>
    "마지막 코드 수정 이후에 실행된 검증 명령 기록이 없습니다.",
  R3_CONCEALED_FAILURE: (commands) =>
    commands.length > 0
      ? `마지막 검증 실행이 실패로 끝났습니다: ${formatCodeList(commands)}`
      : "마지막 검증 실행에서 오류가 확인되었습니다.",
  R4_UNREPORTED_MODIFIED: (files) =>
    `실제로 수정했지만 보고 목록에서 빠진 파일이 있습니다: ${formatCodeList(files)}`,
  R5_FABRICATED_COMMAND: (commands) =>
    `현재 작업 턴에서 실행 기록을 찾을 수 없는 검증 명령이 보고되었습니다: ${formatCodeList(commands)}`,
  R6_PHANTOM_MODIFIED: (files) =>
    `실제 수정 기록이나 작업 트리 변경에서 확인되지 않은 파일이 보고되었습니다: ${formatCodeList(files)}`,
  R7_HEDGE_DETECTED: (hits) =>
    `자가 평가 문장에서 추측성 표현이 ${hits}회 감지되었지만 미검증 범위가 비어 있습니다.`,
  R8_AUDIT_REJECTED: () =>
    "독립 코드 감사관이 결함을 지적해 반려 판정을 내렸습니다. 지적 사항을 수정하고 검증과 독립 감사를 다시 통과해야 합니다.",
  R8_AUDIT_ERROR: () =>
    "독립 코드 감사관 실행이 오류나 판정 누락으로 종료되었습니다. 독립 코드 감사관을 다시 호출해 최종 판정을 받아 주세요.",
};

const AUDIT_RULE_MESSAGES = {
  R1_UNREAD_INSPECTED: (files) =>
    `세션 열람 원장에 존재하지 않는 파일이 점검 대상으로 기재되었습니다: ${formatCodeList(files)}`,
  R2_STALE_VERIFICATION: () =>
    "최종 코드 변경 시점 이후에 수행된 검증 실행 증빙이 누락되었습니다.",
  R3_CONCEALED_FAILURE: (commands) =>
    commands.length > 0
      ? `최종 검증 실행의 실패 결과가 누락되거나 통과로 기재되었습니다: ${formatCodeList(commands)}`
      : "최종 검증 실행에서 실패 상태가 기록되었습니다.",
  R4_UNREPORTED_MODIFIED: (files) =>
    `원장에 기록된 수정 파일이 완료 보고에서 누락되었습니다: ${formatCodeList(files)}`,
  R5_FABRICATED_COMMAND: (commands) =>
    `실행 원장과 대조되지 않는 검증 명령이 통과 항목으로 기재되었습니다: ${formatCodeList(commands)}`,
  R6_PHANTOM_MODIFIED: (files) =>
    `원장 및 작업 트리 대조에서 확인 불가한 수정 파일이 기재되었습니다: ${formatCodeList(files)}`,
  R7_HEDGE_DETECTED: (hits) =>
    `평가 기술에서 불확실 표현이 ${hits}건 검출되었으나 미검증 범위 항목이 공란입니다.`,
  R8_AUDIT_REJECTED: () =>
    "독립 코드 감사관의 검토에서 반려 판정이 기록되었습니다. 지적된 결함을 시정하고 재검증 및 재감사를 완료하십시오.",
  R8_AUDIT_ERROR: () =>
    "독립 코드 감사관 응답에서 실행 오류 또는 판정 태그 누락이 확인되었습니다. 독립 코드 감사관을 재호출하여 정상 판정을 확보하십시오.",
};

export const REGISTER_COPY = {
  neutral: {
    toolDescription:
      "작업을 마치기 전에 수정한 파일과 읽은 파일, 실행한 검증 명령을 실제 작업 기록과 대조해 완료 보고의 정확성을 확인합니다.",
    paramDescriptions: {
      modified_files: "이번 턴에서 실제로 수정하거나 새로 만든 작업 공간 상대 경로 목록입니다.",
      inspected_files: "판단 근거로 삼기 위해 직접 열어 읽은 파일의 상대 경로 목록입니다.",
      verification_runs: "코드 수정 뒤에 실행한 검증 명령과 결과, 해당 없음 사유를 담은 목록입니다.",
      unverified_scope: "이번 턴에서 직접 검증하지 못한 범위나 남은 제약 사항 목록입니다.",
      self_assessment: "작업 완료 상태와 확인한 근거를 한국어로 간결하게 정리한 설명입니다.",
    },
    headers: {
      PASS: VERDICT_HEADERS.PASS,
      PASS_WITH_WARNING: VERDICT_HEADERS.PASS_WITH_WARNING,
      PASS_WITH_DEGRADATION: VERDICT_HEADERS.PASS_WITH_DEGRADATION,
      PASS_WITH_AUDIT_DEGRADATION: VERDICT_HEADERS.PASS_WITH_AUDIT_DEGRADATION,
      ESCALATE_AUDIT_REQUIRED: VERDICT_HEADERS.ESCALATE_AUDIT_REQUIRED,
      SKIPPED_NO_SESSION: VERDICT_HEADERS.SKIPPED_NO_SESSION,
      REJECT: VERDICT_HEADERS.REJECT_NEUTRAL,
    },
    ruleMessages: NEUTRAL_RULE_MESSAGES,
    summaries: {
      PASS: "보고한 파일 목록과 검증 기록이 실제 작업 기록과 모두 일치합니다. 이제 최종 답변을 작성해도 됩니다.",
      PASS_WITH_WARNING: "필수 검증은 통과했지만 주의 항목이 있습니다. 최종 답변에 확인 범위를 분명히 적어 주세요.",
      PASS_WITH_DEGRADATION:
        "반복 반려에 따라 제한 통과로 전환했습니다. 최종 답변에서 검증하지 못한 범위를 숨기지 말고 그대로 안내해 주세요.",
      PASS_WITH_AUDIT_DEGRADATION:
        "독립 감사 반복 반려 또는 실행 장애에 따라 감사 제한 통과로 전환했습니다. 최종 답변에 남은 쟁점과 미해결 위험을 숨기지 말고 그대로 안내해 주세요.",
      ESCALATE_AUDIT_REQUIRED:
        "고위험 변경으로 분류되어 독립 검토가 필요합니다. `invoke_subagent` 도구로 `hstack-auditor` 유형과 `독립 코드 감사관` 역할을 지정해 감사를 받은 뒤 완료 검증 도구를 다시 호출해 주세요.",
      SKIPPED_NO_SESSION: "세션 기록 경로가 없어 완료 검증을 생략했습니다. 확인한 사실만 근거로 최종 답변을 작성해 주세요.",
      REJECT: "아래 항목을 먼저 해소하거나 누락된 검증을 마친 뒤 완료 검증 도구를 다시 호출해 주세요.",
    },
    degradedNotice: "반려 누적 한도에 도달했고 미검증 범위가 명시되어 제한 통과 처리되었습니다.",
    auditDegradedRejectNotice: "독립 감사 반려 한도에 도달했고 잔여 쟁점이 미검증 범위에 명시되어 감사 제한 통과 처리되었습니다.",
    auditDegradedErrorNotice: "독립 감사 실행 오류가 연속 발생했고 미검증 범위가 명시되어 감사 제한 통과 처리되었습니다.",
    auditPassedLine: "- 독립 감사: 통과",
  },
  audit: {
    toolDescription:
      "최종 보고 직전에 수정 파일, 열람 파일, 검증 실행 증빙을 세션 원장과 작업 트리 기록에 대조하여 감사 판정을 수행합니다.",
    paramDescriptions: {
      modified_files: "현재 턴에서 변경 또는 생성한 작업 공간 상대 경로 목록을 빠짐없이 기재합니다.",
      inspected_files: "분석과 결론의 근거로 직접 열람한 파일의 상대 경로 목록을 기재합니다.",
      verification_runs: "최종 코드 변경 이후 수행한 검증 명령, 실행 결과, 미적용 사유의 증빙 목록을 기재합니다.",
      unverified_scope:
        '직접 검증하지 못한 대상과 확인 한계를 구체적으로 기재합니다. 실제로 누락된 검증이 없다면 "없음" 같은 빈 문구를 채우지 말고 빈 배열로 전달합니다.',
      self_assessment: "변경 내용과 검증 근거에 대한 완료 평가 소견을 한국어로 기재합니다.",
    },
    headers: {
      PASS: VERDICT_HEADERS.PASS,
      PASS_WITH_WARNING: VERDICT_HEADERS.PASS_WITH_WARNING,
      PASS_WITH_DEGRADATION: VERDICT_HEADERS.PASS_WITH_DEGRADATION,
      PASS_WITH_AUDIT_DEGRADATION: VERDICT_HEADERS.PASS_WITH_AUDIT_DEGRADATION,
      ESCALATE_AUDIT_REQUIRED: VERDICT_HEADERS.ESCALATE_AUDIT_REQUIRED,
      SKIPPED_NO_SESSION: VERDICT_HEADERS.SKIPPED_NO_SESSION,
      REJECT: VERDICT_HEADERS.REJECT_AUDIT,
    },
    ruleMessages: AUDIT_RULE_MESSAGES,
    summaries: {
      PASS: "제출된 변경 내역과 검증 증빙이 세션 원장과 일치합니다. 최종 보고를 진행할 수 있습니다.",
      PASS_WITH_WARNING: "감사 기준을 충족했으나 주의 소견이 남아 있습니다. 최종 보고에 제한 사항을 명시하십시오.",
      PASS_WITH_DEGRADATION:
        "기각 누적 기준에 도달하여 제한 통과 판정이 부여되었습니다. 최종 보고에 미검증 범위를 투명하게 기재하십시오.",
      PASS_WITH_AUDIT_DEGRADATION:
        "독립 감사 기각 누적 또는 감사 실행 장애 기준에 도달하여 감사 제한 통과 판정이 부여되었습니다. 최종 보고에 잔여 쟁점과 제한 사항을 투명하게 기재하십시오.",
      ESCALATE_AUDIT_REQUIRED:
        "고위험 변경으로 판정되어 독립 코드 감사가 요구됩니다. `invoke_subagent` 도구로 `hstack-auditor` 유형과 `독립 코드 감사관` 역할을 지정해 감사를 완료한 뒤 감사 검증을 재요청하십시오.",
      SKIPPED_NO_SESSION: "세션 원장 정보가 전달되지 않아 감사 대조를 생략했습니다. 확인된 사실만 기재하십시오.",
      REJECT: "아래 기각 사유를 시정하고 필요한 검증 증빙을 확보한 뒤 감사 검증을 재요청하십시오.",
    },
    degradedNotice: "기각 누적 한도에 도달하였고 미검증 범위가 명시되어 제한 통과로 전환되었습니다.",
    auditDegradedRejectNotice: "독립 감사 기각 누적 한도에 도달하였고 미검증 범위에 잔여 쟁점이 기재되어 감사 제한 통과로 전환되었습니다.",
    auditDegradedErrorNotice: "독립 감사 연속 장애가 확인되었고 미검증 범위가 기재되어 감사 제한 통과로 전환되었습니다.",
    auditPassedLine: "- 독립 감사: 통과",
  },
};
