import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENGLISH_RUN_WORD_THRESHOLD,
  MIN_HANGUL_RATIO,
  MIN_LATIN_CHARS_FOR_DRIFT,
  MIN_NATURAL_CHARS,
  SEGMENT_MAX_HANGUL_RATIO,
  SEGMENT_MIN_NATURAL_CHARS,
  analyzeField,
  evaluatePlannerResponse,
  extractNaturalText,
} from "../scripts/analyzer.mjs";
import { handlePostInvocation } from "../scripts/post-invocation.mjs";
import {
  DEFAULT_COOLDOWN_INVOCATIONS,
  DRIFT_MARKER,
  buildCorrectionMessage,
  decideHookAction,
  parseTranscriptJsonl,
} from "../scripts/transcript.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "..");
const HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "post-invocation.mjs");

function makeStep(stepIndex, type, { thinking = "", content = "" } = {}) {
  return { stepIndex, type, thinking, content };
}

function toJsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("analyzer", () => {
  it("exports documented threshold constants", () => {
    assert.equal(MIN_NATURAL_CHARS, 24);
    assert.equal(MIN_HANGUL_RATIO, 0.45);
    assert.equal(MIN_LATIN_CHARS_FOR_DRIFT, 16);
    assert.equal(ENGLISH_RUN_WORD_THRESHOLD, 8);
    assert.equal(SEGMENT_MIN_NATURAL_CHARS, 40);
    assert.equal(SEGMENT_MAX_HANGUL_RATIO, 0.25);
  });

  it("passes pure Korean thinking and content", () => {
    const result = evaluatePlannerResponse({
      thinking: "먼저 플러그인 설정 구조를 확인하고 각 모듈의 책임을 분리해 보자. 경계 계층은 얇게 유지한다.",
      content: "플러그인 핵심 파일과 테스트를 모두 구성했고 모든 검증을 통과했다.",
    });

    assert.equal(result.kind, "ok");
    assert.equal(result.thinking.status, "korean");
    assert.equal(result.thinking.driftReason, "none");
    assert.equal(result.content.status, "korean");
    assert.equal(result.content.driftReason, "none");
  });

  it("does not flag code, path, symbol, flag, URL, XML, or quote-heavy Korean text", () => {
    const technicalKorean = [
      "먼저 /tmp/tk-worktrees/core/scripts/post-invocation.mjs와 scripts/analyzer.mjs에서 상태를 확인한다.",
      "> Error: Cannot read properties of undefined in PostInvocation hook while parsing JSON",
      "Windows 경로 C:\\Users\\dev\\thinking-korean\\hooks.json과 https://github.com/hs1662/thinking-korean에서 문서를 대조한다.",
      "핵심 함수 evaluatePlannerResponse가 PLANNER_RESPONSE의 `thinking`과 `content`를 읽고 --strict와 -v 플래그를 처리한다.",
      '원문 로그 "Unexpected end of JSON input while reading transcript file"는 무시하고 <SYSTEM_MESSAGE> 태그와 a.b.c 경로를 제외한다.',
      "```js",
      "export function verifyBehavior(payload) {",
      "  return payload.status === 'ok' ? true : false;",
      "}",
      "```",
      "또한 camelCase, PascalCase, snake_case, SCREAMING_SNAKE 식별자가 한국어 조사와 붙어도 정상 통과한다.",
    ].join("\n");

    const extracted = extractNaturalText(technicalKorean);
    assert.ok(extracted.includes("\n"), "preserves line breaks");
    assert.equal(extracted.includes("verifyBehavior"), false);
    assert.equal(extracted.includes("Cannot read properties"), false);

    const evaluation = evaluatePlannerResponse({
      thinking: technicalKorean,
      content: "scripts/post-invocation.mjs와 `hooks.json`을 검증했고 PostInvocation 후크 계약과 예외 처리가 모두 정상 동작한다.",
    });

    assert.equal(evaluation.kind, "ok");
    assert.equal(evaluation.thinking.status, "korean");
    assert.equal(evaluation.content.status, "korean");
  });

  it("does not trigger english_run when total Latin characters are below minimum drift threshold", () => {
    const analysis = analyzeField(
      "thinking",
      "변수 a b c d e f g h 의 순서를 차례대로 비교하면서 전체 상태를 한국어로 정리했다.",
    );

    assert.equal(analysis.status, "korean");
    assert.equal(analysis.driftReason, "none");
  });

  it("detects English thinking drift while content stays Korean", () => {
    const evaluation = evaluatePlannerResponse({
      thinking: "Let me check the transcript parser first and verify how each invocation step is normalized.",
      content: "전사 파서와 후크 응답 형식을 점검했고 문제는 발견되지 않았다.",
    });

    assert.equal(evaluation.kind, "drifted");
    assert.deepEqual(evaluation.driftedFields, ["thinking"]);
    assert.equal(evaluation.thinking.status, "drifted");
    assert.equal(evaluation.thinking.driftReason, "low_hangul_ratio");
    assert.equal(evaluation.content.status, "korean");
  });

  it("detects English content drift while thinking stays Korean", () => {
    const evaluation = evaluatePlannerResponse({
      thinking: "먼저 테스트 결과를 검토하고 최종 응답을 간결하게 정리하자.",
      content: "All unit tests passed and the plugin configuration has been verified without any errors.",
    });

    assert.equal(evaluation.kind, "drifted");
    assert.deepEqual(evaluation.driftedFields, ["content"]);
    assert.equal(evaluation.thinking.status, "korean");
    assert.equal(evaluation.content.status, "drifted");
    assert.equal(evaluation.content.driftReason, "low_hangul_ratio");
  });

  it("detects tail English segment drift inside long Korean thinking", () => {
    const thinking = [
      "먼저 플러그인 매니페스트와 규칙 파일이 안티그래비티 로더 규격에 맞는지 확인한다.",
      "전사 분석기는 외부 파일 입출력과 완전히 분리된 순수 모듈로 설계해 재현 가능한 단위 테스트를 작성한다.",
      "반복 호출 시 이미 보정 메시지가 주입되어 있다면 중복 주입하지 않고 조용히 통과해야 한다.",
      "",
      "Wait, let me double check the remaining edge cases before emitting the final response.",
    ].join("\n");

    const analysis = analyzeField("thinking", thinking);
    assert.ok(analysis.hangulRatio >= MIN_HANGUL_RATIO);
    assert.equal(analysis.status, "drifted");
    assert.equal(analysis.driftReason, "english_segment");
  });

  it("detects inline contiguous English word run inside a single Korean paragraph", () => {
    const thinking =
      "먼저 파일 구조를 파악하고 분석기 모듈의 경계를 확인했다. 테스트 케이스를 설계하면서 생각해 보니 now let me check the remaining edge cases carefully before writing any code to disk. 그다음 결과를 정리하고 변경 사항을 커밋하면 된다.";

    const analysis = analyzeField("thinking", thinking);
    assert.ok(analysis.hangulRatio >= MIN_HANGUL_RATIO);
    assert.equal(analysis.status, "drifted");
    assert.equal(analysis.driftReason, "english_run");
  });

  it("ignores empty and short fragments below minimum natural character threshold", () => {
    assert.equal(analyzeField("thinking", "").status, "insufficient");
    assert.equal(analyzeField("thinking", "   \n\t  ").status, "insufficient");
    assert.equal(analyzeField("thinking", "확인 완료").status, "insufficient");
    assert.equal(analyzeField("thinking", "Let me check").status, "insufficient");

    const evaluation = evaluatePlannerResponse({
      thinking: "Let me check",
      content: "",
    });
    assert.equal(evaluation.kind, "ok");
  });
});

