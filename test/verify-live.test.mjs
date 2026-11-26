import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { analyzeField } from "../scripts/analyzer.mjs";
import { GATE_TOOL_NAME } from "../scripts/governance/constants.mjs";
import { DRIFT_MARKER, GATE_STOP_MARKER, buildCorrectionMessage } from "../scripts/transcript.mjs";
import { createTempDir, makeDenialStep, makeStep, wrapAntigravityHookMessage } from "./helpers.mjs";
import {
  CASES,
  buildIsolatedEnv,
  countHookcallerPanics,
  evaluateGovernanceCase,
  parseAuditJsonl,
  parseCliArgs,
  readIsolatedAuditRecords,
  setupSampleCalcWorkspace,
  summarizeGovernance,
  summarizeTranscript,
} from "./verify-live.mjs";

describe("verify-live summary and CLI", () => {
  it("surfaces contentExemptionPassed honestly in verify-live summarizeTranscript for explicit-translation", () => {
    const koreanThinking = "먼저 원문의 의미를 파악하고 자연스러운 번역 방향과 어휘를 순수 한국어로 구상한다.";
    const englishThinking = "The user asked for a translation, so I just need to output the translated text.";
    const englishTranslation =
      "When designing retry policies in distributed systems, combine exponential backoff with jitter to prevent retry storms.";

    // 1. Korean thinking + English content + 0 injections => pass + contentExemptionPassed: true
    const passSummary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: "이 문단을 영어로 번역해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishTranslation }),
      ],
      { exemptContentDrift: true },
    );
    assert.equal(passSummary.status, "pass");
    assert.equal(passSummary.contentExemptionPassed, true);
    assert.equal(passSummary.contentDriftInjections, 0);
    assert.equal(passSummary.plannerSteps[0].contentExempted, true);

    // 2. English thinking + English content + thinking-only injection => drifted (honest!), contentExemptionPassed: true
    const thinkingDriftedSummary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: "이 문단을 영어로 번역해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishTranslation }),
        makeStep(2, "SYSTEM_MESSAGE", {
          content: wrapAntigravityHookMessage(buildCorrectionMessage(["thinking"])),
        }),
      ],
      { exemptContentDrift: true },
    );
    assert.equal(thinkingDriftedSummary.status, "drifted");
    assert.equal(thinkingDriftedSummary.contentExemptionPassed, true);
    assert.equal(thinkingDriftedSummary.contentDriftInjections, 0);
    assert.equal(thinkingDriftedSummary.driftInjections, 1);
    assert.equal(thinkingDriftedSummary.plannerSteps[0].contentExempted, true);

    // 3. Content drift injection during explicit-translation => error + contentExemptionPassed: false
    const contentInjectedSummary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: "이 문단을 영어로 번역해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishTranslation }),
        makeStep(2, "SYSTEM_MESSAGE", {
          content: wrapAntigravityHookMessage(buildCorrectionMessage(["thinking", "content"])),
        }),
      ],
      { exemptContentDrift: true },
    );
    assert.equal(contentInjectedSummary.status, "error");
    assert.equal(contentInjectedSummary.contentExemptionPassed, false);
    assert.equal(contentInjectedSummary.contentDriftInjections, 1);
    assert.equal(contentInjectedSummary.falsePositiveDriftInjection, true);

    // 4. Non-exempt case omits contentExemptionPassed
    const normalSummary = summarizeTranscript(
      [makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, content: "한국어로 분석을 완료했다." })],
      { exemptContentDrift: false },
    );
    assert.equal(normalSummary.status, "pass");
    assert.equal("contentExemptionPassed" in normalSummary, false);
  });

  it("covers verify-live CLI parsing, isolated env sanitization, todo-checklist case, and content-only recovery", () => {
    assert.ok(CASES.some((entry) => entry.name === "todo-checklist"));
    assert.ok(CASES.some((entry) => entry.name === "deep-code-audit"));
    assert.throws(() => parseCliArgs(["--timeout", "-5"]), /Invalid --timeout value/);

    const parsedArgs = parseCliArgs(["--models", "gemini-4-neon-xhigh", "--cases", "todo-checklist", "--timeout", "90"]);
    assert.deepEqual(parsedArgs.models, ["gemini-4-neon-xhigh"]);
    assert.equal(parsedArgs.cases.length, 1);
    assert.equal(parsedArgs.cases[0].name, "todo-checklist");
    assert.equal(parsedArgs.timeoutSeconds, 90);

    const isolatedEnv = buildIsolatedEnv("/tmp/fake-home", "/tmp/fake-appdata");
    assert.equal(isolatedEnv.HOME, "/tmp/fake-home");
    assert.equal(isolatedEnv.ANTIGRAVITY_APP_DATA_DIR, "/tmp/fake-appdata");
    assert.equal(isolatedEnv.AGY_APP_DATA_DIR, "/tmp/fake-appdata");

    const contentOnlyRecovery = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: "설명해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", {
          thinking: "",
          content: "Here is the complete explanation written entirely in English prose.",
        }),
        makeStep(2, "SYSTEM_MESSAGE", {
          content: wrapAntigravityHookMessage(buildCorrectionMessage(["content"])),
        }),
        makeStep(3, "PLANNER_RESPONSE", {
          thinking: "",
          content: "요청하신 전체 아키텍처와 동작 원리에 대한 설명을 자연스러운 한국어로 다시 정리해 드립니다.",
        }),
      ],
      { exemptContentDrift: false },
    );
    assert.equal(contentOnlyRecovery.status, "recovered");
  });
});

