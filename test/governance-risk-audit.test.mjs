import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import { analyzeField } from "../scripts/analyzer.mjs";
import {
  AUDITOR_AGENT_NAME,
  AUDITOR_ROLE_LABEL,
  AUDITOR_SESSION_MARKER,
  AUDIT_PASS_TAG,
  AUDIT_REJECT_TAG,
  GATE_TOOL_NAME,
  HANDOFF_COPY,
  HANDOFF_TOOL_NAME,
  POLLUTION_WARNING_LINE,
  REGISTER_COPY,
  VERDICT_HEADERS,
  WORKER_AGENT_NAME,
  WORKER_ROLE_LABEL,
  WORKER_SESSION_MARKER,
} from "../scripts/governance/constants.mjs";
import { decideGate } from "../scripts/governance/decide-gate.mjs";
import { parseAuditVerdictFromText, readFactLedger, readGitLedger } from "../scripts/governance/fact-ledger.mjs";
import { classifyRisk, resolveAuditEscalationMode } from "../scripts/governance/risk-classifier.mjs";
import { handlePreToolGate } from "../scripts/pre-tool-gate.mjs";
import { handleStop } from "../scripts/stop.mjs";
import { createTempDir, toJsonl } from "./helpers.mjs";

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function makeLedger(overrides = {}) {
  return {
    transcriptAvailable: true,
    sessionRole: "main",
    sessionReadFiles: new Set(["auth/token.mjs"]),
    turnStartStepIndex: 0,
    turnWrittenFiles: new Set(["auth/token.mjs"]),
    turnCodeWrittenFiles: new Set(["auth/token.mjs"]),
    lastWriteStepIndex: 3,
    lastCodeWriteStepIndex: 3,
    turnExecutions: [
      {
        stepIndex: 5,
        command: "node --test test/token.test.mjs",
        kind: "verification",
        passed: true,
        status: "DONE",
        error: "",
        tail: "ℹ pass 3\nℹ fail 0",
      },
    ],
    turnFailedExecutionCount: 0,
    fileEditCounts: new Map([["auth/token.mjs", 1]]),
    turnGateAttempts: [],
    turnSubagentAudits: [],
    latestTokens: { inputTokens: 2000, cacheReadTokens: 1000, outputTokens: 300 },
    gateBlockedThisTurn: false,
    ...overrides,
  };
}

function makeGitLedger(overrides = {}) {
  return {
    gitAvailable: true,
    gitRoot: "/repo",
    gitDirtyFiles: new Set(["auth/token.mjs"]),
    diffNumstat: new Map([["auth/token.mjs", { added: 10, deleted: 2 }]]),
    gitBranch: "main",
    gitHead: "abc1234",
    ...overrides,
  };
}

function makeInput(overrides = {}) {
  return {
    modified_files: ["auth/token.mjs"],
    inspected_files: ["auth/token.mjs"],
    verification_runs: [{ command: "node --test test/token.test.mjs", outcome: "pass" }],
    unverified_scope: [],
    self_assessment: "수정 내용과 단위 테스트 결과를 직접 확인했습니다.",
    ...overrides,
  };
}