describe("transcript reducer", () => {
  it("exports documented marker and cooldown constants", () => {
    assert.equal(DRIFT_MARKER, "[thinking-korean:drift]");
    assert.equal(DEFAULT_COOLDOWN_INVOCATIONS, 2);
  });

  it("returns no_planner_response when transcript has no planner responses", () => {
    const decision = decideHookAction([
      makeStep(0, "SYSTEM_MESSAGE", { content: "세션 시작" }),
      makeStep(1, "USER_INPUT", { content: "코드를 점검해 줘" }),
    ]);

    assert.deepEqual(decision, { action: "noop", reason: "no_planner_response" });
  });

  it("suppresses repeated drift during cooldown and re-injects after cooldown window", () => {
    const englishThinking = "Let me read the hook script and verify the JSON output format carefully.";
    const wrappedMarker = `<SYSTEM_MESSAGE>\n${buildCorrectionMessage(["thinking"])}\n</SYSTEM_MESSAGE>`;

    const first = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ]);
    assert.equal(first.action, "inject");
    assert.equal(first.stepIndex, 0);
    assert.deepEqual(first.driftedFields, ["thinking"]);
    assert.ok(first.message.startsWith(DRIFT_MARKER));
    assert.ok(first.message.includes("thinking"));

    const afterOne = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ]);
    assert.deepEqual(afterOne, { action: "noop", reason: "cooldown_active" });

    const afterTwo = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ]);
    assert.deepEqual(afterTwo, { action: "noop", reason: "cooldown_active" });

    const afterThree = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ]);
    assert.equal(afterThree.action, "inject");
    assert.equal(afterThree.stepIndex, 4);
    assert.deepEqual(afterThree.driftedFields, ["thinking"]);
  });

  it("returns ok rather than cooldown_active when the latest response recovered to Korean", () => {
    const wrappedMarker = `<SYSTEM_MESSAGE>\n${buildCorrectionMessage(["thinking"])}\n</SYSTEM_MESSAGE>`;
    const decision = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", {
        thinking: "Let me inspect the configuration file first before continuing.",
      }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", {
        thinking: "이제 한국어로 추론을 이어 가며 남은 테스트 케이스를 검증하자.",
      }),
    ]);

    assert.deepEqual(decision, { action: "noop", reason: "ok" });
  });

  it("is idempotent when a drift marker already follows the latest planner response", () => {
    const decision = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", {
        thinking: "Let me check all files and verify the hook behavior before finishing.",
      }),
      makeStep(1, "SYSTEM_MESSAGE", {
        content: `<SYSTEM_MESSAGE>\n${buildCorrectionMessage(["thinking"])}\n</SYSTEM_MESSAGE>`,
      }),
    ]);

    assert.deepEqual(decision, { action: "noop", reason: "already_covered" });
  });

  it("ignores drift markers that appear outside SYSTEM_MESSAGE steps", () => {
    const decision = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", {
        thinking: "Let me verify the post-invocation hook behavior right now before committing.",
      }),
      makeStep(1, "GENERIC", {
        content: `tool output mentioning ${DRIFT_MARKER}`,
      }),
    ]);

    assert.equal(decision.action, "inject");
    assert.equal(decision.stepIndex, 0);
  });

  it("tolerates blank lines, malformed JSON, and non-object entries in JSONL", () => {
    const raw = [
      "",
      "{broken json",
      "null",
      "42",
      "[]",
      JSON.stringify({ step_index: 1, type: "USER_INPUT", content: "확인해 줘" }),
      "   ",
      JSON.stringify({
        step_index: 2,
        type: "PLANNER_RESPONSE",
        thinking: "Now I will inspect the files and verify the remaining conditions.",
        content: "모든 파일을 점검하고 결과를 정리했다.",
      }),
    ].join("\n");

    const steps = parseTranscriptJsonl(raw);
    assert.equal(steps.length, 2);
    assert.equal(steps[1].stepIndex, 2);

    const decision = decideHookAction(steps);
    assert.equal(decision.action, "inject");
    assert.deepEqual(decision.driftedFields, ["thinking"]);
  });

  it("names both fields in correction message when both thinking and content drift", () => {
    const message = buildCorrectionMessage(["thinking", "content"]);
    assert.ok(message.startsWith(DRIFT_MARKER));
    assert.ok(message.includes("thinking"));
    assert.ok(message.includes("content"));
  });
});