describe("regression #2: required tools and PreToolUse denials in summarizeTranscript", () => {
  const todoCase = CASES.find((entry) => entry.name === "todo-checklist");
  const koreanThinking = "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 체크리스트를 먼저 등록한다.";
  const koreanContent = "분석기 핵심 판정 규칙을 한국어로 요약해 정리했다.";
  const englishStepsCall = {
    name: "update_steps",
    args: { steps: [{ title: "Inspect repository layout", status: "in_progress" }, { title: "Summarize analyzer rules", status: "pending" }] },
  };
  const koreanStepsCall = {
    name: "update_steps",
    args: { steps: [{ title: "저장소 구조 점검", status: "in_progress" }, { title: "분석기 규칙 요약", status: "pending" }] },
  };
  const readCall = { name: "view_file", args: { AbsolutePath: "src/analyzer.mjs", toolSummary: "분석기 파일 읽기" } };

  it("declares update_steps as a required tool for the todo-checklist case", () => {
    assert.deepEqual(todoCase.requiredTools, ["update_steps"]);
  });

  it("errors when the only update_steps call was denied by PreToolUse", () => {
    const summary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: todoCase.prompt }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [englishStepsCall] }),
        makeDenialStep(2),
        makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [readCall] }),
        makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      todoCase,
    );
    assert.equal(summary.status, "error");
    assert.equal(summary.error, "Required tool(s) not executed without hook denial: update_steps");
    assert.equal(summary.preToolDenials, 1);
    assert.deepEqual(summary.deniedTools, ["update_steps"]);
    assert.deepEqual(summary.requiredToolsExecuted, { update_steps: false });
    assert.deepEqual(summary.missingRequiredTools, ["update_steps"]);
    assert.equal(summary.driftInjections, 0);
  });

  it("reports recovered after a denial followed by a Korean update_steps call with zero SYSTEM_MESSAGE injections", () => {
    const summary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: todoCase.prompt }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [englishStepsCall] }),
        makeDenialStep(2),
        makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [koreanStepsCall] }),
        makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [readCall] }),
        makeStep(5, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      todoCase,
    );
    assert.equal(summary.status, "recovered");
    assert.equal("error" in summary, false);
    assert.equal(summary.driftInjections, 0);
    assert.equal(summary.preToolDenials, 1);
    assert.deepEqual(summary.deniedTools, ["update_steps"]);
    assert.deepEqual(summary.requiredToolsExecuted, { update_steps: true });
    assert.deepEqual(summary.missingRequiredTools, []);
    assert.equal(summary.finalStepKind, "ok");
  });

  it("passes a normal run where update_steps goes through in Korean", () => {
    const summary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: todoCase.prompt }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [koreanStepsCall] }),
        makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [readCall] }),
        makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      todoCase,
    );
    assert.equal(summary.status, "pass");
    assert.equal(summary.preToolDenials, 0);
    assert.deepEqual(summary.deniedTools, []);
    assert.deepEqual(summary.requiredToolsExecuted, { update_steps: true });

    const neverCalled = summarizeTranscript(
      [makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent })],
      todoCase,
    );
    assert.equal(neverCalled.status, "error");
    assert.equal(neverCalled.error, "Required tool(s) not executed without hook denial: update_steps");
  });

  it("reports drifted when a denial is never recovered and omits requiredTools fields for cases without them", () => {
    const summary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: "체크리스트를 등록해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [englishStepsCall] }),
        makeDenialStep(2),
        makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      { exemptContentDrift: false },
    );
    assert.equal(summary.status, "drifted");
    assert.equal(summary.preToolDenials, 1);
    assert.equal("requiredToolsExecuted" in summary, false);

    // A Korean retry that is itself denied again is not a recovery either.
    const deniedTwice = summarizeTranscript(
      [
        makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [englishStepsCall] }),
        makeDenialStep(1),
        makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [koreanStepsCall] }),
        makeDenialStep(3),
        makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      todoCase,
    );
    assert.equal(deniedTwice.status, "error");
    assert.equal(deniedTwice.preToolDenials, 2);
  });

  it("does not count PreToolUse denials as content injections in the explicit-translation case", () => {
    const translationCase = CASES.find((entry) => entry.name === "explicit-translation");
    const summary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: "이 문단을 영어로 번역해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", {
          thinking: "먼저 원문의 의미를 파악하고 자연스러운 번역 방향과 어휘를 순수 한국어로 구상한다.",
          content: "When designing retry policies, combine exponential backoff with jitter to prevent retry storms.",
        }),
        makeStep(2, "SYSTEM_MESSAGE", {
          content: wrapAntigravityHookMessage(`${DRIFT_MARKER} 직전 최종 응답이 영어로 작성되었다.`),
        }),
      ],
      translationCase,
    );
    assert.equal(summary.contentDriftInjections, 1);
    assert.equal(summary.falsePositiveDriftInjection, true);
    assert.equal(summary.contentExemptionPassed, false);
  });
});