describe("risk-classifier TIER_0/TIER_1 classification and mode resolution", () => {
  it("exempts doc-only edits (empty turnCodeWrittenFiles) unconditionally as TIER_0", () => {
    const res = classifyRisk({
      turnCodeWrittenFiles: new Set(),
      gitLedger: { diffNumstat: new Map([["README.md", { added: 500, deleted: 100 }]]) },
    });
    assert.equal(res.tier, "TIER_0");
    assert.deepEqual(res.reasons, []);
    assert.equal(res.changedLines, 0);
  });

  it("classifies small non-sensitive code edits as TIER_0", () => {
    const res = classifyRisk({
      turnCodeWrittenFiles: new Set(["src/math.mjs", "test/math.test.mjs"]),
      gitLedger: { diffNumstat: new Map([["src/math.mjs", { added: 12, deleted: 3 }]]) },
    });
    assert.equal(res.tier, "TIER_0");
    assert.deepEqual(res.reasons, []);
    assert.equal(res.changedLines, 15);
  });

  it("classifies sensitive paths (auth, security, migrations, governance, workflows, Dockerfile) as TIER_1", () => {
    for (const sensitivePath of [
      "src/auth/login.mjs",
      "auth/token.mjs",
      "src/security/hmac.mjs",
      "db/migrations/001_init.sql",
      "prisma/schema.prisma",
      ".github/workflows/ci.yml",
      "Dockerfile",
      "hooks.json",
      "mcp_config.json",
      "scripts/governance/decide-gate.mjs",
      "scripts/mcp/server.mjs",
    ]) {
      const res = classifyRisk({
        turnCodeWrittenFiles: new Set([sensitivePath]),
        gitLedger: { diffNumstat: new Map([[sensitivePath, { added: 2, deleted: 0 }]]) },
      });
      assert.equal(res.tier, "TIER_1", `expected TIER_1 for ${sensitivePath}`);
      assert.ok(res.reasons.includes("sensitive_path"));
      assert.deepEqual(res.matchedSensitiveFiles, [sensitivePath]);
    }
  });

  it("classifies 4+ code files or 150+ changed lines as TIER_1", () => {
    const fourFiles = classifyRisk({
      turnCodeWrittenFiles: new Set(["src/a.mjs", "src/b.mjs", "src/c.mjs", "src/d.mjs"]),
      gitLedger: { diffNumstat: new Map([["src/a.mjs", { added: 5, deleted: 0 }]]) },
    });
    assert.equal(fourFiles.tier, "TIER_1");
    assert.deepEqual(fourFiles.reasons, ["large_file_count"]);

    const bigDiff = classifyRisk({
      turnCodeWrittenFiles: new Set(["src/a.mjs"]),
      gitLedger: { diffNumstat: new Map([["src/a.mjs", { added: 100, deleted: 50 }]]) },
    });
    assert.equal(bigDiff.tier, "TIER_1");
    assert.deepEqual(bigDiff.reasons, ["large_diff_lines"]);
    assert.equal(bigDiff.changedLines, 150);
  });

  it("resolves audit escalation precedence: HSTACK_AUDIT_ESCALATION env > config.json > auto", () => {
    const dir = createTempDir("hstack-risk-cfg-");
    const prev = process.env.HSTACK_AUDIT_ESCALATION;
    try {
      delete process.env.HSTACK_AUDIT_ESCALATION;
      assert.equal(resolveAuditEscalationMode(dir), "auto");

      writeFileSync(join(dir, "config.json"), JSON.stringify({ auditEscalation: "manual" }), "utf8");
      assert.equal(resolveAuditEscalationMode(dir), "manual");

      process.env.HSTACK_AUDIT_ESCALATION = "off";
      assert.equal(resolveAuditEscalationMode(dir), "off");

      process.env.HSTACK_AUDIT_ESCALATION = "invalid-mode";
      assert.equal(resolveAuditEscalationMode(dir), "manual");
    } finally {
      if (prev === undefined) delete process.env.HSTACK_AUDIT_ESCALATION;
      else process.env.HSTACK_AUDIT_ESCALATION = prev;
    }
  });
});