describe("post-invocation hook CLI and adapter", () => {
  const tempDirs = [];

  function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), "thinking-korean-test-"));
    tempDirs.push(dir);
    return dir;
  }

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs as a real subprocess and emits Antigravity injectSteps JSON on drift", () => {
    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "구조를 설명해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          thinking: "Let me inspect the repository layout and verify every exported symbol first.",
          content: "저장소 구조를 분석하고 핵심 모듈을 정리했다.",
        },
      ]),
      "utf8",
    );

    const proc = spawnSync(process.execPath, [HOOK_SCRIPT], {
      cwd: PLUGIN_ROOT,
      input: JSON.stringify({
        hookEventName: "PostInvocation",
        transcriptPath,
      }),
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    assert.equal(proc.stderr, "");
    assert.ok(proc.stdout.endsWith("\n"));

    const parsed = JSON.parse(proc.stdout);
    assert.equal(Array.isArray(parsed.injectSteps), true);
    assert.equal(parsed.injectSteps.length, 1);
    const injectedMessage = parsed.injectSteps[0].systemMessage.systemMessage;
    assert.ok(injectedMessage.startsWith(DRIFT_MARKER));
    assert.ok(injectedMessage.includes("thinking"));
  });

  it("prefers sibling transcript_full.jsonl when stdin provides truncated transcript.jsonl", () => {
    const dir = createTempDir();
    const compactPath = join(dir, "transcript.jsonl");
    const fullPath = join(dir, "transcript_full.jsonl");

    writeFileSync(
      compactPath,
      toJsonl([
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          thinking: "먼저 전체 구조를 확인하고 각 파일의 책임을 한국어로 정리했다.",
          truncated_fields: ["thinking"],
        },
      ]),
      "utf8",
    );
    writeFileSync(
      fullPath,
      toJsonl([
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          thinking: [
            "먼저 전체 구조를 확인하고 각 파일의 책임을 한국어로 정리했다.",
            "",
            "Wait, let me double check all edge cases in the hook before writing output.",
          ].join("\n"),
        },
      ]),
      "utf8",
    );

    const proc = spawnSync(process.execPath, [HOOK_SCRIPT], {
      cwd: PLUGIN_ROOT,
      input: JSON.stringify({ transcriptPath: compactPath }),
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.injectSteps.length, 1);
    assert.ok(parsed.injectSteps[0].systemMessage.systemMessage.startsWith(DRIFT_MARKER));
  });

  it("outputs empty object when latest planner response is Korean", () => {
    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          thinking: "먼저 파일 구성을 확인하고 한국어로 추론을 계속 진행한다.",
          content: "모든 확인을 마치고 한국어로 최종 응답을 작성했다.",
        },
      ]),
      "utf8",
    );

    const proc = spawnSync(process.execPath, [HOOK_SCRIPT], {
      cwd: PLUGIN_ROOT,
      input: JSON.stringify({ transcriptPath }),
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    assert.equal(proc.stdout, "{}\n");
  });

  it("fails open with exit code 0 and {} on malformed stdin, missing path, unreadable file, or empty file", () => {
    const dir = createTempDir();
    const emptyPath = join(dir, "empty.jsonl");
    writeFileSync(emptyPath, "", "utf8");

    const inputs = [
      "{not-json",
      JSON.stringify({}),
      JSON.stringify({ transcriptPath: join(dir, "does-not-exist.jsonl") }),
      JSON.stringify({ transcriptPath: emptyPath }),
    ];

    for (const stdinText of inputs) {
      const proc = spawnSync(process.execPath, [HOOK_SCRIPT], {
        cwd: PLUGIN_ROOT,
        input: stdinText,
        encoding: "utf8",
      });
      assert.equal(proc.status, 0);
      assert.equal(proc.stdout, "{}\n");
    }

    assert.deepEqual(
      handlePostInvocation(JSON.stringify({ transcriptPath: "/virtual/transcript.jsonl" }), () => {
        throw new Error("EACCES");
      }),
      {},
    );
  });
});
