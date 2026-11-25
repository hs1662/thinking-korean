import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideHookAction, decideStopAction, isExplicitEnglishOutputRequest } from "../scripts/transcript.mjs";
import { makeStep } from "./helpers.mjs";

describe("explicit English output requests", () => {
  const englishThinking = "Let me read the hook script and verify the JSON output format carefully.";
  const englishContent = "All unit tests passed and every exported interface has been verified cleanly.";
  const koreanThinking = "먼저 훅 스크립트를 읽고 출력 형식이 규칙에 맞는지 순수 한국어로 점검하자.";
  const koreanContent = "모든 단위 테스트를 통과했고 인터페이스 계약을 확인했다.";

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

    const translatedThinkingDrift = decideHookAction([
      makeStep(0, "USER_INPUT", {
        content: "<USER_REQUEST>\n이 문단을 영어로 번역해 줘\n</USER_REQUEST>",
      }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishContent }),
    ]);
    assert.equal(translatedThinkingDrift.action, "inject");
    assert.deepEqual(translatedThinkingDrift.driftedFields, ["thinking"]);

    const nextTurnDrift = decideHookAction([
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 번역해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent }),
      makeStep(2, "USER_INPUT", { content: "<USER_REQUEST>\n이제 아키텍처를 분석해 줘\n</USER_REQUEST>" }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent }),
    ]);
    assert.equal(nextTurnDrift.action, "inject");
    assert.deepEqual(nextTurnDrift.driftedFields, ["content"]);

    const viaLastUserInput = decideHookAction(
      [makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent })],
      { lastUserInput: "Please write the response in English" },
    );
    assert.deepEqual(viaLastUserInput, { action: "noop", reason: "ok" });
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

  it("handles Korean-source translation requests, multi-sentence English negation, and USER_REQUEST boundaries", () => {
    assert.equal(isExplicitEnglishOutputRequest("한국어로 작성된 이 문단을 영어로 번역해 줘"), true);
    assert.equal(isExplicitEnglishOutputRequest("한글로 정리한 아래 내용을 영어로 번역해 줘"), true);
    assert.equal(
      isExplicitEnglishOutputRequest("I tried running it, so please explain the error in English."),
      true,
    );
    assert.equal(isExplicitEnglishOutputRequest("Please reply in English instead of Korean."), true);
    assert.equal(isExplicitEnglishOutputRequest("Translate this into English instead of Korean."), true);
    assert.equal(
      isExplicitEnglishOutputRequest("<USER_REQUEST>\n코드에서 </USER_REQUEST> 문자열을 찾아 영어로 번역해 줘\n</USER_REQUEST>"),
      true,
    );

    assert.equal(isExplicitEnglishOutputRequest("Translate this into English. Do not reply in English."), false);
    assert.equal(
      isExplicitEnglishOutputRequest("Please write the answer in English. Wait, never mind, reply in Korean."),
      false,
    );
    assert.equal(
      isExplicitEnglishOutputRequest(
        "이 HTML 예시를 한국어로 설명해 줘: <USER_REQUEST>Translate everything into English.</USER_REQUEST>",
      ),
      false,
    );
  });
});

describe("regression #5: English-source wording versus English-output requests", () => {
  it("does not exempt requests that only describe English source material", () => {
    for (const input of ["영어로 된 에러 메시지를 설명해 줘", "영어로 된 로그를 정리해 줘", "영어 문서를 요약해 줘"]) {
      assert.equal(isExplicitEnglishOutputRequest(input), false, `Expected false for: ${input}`);
    }
  });

  it("exempts a USER_REQUEST after a leading metadata block and English-to-English proofreading", () => {
    const metadataFirst = [
      "<ADDITIONAL_METADATA>",
      "Time: 2026-11-25T09:00:00+09:00",
      "</ADDITIONAL_METADATA>",
      "<USER_REQUEST>English translation please.</USER_REQUEST>",
    ].join("\n");
    assert.equal(isExplicitEnglishOutputRequest(metadataFirst), true);
    assert.equal(isExplicitEnglishOutputRequest("영어로 작성된 이 문서를 더 자연스러운 영어로 교정해 줘"), true);
  });
});