describe("decideGate independent audit escalation, R8, stale invalidation, E9/E10, and precedence", () => {
  it("prioritizes R1-R6 deterministic rejections over audit escalation", () => {
    const res = decideGate(makeInput({ inspected_files: ["auth/token.mjs", "auth/unread.mjs"] }), {
      ledger: makeLedger(),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "REJECT");
    assert.deepEqual(res.blockedRules, ["R1_UNREAD_INSPECTED"]);
  });

  it("escalates TIER_1 main-session edits when no post-write audit exists", () => {
    const res = decideGate(makeInput(), {
      ledger: makeLedger(),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "ESCALATE_AUDIT_REQUIRED");
    assert.equal(res.passed, false);
    assert.equal(res.risk.tier, "TIER_1");
    assert.ok(res.receiptText.startsWith(VERDICT_HEADERS.ESCALATE_AUDIT_REQUIRED));
    assert.ok(res.receiptText.includes("hstack-auditor"));
    assert.ok(res.receiptText.includes("독립 코드 감사관"));
  });

  it("skips escalation when auditEscalation is off or manual, or sessionRole is auditor", () => {
    for (const mode of ["off", "manual"]) {
      const res = decideGate(makeInput(), {
        ledger: makeLedger(),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
        auditEscalation: mode,
      });
      assert.equal(res.verdict, "PASS");
    }

    const auditorRes = decideGate(makeInput(), {
      ledger: makeLedger({ sessionRole: "auditor" }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(auditorRes.verdict, "PASS");
  });

  it("blocks with R8_AUDIT_REJECTED when latest post-write audit rejected and invalidates stale PASS after code rewrite", () => {
    const rejected = decideGate(makeInput(), {
      ledger: makeLedger({
        turnSubagentAudits: [{ stepIndex: 6, typeName: AUDITOR_AGENT_NAME, verdict: "REJECT" }],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(rejected.verdict, "REJECT");
    assert.deepEqual(rejected.blockedRules, ["R8_AUDIT_REJECTED"]);

    const stale = decideGate(makeInput(), {
      ledger: makeLedger({
        lastCodeWriteStepIndex: 8,
        turnExecutions: [{ stepIndex: 9, command: "node --test test/token.test.mjs", kind: "verification", passed: true }],
        turnSubagentAudits: [{ stepIndex: 6, typeName: AUDITOR_AGENT_NAME, verdict: "PASS" }],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(stale.verdict, "ESCALATE_AUDIT_REQUIRED");
  });

  it("passes with 독립 감사: 통과 when post-write audit passed and appends pollution warning when requested", () => {
    const res = decideGate(makeInput(), {
      ledger: makeLedger({
        turnSubagentAudits: [{ stepIndex: 7, typeName: AUDITOR_AGENT_NAME, verdict: "PASS" }],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
      pollutionAlert: true,
    });
    assert.equal(res.verdict, "PASS");
    assert.equal(res.passed, true);
    assert.ok(res.receiptText.includes("독립 감사: 통과"));
    assert.ok(res.receiptText.includes("[컨텍스트 열화 주의]"));
  });

  it("applies E9 escape after 2 audit rejections when unverified_scope is non-empty", () => {
    const blockedNoScope = decideGate(makeInput({ unverified_scope: [] }), {
      ledger: makeLedger({
        turnSubagentAudits: [
          { stepIndex: 6, typeName: AUDITOR_AGENT_NAME, verdict: "REJECT" },
          { stepIndex: 8, typeName: AUDITOR_AGENT_NAME, verdict: "REJECT" },
        ],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(blockedNoScope.verdict, "REJECT");
    assert.deepEqual(blockedNoScope.blockedRules, ["R8_AUDIT_REJECTED"]);

    const degraded = decideGate(
      makeInput({ unverified_scope: ["외부 인증 서버 키 로테이션 정책은 로컬에서 재현할 수 없음"] }),
      {
        ledger: makeLedger({
          turnSubagentAudits: [
            { stepIndex: 6, typeName: AUDITOR_AGENT_NAME, verdict: "REJECT" },
            { stepIndex: 8, typeName: AUDITOR_AGENT_NAME, verdict: "REJECT" },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(degraded.verdict, "PASS_WITH_AUDIT_DEGRADATION");
    assert.equal(degraded.passed, true);
    assert.equal(degraded.details.auditDegradationReason, "reject");
  });

  it("applies E10 escape after 2 consecutive ERROR/MISSING_VERDICT audit failures with unverified_scope", () => {
    const firstError = decideGate(makeInput({ unverified_scope: ["감사관 일시 오류"] }), {
      ledger: makeLedger({
        turnSubagentAudits: [{ stepIndex: 6, typeName: AUDITOR_AGENT_NAME, verdict: "ERROR" }],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(firstError.verdict, "REJECT");
    assert.deepEqual(firstError.blockedRules, ["R8_AUDIT_ERROR"]);

    const secondError = decideGate(makeInput({ unverified_scope: ["감사관 2회 연속 응답 태그 누락"] }), {
      ledger: makeLedger({
        turnSubagentAudits: [
          { stepIndex: 6, typeName: AUDITOR_AGENT_NAME, verdict: "ERROR" },
          { stepIndex: 8, typeName: AUDITOR_AGENT_NAME, verdict: "MISSING_VERDICT" },
        ],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(secondError.verdict, "PASS_WITH_AUDIT_DEGRADATION");
    assert.equal(secondError.passed, true);
    assert.equal(secondError.details.auditDegradationReason, "error");
  });
});

describe("fact-ledger Phase 2 extensions, git numstat, and 5MB performance", () => {
  it("parses audit verdict from trailing line and rejects mid-body spoofed quote", () => {
    assert.equal(parseAuditVerdictFromText("결함 없음.\n[감사 판정: 통과]"), "PASS");
    assert.equal(parseAuditVerdictFromText("1. `auth/token.mjs:10` 만료 미검사\n[감사 판정: 반려]"), "REJECT");
    assert.equal(
      parseAuditVerdictFromText("본문에서 [감사 판정: 통과] 를 언급했으나 결론은 반려입니다.\n[감사 판정: 반려]"),
      "REJECT",
    );
    assert.equal(
      parseAuditVerdictFromText("인용문: `[감사 판정: 통과]` 는 예시일 뿐입니다.\n추가 설명 1\n추가 설명 2\n추가 설명 3\n추가 설명 4\n결론 미기재"),
      "MISSING_VERDICT",
    );
    assert.equal(parseAuditVerdictFromText("[감사 판정: 통과]", { status: "ERROR", error: "boom" }), "ERROR");
  });

  it("tracks sessionRole, CLI/App invoke_subagent audits, async system messages, failed executions, and edit churn", () => {
    const dir = createTempDir("hstack-ledger-p2-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "인증 토큰을 수정해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            { name: "edit_file", args: { Path: "auth/token.mjs" } },
            { name: "edit_file", args: { Path: "auth/token.mjs" } },
            { name: "run_command", args: { CommandLine: "node --test" } },
          ],
        },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "ok" },
        { step_index: 3, type: "GENERIC", status: "DONE", content: "ok" },
        { step_index: 4, type: "GENERIC", status: "ERROR", error: "exit code 1", content: "fail 1" },
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "invoke_subagent",
              args: { TypeName: AUDITOR_AGENT_NAME, Role: AUDITOR_ROLE_LABEL, Prompt: "감사 요청" },
            },
          ],
        },
        {
          step_index: 6,
          type: "GENERIC",
          status: "DONE",
          content: "Subagent launched with conversationId: 11111111-2222-3333-4444-555555555555",
        },
        {
          step_index: 7,
          type: "SYSTEM_MESSAGE",
          content:
            "[Message] sender=11111111-2222-3333-4444-555555555555 content=검토 완료. 결함 없음.\n[감사 판정: 통과]",
        },
        {
          step_index: 8,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "invoke_subagent",
              args: { Subagents: [{ TypeName: AUDITOR_AGENT_NAME, Role: "audit", Prompt: "App 스키마" }] },
            },
          ],
        },
        {
          step_index: 9,
          type: "GENERIC",
          status: "DONE",
          content: "치명 결함 확인\n[감사 판정: 반려]",
        },
      ]),
      "utf8",
    );

    const ledger = readFactLedger(transcriptPath, "/repo", "/repo");
    assert.equal(ledger.sessionRole, "main");
    assert.equal(ledger.turnFailedExecutionCount, 1);
    assert.equal(ledger.fileEditCounts.get("auth/token.mjs"), 2);
    assert.equal(ledger.turnSubagentAudits.length, 2);
    assert.equal(ledger.turnSubagentAudits[0].verdict, "PASS");
    assert.equal(ledger.turnSubagentAudits[0].stepIndex, 7);
    assert.equal(ledger.turnSubagentAudits[1].verdict, "REJECT");

    const auditorPath = join(dir, "auditor.jsonl");
    writeFileSync(
      auditorPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: `코드 검토\n\n${AUDITOR_SESSION_MARKER}` },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "write_file", args: { Path: "a.mjs" } }] },
      ]),
      "utf8",
    );
    assert.equal(readFactLedger(auditorPath, "/repo", "/repo").sessionRole, "auditor");
  });

  it("collects diffNumstat for modified tracked files and untracked code files, including repos without HEAD", () => {
    const repo = createTempDir("hstack-git-numstat-");
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.email", "test@example.com"]);
    runGit(repo, ["config", "user.name", "Test"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "unborn.mjs"), "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf8");
    const unbornLedger = readGitLedger(repo);
    assert.equal(unbornLedger.gitAvailable, true);
    assert.equal(unbornLedger.diffNumstat.get("src/unborn.mjs")?.added, 3);

    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "init"]);
    writeFileSync(join(repo, "src", "unborn.mjs"), "const a = 10;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n", "utf8");
    writeFileSync(join(repo, "src", "newfile.mjs"), "export const x = 1;\nexport const y = 2;\n", "utf8");
    writeFileSync(join(repo, "NOTES.md"), "line1\nline2\nline3\n", "utf8");

    const ledger = readGitLedger(repo);
    assert.equal(ledger.diffNumstat.get("src/unborn.mjs")?.added, 3);
    assert.equal(ledger.diffNumstat.get("src/unborn.mjs")?.deleted, 2);
    assert.equal(ledger.diffNumstat.get("src/newfile.mjs")?.added, 2);
    assert.equal(ledger.diffNumstat.has("NOTES.md"), false);
    assert.ok(ledger.gitHead.length >= 7);
  });

  it("keeps 5MB readFactLedger median scan latency <= 100ms", () => {
    const dir = createTempDir("hstack-perf-5mb-");
    const filePath = join(dir, "transcript_full.jsonl");
    const bigChunk = "x".repeat(48_000);
    const lines = [JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "성능 측정" })];
    let step = 1;
    for (let i = 0; i < 105; i += 1) {
      lines.push(
        JSON.stringify({
          step_index: step++,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "read_file", args: { Path: `src/file-${i}.mjs` } }],
        }),
      );
      lines.push(JSON.stringify({ step_index: step++, type: "GENERIC", status: "DONE", content: bigChunk }));
    }
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");

    const samples = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      const ledger = readFactLedger(filePath, "/repo", "/repo");
      samples.push(performance.now() - t0);
      assert.equal(ledger.sessionReadFiles.size, 105);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[2];
    assert.ok(medianMs <= 100, `Expected 5MB readFactLedger median <= 100ms, got ${medianMs.toFixed(2)}ms`);
  });
});

describe("pre-tool-gate invoke_subagent dual-schema overwrite and stop.mjs auditor recursion guard", () => {
  it("injects Korean Role and context marker for CLI and App invoke_subagent while ignoring other subagents", () => {
    const dir = createTempDir("hstack-pretool-subagent-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "이전 턴" },
        { step_index: 4, type: "USER_INPUT", content: "현재 턴" },
      ]),
      "utf8",
    );

    const cliOut = handlePreToolGate(
      JSON.stringify({
        hookEventName: "PreToolUse",
        cwd: "/repo",
        transcriptPath,
        toolCall: {
          name: "invoke_subagent",
          args: { TypeName: AUDITOR_AGENT_NAME, Role: "Code Auditor", Prompt: "변경 검토" },
        },
      }),
    );
    assert.equal(cliOut.decision, "allow");
    assert.equal(cliOut.overwrite.Role, AUDITOR_ROLE_LABEL);
    assert.ok(cliOut.overwrite.Prompt.includes(AUDITOR_SESSION_MARKER));
    assert.ok(cliOut.overwrite.Prompt.includes(transcriptPath));
    assert.ok(cliOut.overwrite.Prompt.includes("`4`"));

    const appOut = handlePreToolGate(
      JSON.stringify({
        hookEventName: "PreToolUse",
        cwd: "/repo",
        transcriptPath,
        toolCall: {
          name: "invoke_subagent",
          args: {
            Subagents: [
              { TypeName: "research", Role: "탐색기", Prompt: "탐색" },
              { TypeName: WORKER_AGENT_NAME, Role: "Worker", Prompt: "구현" },
            ],
          },
        },
      }),
    );
    assert.equal(appOut.decision, "allow");
    assert.equal(appOut.overwrite.Subagents[0].Role, "탐색기");
    assert.equal(appOut.overwrite.Subagents[1].Role, WORKER_ROLE_LABEL);
    assert.ok(appOut.overwrite.Subagents[1].Prompt.includes(WORKER_SESSION_MARKER));

    const otherOut = handlePreToolGate(
      JSON.stringify({
        hookEventName: "PreToolUse",
        cwd: "/repo",
        transcriptPath,
        toolCall: {
          name: "invoke_subagent",
          args: { TypeName: "research", Role: "연구자", Prompt: "확인" },
        },
      }),
    );
    assert.deepEqual(otherOut, { decision: "allow" });

    const handoffOut = handlePreToolGate(
      JSON.stringify({
        hookEventName: "PreToolUse",
        cwd: "/repo",
        conversationId: "conv-1",
        transcriptPath,
        toolCall: { name: HANDOFF_TOOL_NAME, args: { action: "list" } },
      }),
    );
    assert.equal(handoffOut.decision, "auto_approve");
    assert.equal(handoffOut.overwrite.toolSummary, "팩트 증류 컨텍스트 핸드오프 처리");
    assert.equal(handoffOut.overwrite._session.conversationId, "conv-1");
  });

  it("bypasses governance Stop blocking for [hstack:독립감사] sessions while keeping escalation non-passing in main sessions", () => {
    const dir = createTempDir("hstack-stop-auditor-");
    const auditorTranscript = join(dir, "auditor_full.jsonl");
    writeFileSync(
      auditorTranscript,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: `독립 검토 요청\n${AUDITOR_SESSION_MARKER}` },
        { step_index: 1, type: "PLANNER_RESPONSE", thinking: "한국어로 검토합니다.", tool_calls: [{ name: "write_file", args: { Path: "tmp.mjs" } }] },
        { step_index: 2, type: "PLANNER_RESPONSE", thinking: "검토를 마칩니다.", content: "결함이 없습니다.\n[감사 판정: 통과]" },
      ]),
      "utf8",
    );

    const auditorStop = handleStop(
      JSON.stringify({
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
        executionNum: 0,
        cwd: dir,
        transcriptPath: auditorTranscript,
      }),
    );
    assert.deepEqual(auditorStop, {});

    const mainEscalatedTranscript = join(dir, "main_full.jsonl");
    writeFileSync(
      mainEscalatedTranscript,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "인증 파일 수정해 줘" },
        { step_index: 1, type: "PLANNER_RESPONSE", thinking: "수정합니다.", tool_calls: [{ name: "edit_file", args: { Path: "auth/token.mjs" } }] },
        { step_index: 2, type: "PLANNER_RESPONSE", thinking: "검증 호출합니다.", tool_calls: [{ name: GATE_TOOL_NAME, args: {} }] },
        { step_index: 3, type: "GENERIC", status: "DONE", content: `${VERDICT_HEADERS.ESCALATE_AUDIT_REQUIRED}\n독립 감사 필요` },
        { step_index: 4, type: "PLANNER_RESPONSE", thinking: "완료합니다.", content: "작업을 마쳤습니다." },
      ]),
      "utf8",
    );

    const mainStop = handleStop(
      JSON.stringify({
        hookEventName: "Stop",
        terminationReason: "NO_TOOL_CALL",
        executionNum: 0,
        cwd: dir,
        transcriptPath: mainEscalatedTranscript,
      }),
    );
    assert.equal(mainStop.decision, "continue");
  });
});

describe("Phase 2 Korean copy compliance with scripts/analyzer.mjs", () => {
  it("ensures all new escalation, rejection, pollution, and handoff copy passes analyzeField as korean", () => {
    const samples = [
      POLLUTION_WARNING_LINE,
      ...Object.values(HANDOFF_COPY),
      REGISTER_COPY.neutral.summaries.ESCALATE_AUDIT_REQUIRED,
      REGISTER_COPY.neutral.summaries.PASS_WITH_AUDIT_DEGRADATION,
      REGISTER_COPY.neutral.auditDegradedRejectNotice,
      REGISTER_COPY.neutral.auditDegradedErrorNotice,
      REGISTER_COPY.neutral.ruleMessages.R8_AUDIT_REJECTED(),
      REGISTER_COPY.neutral.ruleMessages.R8_AUDIT_ERROR(),
      REGISTER_COPY.audit.summaries.ESCALATE_AUDIT_REQUIRED,
      REGISTER_COPY.audit.summaries.PASS_WITH_AUDIT_DEGRADATION,
      REGISTER_COPY.audit.auditDegradedRejectNotice,
      REGISTER_COPY.audit.auditDegradedErrorNotice,
      REGISTER_COPY.audit.ruleMessages.R8_AUDIT_REJECTED(),
      REGISTER_COPY.audit.ruleMessages.R8_AUDIT_ERROR(),
    ];
    for (const sample of samples) {
      const analysis = analyzeField("content", sample);
      assert.equal(analysis.status, "korean", `expected korean status for: ${sample} (got ${JSON.stringify(analysis)})`);
    }
  });
});
