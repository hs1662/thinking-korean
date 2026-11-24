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
import { handleStop } from "../scripts/stop.mjs";
import {
  DEFAULT_COOLDOWN_INVOCATIONS,
  DRIFT_MARKER,
  LEGACY_DRIFT_MARKERS,
  MAX_CONSECUTIVE_FAILED_THINKING,
  buildCorrectionMessage,
  decideHookAction,
  decideStopAction,
  isDriftMarkerStep,
  isExplicitEnglishOutputRequest,
  parseTranscriptJsonl,
} from "../scripts/transcript.mjs";
import { summarizeTranscript } from "./verify-live.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "..");
const HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "post-invocation.mjs");
const STOP_HOOK_SCRIPT = join(PLUGIN_ROOT, "scripts", "stop.mjs");
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
    assert.equal(rulesText.includes("영문 알파벳을 단 한 글자도 쓰지 말고"), false);
    assert.equal(rulesText.includes("반드시 한국어 뜻이나 한글 음차로 바꿔서"), false);
    assert.ok(rulesText.includes("자연스러운 한국어"));
    assert.ok(rulesText.includes("이 추론과 생각 요약은 반드시 한국어로만 작성한다."));
    assert.ok(rulesText.includes("영어 문장"));
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

  it("passes natural Korean conversational sentences with embedded English words and technical terms", () => {
    const naturalKoreanSamples = [
      "지금 docker랑 postgres memory, disk, port 상태 체크하고 log랑 config 확인해 보자.",
      "이 PR은 cache랑 timeout 처리만 고치면 되고, lint랑 test 돌려서 pass 확인하자.",
      "이 컴포넌트는 dark mode랑 responsive layout 지원하고, hover state랑 focus ring 스타일만 맞추면 돼.",
      "원인 보니까 retry backoff랑 token budget 계산에서 race condition이 나서 stale cache가 남았어.",
      [
        "먼저 docker랑 postgres 상태 확인하고 memory, disk, port 설정을 체크해 보자.",
        "그다음 retry backoff랑 token budget 로직만 다듬어서 lint랑 test pass까지 보면 깔끔할 거야.",
      ].join("\n"),
    ];

    for (const sample of naturalKoreanSamples) {
      const thinkingAnalysis = analyzeField("thinking", sample);
      assert.equal(thinkingAnalysis.status, "korean", `expected thinking korean for: ${sample}`);
      assert.equal(thinkingAnalysis.driftReason, "none");

      const contentAnalysis = analyzeField("content", sample);
      assert.equal(contentAnalysis.status, "korean", `expected content korean for: ${sample}`);
      assert.equal(contentAnalysis.driftReason, "none");
    }
  });

  it("still catches genuine English clauses, contractions, and 4+ word runs mixed into Korean lines", () => {
    const mixedDriftSamples = [
      "먼저 확인했다. Let me check this file before proceeding.",
      "먼저 확인했다. I'll fix it. 그다음 배포한다. It works now.",
      "먼저 로그를 확인했다. We can't skip this step. 그다음 정리한다. Don't ignore it.",
      "먼저 구조를 정리하고 Wait, let me check, then update the parser, and run tests. 마무리한다.",
      "먼저 구조를 확인하고 apple banana orange grape 정리한다.",
      "먼저 구조를 확인하고 apple banana orange grape peach melon lemon mango 정리한다.",
      "먼저 확인했다. Fix bug. Deploy build. Verify pass. 이제 끝낸다.",
      "먼저 확인했다. Fix parser bug. 그다음 배포한다. Run unit tests.",
      "먼저 확인했다. fix for bug와 works on server 쪽 체크해 보자.",
      "확인했음. Let me check the file.",
      "확인했습니다. Let me check this now.",
      "이 추론과 생각 요약은 반드시 한국어로만 작성한다. Checking parser output, verifying regex logic, running tests quickly, comparing results carefully, fixing edge cases.",
      "먼저 확인했다. Checking parser output, verifying regex logic, running tests quickly 정리한다.",
    ];

    for (const sample of mixedDriftSamples) {
      const analysis = analyzeField("thinking", sample);
      assert.equal(analysis.status, "drifted", `expected drifted for: ${sample}`);
    }
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
      assert.equal(msg.includes("영문 알파벳을 단 한 글자도 쓰지 말고"), false);
      assert.equal(msg.includes("한글 음차"), false);
      assert.ok(msg.includes("이 추론과 생각 요약은 반드시 한국어로만 작성한다."));
    }

    assert.ok(thinkingOnly.includes("직전 내부 추론과 생각 요약이 영어로 작성되었다."));
    assert.equal(thinkingOnly.includes("직전 최종 응답이 영어로 작성되었다."), false);

    assert.ok(contentOnly.includes("직전 최종 응답이 영어로 작성되었다."));
    assert.equal(contentOnly.includes("직전 내부 추론과 생각 요약이 영어로 작성되었다."), false);

    assert.ok(both.includes("직전 내부 추론·생각 요약과 최종 응답이 모두 영어로 작성되었다."));
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

  it("does not skip PLANNER_RESPONSE or USER_INPUT when a nested type field appears before byte 256", () => {
    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const padding = "A".repeat(300);

    // Nested "type":"tool_result" sits inside the first 256 bytes, while top-level "type":"PLANNER_RESPONSE" comes after byte 256.
    const nestedPlannerRecord = {
      step_index: 1,
      payload: { type: "tool_result", padding },
      type: "PLANNER_RESPONSE",
      thinking: "Let me inspect the parser implementation carefully before making any edit.",
      content: "파서 구현을 확인하고 변경 사항을 한국어로 정리했다.",
    };
    assert.ok(JSON.stringify(nestedPlannerRecord).indexOf('"PLANNER_RESPONSE"') > 256);

    writeFileSync(transcriptPath, `${JSON.stringify(nestedPlannerRecord)}\n`, "utf8");
    const driftResult = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    assert.equal(driftResult.injectSteps.length, 1);
    assert.ok(driftResult.injectSteps[0].systemMessage.systemMessage.startsWith(DRIFT_MARKER));

    // Nested "type":"tool_result" before byte 256 on USER_INPUT must still preserve explicit translation exemption.
    const nestedUserInput = {
      step_index: 0,
      meta: { type: "tool_result", padding },
      type: "USER_INPUT",
      content: "<USER_REQUEST>\n이 문장을 영어로 해 줘\n</USER_REQUEST>",
    };
    assert.ok(JSON.stringify(nestedUserInput).indexOf('"USER_INPUT"') > 256);

    const genericWithNestedPlanner = {
      step_index: 1,
      meta: { type: "PLANNER_RESPONSE" },
      type: "GENERIC",
      content: "Z".repeat(400_000),
    };
    const translatedResponse = {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      thinking: "먼저 원문의 핵심 의미를 한국어로 파악하고 자연스러운 표현 방향을 구상한다.",
      content: "Here is the natural English translation of the requested sentence.",
    };
    writeFileSync(
      transcriptPath,
      toJsonl([nestedUserInput, genericWithNestedPlanner, translatedResponse]),
      "utf8",
    );
    const exemptResult = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    assert.deepEqual(exemptResult, {});
  });

  it("handles exact 256-byte lines and partial-chunk reads safely without scanning past bytesRead", () => {
    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");

    const buildExactByteRecord = (targetBytes, type, thinking) => {
      const base = { step_index: 0, type, thinking, content: "한국어", pad: "" };
      const overhead = Buffer.byteLength(JSON.stringify(base), "utf8");
      base.pad = "P".repeat(Math.max(0, targetBytes - overhead));
      const serialized = JSON.stringify(base);
      assert.equal(Buffer.byteLength(serialized, "utf8"), targetBytes);
      return serialized;
    };

    const line255 = buildExactByteRecord(
      255,
      "PLANNER_RESPONSE",
      "한국어 사고 문장이 정확히 이백오십오 바이트 경계에서도 안전하게 처리된다.",
    );
    const line256 = buildExactByteRecord(
      256,
      "PLANNER_RESPONSE",
      "한국어 사고 문장이 정확히 이백오십육 바이트 경계에서도 안전하게 처리된다.",
    );
    const line257Drifted = buildExactByteRecord(
      257,
      "PLANNER_RESPONSE",
      "Now let me inspect the remaining files carefully before writing any output.",
    );

    // Put >256KB GENERIC first so the final 255/256/257B lines land in a partial trailing chunk (bytesRead < CHUNK_SIZE) without trailing newline.
    const bigGeneric = JSON.stringify({ step_index: 0, type: "GENERIC", content: "G".repeat(270_000) });
    writeFileSync(transcriptPath, `${bigGeneric}\n${line255}\n${line256}\n${line257Drifted}`, "utf8");

    const result = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    assert.equal(result.injectSteps.length, 1);
    assert.ok(result.injectSteps[0].systemMessage.systemMessage.startsWith(DRIFT_MARKER));
  });
});

