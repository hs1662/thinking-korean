import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  SHORT_ENGLISH_PROSE_WORD_THRESHOLD,
  analyzeField,
  evaluatePlannerResponse,
  extractNaturalText,
} from "../scripts/analyzer.mjs";
import { handlePostInvocation } from "../scripts/post-invocation.mjs";
import {
  DEFAULT_COOLDOWN_INVOCATIONS,
  DRIFT_MARKER,
  LEGACY_DRIFT_MARKERS,
  MAX_CONSECUTIVE_FAILED_THINKING,
  buildCorrectionMessage,
  decideHookAction,
  isDriftMarkerStep,
  isExplicitEnglishOutputRequest,
  parseTranscriptJsonl,
} from "../scripts/transcript.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "..");
const HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "post-invocation.mjs");
const RULES_PATH = join(PLUGIN_ROOT, "rules", "AGENTS.md");

function makeStep(stepIndex, type, { thinking = "", content = "" } = {}) {
  return { stepIndex, type, thinking, content };
}

function toJsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function wrapAntigravityHookMessage(message, hookName = "PostInvocation") {
  return [
    "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.",
    "",
    "<SYSTEM_MESSAGE>",
    `The following system message was injected by a ${hookName} hook:`,
    message,
    "</SYSTEM_MESSAGE>",
  ].join("\n");
}

describe("rules", () => {
  it("keeps rules/AGENTS.md 100% pure Korean without ASCII letters and well under budget", () => {
    const rulesText = readFileSync(RULES_PATH, "utf8");
    assert.ok(rulesText.length > 200);
    assert.ok(Buffer.byteLength(rulesText, "utf8") < 20_000);
    assert.equal(/[A-Za-z]/.test(rulesText), false, "rules/AGENTS.md must not contain ASCII letters");
  });
});