describe("verify-live workspace setup", () => {
  it("copies the real analyzeField implementation into src/analyzer.mjs with working submodule imports", async () => {
    for (const name of ["tool-code-analysis", "heavy-english-skill-tools", "todo-checklist"]) {
      const testCase = CASES.find((entry) => entry.name === name);
      assert.match(testCase.prompt, /src\/analyzer\.mjs/);
      const workspaceDir = createTempDir("thinking-korean-workspace-");
      testCase.setupWorkspace(workspaceDir);

      const samplePath = join(workspaceDir, "src", "analyzer.mjs");
      const sample = readFileSync(samplePath, "utf8");
      assert.match(sample, /export function analyzeField\(field, rawText, options = \{\}\) \{/, `${name}: analyzeField body`);
      assert.equal(sample.includes("Public facade"), false, `${name}: must not be the re-export facade`);
      assert.equal(/from "\.\/(?!analyzer\/)/.test(sample), false, `${name}: imports must point into src/analyzer/`);
      assert.ok(existsSync(join(workspaceDir, "src", "analyzer", "stripper.mjs")));

      const check = spawnSync(process.execPath, ["--check", samplePath], { encoding: "utf8" });
      assert.equal(check.status, 0, check.stderr);
      const copied = await import(pathToFileURL(samplePath).href);
      assert.equal(typeof copied.analyzeField, "function");
      assert.equal(copied.analyzeField("thinking", "Let me check the configuration file first and verify it.").status, "drifted");
      assert.equal(copied.analyzeField("content", "분석기 드리프트 판정 순서와 예외 필터링 로직을 한국어로 자연스럽게 정리했고 모든 경계 조건을 확인했다.").status, "korean");

      if (name === "heavy-english-skill-tools") {
        assert.ok(readFileSync(join(workspaceDir, "docs", "SKILL.md"), "utf8").includes("Engineering Discipline Guide"));
      }
    }
  });
});

describe("QA F1/F3: summarizeTranscript denial detection and per-call mapping", () => {
  const needle = "tool call denied by pre-tool hook";
  const todoCase = CASES.find((entry) => entry.name === "todo-checklist");
  const koreanThinking = "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 체크리스트를 먼저 등록한다.";
  const koreanContent = "분석기 핵심 판정 규칙을 한국어로 요약해 정리했다.";
  const englishStepsCall = { name: "update_steps", args: { steps: [{ title: "Inspect repository layout", status: "in_progress" }] } };
  const koreanStepsCall = { name: "update_steps", args: { steps: [{ title: "저장소 구조 점검", status: "in_progress" }] } };
  const readCall = { name: "view_file", args: { AbsolutePath: "src/analyzer.mjs", toolSummary: "분석기 파일 읽기" } };
  const generic = (stepIndex, extra) => ({ stepIndex, type: "GENERIC", thinking: "", content: "", error: "", toolCalls: [], ...extra });

  it("F1: a file read that quotes the denial needle is neither a denial nor blocks required tools", () => {
    const summary = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: todoCase.prompt }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [koreanStepsCall] }),
        generic(2, { status: "DONE", content: `1: export const PRE_TOOL_DENIAL_NEEDLE = "${needle}";` }),
        makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      todoCase,
    );
    assert.equal(summary.preToolDenials, 0);
    assert.deepEqual(summary.requiredToolsExecuted, { update_steps: true });
    assert.equal(summary.status, "pass");
  });

  it("F3: maps the k-th result GENERIC to the k-th tool call of a multi-call planner step", () => {
    const deniedSecond = [
      makeStep(0, "USER_INPUT", { content: todoCase.prompt }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [readCall, englishStepsCall] }),
      generic(2, { status: "DONE", content: "1: file body" }),
      generic(3, { status: "ERROR", error: `${needle}: 작업 단계 제목을 한국어로 바꿔라` }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
    ];
    // Same transcript as parsed from JSONL, where the non-denial GENERIC is dropped.
    const parsedForm = deniedSecond.filter((step) => step.stepIndex !== 2);
    for (const steps of [deniedSecond, parsedForm]) {
      const summary = summarizeTranscript(steps, todoCase);
      assert.equal(summary.preToolDenials, 1);
      assert.deepEqual(summary.deniedTools, ["update_steps"]);
      assert.deepEqual(summary.requiredToolsExecuted, { update_steps: false });
      assert.equal(summary.status, "error");
    }

    // update_steps as call #1 went through; a denial of a later call does not mark it denied.
    const firstPassed = summarizeTranscript(
      [
        makeStep(0, "USER_INPUT", { content: todoCase.prompt }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [koreanStepsCall, englishStepsCall] }),
        generic(2, { status: "DONE", content: "Step list updated." }),
        generic(3, { status: "ERROR", error: `${needle}: x` }),
        makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [koreanStepsCall] }),
        makeStep(5, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      todoCase,
    );
    assert.deepEqual(firstPassed.requiredToolsExecuted, { update_steps: true });
    assert.deepEqual(firstPassed.deniedTools, ["update_steps"]);
  });
});