describe("regression tests for analyzer, translation request, and verify-live summary", () => {
  it("exempts short markdown headings and cited English principle titles inside Korean content while catching prose drift", () => {
    // Exact #17 repro: Claude heavy-english-skill-tools Korean content with short English markdown heading
    const claudeContentRepro = [
      "문서 전체와 분석기 구현을 확인한 결과를 아래 항목별로 정리한다.",
      "",
      "### ③ Test Behavior, Not Implementation (+ Prove It Works)",
      "내부 구현 세부 사항에 결합하지 않고 실제 드리프트 감지, 번역 요청 면제, 복구 시 백오프 초기화 같은 관찰 가능한 동작을 검증해야 한다.",
      "또한 문법 검사, 엄격 매니페스트 검증, 실행 권한, 격리 라이브 실행까지 확인해 변경의 신뢰성을 보장한다.",
    ].join("\n");
    const claudeAnalysis = analyzeField("content", claudeContentRepro);
    assert.equal(claudeAnalysis.status, "korean");
    assert.equal(claudeAnalysis.driftReason, "none");

    // 8-word English heading rule title inside Korean content must not trigger english_run or english_segment
    const headingWithEightWords = [
      "분석기 설계에서 특히 중요한 규칙을 정리한다.",
      "",
      "### 3. Prefer deterministic line scanners over fragile backtracking regexes",
      "다중 줄 코드 펜스와 중첩 백틱은 정규식 대신 결정적 라인 스캐너로 처리해야 자연어 오삭제를 막을 수 있다.",
    ].join("\n");
    assert.equal(analyzeField("content", headingWithEightWords).status, "korean");

    // Quoted, parenthetical, bold, and separator-listed English rule titles inside Korean explanations (Gemini ~90% Korean content style)
    const geminiCitedTitlesContent = [
      "문서 전체의 핵심 원칙과 분석기 구현 경계를 한국어로 상세하게 정리하면 다음과 같다.",
      "결정적 라인 스캐너 우선(Prefer deterministic line scanners over fragile backtracking regexes) 규칙을 분석기에 적용하면 다중 줄 코드 펜스 처리에서 발생하는 역추적 위험을 효과적으로 줄일 수 있다.",
      '문서의 "Prefer deterministic line scanners over fragile backtracking regexes" 규칙은 줄 단위 스캐너로 펜스 경계를 정확히 유지하도록 안내한다.',
      "- **Prefer deterministic line scanners over fragile backtracking regexes**: 정규식 대신 줄 단위 스캐너를 사용해 안전하게 파싱한다.",
      "- **Test Behavior, Not Implementation**: 내부 구현 세부가 아니라 외부에서 관찰 가능한 동작을 중심으로 검증한다.",
      "핵심 원칙인 Boundary Discipline · Model the Domain · Guard the Context Window · Prove It Works를 분석기 검증 흐름에 차례로 적용해 경계 오류와 컨텍스트 오염을 함께 차단한다.",
      "주요 원칙 Boundary Discipline / Model the Domain / Prove It Works를 단위 테스트와 격리 라이브 검증 설계에 모두 반영해 신뢰성을 확보했다.",
    ].join("\n");
    const geminiAnalysis = analyzeField("content", geminiCitedTitlesContent);
    assert.equal(geminiAnalysis.status, "korean");
    assert.equal(geminiAnalysis.driftReason, "none");

    // Concise Korean bullet list citing English rule titles in bold/quotes/parentheses still passes when non-cited prose is Korean
    const conciseRuleBullets = [
      "- **Prefer deterministic line scanners over fragile backtracking regexes**: 정규식 대신 줄 단위 스캐너를 사용한다.",
      '- "Separate user-facing verbatim requirements from internal reasoning hygiene" 원칙에 따라 내부 사고와 최종 출력의 표기 범위를 분리한다.',
      "- 동작 중심 검증(Test Behavior, Not Implementation)을 기준으로 단위 테스트를 구성한다.",
    ].join("\n");
    assert.equal(analyzeField("content", conciseRuleBullets).status, "korean");

    // Long prose heading (>100 chars) inside Korean content MUST still be flagged
    const longProseHeading = [
      "전체 구조를 한국어로 간단히 요약한 뒤 다음 섹션을 확인한다.",
      "",
      "## Now let me explain the entire architecture and implementation details in English without switching back to Korean anytime soon",
      "추가 설명을 한국어로 이어서 정리한다.",
    ].join("\n");
    assert.equal(analyzeField("content", longProseHeading).status, "drifted");

    // All-English document made only of short headings MUST still trigger document-wide low_hangul_ratio
    const allEnglishHeadings = [
      "# Boundary Discipline",
      "## Model the Domain",
      "### Test Behavior, Not Implementation",
    ].join("\n");
    const allHeadingsAnalysis = analyzeField("content", allEnglishHeadings);
    assert.equal(allHeadingsAnalysis.status, "drifted");
    assert.equal(allHeadingsAnalysis.driftReason, "low_hangul_ratio");

    // Genuine 8+ word English prose runs inside high-Hangul Korean sentences (quoted, parenthetical) MUST still trigger english_run
    const quotedProseRun =
      '먼저 플러그인 전체 설정 파일과 전사 분석기 경계 조건을 차례대로 확인하며 한국어로 정리했다. 이어서 중간 메모를 남기면서 "Let me check the configuration file first and verify every module carefully." 라고 적은 뒤 최종 결과를 한국어로 보고하고 검증을 마무리한다.';
    const quotedProseAnalysis = analyzeField("content", quotedProseRun);
    assert.ok(quotedProseAnalysis.hangulRatio >= MIN_HANGUL_RATIO);
    assert.equal(quotedProseAnalysis.status, "drifted");
    assert.equal(quotedProseAnalysis.driftReason, "english_run");

    const parenProseRun =
      "먼저 플러그인 전체 설정 파일과 전사 분석기 경계 조건을 차례대로 확인하며 한국어로 정리했다. 이어서 보충 설명 (I will now check the remaining parser files carefully before editing.) 을 덧붙인 뒤 최종 결과를 한국어로 보고하고 검증을 마무리한다.";
    const parenProseAnalysis = analyzeField("content", parenProseRun);
    assert.ok(parenProseAnalysis.hangulRatio >= MIN_HANGUL_RATIO);
    assert.equal(parenProseAnalysis.status, "drifted");
    assert.equal(parenProseAnalysis.driftReason, "english_run");
  });

  it("strips fenced code blocks inside blockquotes without swallowing trailing English prose", () => {
    // Exact #17 repro: ~33 Hangul chars + 8-line > ```js block
    const quotedCodeRepro = [
      "아래 인용된 자바스크립트 예시 코드의 핵심 동작만 한국어로 요약한다.",
      "",
      "> ```js",
      "> function processItems(records) {",
      ">   const normalized = records.filter(Boolean);",
      ">   const mapped = normalized.map((entry) => entry.trim());",
      ">   const unique = Array.from(new Set(mapped));",
      ">   return unique.sort((a, b) => a.localeCompare(b));",
      "> }",
      "> ```",
    ].join("\n");
    const analysis = analyzeField("content", quotedCodeRepro);
    assert.equal(analysis.latinCount, 0);
    assert.equal(analysis.status, "korean");

    // Nested blockquote fenced code block
    const nestedQuotedCode = [
      "중첩 인용구 내부의 코드 블록도 자연어 비율 계산에서 완전히 제외한다.",
      "",
      "> > ```ts",
      "> > export const computeTotal = (values: number[]) => values.reduce((a, b) => a + b, 0);",
      "> > ```",
    ].join("\n");
    assert.equal(analyzeField("content", nestedQuotedCode).status, "korean");

    // Unclosed fence inside a blockquote MUST NOT swallow English prose outside the blockquote
    const unclosedQuotedFence = [
      "> ```js",
      "> const onlyQuoted = true;",
      "",
      "Now let me continue explaining the remaining logic in English outside the blockquote.",
    ].join("\n");
    assert.equal(analyzeField("thinking", unclosedQuotedFence).status, "drifted");
  });

  it("bounds ERROR_QUOTE_RE length/openers and catches short English prose with 1-2 Hangul chars", () => {
    // Generic prose openers must NOT be stripped as error quotes
    const couldNotProse =
      '"Could not decide whether to refactor the whole module right now because the tests are unclear."';
    assert.equal(analyzeField("thinking", couldNotProse).status, "drifted");

    const failedToSeeProse =
      "> Failed to see why the previous logic should stay intact when a simpler parser exists.";
    assert.equal(analyzeField("thinking", failedToSeeProse).status, "drifted");

    // Overlong >180 char quote even starting with Error: or Failed to connect must NOT be stripped
    const overlongErrorLikeProse =
      '"Error: Failed to connect to the service, and now let me spend several extra clauses explaining the full architectural rationale in English so that the quote easily exceeds the one hundred eighty character limit."';
    assert.ok(overlongErrorLikeProse.length > 180);
    assert.equal(analyzeField("thinking", overlongErrorLikeProse).status, "drifted");

    // Legitimate short error quotes still pass inside Korean text
    const validShortErrors = [
      '원문 오류 "Failed to connect to remote host"와 "Could not find module foo"를 확인했다.',
      "> Unable to open file /etc/hosts",
      "모든 오류 로그를 한국어로 분석해 원인을 정리했다.",
    ].join("\n");
    assert.equal(analyzeField("content", validShortErrors).status, "korean");

    // 1-2 Hangul char prefix must NOT bypass short_english_prose
    const oneHangulDrift = analyzeField("thinking", "네, I will check the file now.");
    assert.equal(oneHangulDrift.status, "drifted");
    assert.equal(oneHangulDrift.driftReason, "short_english_prose");

    const twoHangulDrift = analyzeField("thinking", "확인, let me read this file now.");
    assert.equal(twoHangulDrift.status, "drifted");
    assert.equal(twoHangulDrift.driftReason, "short_english_prose");
  });

  it("accurately classifies all 9 #17 isExplicitEnglishOutputRequest cases plus edge cases", () => {
    const expectedFalse = [
      "이 문서는 영어로 작성되어 있어. 한국어로 요약해 줘",
      "이 문서는 영어로 작성된 파일이야. 한국어로 분석해 줘",
      "왜 자꾸 영어로 답변하는 거야?",
      "방금 영어로 응답했잖아. 한국어로 고쳐 줘",
      "영어로 출력되는 버그를 고쳐 줘",
      "영어로 설명하면 안 돼. 한국어로 말해 줘",
      "The agent kept trying to reply in English instead of Korean.",
      "영어로 쓰지 마. 한국어로 써 줘.",
      "영어로 답변 대신 한국어로 말해 줘",
      "Stop replying in English.",
      "Don't write in English.",
      "Why did the agent reply in English?",
    ];
    for (const input of expectedFalse) {
      assert.equal(isExplicitEnglishOutputRequest(input), false, `Expected false for: ${input}`);
    }

    const expectedTrue = [
      "이 문장을 영어로 해 줘",
      "영어로 이메일 초안을 작성해 줘",
      "영어로 설명해 주세요",
      "영어로 요약 부탁해",
      "영어로 답변을 원해",
      "Could you explain this in English?",
      "Do not use tools, translate this into English.",
    ];
    for (const input of expectedTrue) {
      assert.equal(isExplicitEnglishOutputRequest(input), true, `Expected true for: ${input}`);
    }
  });

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
});

