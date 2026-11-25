import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { analyzeUiTexts } from "../scripts/analyzer.mjs";
import {
  decideHookAction,
  decidePreToolUseAction,
  extractUiTextsFromToolCall,
  extractUiTextsFromToolCalls,
  parseTranscriptJsonl,
} from "../scripts/transcript.mjs";
import { createTempDir, toJsonl } from "./helpers.mjs";

describe("UI text extraction", () => {
  it("extracts titles, summaries, questions, and options from every supported UI tool", () => {
    const texts = extractUiTextsFromToolCalls([
      { name: "update_steps", args: { toolSummary: "단계 갱신", steps: [{ title: "구조 점검" }, { title: "테스트 실행" }] } },
      { name: "todo_write", args: { todos: [{ content: "문서 갱신" }] } },
      { name: "update_plan", args: { plan: [{ step: "계획 수립" }] } },
      { name: "task_create", args: { subject: "작업 생성" } },
      { name: "task_update", args: { title: "작업 갱신" } },
      { name: "ask_question", args: { questions: [{ question: "어느 방식을 고를까?", options: ["유지", "분리"] }] } },
      { name: "invoke_subagent", args: { Role: "검토 담당" } },
      { name: "write_file", args: { ArtifactMetadata: { Summary: "보고서 작성" } } },
      { name: "swarm", args: { title: "병렬 점검" } },
      { name: "run_workflow", args: { Description: "배포 흐름" } },
    ]);
    assert.deepEqual(texts, [
      "단계 갱신",
      "구조 점검",
      "테스트 실행",
      "문서 갱신",
      "계획 수립",
      "작업 생성",
      "작업 갱신",
      "어느 방식을 고를까?",
      "유지",
      "분리",
      "검토 담당",
      "보고서 작성",
      "병렬 점검",
      "배포 흐름",
    ]);
    assert.equal(analyzeUiTexts(texts).status, "korean");
    assert.deepEqual(extractUiTextsFromToolCalls(undefined), []);
    assert.deepEqual(extractUiTextsFromToolCall(null), []);
    assert.deepEqual(extractUiTextsFromToolCall({ name: "update_steps" }), []);
  });
});

describe("regression #3: JSON-stringified tool args in compact transcript.jsonl", () => {
  const englishSteps = [
    { title: "Inspect repository layout", status: "in_progress" },
    { title: "Audit hook adapters", status: "pending" },
  ];
  const englishQuestions = [{ question: "Which option should we pick?", options: ["Keep layout", "Split helper"] }];

  it("unwraps stringified args.steps, args.questions, and a quoted toolSummary before analyzeUiTexts", () => {
    const dir = createTempDir("thinking-korean-ui-");
    const compactPath = join(dir, "transcript.jsonl");
    writeFileSync(
      compactPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "점검해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          thinking: "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 저장소 구조부터 확인한다.",
          tool_calls: [
            { name: "update_steps", args: { steps: JSON.stringify(englishSteps), toolSummary: JSON.stringify("Run unit tests") } },
            { name: "ask_question", args: { questions: JSON.stringify(englishQuestions) } },
          ],
        },
      ]),
      "utf8",
    );

    const steps = parseTranscriptJsonl(readFileSync(compactPath, "utf8"));
    assert.equal(steps.length, 2);
    const texts = extractUiTextsFromToolCalls(steps[1].toolCalls);
    assert.deepEqual(texts, [
      "Run unit tests",
      "Inspect repository layout",
      "Audit hook adapters",
      "Which option should we pick?",
      "Keep layout",
      "Split helper",
    ]);
    assert.equal(texts.some((text) => text.startsWith('"') || text.startsWith("[")), false);
    assert.equal(analyzeUiTexts(texts).status, "drifted");

    const decision = decideHookAction(steps);
    assert.equal(decision.action, "inject");
    assert.deepEqual(decision.driftedFields, ["ui"]);
  });

  it("yields the same UI texts for object args, stringified fields, stringified args, and double serialization", () => {
    const objectForm = { name: "update_steps", args: { steps: englishSteps } };
    const fieldStringForm = { name: "update_steps", args: { steps: JSON.stringify(englishSteps) } };
    const argsStringForm = { name: "update_steps", args: JSON.stringify({ steps: englishSteps }) };
    const doubleForm = { name: "update_steps", args: { steps: JSON.stringify(JSON.stringify(englishSteps)) } };
    const expected = extractUiTextsFromToolCall(objectForm);
    assert.deepEqual(expected, ["Inspect repository layout", "Audit hook adapters"]);
    for (const call of [fieldStringForm, argsStringForm, doubleForm]) {
      assert.deepEqual(extractUiTextsFromToolCall(call), expected);
    }

    const askObject = { name: "ask_question", args: { questions: englishQuestions } };
    const askString = { name: "ask_question", args: { questions: JSON.stringify(englishQuestions) } };
    assert.deepEqual(extractUiTextsFromToolCall(askString), extractUiTextsFromToolCall(askObject));

    assert.deepEqual(extractUiTextsFromToolCall({ name: "run_command", args: { toolSummary: '"Run unit tests"' } }), [
      "Run unit tests",
    ]);
    assert.equal(decidePreToolUseAction(fieldStringForm, []).action, "deny");
  });

  it("falls back safely on corrupt JSON strings without throwing", () => {
    const corruptCalls = [
      { name: "update_steps", args: { steps: "[{broken", toolSummary: '"unterminated' } },
      { name: "ask_question", args: "{bad json" },
      { name: "ask_question", args: { questions: "[1, 2" } },
      { name: "todo_write", args: { todos: "{not: valid}" } },
      { name: "update_plan", args: { plan: "null" } },
      { name: "task_create", args: { subject: "[unclosed" } },
    ];
    let texts;
    assert.doesNotThrow(() => {
      texts = extractUiTextsFromToolCalls(corruptCalls);
    });
    assert.deepEqual(texts, ['"unterminated', "[unclosed"]);
    assert.doesNotThrow(() => analyzeUiTexts(texts));

    const raw = toJsonl([
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        thinking: "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 손상된 인자를 확인한다.",
        tool_calls: corruptCalls,
      },
    ]);
    const steps = parseTranscriptJsonl(raw);
    assert.equal(steps.length, 1);
    assert.doesNotThrow(() => decideHookAction(steps));
    for (const call of corruptCalls) {
      assert.doesNotThrow(() => decidePreToolUseAction(call, steps));
    }
  });

  it("preserves JSON-object or JSON-array shaped leaf UI strings instead of dropping them during unwrapping", () => {
    const objectSummaryCall = {
      name: "run_command",
      args: { toolSummary: '{"task":"Check git status and run unit tests"}' },
    };
    const arrayOptionCall = {
      name: "ask_question",
      args: { questions: [{ question: "형식을 고르세요", options: ['["Check status"]', '{"mode":"fast"}'] }] },
    };

    assert.deepEqual(extractUiTextsFromToolCall(objectSummaryCall), ['{"task":"Check git status and run unit tests"}']);
    assert.deepEqual(extractUiTextsFromToolCall(arrayOptionCall), [
      "형식을 고르세요",
      '["Check status"]',
      '{"mode":"fast"}',
    ]);
  });
});
