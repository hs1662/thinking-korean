import { posix } from "node:path";
import { GATE_STOP_MARKER } from "../transcript/markers.mjs";

export const GATE_TOOL_NAME = "mcp_hstack_gate_verify_completion";
export const GATE_BLOCK_MARKER = GATE_STOP_MARKER;

export const PASSING_VERDICTS = new Set([
  "PASS",
  "PASS_WITH_WARNING",
  "PASS_WITH_DEGRADATION",
  "SKIPPED_NO_SESSION",
]);

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

export const READ_ONLY_CMDS = new Set([
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  ...READ_ONLY_BINARIES,
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
      SKIPPED_NO_SESSION: VERDICT_HEADERS.SKIPPED_NO_SESSION,
      REJECT: VERDICT_HEADERS.REJECT_NEUTRAL,
    },
    ruleMessages: NEUTRAL_RULE_MESSAGES,
    summaries: {
      PASS: "보고한 파일 목록과 검증 기록이 실제 작업 기록과 모두 일치합니다. 이제 최종 답변을 작성해도 됩니다.",
      PASS_WITH_WARNING: "필수 검증은 통과했지만 주의 항목이 있습니다. 최종 답변에 확인 범위를 분명히 적어 주세요.",
      PASS_WITH_DEGRADATION:
        "반복 반려에 따라 제한 통과로 전환했습니다. 최종 답변에서 검증하지 못한 범위를 숨기지 말고 그대로 안내해 주세요.",
      SKIPPED_NO_SESSION: "세션 기록 경로가 없어 완료 검증을 생략했습니다. 확인한 사실만 근거로 최종 답변을 작성해 주세요.",
      REJECT: "아래 항목을 먼저 해소하거나 누락된 검증을 마친 뒤 완료 검증 도구를 다시 호출해 주세요.",
    },
    degradedNotice: "반려 누적 한도에 도달했고 미검증 범위가 명시되어 제한 통과 처리되었습니다.",
  },
  audit: {
    toolDescription:
      "최종 보고 직전에 수정 파일, 열람 파일, 검증 실행 증빙을 세션 원장과 작업 트리 기록에 대조하여 감사 판정을 수행합니다.",
    paramDescriptions: {
      modified_files: "현재 턴에서 변경 또는 생성한 작업 공간 상대 경로 목록을 빠짐없이 기재합니다.",
      inspected_files: "분석과 결론의 근거로 직접 열람한 파일의 상대 경로 목록을 기재합니다.",
      verification_runs: "최종 코드 변경 이후 수행한 검증 명령, 실행 결과, 미적용 사유의 증빙 목록을 기재합니다.",
      unverified_scope: "직접 검증하지 못한 대상과 확인 한계를 구체적으로 기재합니다.",
      self_assessment: "변경 내용과 검증 근거에 대한 완료 평가 소견을 한국어로 기재합니다.",
    },
    headers: {
      PASS: VERDICT_HEADERS.PASS,
      PASS_WITH_WARNING: VERDICT_HEADERS.PASS_WITH_WARNING,
      PASS_WITH_DEGRADATION: VERDICT_HEADERS.PASS_WITH_DEGRADATION,
      SKIPPED_NO_SESSION: VERDICT_HEADERS.SKIPPED_NO_SESSION,
      REJECT: VERDICT_HEADERS.REJECT_AUDIT,
    },
    ruleMessages: AUDIT_RULE_MESSAGES,
    summaries: {
      PASS: "제출된 변경 내역과 검증 증빙이 세션 원장과 일치합니다. 최종 보고를 진행할 수 있습니다.",
      PASS_WITH_WARNING: "감사 기준을 충족했으나 주의 소견이 남아 있습니다. 최종 보고에 제한 사항을 명시하십시오.",
      PASS_WITH_DEGRADATION:
        "기각 누적 기준에 도달하여 제한 통과 판정이 부여되었습니다. 최종 보고에 미검증 범위를 투명하게 기재하십시오.",
      SKIPPED_NO_SESSION: "세션 원장 정보가 전달되지 않아 감사 대조를 생략했습니다. 확인된 사실만 기재하십시오.",
      REJECT: "아래 기각 사유를 시정하고 필요한 검증 증빙을 확보한 뒤 감사 검증을 재요청하십시오.",
    },
    degradedNotice: "기각 누적 한도에 도달하였고 미검증 범위가 명시되어 제한 통과로 전환되었습니다.",
  },
};