describe("stop hook decision, adapter, and CLI", () => {
  const tempDirs = [];

  function createTempDir() {
    const dir = mkdtempSync(join(tmpdir(), "thinking-korean-stop-test-"));
    tempDirs.push(dir);
    return dir;
  }

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requests continuation with pure-Korean content correction when final content drifted on normal stop", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "구조를 요약해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 구조를 확인하고 핵심 동작을 한국어로 정리한다.",
        content: "I reviewed the repository structure and summarized all exported modules for you.",
      }),
    ];

    const decision = decideStopAction(steps, { terminationReason: "NO_TOOL_CALL" });
    assert.equal(decision.action, "continue");
    assert.equal(decision.stepIndex, 1);
    assert.equal(decision.alreadyCoveredByPostHook, false);
    assert.equal(decision.reasonMessage, buildCorrectionMessage(["content"]));
    assert.ok(decision.reasonMessage.startsWith(DRIFT_MARKER));
    assert.equal(/[A-Za-z]/.test(decision.reasonMessage), false);
  });

  it("omits duplicate reason when PostInvocation already injected a drift marker after the latest planner step", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "원인을 설명해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        content: "Here is the complete explanation of the root cause in English prose.",
      }),
      makeStep(2, "SYSTEM_MESSAGE", {
        content: wrapAntigravityHookMessage(buildCorrectionMessage(["content"])),
      }),
    ];

    const decision = decideStopAction(steps, { terminationReason: "NO_TOOL_CALL" });
    assert.equal(decision.action, "continue");
    assert.equal(decision.alreadyCoveredByPostHook, true);
    assert.equal(decision.reasonMessage, "");

    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "원인을 설명해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: "Here is the complete explanation of the root cause in English prose.",
        },
        {
          step_index: 2,
          type: "SYSTEM_MESSAGE",
          content: wrapAntigravityHookMessage(buildCorrectionMessage(["content"])),
        },
      ]),
      "utf8",
    );

    const output = handleStop(
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath,
        continuationActive: false,
        terminationReason: "NO_TOOL_CALL",
      }),
    );
    assert.deepEqual(output, { decision: "continue" });
  });

  it("guards against infinite continuation loops when continuationActive is true", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "원인을 설명해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        content: "Here is the complete explanation of the root cause in English prose.",
      }),
    ];

    const decision = decideStopAction(steps, { continuationActive: true });
    assert.deepEqual(decision, { action: "noop", reason: "continuation_active" });

    const dir = createTempDir();
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "원인을 설명해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: "Here is the complete explanation of the root cause in English prose.",
        },
      ]),
      "utf8",
    );

    const output = handleStop(
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath,
        continuationActive: true,
        terminationReason: "NO_TOOL_CALL",
      }),
    );
    assert.deepEqual(output, {});
  });

  it("enforces stateless one-retry cap per turn even if runtime omits continuationActive", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "원인을 설명해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        content: "First English explanation that triggered a correction marker.",
      }),
      makeStep(2, "SYSTEM_MESSAGE", {
        content: wrapAntigravityHookMessage(buildCorrectionMessage(["content"])),
      }),
      makeStep(3, "PLANNER_RESPONSE", {
        content: "Second English explanation that still drifted after continuation.",
      }),
    ];

    assert.deepEqual(
      decideStopAction(steps, { continuationActive: false, terminationReason: "NO_TOOL_CALL" }),
      { action: "noop", reason: "stop_retry_cap_reached" },
    );

    const nextTurnSteps = [
      ...steps,
      makeStep(4, "USER_INPUT", { content: "다음 문제도 한국어로 정리해 줘" }),
      makeStep(5, "PLANNER_RESPONSE", {
        content: "Another English response on a brand new user turn should be caught once.",
      }),
    ];
    const nextDecision = decideStopAction(nextTurnSteps, {
      continuationActive: false,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.equal(nextDecision.action, "continue");
    assert.equal(nextDecision.stepIndex, 5);
  });

  it("noops on non-normal termination reasons", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "설명해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        content: "Here is a full English response that should not continue after abnormal termination.",
      }),
    ];

    for (const terminationReason of ["", "ERROR", "USER_CANCELED", "MAX_INVOCATIONS", "ABORTED"]) {
      assert.deepEqual(decideStopAction(steps, { terminationReason }), {
        action: "noop",
        reason: "non_normal_termination",
      });
    }
    assert.deepEqual(decideStopAction(steps), {
      action: "noop",
      reason: "non_normal_termination",
    });
  });

  it("exempts English final content when lastUserInput or transcript USER_INPUT requested English output", () => {
    const transcriptExemptSteps = [
      makeStep(0, "USER_INPUT", { content: "이 문장을 영어로 번역해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "번역 방향을 한국어로 정리한다.",
        content: "This distributed retry policy combines exponential backoff with jitter.",
      }),
    ];
    assert.deepEqual(decideStopAction(transcriptExemptSteps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "content_exempt",
    });

    const overrideSteps = [
      makeStep(0, "USER_INPUT", { content: "구조를 한국어로 설명해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        content: "Please find the complete English summary of the architecture below.",
      }),
    ];
    assert.deepEqual(
      decideStopAction(overrideSteps, {
        lastUserInput: "Please reply in English.",
        terminationReason: "NO_TOOL_CALL",
      }),
      { action: "noop", reason: "content_exempt" },
    );
  });

  it("does not block stop when content is Korean even if thinking drifted to English", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "핵심 변경사항을 정리해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "Let me review every modified module carefully before producing the final summary.",
        content: "핵심 변경사항을 정리하고 모든 검증 결과를 확인했다.",
      }),
    ];

    assert.deepEqual(decideStopAction(steps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "ok",
    });
  });

  it("runs scripts/stop.mjs as a real subprocess and emits continue decision on English content drift", () => {
    const dir = createTempDir();
    const compactPath = join(dir, "transcript.jsonl");
    const fullPath = join(dir, "transcript_full.jsonl");

    writeFileSync(
      compactPath,
      toJsonl([
        {
          step_index: 0,
          type: "PLANNER_RESPONSE",
          content: "짧은 한국어 앞부분만 남고 잘린 응답이다.",
          truncated_fields: ["content"],
        },
      ]),
      "utf8",
    );
    writeFileSync(
      fullPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "구조를 설명해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          thinking: "먼저 전체 구조를 확인하고 핵심 모듈의 역할을 한국어로 정리한다.",
          content: "I inspected the repository layout and confirmed every exported hook works properly.",
        },
      ]),
      "utf8",
    );

    const proc = spawnSync(process.execPath, [STOP_HOOK_SCRIPT], {
      cwd: PLUGIN_ROOT,
      input: JSON.stringify({
        hookEventName: "Stop",
        transcriptPath: compactPath,
        continuationActive: false,
        terminationReason: "NO_TOOL_CALL",
      }),
      encoding: "utf8",
    });

    assert.equal(proc.status, 0);
    assert.equal(proc.stderr, "");
    assert.ok(proc.stdout.endsWith("\n"));

    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.decision, "continue");
    assert.equal(parsed.reason, buildCorrectionMessage(["content"]));
    assert.ok(parsed.reason.startsWith(DRIFT_MARKER));
    assert.equal(/[A-Za-z]/.test(parsed.reason), false);
  });

  it("fails open with exit code 0 and {} on malformed stdin, wrong hookEventName, or missing transcript", () => {
    const cases = [
      "",
      "{broken-json",
      JSON.stringify([]),
      JSON.stringify({ hookEventName: "PostInvocation", transcriptPath: "/tmp/nonexistent.jsonl" }),
      JSON.stringify({ hookEventName: "Stop", transcriptPath: "   " }),
      JSON.stringify({ hookEventName: "Stop", transcriptPath: "/tmp/does-not-exist-stop-hook.jsonl" }),
    ];

    for (const input of cases) {
      assert.deepEqual(handleStop(input), {});
      const proc = spawnSync(process.execPath, [STOP_HOOK_SCRIPT], {
        cwd: PLUGIN_ROOT,
        input,
        encoding: "utf8",
      });
      assert.equal(proc.status, 0);
      assert.equal(proc.stderr, "");
      assert.deepEqual(JSON.parse(proc.stdout), {});
    }
  });
});