describe("analyzer", () => {
  it("exports documented threshold constants", () => {
    assert.equal(MIN_NATURAL_CHARS, 24);
    assert.equal(MIN_HANGUL_RATIO, 0.45);
    assert.equal(MIN_LATIN_CHARS_FOR_DRIFT, 16);
    assert.equal(ENGLISH_RUN_WORD_THRESHOLD, 8);
    assert.equal(SEGMENT_MIN_NATURAL_CHARS, 32);
    assert.equal(SEGMENT_MAX_HANGUL_RATIO, 0.25);
    assert.equal(SHORT_ENGLISH_PROSE_WORD_THRESHOLD, 4);
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

  it("does not flag code, path, symbol, flag, URL, XML, or error-quote-heavy Korean text", () => {
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
      content:
        "scripts/post-invocation.mjs와 `hooks.json`을 검증했고 PostInvocation 후크 계약과 예외 처리가 모두 정상 동작한다.",
    });

    assert.equal(evaluation.kind, "ok");
    assert.equal(evaluation.thinking.status, "korean");
    assert.equal(evaluation.content.status, "korean");
  });

  it("handles CommonMark fenced code blocks without swallowing trailing English prose", () => {
    const inlineTripleBacktick = [
      "```code``` is an inline span.",
      "Now let me write everything in English to verify the scanner catches this.",
    ].join("\n");
    const inlineResult = analyzeField("thinking", inlineTripleBacktick);
    assert.equal(inlineResult.status, "drifted");
    assert.equal(inlineResult.driftReason, "low_hangul_ratio");

    const longerClosingFence = [
      "```js",
      "const value = 42;",
      "````",
      "Now let me explain the remaining implementation details in English.",
    ].join("\n");
    const closingResult = analyzeField("thinking", longerClosingFence);
    assert.equal(closingResult.status, "drifted");
    assert.equal(closingResult.driftReason, "low_hangul_ratio");

    const nestedFences = [
      "````markdown",
      "```js",
      "const shouldBeIgnored = true;",
      "```",
      "````",
      "이제 한국어로 중첩된 코드 블록 분석 결과를 간결하고 정확하게 정리한다.",
    ].join("\n");
    const nestedResult = analyzeField("content", nestedFences);
    assert.equal(nestedResult.latinCount, 0);
    assert.equal(nestedResult.status, "korean");
  });

  it("handles multi-backtick inline code spans accurately", () => {
    const doubleTickText = "예시 ``use `foo` bar`` 코드 스팬을 완전히 제거하고 한국어 설명만 자연스럽게 남긴다.";
    const extracted = extractNaturalText(doubleTickText);
    assert.equal(extracted.includes("use"), false);
    assert.equal(extracted.includes("foo"), false);
    assert.equal(extracted.includes("bar"), false);
    const analysis = analyzeField("content", doubleTickText);
    assert.equal(analysis.latinCount, 0);
    assert.equal(analysis.status, "korean");

    const unclosedTick = "Here is a stray ` backtick and now let me continue writing English prose.";
    assert.equal(analyzeField("thinking", unclosedTick).status, "drifted");
  });

  it("does not strip comparison expressions as XML tags", () => {
    const comparison = "Check x<y where the entire English explanation happens before z>0 in this check.";
    const result = analyzeField("thinking", comparison);
    assert.equal(result.status, "drifted");
    assert.equal(result.driftReason, "low_hangul_ratio");

    const validTags =
      '태그 <SYSTEM_MESSAGE>와 <div class="box">를 모두 정확하게 제외하고 순수 한국어 설명 문장만 남긴다.';
    const extracted = extractNaturalText(validTags);
    assert.equal(extracted.includes("SYSTEM_MESSAGE"), false);
    assert.equal(extracted.includes("class"), false);
    assert.equal(analyzeField("content", validTags).status, "korean");
  });

  it("strips error/short-token quotes and error blockquotes while catching English prose inside quotes", () => {
    const quotedProse =
      '"Let me check the configuration first and verify every single module carefully before editing any file."';
    assert.equal(analyzeField("thinking", quotedProse).status, "drifted");

    const mediumQuotedProse = '"Let me check the configuration file first."';
    assert.equal(analyzeField("thinking", mediumQuotedProse).status, "drifted");

    const blockquoteProse = "> Let me analyze the architecture carefully and plan each change step by step.";
    assert.equal(analyzeField("thinking", blockquoteProse).status, "drifted");

    const legitimateErrorQuotes = [
      '원칙 "Boundary Discipline"에 따라 각 오류를 확인한다.',
      '메시지 "TypeError: Cannot read properties of null"와 "ENOENT: no such file or directory"를 기록했다.',
      '예외 "SyntaxError: Unexpected token in JSON" 및 "EACCES: permission denied"를 점검했다.',
      '스택 "at Object.run (/app/index.js:12:4)"와 "FAIL test/suite.mjs"는 무시한다.',
      "> Exception: Failed to connect to remote host",
      "> at parseLine (scripts/transcript.mjs:44:11)",
    ].join("\n");
    assert.equal(analyzeField("content", legitimateErrorQuotes).status, "korean");
  });

  it("avoids false positives on acronyms, kebab-case IDs, paths, dotfiles, bold wrappers, and flags", () => {
    const shortAcronyms = "CLI에서 HTTP API와 JSONL, STDIN, STDOUT, YAML, CORS, JWT, URL, README, SQL, REST 처리 확인.";
    const shortAcronymAnalysis = analyzeField("content", shortAcronyms);
    assert.equal(shortAcronymAnalysis.latinCount, 0);
    assert.notEqual(shortAcronymAnalysis.status, "drifted");

    const acronyms =
      "이번 작업에서는 CLI에서 HTTP API와 JSONL, STDIN, STDOUT, YAML, CORS, JWT, URL, README, SQL, REST 연동 처리를 모두 한국어로 검증하고 기록했다.";
    assert.equal(analyzeField("content", acronyms).status, "korean");

    const allCapsProse = "LET ME CHECK THE CONFIGURATION FILE FIRST BEFORE CONTINUING WITH THE FIX.";
    assert.equal(analyzeField("thinking", allCapsProse).status, "drifted");

    const shortKebabIds =
      "thinking-korean의 post-invocation과 verify-live에서 gemini-4-neon-xhigh 및 claude-opus-5-5-high 확인";
    const shortKebabAnalysis = analyzeField("content", shortKebabIds);
    assert.equal(shortKebabAnalysis.latinCount, 0);
    assert.notEqual(shortKebabAnalysis.status, "drifted");

    const kebabIds =
      "이번 검증에서 thinking-korean의 post-invocation과 verify-live에서 gemini-4-neon-xhigh 및 claude-opus-5-5-high 모델 동작을 한국어로 확인하고 기록했다.";
    assert.equal(analyzeField("content", kebabIds).status, "korean");

    const pathsAndFlags =
      "이번 점검에서는 **scripts/post-invocation.mjs**와 **--strict**, scripts/, rules/, .gitignore, .env, -v를 모두 검증했고 변경 결과를 한국어로 정리했다.";
    const pathsAnalysis = analyzeField("content", pathsAndFlags);
    assert.equal(pathsAnalysis.latinCount, 0);
    assert.equal(pathsAnalysis.status, "korean");
  });

  it("avoids false positives on tables, bullet token lists, comma lists, model lists, and CLI UI hint lines", () => {
    const commaList =
      "전사 파서가 처리하는 주요 기술 필드 목록은 stdin, stdout, stderr, payload, status, error, thinking, content 등으로 구성되며 각 단계의 상태 전이와 복구 조건을 한국어로 상세하게 요약하고 검증한다.";
    assert.equal(analyzeField("content", commaList).status, "korean");

    const bulletList = [
      "이 프로젝트에서 사용하는 핵심 명령 도구는 다음과 같다.",
      "",
      "- node",
      "- npm",
      "- npx",
      "- git",
      "- bash",
      "- curl",
      "- jq",
      "- rg",
      "",
      "위 도구들은 모두 표준 입출력으로 결과를 반환한다.",
    ].join("\n");
    assert.equal(analyzeField("content", bulletList).status, "korean");

    const markdownTable = [
      "검증 결과를 아래 표로 정리했다.",
      "",
      "| field | status | reason | count |",
      "| --- | --- | --- | --- |",
      "| thinking | pass | none | 1 |",
      "| content | pass | none | 2 |",
      "",
      "모든 필드가 한국어 기준을 충족한다.",
    ].join("\n");
    assert.equal(analyzeField("content", markdownTable).status, "korean");

    const modelList =
      "지원 모델 목록은 GPT 4o, Gemini 2.5 Pro, Claude Opus 4.5, Llama 3.3 등을 포함하며 각각의 한국어 유지율을 비교한다.";
    assert.equal(analyzeField("content", modelList).status, "korean");

    const swarmHintContent = [
      "스웜 에이전트 배치를 완료했고 각 담당자가 독립 워크트리에서 수정과 검증을 진행하고 있다.",
      "결과가 도착하는 대로 통합 테스트와 플러그인 유효성 검증을 실행해 보고하겠다.",
      "",
      "Run /swarm board (default shortcut alt+s) to open the live board.",
    ].join("\n");
    assert.equal(analyzeField("content", swarmHintContent).status, "korean");
  });

  it("still detects English prose inside table cells or bullet items", () => {
    const englishTableCell = [
      "검증 결과를 정리한다.",
      "",
      "| field | note |",
      "| --- | --- |",
      "| thinking | Let me explain the entire architecture in English right now without switching back |",
      "",
      "설명을 마무리한다.",
    ].join("\n");
    assert.equal(analyzeField("content", englishTableCell).status, "drifted");

    const englishBullets = [
      "다음 단계를 정리한다.",
      "",
      "- Let me inspect the analyzer module carefully first.",
      "- Then I will update the transcript reducer logic.",
    ].join("\n");
    assert.equal(analyzeField("content", englishBullets).status, "drifted");
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

  it("detects tail English segment drift including shorter trailing sentences", () => {
    const thinking = [
      "먼저 플러그인 매니페스트와 규칙 파일이 안티그래비티 로더 규격에 맞는지 확인한다.",
      "전사 분석기는 외부 파일 입출력과 완전히 분리된 순수 모듈로 설계해 재현 가능한 단위 테스트를 작성한다.",
      "반복 호출 시 이미 보정 메시지가 주입되어 있다면 중복 주입하지 않고 조용히 통과해야 한다.",
      "",
      "Let me check this file before proceeding.",
    ].join("\n");

    const analysis = analyzeField("thinking", thinking);
    assert.ok(analysis.hangulRatio >= MIN_HANGUL_RATIO);
    assert.equal(analysis.status, "drifted");
    assert.equal(analysis.driftReason, "english_segment");
  });

  it("detects interspersed short English prose lines inside Korean text", () => {
    const mixed = [
      "먼저 첫 번째 설정 파일을 확인한다.",
      "Let me check the first file.",
      "그다음 두 번째 파서 모듈의 경계를 검토한다.",
      "Now I will inspect the parser.",
      "마지막으로 모든 결과를 정리한다.",
    ].join("\n");

    const analysis = analyzeField("thinking", mixed);
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

    const commaClauses =
      "먼저 전체 구조를 분석하고 모듈 경계를 정리했다. Wait, let me check the config, then update the parser, and finally run the tests. 그다음 결과를 기록한다.";
    assert.equal(analyzeField("thinking", commaClauses).status, "drifted");
  });

  it("detects short pure-English prose while keeping tiny fragments insufficient", () => {
    const shortProse = analyzeField("thinking", "I will run the unit tests now.");
    assert.equal(shortProse.status, "drifted");
    assert.equal(shortProse.driftReason, "short_english_prose");

    const shortWithInlineCode = analyzeField(
      "thinking",
      "Let me check `scripts/analyzer.mjs` and `hooks.json` first.",
    );
    assert.equal(shortWithInlineCode.status, "drifted");
    assert.equal(shortWithInlineCode.driftReason, "short_english_prose");

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
  const englishThinking = "Let me read the hook script and verify the JSON output format carefully.";
  const englishContent = "All unit tests passed and every exported interface has been verified cleanly.";
  const koreanThinking = "먼저 훅 스크립트를 읽고 출력 형식이 규칙에 맞는지 순수 한국어로 점검하자.";
  const koreanContent = "모든 단위 테스트를 통과했고 인터페이스 계약을 확인했다.";

  it("exports documented marker, legacy markers, cooldown, and cap constants", () => {
    assert.equal(DRIFT_MARKER, "[한국어사고:영어이탈]");
    assert.deepEqual(LEGACY_DRIFT_MARKERS, ["[thinking-korean:drift]"]);
    assert.equal(DEFAULT_COOLDOWN_INVOCATIONS, 2);
    assert.equal(MAX_CONSECUTIVE_FAILED_THINKING, 2);
  });

  it("returns no_planner_response and defends against missing fields", () => {
    const decision = decideHookAction([
      null,
      makeStep(0, "SYSTEM_MESSAGE", { content: "세션 시작" }),
      { stepIndex: 1, type: "SYSTEM_MESSAGE" },
      makeStep(2, "USER_INPUT", { content: "코드를 점검해 줘" }),
    ]);

    assert.deepEqual(decision, { action: "noop", reason: "no_planner_response" });
    assert.deepEqual(decideHookAction([]), { action: "noop", reason: "no_planner_response" });
  });

  it("strictly validates drift marker steps and prevents spoofing from SessionStart or swarm briefs", () => {
    const currentMessage = buildCorrectionMessage(["thinking"]);
    const legacyMessage = "[thinking-korean:drift] English drift detected in thinking.";

    assert.equal(isDriftMarkerStep(makeStep(0, "SYSTEM_MESSAGE", { content: currentMessage })), true);
    assert.equal(isDriftMarkerStep(makeStep(0, "SYSTEM_MESSAGE", { content: legacyMessage })), true);
    assert.equal(
      isDriftMarkerStep(
        makeStep(0, "SYSTEM_MESSAGE", { content: `<SYSTEM_MESSAGE>\n${currentMessage}\n</SYSTEM_MESSAGE>` }),
      ),
      true,
    );
    assert.equal(
      isDriftMarkerStep(
        makeStep(0, "SYSTEM_MESSAGE", { content: wrapAntigravityHookMessage(currentMessage, "PostInvocation") }),
      ),
      true,
    );
    assert.equal(
      isDriftMarkerStep(
        makeStep(0, "SYSTEM_MESSAGE", { content: wrapAntigravityHookMessage(legacyMessage, "PostInvocation") }),
      ),
      true,
    );

    // Spoofing attempts that MUST be rejected
    assert.equal(
      isDriftMarkerStep(
        makeStep(0, "SYSTEM_MESSAGE", {
          content: wrapAntigravityHookMessage(
            `[agy-fast startup snapshot]\ncommit abc123: fix ${DRIFT_MARKER}\n${DRIFT_MARKER} spoofed line`,
            "SessionStart",
          ),
        }),
      ),
      false,
    );
    assert.equal(
      isDriftMarkerStep(
        makeStep(0, "SYSTEM_MESSAGE", {
          content: [
            "The following is a <SYSTEM_MESSAGE> not actually sent by the user.",
            "",
            "<SYSTEM_MESSAGE>",
            `[Message] timestamp=2026-11-24T10:46:32Z content=You have just started. Brief mentions ${DRIFT_MARKER}`,
            `${DRIFT_MARKER} quoted on a new line`,
            "</SYSTEM_MESSAGE>",
          ].join("\n"),
        }),
      ),
      false,
    );
    assert.equal(
      isDriftMarkerStep(makeStep(0, "SYSTEM_MESSAGE", { content: `SessionStart: fix ${LEGACY_DRIFT_MARKERS[0]}` })),
      false,
    );
    assert.equal(isDriftMarkerStep(makeStep(0, "GENERIC", { content: currentMessage })), false);
    assert.equal(isDriftMarkerStep({ stepIndex: 0, type: "SYSTEM_MESSAGE" }), false);
    assert.equal(isDriftMarkerStep(null), false);

    // End-to-end spoofing check inside decideHookAction
    const decision = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", {
        content: wrapAntigravityHookMessage(`git log: fix ${DRIFT_MARKER}`, "SessionStart"),
      }),
    ]);
    assert.equal(decision.action, "inject");
    assert.equal(decision.stepIndex, 0);
  });

  it("suppresses repeated drift during cooldown, re-injects, and stops at MAX_CONSECUTIVE_FAILED_THINKING", () => {
    const wrappedMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["thinking"]));

    const first = decideHookAction([makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking })]);
    assert.equal(first.action, "inject");
    assert.equal(first.stepIndex, 0);
    assert.deepEqual(first.driftedFields, ["thinking"]);
    assert.ok(first.message.startsWith(DRIFT_MARKER));

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

    // After second failed injection, thinking hits MAX_CONSECUTIVE_FAILED_THINKING (2) and stops polluting context
    const cappedSteps = [
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(5, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(6, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(7, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(8, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(9, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ];
    assert.deepEqual(decideHookAction(cappedSteps), { action: "noop", reason: "thinking_cap_reached" });
  });

  it("applies exponential backoff when cap allows more than two attempts", () => {
    const wrappedMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["thinking"]));
    const steps = [
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(5, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(6, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(7, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(8, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(9, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ];

    // After 2nd failed injection with base cooldown 2, exponential cooldown is 4 responses
    assert.deepEqual(decideHookAction(steps, { maxConsecutiveFailedThinking: 3 }), {
      action: "noop",
      reason: "cooldown_active",
    });

    const fifthAfterSecondMarker = decideHookAction(
      [...steps, makeStep(10, "PLANNER_RESPONSE", { thinking: englishThinking })],
      { maxConsecutiveFailedThinking: 3 },
    );
    assert.equal(fifthAfterSecondMarker.action, "inject");
    assert.equal(fifthAfterSecondMarker.stepIndex, 10);
  });

  it("resets cooldown and failure cap immediately when thinking genuinely recovers to Korean", () => {
    const wrappedMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["thinking"]));

    const recovered = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking }),
    ]);
    assert.deepEqual(recovered, { action: "noop", reason: "ok" });

    // Re-drift immediately after genuine recovery must NOT be blocked by the old cooldown
    const reDriftedAfterRecovery = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ]);
    assert.equal(reDriftedAfterRecovery.action, "inject");
    assert.equal(reDriftedAfterRecovery.stepIndex, 3);
    assert.deepEqual(reDriftedAfterRecovery.driftedFields, ["thinking"]);

    // Recovery after hitting thinking cap unlocks future injections
    const unlockedAfterCap = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(5, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(6, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(7, "PLANNER_RESPONSE", { thinking: koreanThinking }),
      makeStep(8, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ]);
    assert.equal(unlockedAfterCap.action, "inject");
    assert.equal(unlockedAfterCap.stepIndex, 8);
  });

  it("does not unlock thinking cap on empty or insufficient thinking steps", () => {
    const wrappedMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["thinking"]));
    const steps = [
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(5, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(6, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(7, "PLANNER_RESPONSE", { thinking: "", content: koreanContent }),
      makeStep(8, "PLANNER_RESPONSE", { thinking: englishThinking, content: koreanContent }),
    ];

    assert.deepEqual(decideHookAction(steps), { action: "noop", reason: "thinking_cap_reached" });
  });

  it("still corrects content drift independently after thinking reaches its consecutive failure cap", () => {
    const wrappedThinkingMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["thinking"]));
    const steps = [
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking, content: koreanContent }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedThinkingMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking, content: koreanContent }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking, content: koreanContent }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: englishThinking, content: koreanContent }),
      makeStep(5, "SYSTEM_MESSAGE", { content: wrappedThinkingMarker }),
      makeStep(6, "PLANNER_RESPONSE", { thinking: englishThinking, content: koreanContent }),
      makeStep(7, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishContent }),
    ];

    const decision = decideHookAction(steps);
    assert.equal(decision.action, "inject");
    assert.equal(decision.stepIndex, 7);
    assert.deepEqual(decision.driftedFields, ["content"]);
    assert.ok(decision.message.includes("최종 응답"));
  });

  it("exempts content drift on explicit translation/English requests while still enforcing Korean thinking", () => {
    assert.equal(isExplicitEnglishOutputRequest("이 문단을 자연스러운 영어로 번역해 줘"), true);
    assert.equal(isExplicitEnglishOutputRequest("영문으로 요약해 줘"), true);
    assert.equal(isExplicitEnglishOutputRequest("Translate this paragraph into English."), true);
    assert.equal(isExplicitEnglishOutputRequest("Please reply in English."), true);

    assert.equal(isExplicitEnglishOutputRequest("지금도 전부 영어로 나오잖아"), false);
    assert.equal(isExplicitEnglishOutputRequest("왜 영어로 생각하는지 분석해 줘"), false);
    assert.equal(isExplicitEnglishOutputRequest("영어로 번역하지 말고 한국어로 답해 줘"), false);
    assert.equal(isExplicitEnglishOutputRequest("Do not reply in English, answer in Korean."), false);
    assert.equal(
      isExplicitEnglishOutputRequest(
        "<USER_REQUEST>\n구조를 분석해 줘\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nWrite in English\n</ADDITIONAL_METADATA>",
      ),
      false,
    );

    const translatedOk = decideHookAction([
      makeStep(0, "USER_INPUT", {
        content:
          "<USER_REQUEST>\n이 문단을 자연스러운 영어로 번역해 줘\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nTime: now\n</ADDITIONAL_METADATA>",
      }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent }),
    ]);
    assert.deepEqual(translatedOk, { action: "noop", reason: "ok" });

    // Even during translation, English thinking MUST still trigger drift correction for thinking only
    const translatedThinkingDrift = decideHookAction([
      makeStep(0, "USER_INPUT", {
        content: "<USER_REQUEST>\n이 문단을 영어로 번역해 줘\n</USER_REQUEST>",
      }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishContent }),
    ]);
    assert.equal(translatedThinkingDrift.action, "inject");
    assert.deepEqual(translatedThinkingDrift.driftedFields, ["thinking"]);

    // Subsequent non-translation turn restores content checking
    const nextTurnDrift = decideHookAction([
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 번역해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent }),
      makeStep(2, "USER_INPUT", { content: "<USER_REQUEST>\n이제 아키텍처를 분석해 줘\n</USER_REQUEST>" }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent }),
    ]);
    assert.equal(nextTurnDrift.action, "inject");
    assert.deepEqual(nextTurnDrift.driftedFields, ["content"]);

    // options.lastUserInput also exempts content
    const viaLastUserInput = decideHookAction(
      [makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent })],
      { lastUserInput: "Please write the response in English" },
    );
    assert.deepEqual(viaLastUserInput, { action: "noop", reason: "ok" });
  });

  it("is idempotent when a current or legacy drift marker already follows the latest planner response", () => {
    const withCurrent = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", {
        content: `<SYSTEM_MESSAGE>\n${buildCorrectionMessage(["thinking"])}\n</SYSTEM_MESSAGE>`,
      }),
    ]);
    assert.deepEqual(withCurrent, { action: "noop", reason: "already_covered" });

    const withLegacy = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", {
        content: wrapAntigravityHookMessage(`${LEGACY_DRIFT_MARKERS[0]} legacy message`),
      }),
    ]);
    assert.deepEqual(withLegacy, { action: "noop", reason: "already_covered" });
  });

  it("tolerates blank lines, malformed JSON, non-object entries, and string step_index in JSONL", () => {
    const raw = [
      "",
      "{broken json",
      "null",
      "42",
      "[]",
      JSON.stringify({ step_index: "1", type: "USER_INPUT", content: "확인해 줘" }),
      "   ",
      JSON.stringify({
        step_index: "2",
        type: "PLANNER_RESPONSE",
        thinking: "Now I will inspect the files and verify the remaining conditions.",
        content: "모든 파일을 점검하고 결과를 정리했다.",
      }),
    ].join("\n");

    const steps = parseTranscriptJsonl(raw);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].stepIndex, 1);
    assert.equal(steps[1].stepIndex, 2);

    const decision = decideHookAction(steps);
    assert.equal(decision.action, "inject");
    assert.deepEqual(decision.driftedFields, ["thinking"]);
  });

  it("builds pure-Korean correction messages tailored to the drifted fields", () => {
    const thinkingOnly = buildCorrectionMessage(["thinking"]);
    const contentOnly = buildCorrectionMessage(["content"]);
    const both = buildCorrectionMessage(["thinking", "content"]);
    const fallback = buildCorrectionMessage([]);

    for (const msg of [thinkingOnly, contentOnly, both, fallback]) {
      assert.ok(msg.startsWith(DRIFT_MARKER));
      assert.equal(/[A-Za-z]/.test(msg), false, `Correction message must be pure Korean: ${msg}`);
    }

    assert.ok(thinkingOnly.includes("직전 내부 추론과 사고 요약이 영어로 작성되었다."));
    assert.equal(thinkingOnly.includes("직전 최종 응답이 영어로 작성되었다."), false);

    assert.ok(contentOnly.includes("직전 최종 응답이 영어로 작성되었다."));
    assert.equal(contentOnly.includes("직전 내부 추론과 사고 요약이 영어로 작성되었다."), false);

    assert.ok(both.includes("직전 내부 추론·사고 요약과 최종 응답이 모두 영어로 작성되었다."));
    assert.ok(fallback.includes("영어 이탈이 감지되었다."));
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
    assert.equal(/[A-Za-z]/.test(injectedMessage), false);
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

  it("trims transcriptPath, guards hookEventName, and forwards lastUserInput for translation exemption", () => {
    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          thinking: "먼저 번역할 문단의 의미를 한국어로 분석하고 자연스러운 표현을 고르자.",
          content: "Here is the natural English translation of the requested Korean paragraph.",
        },
      ]),
      "utf8",
    );

    // Non-PostInvocation event is ignored even if transcript drifted
    const ignoredEvent = handlePostInvocation(
      JSON.stringify({
        hookEventName: "SessionStart",
        transcriptPath: `  ${transcriptPath}  `,
      }),
    );
    assert.deepEqual(ignoredEvent, {});

    // Without translation request, content drift triggers injection (and trimmed path works)
    const drifted = handlePostInvocation(
      JSON.stringify({
        hookEventName: "PostInvocation",
        transcriptPath: `  ${transcriptPath}  `,
      }),
    );
    assert.equal(drifted.injectSteps.length, 1);

    // With explicit lastUserInput translation request, content drift is exempted
    const proc = spawnSync(process.execPath, [HOOK_SCRIPT], {
      cwd: PLUGIN_ROOT,
      input: JSON.stringify({
        hookEventName: "PostInvocation",
        transcriptPath: `  ${transcriptPath}  `,
        lastUserInput: "이 문단을 자연스러운 영어로 번역해 줘",
      }),
      encoding: "utf8",
    });
    assert.equal(proc.status, 0);
    assert.equal(proc.stdout, "{}\n");
  });

  it("fast-scans large transcripts with multi-MB GENERIC lines and chunk-spanning UTF-8 safely", () => {
    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const hugeToolPayload = "X".repeat(1024 * 1024);
    const longKoreanThinking = "한국어 추론 내용이 청크 경계를 넘어도 깨지지 않는다. ".repeat(6000);

    const records = [
      { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\n전체 코드를 분석해 줘\n</USER_REQUEST>" },
      { step_index: 1, type: "GENERIC", content: hugeToolPayload },
      { step_index: 2, type: "GENERIC", content: hugeToolPayload },
      { step_index: 3, type: "GENERIC", content: hugeToolPayload },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        thinking: longKoreanThinking,
        content: "모든 분석을 마치고 한국어로 결과를 보고한다.",
      },
    ];
    writeFileSync(transcriptPath, toJsonl(records), "utf8");

    const okResult = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    assert.deepEqual(okResult, {});

    // Append a drifted planner response after another huge GENERIC step (without trailing newline)
    const withDrift =
      toJsonl(records) +
      `${JSON.stringify({ step_index: 5, type: "GENERIC", content: hugeToolPayload })}\n` +
      JSON.stringify({
        step_index: 6,
        type: "PLANNER_RESPONSE",
        thinking: "Let me inspect the remaining modules and verify the hook output format.",
        content: "모든 모듈을 점검했다.",
      });
    writeFileSync(transcriptPath, withDrift, "utf8");

    const driftResult = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    assert.equal(driftResult.injectSteps.length, 1);
    assert.ok(driftResult.injectSteps[0].systemMessage.systemMessage.startsWith(DRIFT_MARKER));
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
