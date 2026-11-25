import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ENGLISH_RUN_WORD_THRESHOLD,
  MIN_HANGUL_RATIO,
  MIN_LATIN_CHARS_FOR_DRIFT,
  MIN_NATURAL_CHARS,
  SEGMENT_MAX_HANGUL_RATIO,
  SEGMENT_MIN_NATURAL_CHARS,
  SHORT_ENGLISH_PROSE_WORD_THRESHOLD,
  analyzeField,
  analyzeUiTexts,
  evaluatePlannerResponse,
  extractNaturalText,
} from "../scripts/analyzer.mjs";
import { decidePreToolUseAction } from "../scripts/transcript.mjs";
import { RULES_PATH } from "./helpers.mjs";

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

  it("enforces Korean rules for user-visible checklist and tool UI labels in rules/AGENTS.md", () => {
    const rulesText = readFileSync(RULES_PATH, "utf8");
    assert.equal(/[A-Za-z]/.test(rulesText), false);
    assert.ok(rulesText.includes("할 일 목록"));
    assert.ok(rulesText.includes("도구 실행 요약"));
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

describe("analyzer regressions: headings, quoted code, error quotes, and bypasses", () => {
  it("exempts short markdown headings and cited English principle titles inside Korean content while catching prose drift", () => {
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

    const headingWithEightWords = [
      "분석기 설계에서 특히 중요한 규칙을 정리한다.",
      "",
      "### 3. Prefer deterministic line scanners over fragile backtracking regexes",
      "다중 줄 코드 펜스와 중첩 백틱은 정규식 대신 결정적 라인 스캐너로 처리해야 자연어 오삭제를 막을 수 있다.",
    ].join("\n");
    assert.equal(analyzeField("content", headingWithEightWords).status, "korean");

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

    const conciseRuleBullets = [
      "- **Prefer deterministic line scanners over fragile backtracking regexes**: 정규식 대신 줄 단위 스캐너를 사용한다.",
      '- "Separate user-facing verbatim requirements from internal reasoning hygiene" 원칙에 따라 내부 사고와 최종 출력의 표기 범위를 분리한다.',
      "- 동작 중심 검증(Test Behavior, Not Implementation)을 기준으로 단위 테스트를 구성한다.",
    ].join("\n");
    assert.equal(analyzeField("content", conciseRuleBullets).status, "korean");

    const longProseHeading = [
      "전체 구조를 한국어로 간단히 요약한 뒤 다음 섹션을 확인한다.",
      "",
      "## Now let me explain the entire architecture and implementation details in English without switching back to Korean anytime soon",
      "추가 설명을 한국어로 이어서 정리한다.",
    ].join("\n");
    assert.equal(analyzeField("content", longProseHeading).status, "drifted");

    const allEnglishHeadings = [
      "# Boundary Discipline",
      "## Model the Domain",
      "### Test Behavior, Not Implementation",
    ].join("\n");
    const allHeadingsAnalysis = analyzeField("content", allEnglishHeadings);
    assert.equal(allHeadingsAnalysis.status, "drifted");
    assert.equal(allHeadingsAnalysis.driftReason, "low_hangul_ratio");

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

    const nestedQuotedCode = [
      "중첩 인용구 내부의 코드 블록도 자연어 비율 계산에서 완전히 제외한다.",
      "",
      "> > ```ts",
      "> > export const computeTotal = (values: number[]) => values.reduce((a, b) => a + b, 0);",
      "> > ```",
    ].join("\n");
    assert.equal(analyzeField("content", nestedQuotedCode).status, "korean");

    const unclosedQuotedFence = [
      "> ```js",
      "> const onlyQuoted = true;",
      "",
      "Now let me continue explaining the remaining logic in English outside the blockquote.",
    ].join("\n");
    assert.equal(analyzeField("thinking", unclosedQuotedFence).status, "drifted");
  });

  it("bounds ERROR_QUOTE_RE length/openers and catches short English prose with 1-2 Hangul chars", () => {
    const couldNotProse =
      '"Could not decide whether to refactor the whole module right now because the tests are unclear."';
    assert.equal(analyzeField("thinking", couldNotProse).status, "drifted");

    const failedToSeeProse =
      "> Failed to see why the previous logic should stay intact when a simpler parser exists.";
    assert.equal(analyzeField("thinking", failedToSeeProse).status, "drifted");

    const overlongErrorLikeProse =
      '"Error: Failed to connect to the service, and now let me spend several extra clauses explaining the full architectural rationale in English so that the quote easily exceeds the one hundred eighty character limit."';
    assert.ok(overlongErrorLikeProse.length > 180);
    assert.equal(analyzeField("thinking", overlongErrorLikeProse).status, "drifted");

    const validShortErrors = [
      '원문 오류 "Failed to connect to remote host"와 "Could not find module foo"를 확인했다.',
      "> Unable to open file /etc/hosts",
      "모든 오류 로그를 한국어로 분석해 원인을 정리했다.",
    ].join("\n");
    assert.equal(analyzeField("content", validShortErrors).status, "korean");

    const oneHangulDrift = analyzeField("thinking", "네, I will check the file now.");
    assert.equal(oneHangulDrift.status, "drifted");
    assert.equal(oneHangulDrift.driftReason, "short_english_prose");

    const twoHangulDrift = analyzeField("thinking", "확인, let me read this file now.");
    assert.equal(twoHangulDrift.status, "drifted");
    assert.equal(twoHangulDrift.driftReason, "short_english_prose");
  });

  it("closes analyzer bypasses and prevents single-line technical label false positives", () => {
    const shortQuotedProse = '"I will fix it." "Let me check this." "We can do that." "It works for now."';
    assert.equal(analyzeField("thinking", shortQuotedProse).status, "drifted");

    const shortEnglishHeadings = [
      "먼저 코드를 확인하고 결과를 정리했다.",
      "## Let me explain the entire root cause and fix in English right now",
      "## Now I will summarize all the remaining implementation details for you",
      "마지막으로 확인을 마쳤다.",
    ].join("\n");
    assert.equal(analyzeField("content", shortEnglishHeadings).status, "drifted");

    const commaProseBypass = [
      "검증 절차를 정리하면 다음과 같다.",
      "Check the config, update the parser, run all tests, verify the output",
    ].join("\n");
    assert.equal(analyzeField("content", commaProseBypass).status, "drifted");

    const bulletProseBypass = [
      "작업 순서를 간결하게 정리하면 다음과 같다.",
      "- Check the config",
      "- Read the logs",
      "- Update the parser",
      "- Run all tests",
    ].join("\n");
    assert.equal(analyzeField("content", bulletProseBypass).status, "drifted");

    const inlineCommaRun =
      "먼저 기존 코드를 전체적으로 검토하고 테스트 범위를 확인했다. First, let us check the file, read it, and verify the state. 마지막으로 모든 결과를 한국어로 깔끔하게 정리했다.";
    assert.equal(analyzeField("thinking", inlineCommaRun).status, "drifted");

    const escapedBacktick =
      "확인 결과 \\`기호 때문에 now let me write a full English explanation about how the parser breaks completely `code` 끝났다.";
    assert.equal(analyzeField("thinking", escapedBacktick).status, "drifted");

    const allCapsShortProse = "IS IT DONE? GO TO BED! WE SEE YOU. DO NOT STOP NOW.";
    assert.equal(analyzeField("thinking", allCapsShortProse).status, "drifted");

    const bracketedImperativeProse =
      "한국어 설명입니다. (Check the config file and verify everything works properly) 계속 설명합니다.";
    assert.equal(analyzeField("content", bracketedImperativeProse).status, "drifted");

    const koreanReportWithCheckpoint = [
      "목표는 코드베이스의 정확성과 훅 계약을 읽기 전용으로 점검하는 것입니다.",
      "",
      "throughput checkpoint: n/a, read-only investigation",
      "",
      "전체 테스트와 플러그인 검증 결과를 모두 확인했고 핵심 결함을 정리했습니다.",
    ].join("\n");
    assert.equal(analyzeField("content", koreanReportWithCheckpoint).status, "korean");
  });
});

describe("regression #4: UI label proper nouns versus English task labels", () => {
  const PROPER_NOUN_LABELS = [
    "React Router",
    "Docker Compose",
    "GitHub Actions",
    "Visual Studio Code",
    "TypeScript 5.x",
    "탭: React Router",
  ];
  const ENGLISH_TASK_LABELS = [
    "단계: Analyze codebase structure",
    "1단계: Check database schema migration",
    "Check UserController",
    "Fix HookHandler",
    "Run unit tests",
    "Git status check",
  ];

  it("does not flag proper-noun and versioned product labels as UI drift", () => {
    for (const label of PROPER_NOUN_LABELS) {
      assert.notEqual(analyzeUiTexts([label]).status, "drifted", `expected pass for: ${label}`);
      const decision = decidePreToolUseAction(
        { name: "update_steps", args: { steps: [{ title: label, status: "pending" }] } },
        [],
      );
      assert.equal(decision.action, "allow", `expected PreToolUse allow for: ${label}`);
    }
    assert.notEqual(analyzeUiTexts(PROPER_NOUN_LABELS).status, "drifted");
  });

  it("flags English imperative task labels even behind a short Korean prefix", () => {
    for (const label of ENGLISH_TASK_LABELS) {
      const analysis = analyzeUiTexts([label]);
      assert.equal(analysis.status, "drifted", `expected drifted for: ${label}`);
      const decision = decidePreToolUseAction(
        { name: "update_steps", args: { steps: [{ title: label, status: "pending" }] } },
        [],
      );
      assert.equal(decision.action, "deny", `expected PreToolUse deny for: ${label}`);
    }
  });
});

describe("regressions: summarizer boilerplate, spaced Korean UI prefixes, and prose headings", () => {
  it("strips the runtime summarizer boilerplate line in thinking without exempting content", () => {
    const boilerplate = "I'm thinking through how to approach this.";
    const withKoreanBody = `${boilerplate}\n\n\n문제 해결을 위해 먼저 트랜스크립트 파서와 훅 어댑터 경계를 차근차근 분석한다.`;
    const thinkingWithKorean = analyzeField("thinking", withKoreanBody);
    assert.equal(thinkingWithKorean.status, "korean");
    assert.equal(thinkingWithKorean.driftReason, "none");

    const thinkingOnlyBoilerplate = analyzeField("thinking", `${boilerplate}\n\n\n`);
    assert.equal(thinkingOnlyBoilerplate.status, "insufficient");
    assert.equal(thinkingOnlyBoilerplate.driftReason, "none");

    const contentBoilerplate = analyzeField("content", boilerplate);
    assert.equal(contentBoilerplate.status, "drifted");
  });

  it("flags English UI task labels behind a multi-word Korean prefix", () => {
    for (const label of ["체크 항목: Fix build bug", "작업 단계: Check parser state", "1단계 검토: Run unit tests"]) {
      assert.equal(analyzeUiTexts([label]).status, "drifted", `expected drifted for: ${label}`);
    }
    assert.notEqual(analyzeUiTexts(["체크 항목: React Router"]).status, "drifted");
  });

  it("flags multi-function-word English prose headings inside Korean content while preserving concise rule titles", () => {
    const proseHeading = [
      "# Checking the build and fixing errors in this repository",
      "",
      "이 문장은 자연스러운 한국어 본문으로 작성되어 전체 한글 비율을 충분히 높게 유지한다.",
    ].join("\n");
    assert.equal(analyzeField("content", proseHeading).status, "drifted");
  });

  it("strips multiline inline backtick code spans inside a paragraph without swallowing prose across blocks", () => {
    const multilineInlineCode = [
      "다음 인라인 코드 예시를 참고해 설정을 확인한다:",
      "`const x = \"this is a long english string literal inside inline code\";",
      "console.log(\"another long english message that must be stripped\", x);`",
      "위 코드는 정상적으로 제거되어 한국어 본문으로 판정되어야 한다.",
    ].join("\n");
    assert.equal(analyzeField("content", multilineInlineCode).status, "korean");

    const strayBackticksAcrossParagraphs = [
      "첫 번째 문단에서 짝이 없는 `기호가 남았다.",
      "",
      "Now let me explain the entire root cause and fix in pure English prose right here.",
      "",
      "세 번째 문단에도 짝이 없는 `기호가 남았다.",
    ].join("\n");
    assert.equal(analyzeField("content", strayBackticksAcrossParagraphs).status, "drifted");

    const strayBackticksAcrossListItems = [
      "작업 항목을 정리하면 다음과 같다.",
      "- 첫 번째 항목의 짝 없는 `백틱",
      "- Now let me write an English explanation inside the next list item.",
      "- 세 번째 항목의 짝 없는 `백틱",
    ].join("\n");
    assert.equal(analyzeField("content", strayBackticksAcrossListItems).status, "drifted");
  });

  it("detects 3-word English imperative clauses in mixed Korean UI labels without flagging technical proper nouns", () => {
    for (const label of [
      "저장소 Check build status",
      '"단계" Check repository status',
      "MCP 서버 Check status now",
    ]) {
      assert.equal(analyzeUiTexts([label]).status, "drifted", `expected drifted for: ${label}`);
    }

    for (const label of [
      "React Router 설치",
      "GitHub Actions 설정",
      "TypeScript 5.x 마이그레이션",
      "API status 확인",
      "update_steps 도구 확인",
    ]) {
      assert.notEqual(analyzeUiTexts([label]).status, "drifted", `expected non-drifted for: ${label}`);
    }
  });

  it("isolates stray backticks in parenthesized numbered lists and avoids false positives on short cited Korean lines", () => {
    const strayBackticksAcrossParenList = [
      "작업 항목을 정리하면 다음과 같다.",
      "1) 첫 번째 항목의 짝 없는 `백틱",
      "2) Now let me write an English explanation inside the next numbered item completely.",
      "3) 세 번째 항목의 짝 없는 `백틱",
    ].join("\n");
    assert.equal(analyzeField("content", strayBackticksAcrossParenList).status, "drifted");

    for (const shortCited of ["확인 (React Cache Store Data)", "확인 **React Cache Store Data**"]) {
      const analysis = analyzeField("content", shortCited);
      assert.equal(analysis.status, "insufficient", `expected insufficient for: ${shortCited}`);
      assert.equal(analysis.driftReason, "none");
    }

    for (const shortDrift of [
      "확인 (Now let me check the file)",
      "확인 (Check the build status)",
      "확인 (Check the React Router)",
      "확인 (Fix the Prisma Schema)",
      "확인 (Update the Node Server)",
      "확인 (Check ALL build status)",
      "확인 (It really works well)",
      "확인 (It breaks React render)",
      "확인 (This React hook fails)",
      "확인 (That Prisma query broke)",
      "응 (I check these files)",
      "확인 **Check the build status**",
      "# Build Status\nI will fix it",
      "Status: Ready\nI will fix it",
      "- Build\nI will check it",
      "1) Build\nI will check it",
    ]) {
      assert.equal(analyzeField("thinking", shortDrift).status, "drifted", `expected drifted for: ${shortDrift}`);
    }

    for (const legitCited of [
      "테스트 전략은 (Test behavior not implementation) 원칙을 따른다.",
      "메모리 최적화를 위해 (Copy on write semantics) 기법을 적용한다.",
      "이 라이브러리는 (Open source software license) 조항을 따른다.",
      "복제 저장소는 (Read after write consistency) 수준을 보장한다.",
      "네트워크 계층에서 (Load balancing over proxy) 방식으로 분산한다.",
      "스토리지 엔진은 (Log structured merge tree) 구조를 채택했다.",
      "참고 (Support for the Legacy API)",
      "참고 (Start of the Event Stream)",
      "설계 참고 문서는 **Design of a Modern Compiler** 책의 구성을 따른다.",
      "아키텍처 개요는 (Review of the System Architecture) 문서를 바탕으로 정리했다.",
      "참고 (List of all Active Nodes)",
      "참고 (Call to the External API)",
      "참고 (Run of the Test Suite)",
      "복제 일관성 전략은 (Read one write all protocol) 방식을 기준으로 설명한다.",
      "참고 (This in Strict Mode)",
      "- 원리: **This in Strict Mode**",
      "참고 (This in Arrow Functions)",
      "참고 (This in Class Methods)",
    ]) {
      assert.notEqual(analyzeField("content", legitCited).status, "drifted", `expected non-drifted for: ${legitCited}`);
    }
  });

  it("strips uppercase technical runs in linear time without catastrophic backtracking on trailing lowercase digits", () => {
    const token = `AA${"1".repeat(26)}a`;
    const sample = `해시 토큰 ${token} 과 HTTP2, H264, UTF8MB4, SHA256SUMS 값을 한국어로 확인하고 검증한다.`;
    const startMs = performance.now();
    const analysis = analyzeField("content", sample);
    const elapsedMs = performance.now() - startMs;

    assert.ok(elapsedMs < 50, `expected linear-time analysis (<50ms), took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(analysis.status, "korean");
  });
});
