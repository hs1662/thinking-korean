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
      "영어로 대답해 줘",
      "영어로 대답해 주세요",
      "영어로 대답 좀 해 줘",
      "영어로 대답을 해 줘",
      "영어로 대답 부탁해",
      "영어로 알려 줘",
      "영어로 알려 주세요",
      "영어로 알려 주시겠어요?",
      "영어로 알려 주실 수 있나요?",
      "영어로 번역해서 보여 줘",
      "영어로 번역해서 보여 주세요",
      "영어로 요약해서 알려 줘",
      "영어로 설명해 주시겠어요?",
      "영어로 작성해 주시겠어요?",
      "영어로 번역해 주실 수 있나요?",
      "영어로 바꿔 주시겠어요?",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(input), true, `Expected true for: ${input}`);
    }

    for (const input of [
      "영어로 옮기지 마",
      "영어로 옮기지 말고 한국어로 답해 줘",
      "영어로 대답하지 마",
      "영어로 대답하지 말고 한국어로 대답해 줘",
      "영어로 대답하면 안 돼",
      "영어로 알려 주지 마",
      "영어로 알려 주지 말고 한국어로 알려 줘",
      "영어로 번역해서 보여 주지 마",
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
      "영어로 돼 있는 에러 메시지를 설명해 줘",
      "영어로 돼있는 에러 메시지를 설명해 줘",
      "영어로 돼 있는 거 설명해 줘",
      "영어로 돼있는거를 요약해 줘",
      "영어로 쓰여 있는 문서를 요약해 줘",
      "영어로 쓰여있는것들을 정리해 줘",
      "영어로 적혀 있는 로그를 정리해 줘",
      "영어로 적혀있는거도 설명해 줘",
      "영어로 나와 있는 경고를 설명해 줘",
      "영어로 나와있는걸 요약해 줘",
      "영어로 받은 이메일을 요약해 줘",
      "영어로 받은거를 정리해 줘",
      "영어로 온 메시지를 설명해 줘",
      "영어로 온거 설명해 줘",
      "영어로 뜬 에러를 설명해 줘",
      "영어로 뜬거를 설명해 줘",
      "영어로 뜨는 경고를 정리해 줘",
      "영어로 뜨는거 요약해 줘",
      "영어로 찍힌 로그를 설명해 줘",
      "영어로 찍힌것들을 정리해 줘",
      "영어로 찍히는 출력을 요약해 줘",
      "영어로 찍히는거 설명해 줘",
      "영어로 나오는 메시지를 설명해 줘",
      "영어로 나오는거를 요약해 줘",
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

    const politeReplySteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 대답해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 사용자의 질문에 영어로 대답을 작성하자.",
        content: "Here is the answer to your question in English.",
      }),
    ];
    assert.deepEqual(decideHookAction(politeReplySteps), { action: "noop", reason: "ok" });
    assert.deepEqual(decideStopAction(politeReplySteps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "content_exempt",
    });

    const contractedSourceModifierSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로 돼 있는 에러 메시지를 설명해 줘\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 에러 메시지의 의미를 한국어로 설명하자.",
        content: "This error message means the connection was refused by the remote host.",
      }),
    ];
    assert.equal(decideHookAction(contractedSourceModifierSteps).action, "inject");
    assert.deepEqual(decideHookAction(contractedSourceModifierSteps).driftedFields, ["content"]);
    assert.equal(
      decideStopAction(contractedSourceModifierSteps, { terminationReason: "NO_TOOL_CALL" }).action,
      "continue",
    );
  });

  it("scans repeated polite request prefixes in linear time without quadratic EN_POLITE_REQUEST_RE backtracking", () => {
    const repeatedPlease = `${"please ".repeat(20_000)}확인해 줘`;
    const startMs = performance.now();
    const result = isExplicitEnglishOutputRequest(repeatedPlease);
    const elapsedMs = performance.now() - startMs;

    assert.ok(elapsedMs < 250, `expected linear-time request check (<250ms), took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(result, false);
    assert.equal(isExplicitEnglishOutputRequest("Could you please kindly just reply in English?"), true);
  });

  it("strips metadata blocks in linear time without quadratic METADATA_BLOCK_RE scans on unclosed tags", () => {
    const unclosedTags = `${"<ADDITIONAL_METADATA>".repeat(20_000)}구조를 분석해 줘`;
    const startMs = performance.now();
    const result = isExplicitEnglishOutputRequest(unclosedTags);
    const elapsedMs = performance.now() - startMs;

    assert.ok(elapsedMs < 250, `expected linear-time metadata strip (<250ms), took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(result, false);
    assert.equal(
      isExplicitEnglishOutputRequest(
        "<USER_SETTINGS_CHANGE> Write in English </USER_SETTINGS_CHANGE>\n<USER_REQUEST>영어로 번역해 줘</USER_REQUEST>",
      ),
      true,
    );
  });

  it("strips repeated metadata blocks before a distant other metadata tag in linear time without quadratic rescans", () => {
    const repeatedThenOtherTag = `${"<USER_SETTINGS_CHANGE>x</USER_SETTINGS_CHANGE>".repeat(12_000)}<ADDITIONAL_METADATA>Write in English</ADDITIONAL_METADATA>구조를 분석해 줘`;
    const startMs = performance.now();
    const result = isExplicitEnglishOutputRequest(repeatedThenOtherTag);
    const elapsedMs = performance.now() - startMs;

    assert.ok(elapsedMs < 250, `expected linear-time multi-tag metadata strip (<250ms), took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(result, false);
  });

  it("scans padded Korean request nouns in linear time without quadratic KO_REQUEST_NOUN_ENDING backtracking", () => {
    for (const prefix of ["영어로 번역", "영작"]) {
      const padded = `${prefix}${" ".repeat(50_000)}x`;
      const startMs = performance.now();
      const result = isExplicitEnglishOutputRequest(padded);
      const elapsedMs = performance.now() - startMs;

      assert.ok(
        elapsedMs < 250,
        `expected linear-time request check for "${prefix}" (<250ms), took ${elapsedMs.toFixed(1)}ms`,
      );
      assert.equal(result, false);
    }

    assert.equal(isExplicitEnglishOutputRequest("영어로 답변 원해"), true);
    assert.equal(isExplicitEnglishOutputRequest("영어로 답변을 원해"), true);
    assert.equal(isExplicitEnglishOutputRequest("영어로 요약 부탁해"), true);
    assert.equal(isExplicitEnglishOutputRequest("영어로 번역: 오늘 회의는 취소되었습니다."), true);
    assert.equal(isExplicitEnglishOutputRequest("영작: 오늘 회의는 취소되었습니다."), true);
  });

  it("scans repeated Korean language-particle tokens in linear time without quadratic backtracking", () => {
    for (const token of ["영어로", "한국어로"]) {
      const repeated = token.repeat(14_000);
      const startMs = performance.now();
      const result = isExplicitEnglishOutputRequest(repeated);
      const elapsedMs = performance.now() - startMs;

      assert.ok(
        elapsedMs < 250,
        `expected linear-time request check for repeated "${token}" (<250ms), took ${elapsedMs.toFixed(1)}ms`,
      );
      assert.equal(result, false);
    }

    assert.equal(isExplicitEnglishOutputRequest("영어로 자연스럽게 번역해 줘"), true);
    assert.equal(isExplicitEnglishOutputRequest("영어로 자연스럽게 번역하지 마"), false);
    assert.equal(isExplicitEnglishOutputRequest("영어로 번역하고 한국어로 자연스럽게 요약해 줘"), false);
  });

  it("strips trailing 좀 in isSourceDescription in linear time on whitespace-padded source modifiers", () => {
    const padded = `영어로 된${" ".repeat(60_000)}글 써줘`;
    const startMs = performance.now();
    const result = isExplicitEnglishOutputRequest(padded);
    const elapsedMs = performance.now() - startMs;

    assert.ok(
      elapsedMs < 250,
      `expected linear-time source description check (<250ms), took ${elapsedMs.toFixed(1)}ms`,
    );
    assert.equal(result, false);
    assert.equal(isExplicitEnglishOutputRequest("영어로 옮긴 거 요약 좀 해 줘"), false);
    assert.equal(isExplicitEnglishOutputRequest("영어로 옮긴 거 요약을 좀 해 줘"), false);
  });

  it("normalizes trailing question punctuation in linear time on ?-terminated sentences with long whitespace or punctuation runs", () => {
    for (const filler of [" ", ",", ";", "~"]) {
      const paddedQuestion = `영어로 된${filler.repeat(60_000)}글 써줘?`;
      const startMs = performance.now();
      const result = isExplicitEnglishOutputRequest(paddedQuestion);
      const elapsedMs = performance.now() - startMs;

      assert.ok(
        elapsedMs < 250,
        `expected linear-time trailing question normalization for "${filler}" (<250ms), took ${elapsedMs.toFixed(1)}ms`,
      );
      assert.equal(result, false);
    }
  });

  it("handles dotted filenames and versions, CJK foreign languages, clause-scoped negation, and Korean reasoning clauses", () => {
    for (const prompt of [
      "영어로 README.md 요약해 줘",
      "영어로 package.json 설명해 줘",
      "영어로 v1.1.0 릴리즈 노트 작성해 줘",
      "Translate README.md into English",
      "Please summarize README.md in English",
      "Translate v1.1.0 release notes to English",
      "Translate scripts/analyzer.mjs comments into English",
      "일본어로 번역해 줘",
      "중국어로 번역해 줘",
      "Can you translate this to Japanese?",
      "Please reply in Chinese",
      "영어로 번역하지 말고 프랑스어로 번역해 줘",
      "Don't reply in English, reply in Spanish",
      "이 문장을 영어로 번역하고, 추론은 한국어로 해 줘",
      "Translate this into English, and keep your reasoning in Korean",
      "<USER_REQUEST>\n영어로요\n</USER_REQUEST>\n<FILE_CONTEXT>extra</FILE_CONTEXT>",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(prompt), true, `expected exempt for: ${prompt}`);
    }

    for (const prompt of [
      "영어로 된 README.md를 한국어로 번역해 줘",
      "영어로 된 v1.1.0 릴리즈 노트를 요약해 줘",
      "영어로 번역하지 말고 한국어로 번역해 줘",
      "Don't reply in English, reply in Korean",
      "영어로 번역하고 한국어로 자연스럽게 요약해 줘",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(prompt), false, `expected Korean for: ${prompt}`);
    }
  });

  it("recognizes particle-suffixed (영어로만/영어로도) and verbless (답변은 영어로) requests in Stop and PostInvocation", () => {
    for (const prompt of [
      "영어로만 대답해",
      "영어로만 대답해 줘",
      "영어로만 답변해 주세요",
      "영어로만 번역해 줘",
      "영어로만 설명해 줘",
      "영어로만 작성해 줘",
      "영어로만 써 줘",
      "영어로만 부탁해",
      "영어로만 이 문장을 번역해 줘",
      "영어로도 번역해 줘",
      "영어로도 설명해 줘",
      "영어로도 요약해 줘",
      "영어로도 대답해 줘",
      "영어로만",
      "영어로만요",
      "영어로도",
      "영어로도요",
      "답변은 영어로",
      "답변은 영어로요",
      "답변은 영어로.",
      "답변은 영어로만",
      "답변은 영어로만요",
      "답변도 영어로",
      "대답은 영어로",
      "설명은 영어로",
      "요약은 영어로",
      "번역은 영어로",
      "추론은 한국어로, 답변은 영어로",
      "이 코드를 분석해 줘. 답변은 영어로만.",
      "영어로 답해. 왜냐하면 해외 팀에 공유해야 하거든.",
      "영어로 답해, 왜냐하면 해외 팀에 공유해야 하거든.",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(prompt), true, `expected exempt for: ${prompt}`);
    }

    for (const prompt of [
      "영어로만 대답하지 마",
      "영어로만 번역하지 말고 한국어로 답해 줘",
      "영어로도 번역하지 마",
      "지금도 전부 영어로만 나오잖아",
      "왜 자꾸 영어로만 답변하는 거야?",
      "영어로만 된 문서를 요약해 줘",
      "답변은 한국어로",
      "답변은 한국어로만",
      "답변은 영어로 하지 마",
      "왜 답변은 영어로?",
      "답변은 왜 자꾸 영어로?",
      "왜 자꾸 영어로 답해?",
      "왜 영어로 답해?",
      "왜 자꾸 영어로 답변해?",
      "왜 자꾸 영어로 말해요?",
      "자꾸 영어로 답해",
      "자꾸 영어로 말해요",
      "영어로 왜 답해?",
      "영어로 자꾸 답해",
      "왜 계속 영어로 답해?",
      "왜 또 영어로 답해",
      "왜 또 영어로 답해?",
      "왜 아직도 영어로 답해",
      "왜 아직까지도 영어로 답해",
      "왜 지금까지도 영어로 답해",
      "왜 계속해서 영어로 답해",
      "자꾸 또 영어로 답해",
      "왜  영어로 답해",
      "왜영어로 답해",
      "자꾸영어로 답해",
      "자꾸만영어로 답해",
      "계속영어로 답해",
      "계속해서영어로 답해",
      "영어로 답해요 왜?",
      "영어로 답해, 왜?",
      "영어로 답해요, 왜?",
      "영어로 답해; 왜?",
      "영어로 답해요 자꾸?",
      "영어로 답해, 자꾸?",
      "영어로 답해요 자꾸만?",
      "영어로 답해요 계속?",
      "영어로 답해, 계속?",
      "영어로 답해요 계속해서?",
      "영어로 답하세요 왜?",
      "영어로 답하세요, 왜?",
      "영어로 답하세요 자꾸?",
      "영어로 답변해요 왜?",
      "영어로 답변해, 왜?",
      "영어로 답변하세요 왜?",
      "영어로만 답해요 왜?",
      "영어로만 답해, 왜?",
      "답변은 영어로, 왜?",
      "답변은 영어로; 왜?",
      "답변은 영어로요, 왜?",
      "답변은 영어로, 자꾸?",
      "답변은 영어로, 계속?",
      "영어로 답해요 왜",
      "영어로 답해, 왜",
      "영어로 답해요 자꾸",
      "영어로 답해, 자꾸",
      "영어로 답해요 계속",
      "영어로 답해… 왜?",
      "영어로 답해. 왜?",
      "영어로 답해.. 왜?",
      "영어로 답해! 왜?",
      "영어로 답해\n왜?",
      "영어로 답해요… 왜?",
      "영어로 답해요. 왜?",
      "영어로 답하세요… 왜?",
      "영어로 답하세요. 왜?",
      "영어로 답변해… 왜?",
      "영어로 답변해. 왜?",
      "영어로만 답해… 왜?",
      "영어로만 답해. 왜?",
      "답변은 영어로… 왜?",
      "답변은 영어로. 왜?",
      "답변은 영어로요. 왜?",
      "영어로 답해… 자꾸?",
      "영어로 답해. 자꾸?",
      "영어로 답해. 자꾸만?",
      "영어로 답해… 계속?",
      "영어로 답해. 계속?",
      "영어로 답해. 계속해서?",
      "영어로 답해. 왜요?",
      "영어로 답해. 왜",
      "영어로 답해… 왜",
      "영어로 답해. 자꾸",
      "영어로 답해. 계속",
      "영어로 답해, … 왜?",
      "영어로 답해. 왜.. ?",
      "이 문장 영어로 번역해 줘. 나머지는 계속 한국어로 해",
      "이 문장 영어로 번역해 줘. 나머지는 계속해서 한국어로 해",
      "이 문장 영어로 번역해 줘. 설명은 자꾸 한국어로 해요",
      "이 문장 영어로 번역해 줘. 답변은 계속 한국어로",
      "영어로 답해?",
      "영어로 답해,?",
      "영어로 답해;?",
      "영어로 답해, ?",
      "영어로 답해; ?",
      "영어로 답해요,?",
      "영어로 답변해,?",
      "영어로 답하세요,?",
      "영어로 답하세요~?",
      "영어로 답하세요？",
      "답변은 영어로,?",
      "답변은 영어로;?",
      "영어로 답해, ..?",
      "영어로 답해; .?",
      "답변은 영어로, ..?",
      "답변은 영어로; .?",
      "영어로 답하세요~..?",
      "영어로 답하세요, …?",
      "영어로 답해..?",
      "영어로 답해.?",
      "영어로 답해!?",
      "영어로 답해?!",
      "영어로 답해...?!",
      "영어로 답해.. ?",
      "영어로 답해…?",
      "영어로 답해요..?",
      "영어로 답해요.?",
      "영어로 답해요!?",
      "영어로 답변해..?",
      "영어로 답변해.?",
      "영어로 답변해!?",
      "영어로 답하세요..?",
      "영어로 답하세요.?",
      "영어로 답하세요!?",
      "영어로 답하세요…?",
      "영어로 답변하세요..?",
      "영어로 답변하세요…?",
      "답변은 영어로..?",
      "답변은 영어로.?",
      "답변은 영어로!?",
      "답변은 영어로…?",
      "영어로 답해..? 한국어로 해",
      "영어로 답해!? 한국어로 해",
      "영어로 말해?",
      "영어로 말해..?",
      "영어로 말해.?",
      "영어로 말해!?",
      "왜 자꾸 영어로 답해? 한국어로 해",
      "영어로 답해. 아니 한국어로 해",
      "한국어로 해",
      "한국어로 해요",
      "한국어로만 해",
      "계속 한국어로 해",
      "자꾸 한국어로 해요",
    ]) {
      assert.equal(isExplicitEnglishOutputRequest(prompt), false, `expected Korean for: ${prompt}`);
    }

    for (const complaintPrompt of [
      "왜 자꾸 영어로 답해? 한국어로 해",
      "왜 또 영어로 답해",
      "왜 아직까지도 영어로 답해",
      "왜영어로 답해",
      "영어로 답해요 왜?",
      "영어로 답해, 왜?",
      "영어로 답해요 자꾸?",
      "답변은 영어로, 왜?",
      "영어로 답해… 왜?",
      "영어로 답해. 왜?",
      "영어로 답해\n왜?",
      "답변은 영어로. 왜?",
      "영어로 답해. 자꾸?",
      "영어로 답해. 계속?",
      "이 문장 영어로 번역해 줘. 나머지는 계속 한국어로 해",
      "영어로 답해,?",
      "영어로 답해, ..?",
      "답변은 영어로, ..?",
      "영어로 답하세요~..?",
      "영어로 답해..?",
      "영어로 답해.?",
      "영어로 답해!?",
    ]) {
      const complaintSteps = [
        makeStep(0, "USER_INPUT", { content: `<USER_REQUEST>\n${complaintPrompt}\n</USER_REQUEST>` }),
        makeStep(1, "PLANNER_RESPONSE", {
          thinking: "먼저 사용자의 불만을 확인하고 답변을 작성하자.",
          content: "Sorry, I will switch to Korean right away and explain the cause clearly.",
        }),
      ];
      assert.equal(decideHookAction(complaintSteps).action, "inject", `expected inject for: ${complaintPrompt}`);
      assert.deepEqual(decideHookAction(complaintSteps).driftedFields, ["content"]);
      assert.equal(
        decideStopAction(complaintSteps, { terminationReason: "NO_TOOL_CALL" }).action,
        "continue",
        `expected continue for: ${complaintPrompt}`,
      );
    }

    const onlyInEnglishSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n영어로만 대답해\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 사용자의 요청대로 영어로만 간결하게 답변을 작성하자.",
        content: "Here is the concise English answer you requested.",
      }),
    ];
    assert.deepEqual(decideHookAction(onlyInEnglishSteps), { action: "noop", reason: "ok" });
    assert.deepEqual(decideStopAction(onlyInEnglishSteps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "content_exempt",
    });

    const verblessSteps = [
      makeStep(0, "USER_INPUT", { content: "<USER_REQUEST>\n답변은 영어로\n</USER_REQUEST>" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "먼저 질문을 파악한 뒤 최종 답변은 영어로 작성하자.",
        content: "The configuration has been validated and all checks passed.",
      }),
    ];
    assert.deepEqual(decideHookAction(verblessSteps), { action: "noop", reason: "ok" });
    assert.deepEqual(decideStopAction(verblessSteps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "content_exempt",
    });
  });
});