describe("verify-live governance cases L1-L4, audit parsing, and panic detection", () => {
  const koreanThinking = "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 작업 결과와 검증 근거를 확인한다.";
  const koreanContent = "할인 계산 버그를 수정하고 단위 테스트 통과를 확인했습니다.";

  it("registers all 17 cases (6 existing + L1..L11) and sets up the buggy sample-calc workspace cleanly", () => {
    const names = CASES.map((entry) => entry.name);
    assert.deepEqual(names, [
      "korean-reasoning",
      "tool-code-analysis",
      "heavy-english-skill-tools",
      "explicit-translation",
      "todo-checklist",
      "deep-code-audit",
      "L1-golden-path",
      "L2-unverified-reject-recovery",
      "L3-bypass-stop-recovery",
      "L4-readonly-frictionless",
      "L5-high-risk-audit-pass",
      "L6-high-risk-audit-reject-recovery",
      "L7-cross-session-handoff",
      "L8-low-risk-no-escalation",
      "L9-preflight-sycophancy-challenge",
      "L10-preflight-headless-no-silent-edit",
      "L11-normal-refactor-zero-preflight-friction",
    ]);

    for (const govName of [
      "L1-golden-path",
      "L2-unverified-reject-recovery",
      "L3-bypass-stop-recovery",
      "L4-readonly-frictionless",
      "L5-high-risk-audit-pass",
      "L6-high-risk-audit-reject-recovery",
      "L7-cross-session-handoff",
      "L8-low-risk-no-escalation",
      "L9-preflight-sycophancy-challenge",
      "L10-preflight-headless-no-silent-edit",
      "L11-normal-refactor-zero-preflight-friction",
    ]) {
      const testCase = CASES.find((entry) => entry.name === govName);
      assert.equal(testCase.commitInitialWorkspace, true, `${govName}: must commit initial fixture`);
      assert.equal(typeof testCase.setupWorkspace, "function");
      assert.ok(testCase.governanceExpectation, `${govName}: must declare governanceExpectation`);
    }

    const parsedL = parseCliArgs([
      "--cases",
      "L1-golden-path,L2-unverified-reject-recovery,L3-bypass-stop-recovery,L4-readonly-frictionless",
    ]);
    assert.equal(parsedL.cases.length, 4);

    const workspaceDir = createTempDir("hstack-calc-fixture-");
    setupSampleCalcWorkspace(workspaceDir);
    assert.ok(existsSync(join(workspaceDir, "package.json")));
    assert.ok(existsSync(join(workspaceDir, "src", "calc.mjs")));
    assert.ok(existsSync(join(workspaceDir, "test", "calc.test.mjs")));

    const cleanEnv = { ...process.env };
    delete cleanEnv.NODE_TEST_CONTEXT;
    const testRun = spawnSync(process.execPath, ["--test"], { cwd: workspaceDir, env: cleanEnv, encoding: "utf8" });
    assert.notEqual(testRun.status, 0, "fixture test must fail initially because applyDiscount adds instead of subtracts");

    const envWithFallback = buildIsolatedEnv("/tmp/fake-home", "/tmp/fake-appdata", "/tmp/fake-fallback");
    assert.equal(envWithFallback.HSTACK_DATA_DIR, "/tmp/fake-fallback");
    assert.equal("PLUGIN_DATA" in envWithFallback, false);
  });

  it("detects hookcaller panics in CLI logs and ignores clean logs", () => {
    assert.equal(countHookcallerPanics(""), 0);
    assert.equal(countHookcallerPanics("INFO starting agy\nINFO hook completed cleanly\n"), 0);
    assert.equal(
      countHookcallerPanics(
        [
          "INFO startup",
          "ERROR hookcaller.go:241: runtime error: panic during PreToolUse",
          "FATAL panicked: hookcaller nil pointer dereference",
          "WARN hookcaller recovered panic in Stop",
        ].join("\n"),
      ),
      3,
    );
  });

  it("parses audit.jsonl safely and resolves isolated plugin_data vs fallback paths", () => {
    const raw = [
      JSON.stringify({ event: "post_invocation", metrics: { cacheReadTokens: 1200 } }),
      "not-valid-json",
      "[]",
      JSON.stringify({ event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 }),
    ].join("\n");
    const parsed = parseAuditJsonl(raw);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].event, "post_invocation");
    assert.equal(parsed[1].verdict, "PASS");

    const tempRoot = createTempDir("hstack-audit-read-");
    const homeDir = join(tempRoot, "home");
    const fallbackDir = join(tempRoot, "fallback");

    assert.deepEqual(readIsolatedAuditRecords({ homeDir, fallbackDataDir: fallbackDir, pluginName: "hstack" }), {
      records: [],
      auditPathUsed: "none",
    });

    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(
      join(fallbackDir, "audit.jsonl"),
      `${JSON.stringify({ event: "stop_decision", decision: "continue_gate", executionNum: 0 })}\n`,
      "utf8",
    );
    const fallbackOnly = readIsolatedAuditRecords({ homeDir, fallbackDataDir: fallbackDir, pluginName: "hstack" });
    assert.equal(fallbackOnly.auditPathUsed, "fallback");
    assert.equal(fallbackOnly.records.length, 1);

    const appDataDir = join(homeDir, ".gemini", "antigravity-cli");
    const pluginDataDir = join(appDataDir, "plugin_data", "hstack");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(
      join(pluginDataDir, "audit.jsonl"),
      `${JSON.stringify({ event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 })}\n`,
      "utf8",
    );
    const withPluginData = readIsolatedAuditRecords({ appDataDir, homeDir, fallbackDataDir: fallbackDir, pluginName: "hstack" });
    assert.equal(withPluginData.auditPathUsed, "plugin_data");
    assert.equal(withPluginData.records.length, 2);
  });

  it("does not count GATE_STOP_MARKER-only Stop messages as language driftInjections", () => {
    const l3Case = CASES.find((entry) => entry.name === "L3-bypass-stop-recovery");
    const steps = [
      makeStep(0, "USER_INPUT", { content: l3Case.prompt }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      makeStep(2, "SYSTEM_MESSAGE", {
        content: wrapAntigravityHookMessage(
          `${GATE_STOP_MARKER} 이번 턴에서 파일을 수정했으나 수정 이후 완료 검증 도구를 통과한 기록이 없다.`,
          "Stop",
        ),
      }),
      makeStep(3, "PLANNER_RESPONSE", {
        thinking: koreanThinking,
        toolCalls: [{ name: GATE_TOOL_NAME, args: {} }],
      }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
    ];

    const summary = summarizeTranscript(steps, l3Case);
    assert.equal(summary.status, "pass");
    assert.equal(summary.driftInjections, 0);

    const gov = summarizeGovernance({
      steps,
      auditRecords: [
        { event: "stop_decision", decision: "continue_gate", executionNum: 0 },
        { event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 },
      ],
      auditPathUsed: "plugin_data",
    });
    assert.equal(gov.stopGateBlocks, 1);
    assert.equal(gov.stopBlocks, 1);
    assert.equal(gov.gateCallCount, 1);
  });

  it("evaluates L1-golden-path pass and failure branches accurately", () => {
    const l1Case = CASES.find((entry) => entry.name === "L1-golden-path");
    const steps = [
      makeStep(0, "USER_INPUT", { content: l1Case.prompt }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [{ name: GATE_TOOL_NAME, args: {} }] }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
    ];
    const passEval = evaluateGovernanceCase(l1Case, {
      steps,
      auditRecords: [
        {
          event: "gate_verify",
          verdict: "PASS",
          blockedRules: [],
          warnedRules: [],
          attemptInTurn: 1,
          metrics: { cacheReadTokens: 3200 },
        },
      ],
      auditPathUsed: "plugin_data",
      hookcallerPanics: 0,
      rawTranscript: '{"type":"GENERIC","content":"A pre-tool hook changed the arguments\\n[완료 검증 통과]"}',
      gitDirtyFiles: ["src/calc.mjs"],
    });
    assert.equal(passEval.ok, true);
    assert.deepEqual(passEval.failures, []);
    assert.equal(passEval.governance.cacheReadTokens, 3200);
    assert.equal(passEval.governance.preToolOverwriteDetected, true);

    const skippedSessionEval = evaluateGovernanceCase(l1Case, {
      steps,
      auditRecords: [
        { event: "gate_verify", verdict: "SKIPPED_NO_SESSION", blockedRules: [], warnedRules: [], attemptInTurn: 1 },
      ],
      auditPathUsed: "fallback",
      hookcallerPanics: 0,
      rawTranscript: '{"type":"GENERIC","content":"[완료 검증 생략]"}',
    });
    assert.equal(skippedSessionEval.ok, false);
    assert.ok(skippedSessionEval.failures.some((msg) => msg.includes('Expected final gate verdict "PASS"')));
    assert.ok(skippedSessionEval.failures.some((msg) => msg.includes("PreToolUse gate interception")));

    const panicEval = evaluateGovernanceCase(l1Case, {
      steps,
      auditRecords: [{ event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 }],
      hookcallerPanics: 1,
      rawTranscript: "A pre-tool hook changed the arguments",
    });
    assert.equal(panicEval.ok, false);
    assert.ok(panicEval.failures.some((msg) => msg.includes("hookcaller panic")));
  });

  it("evaluates L2-unverified-reject-recovery, L3-bypass-stop-recovery, and L4-readonly-frictionless accurately", () => {
    const l2Case = CASES.find((entry) => entry.name === "L2-unverified-reject-recovery");
    const l2Pass = evaluateGovernanceCase(l2Case, {
      auditRecords: [
        {
          event: "gate_verify",
          verdict: "REJECT",
          blockedRules: ["R2_STALE_VERIFICATION"],
          warnedRules: [],
          attemptInTurn: 1,
        },
        { event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 2 },
      ],
      auditPathUsed: "plugin_data",
    });
    assert.equal(l2Pass.ok, true);

    const l2MissingReject = evaluateGovernanceCase(l2Case, {
      auditRecords: [{ event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 }],
    });
    assert.equal(l2MissingReject.ok, false);
    assert.ok(l2MissingReject.failures.some((msg) => msg.includes("R2_STALE_VERIFICATION")));

    const l3Case = CASES.find((entry) => entry.name === "L3-bypass-stop-recovery");
    const l3Steps = [
      makeStep(0, "USER_INPUT", { content: l3Case.prompt }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      makeStep(2, "SYSTEM_MESSAGE", {
        content: wrapAntigravityHookMessage(`${GATE_STOP_MARKER} 완료 검증이 필요합니다.`, "Stop"),
      }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [{ name: GATE_TOOL_NAME, args: {} }] }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
    ];
    const l3Pass = evaluateGovernanceCase(l3Case, {
      steps: l3Steps,
      auditRecords: [
        { event: "stop_decision", decision: "continue_gate", executionNum: 0 },
        { event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 },
      ],
    });
    assert.equal(l3Pass.ok, true);
    assert.equal(l3Pass.governance.stopMaxExecutionNum, 0);

    const l3Runaway = evaluateGovernanceCase(l3Case, {
      steps: l3Steps,
      auditRecords: [
        { event: "stop_decision", decision: "continue_gate", executionNum: 0 },
        { event: "stop_decision", decision: "allow_cap", executionNum: 2 },
        { event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 },
      ],
    });
    assert.equal(l3Runaway.ok, false);
    assert.ok(l3Runaway.failures.some((msg) => msg.includes("stopMaxExecutionNum < 2")));

    const l4Case = CASES.find((entry) => entry.name === "L4-readonly-frictionless");
    const l4Pass = evaluateGovernanceCase(l4Case, {
      steps: [
        makeStep(0, "USER_INPUT", { content: l4Case.prompt }),
        makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, content: koreanContent }),
      ],
      auditRecords: [{ event: "post_invocation", metrics: { cacheReadTokens: 4096 } }],
      gitDirtyFiles: [],
    });
    assert.equal(l4Pass.ok, true);
    assert.equal(l4Pass.governance.gateCallCount, 0);
    assert.equal(l4Pass.governance.stopBlocks, 0);
    assert.equal(l4Pass.governance.cacheReadTokens, 4096);

    const l4Violated = evaluateGovernanceCase(l4Case, {
      steps: [
        makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [{ name: GATE_TOOL_NAME, args: {} }] }),
      ],
      auditRecords: [
        { event: "gate_verify", verdict: "PASS", blockedRules: [], warnedRules: [], attemptInTurn: 1 },
        { event: "stop_decision", decision: "continue_gate", executionNum: 0 },
      ],
      gitDirtyFiles: ["src/calc.mjs"],
    });
    assert.equal(l4Violated.ok, false);
    assert.ok(l4Violated.failures.some((msg) => msg.includes("gateCallCount=0")));
    assert.ok(l4Violated.failures.some((msg) => msg.includes("stopBlocks=0")));
    assert.ok(l4Violated.failures.some((msg) => msg.includes("no modified files")));
  });
});