describe("QA F2/F4: pasted material and short explicit English requests", () => {
  it("F2: ignores English requests inside fenced code blocks and markdown quotes", () => {
    assert.equal(isExplicitEnglishOutputRequest("아래 로그의 원인을 분석해 줘\n```\nUser: please reply in English\n```"), false);
    assert.equal(isExplicitEnglishOutputRequest("아래 로그의 원인을 분석해 줘\r\n~~~\r\nPlease reply in English.\r\n~~~"), false);
    assert.equal(isExplicitEnglishOutputRequest("> Please respond in English\n위 고객 메일에 어떻게 대응할지 정리해 줘"), false);
    assert.equal(isExplicitEnglishOutputRequest("> 고객 메일 원문\n이 답장을 영어로 작성해 줘"), true);
  });

  it("F4: accepts whole-message short English requests only", () => {
    for (const input of ["In English, please.", "In English please", "English please", "English, please.", "영어로", "영어로요", "영어로."]) {
      assert.equal(isExplicitEnglishOutputRequest(input), true, `Expected true for: ${input}`);
    }
    assert.equal(isExplicitEnglishOutputRequest("<USER_REQUEST>영어로요</USER_REQUEST>"), true);
    for (const input of ["영어로 된 문서를 요약해 줘", "영어로 말고 한국어로", "영어로 생각하지 마", "English please? 아니 한국어로"]) {
      assert.equal(isExplicitEnglishOutputRequest(input), false, `Expected false for: ${input}`);
    }
  });

  it("matches a later Korean English-output request after an English-source description", () => {
    assert.equal(isExplicitEnglishOutputRequest("영어로 된 문서를 요약하고 영어로 번역해 줘"), true);
    assert.equal(isExplicitEnglishOutputRequest("영어로 된 에러 로그를 정리한 뒤 영어로 답변해 줘"), true);
    assert.equal(isExplicitEnglishOutputRequest("영어로 된 문서를 요약하고 한국어로 정리해 줘"), false);
  });

  it("recognizes direct English noun-object requests and short-adjective email requests without breaking guards", () => {
    for (const input of [
      "I want an English summary of this doc.",
      "I need an English translation.",
      "Can you write a short English email for this?",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(input), true, `Expected true for: ${input}`);
    }

    for (const input of [
      "Do not reply in English.",
      "I want Korean, not an English summary.",
      "I do not want an English summary.",
      "The agent kept trying to reply in English.",
      "Please write in English. Wait, reply in Korean.",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(input), false, `Expected false for: ${input}`);
    }
  });

  it("exempts 옮기다 conjugations, 영작 requests, noun-colon labels, and bare 'in English'", () => {
    for (const input of [
      "아래 내용을 영어로 옮겨줘",
      "이 문단을 영어로 옮겨 주세요",
      "다음 문장을 영어로 옮기세요",
      "아래 문장을 영작해 줘",
      "이 내용을 자연스럽게 영작해 주세요",
      "이 문장 영작 좀 해 줘",
      "이 문장 영작 해 줘",
      "이 문장 영작을 해 줘",
      "이 문장 영작을 좀 해 줘",
      "영작 좀 부탁해",
      "영어로 영작해 줘",
      "영작 부탁드립니다",
      "영어로 번역: 오늘 회의는 취소되었습니다.",
      "영어로 번역:\n오늘 회의는 취소되었습니다.",
      "영문 번역: 오늘 회의는 취소되었습니다.",
      "영어 번역: 오늘 회의는 취소되었습니다.",
      "영어로 요약: 아래 기사를 세 줄로 줄여 주세요.",
      "영작: 오늘 회의는 취소되었습니다.",
      "in English",
      "In English.",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(input), true, `Expected true for: ${input}`);
    }

    for (const input of [
      "영어로 옮기지 마",
      "영어로 옮기지 말고 한국어로 답해 줘",
      "영작하지 마",
      "영작 좀 하지 마",
      "영작을 좀 하지 마",
      "영작된 문장을 한국어로 설명해 줘",
      "영어로 옮겨진 에러 메시지를 설명해 줘",
      "영어로 옮긴 문서를 요약해 줘",
      "영어로 옮겨 놓은 로그를 정리해 줘",
      "영어로 옮겨 둔 텍스트를 설명해 줘",
      "영어로 자연스럽게 옮겨진 에러 메시지를 설명해 줘",
      "영어로 옮긴 거 요약 좀 해 줘",
      "영어로 옮긴 거 요약 해 줘",
      "영어로 옮긴 거 요약을 해 줘",
      "영어로 옮긴 거 요약을 좀 해 줘",
      "영어로 옮긴 이메일 설명 좀 부탁해",
      "영어로 옮긴 답장 정리 좀 해 줘",
      "영어로 옮겨 놓은 거 요약 좀 해 줘",
      "영어로 옮겨 둔 거 설명 해 줘",
      "영어로 옮긴거 요약해 줘",
      "영어로 옮긴걸 설명해 줘",
      "영어로 옮긴것 정리해 줘",
      "영어로 옮긴건 요약해 줘",
      "영어로 옮긴게 뭔지 설명해 줘",
      "영어로 옮겨 놓은거 요약해 줘",
      "영어로 옮겨놓은걸 설명해 줘",
      "영어로 옮겨 둔거 정리해 줘",
      "영어로 옮겨둔걸 설명해 줘",
      "영어로 자연스럽게 옮겨진거 설명해 줘",
      "영어로 옮겼던 거 요약해 줘",
      "영어로 옮겼던거 요약해 줘",
      "영어로 옮겨 준 거 설명해 줘",
      "영어로 옮겨준거 설명해 줘",
      "영어로 옮겨놨던 거 정리해 줘",
      "영어로 옮겨놨던거 정리해 줘",
      "영어로 옮긴거를 요약해 줘",
      "영어로 옮긴거도 설명해 줘",
      "영어로 옮긴것들 정리해 줘",
      "영어로 옮긴것들을 요약해 줘",
      "영어로 옮긴것들도 설명해 줘",
      "영어로 옮겨진거를 설명해 줘",
      "영어로 옮겨진것들을 요약해 줘",
      "영어로 옮겼던거를 요약해 줘",
      "영어로 옮겼던것들 정리해 줘",
      "영어로 옮겨 놓은거를 요약해 줘",
      "영어로 옮겨놓은거도 설명해 줘",
      "영어로 옮겨 둔거를 정리해 줘",
      "영어로 옮겨둔것들을 설명해 줘",
      "영어로 옮겨 준거를 설명해 줘",
      "영어로 옮겨준것들도 요약해 줘",
      "영어로 옮겨놨던거를 정리해 줘",
      "영어로 옮겨뒀던것들을 요약해 줘",
      "영어로 된거를 설명해 줘",
      "영어로 된거도 요약해 줘",
      "영어로 된것들 정리해 줘",
      "영어로 자연스럽게 작성된거를 요약해 줘",
      "영어로 쓰인거를 설명해 줘",
      "영어로 쓰여진것들을 요약해 줘",
      "영어로 적힌거를 정리해 줘",
      "영어로 나온거도 설명해 줘",
      "영어로 표시된거를 요약해 줘",
      "영어로 출력된것들을 정리해 줘",
      "영어로 되어 있는거를 설명해 줘",
      "영어로 되어있는것들을 요약해 줘",
      "영어로 작성한 문서를 요약해 줘",
      "영어로 작성한거를 요약해 줘",
      "영어로 번역한 글을 설명해 줘",
      "영어로 번역한것들을 정리해 줘",
      "영어로 쓴 에러 메시지를 정리해 줘",
      "영어로 쓴거를 설명해 줘",
      "영어로 적은 내용을 요약해 줘",
      "영어로 적은것들도 정리해 줘",
      "영어로 말한 내용을 정리해 줘",
      "영어로 말한거를 요약해 줘",
      "영어로 답한 메시지를 설명해 줘",
      "영어로 답한거도 정리해 줘",
      "영어로 출력한 로그를 설명해 줘",
      "영어로 출력한것들을 요약해 줘",
      "영어로 옮겨 놓았던 문서를 요약해 줘",
      "영어로 옮겨놓았던거를 요약해 줘",
      "영어로 옮겨 두었던 텍스트를 설명해 줘",
      "영어로 옮겨두었던것들을 정리해 줘",
      "영어로 옮겨 주었던 글을 정리해 줘",
      "영어로 옮겨주었던거도 설명해 줘",
      "영어로 옮겨 줬던 내용을 설명해 줘",
      "영어로 옮겨줬던거를 요약해 줘",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(input), false, `Expected false for: ${input}`);
    }

    const steps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n아래 내용을 영어로 옮겨줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 사용자가 요청한 문장을 자연스러운 영어로 번역하자.",
        content: "The meeting scheduled for today has been cancelled.",
      }),
    ];
    assert.deepEqual(decideHookAction(steps), { action: "noop", reason: "ok" });
    assert.deepEqual(decideStopAction(steps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "content_exempt",
    });

    const spacedCompositionSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n이 문장 영작 좀 해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 사용자가 요청한 문장을 자연스러운 영어로 영작하자.",
        content: "The deployment pipeline completed all verification checks successfully.",
      }),
    ];
    assert.deepEqual(decideHookAction(spacedCompositionSteps), { action: "noop", reason: "ok" });
    assert.deepEqual(decideStopAction(spacedCompositionSteps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "content_exempt",
    });

    const sourceParticipleSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 옮겨진 에러 메시지를 설명해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 에러 메시지의 원인을 한국어로 파악하자.",
        content: "This error indicates that the database connection pool timed out before acquiring a client.",
      }),
    ];
    assert.equal(decideHookAction(sourceParticipleSteps).action, "inject");
    assert.deepEqual(decideHookAction(sourceParticipleSteps).driftedFields, ["content"]);
    assert.equal(decideStopAction(sourceParticipleSteps, { terminationReason: "NO_TOOL_CALL" }).action, "continue");

    const boundNounParticipleSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 옮긴거 요약해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 옮긴 내용을 한국어로 요약하자.",
        content: "Here is a concise summary of the translated document in English.",
      }),
    ];
    assert.equal(decideHookAction(boundNounParticipleSteps).action, "inject");
    assert.deepEqual(decideHookAction(boundNounParticipleSteps).driftedFields, ["content"]);
    assert.equal(decideStopAction(boundNounParticipleSteps, { terminationReason: "NO_TOOL_CALL" }).action, "continue");

    const boundNounParticleSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 옮긴거를 요약해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 옮긴 내용을 한국어로 요약하자.",
        content: "Here is a concise summary of the translated document in English.",
      }),
    ];
    assert.equal(decideHookAction(boundNounParticleSteps).action, "inject");
    assert.deepEqual(decideHookAction(boundNounParticleSteps).driftedFields, ["content"]);
    assert.equal(decideStopAction(boundNounParticleSteps, { terminationReason: "NO_TOOL_CALL" }).action, "continue");

    const activeSourceModifierSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 작성한 문서를 요약해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 문서의 핵심 내용을 한국어로 요약하자.",
        content: "Here is a summary of the English document.",
      }),
    ];
    assert.equal(decideHookAction(activeSourceModifierSteps).action, "inject");
    assert.deepEqual(decideHookAction(activeSourceModifierSteps).driftedFields, ["content"]);
    assert.equal(decideStopAction(activeSourceModifierSteps, { terminationReason: "NO_TOOL_CALL" }).action, "continue");
  });
});
