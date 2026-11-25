import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { analyzeField } from "../scripts/analyzer.mjs";
import { DRIFT_MARKER, buildCorrectionMessage } from "../scripts/transcript.mjs";
import { createTempDir, makeDenialStep, makeStep, wrapAntigravityHookMessage } from "./helpers.mjs";
import { CASES, buildIsolatedEnv, parseCliArgs, summarizeTranscript } from "./verify-live.mjs";

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
