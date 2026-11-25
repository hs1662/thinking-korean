import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { analyzeUiTexts } from "../scripts/analyzer.mjs";
import { readTranscriptSteps } from "../scripts/hook-io.mjs";
import { handlePostInvocation } from "../scripts/post-invocation.mjs";
import { handleStop } from "../scripts/stop.mjs";
import {
  DEFAULT_COOLDOWN_INVOCATIONS,
  DRIFT_MARKER,
  LEGACY_DRIFT_MARKERS,
  MAX_CONSECUTIVE_FAILED_THINKING,
  MAX_CONSECUTIVE_FAILED_UI,
  buildCorrectionMessage,
  decideHookAction,
  decidePreToolUseAction,
  decideStopAction,
  formatDriftMarker,
  isDriftMarkerStep,
  isPreToolDenialStep,
  parseDriftMarkerStep,
  parseTranscriptJsonl,
} from "../scripts/transcript.mjs";
import { createTempDir, makeDenialStep, makeStep, toJsonl, wrapAntigravityHookMessage } from "./helpers.mjs";

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

    const reDriftedAfterRecovery = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking }),
    ]);
    assert.equal(reDriftedAfterRecovery.action, "inject");
    assert.equal(reDriftedAfterRecovery.stepIndex, 3);
    assert.deepEqual(reDriftedAfterRecovery.driftedFields, ["thinking"]);

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

describe("stop hook decision and adapter", () => {
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
});

describe("UI tool labels: PreToolUse decision and PostInvocation/Stop tracking", () => {
  it("denies English update_steps and ask_question calls in PreToolUse with stateless retry cap", () => {
    const englishStepsCall = {
      name: "update_steps",
      args: {
        steps: [
          { title: "Inspect repository layout and baseline checks", status: "in_progress" },
          { title: "Audit core scripts and hook adapters", status: "pending" },
        ],
      },
    };
    const denied = decidePreToolUseAction(englishStepsCall, []);
    assert.equal(denied.action, "deny");
    assert.ok(denied.message.startsWith(DRIFT_MARKER));
    assert.equal(/[A-Za-z]/.test(denied.message), false);

    const koreanStepsCall = {
      name: "update_steps",
      args: {
        steps: [
          { title: "저장소 구조와 기준선 점검", status: "in_progress" },
          { title: "scripts/analyzer.mjs 경계 조건 수정", status: "pending" },
          { title: "Docker Compose 설정", status: "pending" },
          { title: "React Router 적용", status: "pending" },
          { title: "Prisma Client 확인", status: "pending" },
          { title: "Docker Compose와 React Router 설정", status: "pending" },
          { title: "Visual Studio Code Extensions 설정", status: "pending" },
          { title: "탭: React Router", status: "pending" },
        ],
      },
    };
    assert.equal(decidePreToolUseAction(koreanStepsCall, []).action, "allow");

    assert.equal(
      decidePreToolUseAction(
        {
          name: "update_steps",
          args: { steps: [{ title: "확인: let me check the config file now", status: "in_progress" }] },
        },
        [],
      ).action,
      "deny",
    );

    assert.equal(
      decidePreToolUseAction(
        { name: "update_steps", args: { steps: [{ title: "Check UserController", status: "in_progress" }] } },
        [],
      ).action,
      "deny",
    );
    assert.equal(
      decidePreToolUseAction(
        { name: "update_steps", args: { steps: [{ title: "Fix HookHandler", status: "in_progress" }] } },
        [],
      ).action,
      "deny",
    );

    const englishAskCall = {
      name: "ask_question",
      args: {
        questions: [
          {
            question: "Which architecture shape should we pick?",
            options: ["Keep existing layout", "Split hook io helper"],
          },
        ],
      },
    };
    assert.equal(decidePreToolUseAction(englishAskCall, []).action, "deny");

    assert.equal(
      decidePreToolUseAction({ name: "run_command", args: { CommandLine: "npm test", toolSummary: "Run unit tests" } }, []).action,
      "allow",
    );

    const taskCall1 = { name: "task_create", args: { subject: "Inspect config files" } };
    const taskCall2 = { name: "task_create", args: { subject: "Verify output format" } };
    assert.equal(
      decidePreToolUseAction(taskCall1, [
        makeStep(0, "USER_INPUT", { content: "점검해 줘" }),
        { stepIndex: 1, type: "PLANNER_RESPONSE", tool_calls: [taskCall1, taskCall2] },
      ]).action,
      "deny",
    );

    const capped = decidePreToolUseAction(englishStepsCall, [
      makeStep(0, "USER_INPUT", { content: "점검해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", { toolCalls: [englishStepsCall] }),
      { stepIndex: 2, type: "PLANNER_RESPONSE", tool_calls: [englishStepsCall] },
    ]);
    assert.deepEqual(capped, { action: "allow", reason: "pre_tool_retry_cap_reached" });
  });

  it("tracks UI tool-call drift independently in PostInvocation with cap and recovery reset", () => {
    assert.equal(MAX_CONSECUTIVE_FAILED_UI, 2);
    assert.equal(analyzeUiTexts(["Code search", "Directory analysis"]).status, "drifted");
    assert.equal(analyzeUiTexts(["코드베이스 검색", "analyzer.mjs 수정"]).status, "korean");

    const koreanThinking = "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 코드 구조를 먼저 확인하자.";
    const driftedUiCall = [{ name: "run_command", args: { CommandLine: "git status", toolSummary: "Git status check" } }];
    const koreanUiCall = [{ name: "run_command", args: { CommandLine: "git status", toolSummary: "git 상태 확인" } }];

    const first = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
    ]);
    assert.equal(first.action, "inject");
    assert.deepEqual(first.driftedFields, ["ui"]);
    assert.equal(/[A-Za-z]/.test(first.message), false);

    const wrappedUiMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["ui"]));
    const recovered = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedUiMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: koreanUiCall }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
    ]);
    assert.equal(recovered.action, "inject");
    assert.deepEqual(recovered.driftedFields, ["ui"]);

    const capped = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrappedUiMarker }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(5, "SYSTEM_MESSAGE", { content: wrappedUiMarker }),
      makeStep(6, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(7, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(8, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
      makeStep(9, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: driftedUiCall }),
    ]);
    assert.deepEqual(capped, { action: "noop", reason: "ui_cap_reached" });
  });

  it("keeps Stop hook active after earlier thinking/ui markers and recognizes runtime Stop header", () => {
    const thinkingMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["thinking"]));
    const stepsAfterEarlierThinking = [
      makeStep(0, "USER_INPUT", { content: "코드를 분석해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "Let me inspect the repository modules carefully before making any conclusions.",
      }),
      makeStep(2, "SYSTEM_MESSAGE", { content: thinkingMarker }),
      makeStep(3, "PLANNER_RESPONSE", {
        thinking: "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 이제 최종 응답을 정리한다.",
        content: "Here is the complete architectural summary written entirely in English prose.",
      }),
    ];
    const stopDecision = decideStopAction(stepsAfterEarlierThinking, {
      continuationActive: false,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.equal(stopDecision.action, "continue");
    assert.equal(stopDecision.alreadyCoveredByPostHook, false);
    assert.ok(stopDecision.reasonMessage.startsWith(DRIFT_MARKER));

    const samePlannerThinkingMarker = decideStopAction(
      [
        makeStep(0, "USER_INPUT", { content: "설명해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", {
          thinking: "Let me check this file carefully.",
          content: "Here is the complete explanation in English prose.",
        }),
        makeStep(2, "SYSTEM_MESSAGE", { content: thinkingMarker }),
      ],
      { continuationActive: false, terminationReason: "NO_TOOL_CALL" },
    );
    assert.equal(samePlannerThinkingMarker.action, "continue");
    assert.equal(samePlannerThinkingMarker.alreadyCoveredByPostHook, false);
    assert.ok(samePlannerThinkingMarker.reasonMessage.includes("직전 최종 응답이 영어로 작성되었다."));

    const runtimeStopMessage = [
      "The following is a <SYSTEM_MESSAGE> not actually sent by the user.",
      "",
      "<SYSTEM_MESSAGE>",
      `Stop hook blocked termination: ${buildCorrectionMessage(["content"])}`,
      "</SYSTEM_MESSAGE>",
    ].join("\n");
    const parsed = parseDriftMarkerStep(makeStep(4, "SYSTEM_MESSAGE", { content: runtimeStopMessage }));
    assert.equal(parsed?.sourceHook, "Stop");
    assert.deepEqual(parsed?.fields, ["content"]);
    assert.equal(isDriftMarkerStep(makeStep(4, "SYSTEM_MESSAGE", { content: runtimeStopMessage })), true);

    const contentMarker = wrapAntigravityHookMessage(buildCorrectionMessage(["content"]));

    const stopAfterIntermediateToolCall = decideStopAction(
      [
        makeStep(0, "USER_INPUT", { content: "설명해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", {
          content: "Draft English status message before calling a tool.",
          toolCalls: [{ name: "read_file", args: { Path: "README.md" } }],
        }),
        makeStep(2, "SYSTEM_MESSAGE", { content: contentMarker }),
        makeStep(3, "PLANNER_RESPONSE", { thinking: "이 추론과 생각 요약은 반드시 한국어로만 작성한다.", content: "" }),
        makeStep(4, "PLANNER_RESPONSE", {
          thinking: "이 추론과 생각 요약은 반드시 한국어로만 작성한다.",
          content: "Final English explanation that still needs Stop recovery.",
        }),
      ],
      { continuationActive: false, terminationReason: "NO_TOOL_CALL" },
    );
    assert.equal(stopAfterIntermediateToolCall.action, "continue");

    const stopAfterPriorStopRetry = decideStopAction(
      [
        makeStep(0, "USER_INPUT", { content: "설명해 줘" }),
        makeStep(1, "PLANNER_RESPONSE", { content: "First English final answer." }),
        makeStep(2, "SYSTEM_MESSAGE", { content: runtimeStopMessage }),
        makeStep(3, "PLANNER_RESPONSE", { content: "Second English final answer after Stop retry." }),
      ],
      { continuationActive: false, terminationReason: "NO_TOOL_CALL" },
    );
    assert.deepEqual(stopAfterPriorStopRetry, { action: "noop", reason: "stop_retry_cap_reached" });

    const thinkingAfterContentMarker = decideHookAction([
      makeStep(0, "USER_INPUT", { content: "설명해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "Let me read the modules carefully first.",
        content: "Here is the full English explanation.",
      }),
      makeStep(2, "SYSTEM_MESSAGE", { content: contentMarker }),
      makeStep(3, "PLANNER_RESPONSE", {
        thinking: "Now let me inspect another module carefully in English.",
        content: "최종 응답은 한국어로 자연스럽게 다시 작성했다.",
      }),
    ]);
    assert.equal(thinkingAfterContentMarker.action, "inject");
    assert.deepEqual(thinkingAfterContentMarker.driftedFields, ["thinking"]);
  });
});

describe("structured drift marker tags", () => {
  const FIELD_SETS = [["thinking"], ["content"], ["ui"], ["thinking", "content"], ["thinking", "ui"], ["content", "ui"], ["thinking", "content", "ui"]];

  it("round-trips [대상:…] field tags through formatDriftMarker, buildCorrectionMessage, and parseDriftMarkerStep", () => {
    assert.equal(formatDriftMarker([]), DRIFT_MARKER);
    assert.equal(formatDriftMarker(["ui", "thinking"]), `${DRIFT_MARKER}[대상:추론+화면]`);
    for (const fields of FIELD_SETS) {
      const message = buildCorrectionMessage(fields);
      assert.ok(message.startsWith(formatDriftMarker(fields)));
      for (const hookName of ["PostInvocation", "Stop", "PreToolUse"]) {
        const parsed = parseDriftMarkerStep(
          makeStep(0, "SYSTEM_MESSAGE", { content: wrapAntigravityHookMessage(message, hookName) }),
        );
        assert.deepEqual(parsed, { marker: DRIFT_MARKER, sourceHook: hookName, fields, structured: true });
      }
      const bare = parseDriftMarkerStep(makeStep(0, "SYSTEM_MESSAGE", { content: message }));
      assert.deepEqual(bare?.fields, fields);
      assert.equal(bare?.sourceHook, "unknown");
    }

    const reordered = parseDriftMarkerStep(
      makeStep(0, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER}[대상:화면+추론+없음] 본문` }),
    );
    assert.deepEqual(reordered?.fields, ["thinking", "ui"]);
    assert.equal(reordered?.structured, true);

    const denial = parseDriftMarkerStep(makeDenialStep(3));
    assert.deepEqual(denial, { marker: DRIFT_MARKER, sourceHook: "PreToolUse", fields: ["ui"], structured: true });
  });

  it("keeps legacy untagged markers compatible by inferring fields from the body", () => {
    const legacyEnglish = parseDriftMarkerStep(
      makeStep(0, "SYSTEM_MESSAGE", { content: `${LEGACY_DRIFT_MARKERS[0]} English drift detected: thinking drifted.` }),
    );
    assert.equal(legacyEnglish?.marker, LEGACY_DRIFT_MARKERS[0]);
    assert.equal(legacyEnglish?.structured, false);
    assert.deepEqual(legacyEnglish?.fields, ["thinking"]);

    const legacyKoreanContent = parseDriftMarkerStep(
      makeStep(0, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} 직전 최종 응답이 영어로 작성되었다. 한국어로 다시 써라.` }),
    );
    assert.equal(legacyKoreanContent?.structured, false);
    assert.deepEqual(legacyKoreanContent?.fields, ["content"]);

    const legacyKoreanBoth = parseDriftMarkerStep(
      makeStep(0, "SYSTEM_MESSAGE", {
        content: wrapAntigravityHookMessage(`${DRIFT_MARKER} 직전 내부 추론·생각 요약과 최종 응답이 모두 영어로 작성되었다.`),
      }),
    );
    assert.deepEqual(legacyKoreanBoth?.fields, ["thinking", "content"]);
    assert.equal(legacyKoreanBoth?.sourceHook, "PostInvocation");

    const legacyUi = parseDriftMarkerStep(
      makeStep(0, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} 작업 단계 제목이 영어로 작성되었다.` }),
    );
    assert.deepEqual(legacyUi?.fields, ["ui"]);

    const englishThinking = "Let me read the hook script and verify the JSON output format carefully.";
    const englishContent = "All unit tests passed and every exported interface has been verified cleanly.";
    const opaque = makeStep(1, "SYSTEM_MESSAGE", { content: `${LEGACY_DRIFT_MARKERS[0]} please fix it` });
    assert.deepEqual(parseDriftMarkerStep(opaque)?.fields, []);
    assert.deepEqual(
      decideHookAction([makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishContent }), opaque]),
      { action: "noop", reason: "already_covered" },
    );

    const contentOnly = decideHookAction([
      makeStep(0, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishContent }),
      makeStep(1, "SYSTEM_MESSAGE", { content: wrapAntigravityHookMessage(buildCorrectionMessage(["content"])) }),
    ]);
    assert.equal(contentOnly.action, "inject");
    assert.deepEqual(contentOnly.driftedFields, ["thinking"]);
  });

  it("scans untagged legacy drift markers with repeated tokens in linear time without quadratic backtracking", () => {
    const repeatedDrifted = makeStep(0, "SYSTEM_MESSAGE", {
      content: `${DRIFT_MARKER} ${"drifted ".repeat(15_000)}`,
    });
    const startMs = performance.now();
    const parsed = parseDriftMarkerStep(repeatedDrifted);
    const elapsedMs = performance.now() - startMs;

    assert.ok(elapsedMs < 250, `expected linear-time legacy marker scan (<250ms), took ${elapsedMs.toFixed(1)}ms`);
    assert.equal(parsed?.structured, false);
    assert.deepEqual(parsed?.fields, []);

    const legacyThinking = parseDriftMarkerStep(
      makeStep(1, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} thinking has drifted in this step.` }),
    );
    assert.deepEqual(legacyThinking?.fields, ["thinking"]);

    const legacyContent = parseDriftMarkerStep(
      makeStep(2, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} drifted response in content` }),
    );
    assert.deepEqual(legacyContent?.fields, ["content"]);

    const crossSentence = parseDriftMarkerStep(
      makeStep(3, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} drifted here. thinking and content are fine.` }),
    );
    assert.deepEqual(crossSentence?.fields, []);
  });
});

describe("regression #6: PreToolUse denial interplay with PostInvocation and the retry budget", () => {
  const englishThinking = "Let me inspect the repository layout carefully before updating the checklist.";
  const koreanThinking = "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 저장소 구조를 먼저 확인한다.";
  const englishStepsCall = {
    name: "update_steps",
    args: { steps: [{ title: "Inspect repository layout and baseline checks", status: "in_progress" }] },
  };
  const koreanStepsCall = {
    name: "update_steps",
    args: { steps: [{ title: "저장소 구조와 기준선 점검", status: "in_progress" }] },
  };

  it("does not re-inject ui after a GENERIC denial step but still injects thinking drift", () => {
    assert.equal(isPreToolDenialStep(makeDenialStep(2)), true);
    assert.equal(isPreToolDenialStep({ ...makeDenialStep(2), type: "SYSTEM_MESSAGE" }), false);

    const uiOnly = decideHookAction([
      makeStep(0, "USER_INPUT", { content: "점검해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: koreanThinking, toolCalls: [englishStepsCall] }),
      makeDenialStep(2),
    ]);
    assert.deepEqual(uiOnly, { action: "noop", reason: "already_covered" });

    const uiAndThinking = decideHookAction([
      makeStep(0, "USER_INPUT", { content: "점검해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeDenialStep(2),
    ]);
    assert.equal(uiAndThinking.action, "inject");
    assert.deepEqual(uiAndThinking.driftedFields, ["thinking"]);
    assert.equal(parseDriftMarkerStep(makeStep(3, "SYSTEM_MESSAGE", { content: uiAndThinking.message }))?.fields.includes("ui"), false);

    const records = [
      { step_index: 0, type: "USER_INPUT", content: "점검해 줘" },
      { step_index: 1, type: "PLANNER_RESPONSE", thinking: englishThinking, tool_calls: [englishStepsCall] },
      { step_index: 2, type: "GENERIC", content: makeDenialStep(2).content },
    ];
    const output = handlePostInvocation(
      JSON.stringify({ hookEventName: "PostInvocation", transcriptPath: "/virtual/transcript_full.jsonl" }),
      () => toJsonl(records),
    );
    assert.equal(output.injectSteps.length, 1);
    const injected = output.injectSteps[0].systemMessage.systemMessage;
    assert.deepEqual(parseDriftMarkerStep(makeStep(3, "SYSTEM_MESSAGE", { content: injected }))?.fields, ["thinking"]);
  });

  it("resets the PreToolUse retry count after a Korean call goes through", () => {
    const twoDenied = [
      makeStep(0, "USER_INPUT", { content: "점검해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", { toolCalls: [englishStepsCall] }),
      makeDenialStep(2),
      makeStep(3, "PLANNER_RESPONSE", { toolCalls: [englishStepsCall] }),
      makeDenialStep(4),
    ];
    assert.deepEqual(decidePreToolUseAction(englishStepsCall, twoDenied), {
      action: "allow",
      reason: "pre_tool_retry_cap_reached",
    });

    const recoveredThenEnglish = [
      ...twoDenied,
      makeStep(5, "PLANNER_RESPONSE", { toolCalls: [koreanStepsCall] }),
      makeStep(6, "PLANNER_RESPONSE", { toolCalls: [englishStepsCall] }),
    ];
    assert.equal(decidePreToolUseAction(englishStepsCall, recoveredThenEnglish).action, "deny");

    const koreanButDenied = [...twoDenied, makeStep(5, "PLANNER_RESPONSE", { toolCalls: [koreanStepsCall] }), makeDenialStep(6)];
    assert.equal(decidePreToolUseAction(englishStepsCall, koreanButDenied).action, "allow");
  });

  it("fails open when the transcript is unavailable for the retry cap", () => {
    assert.deepEqual(decidePreToolUseAction(englishStepsCall, [], { transcriptAvailable: false }), {
      action: "allow",
      reason: "retry_cap_unavailable",
    });
    assert.equal(decidePreToolUseAction(englishStepsCall, [], { transcriptAvailable: true }).action, "deny");
    assert.deepEqual(decidePreToolUseAction(koreanStepsCall, [], { transcriptAvailable: false }), {
      action: "allow",
      reason: "ok",
    });
  });
});

describe("regression #8: a new user turn without a planner response", () => {
  it("returns no_planner_response from both PostInvocation and Stop", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "구조를 설명해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: "Let me inspect the repository layout carefully before answering the question.",
        content: "Here is the complete explanation of the repository layout in English prose.",
      }),
      makeStep(2, "USER_INPUT", { content: "이번에는 다른 모듈을 설명해 줘" }),
    ];
    assert.deepEqual(decideHookAction(steps), { action: "noop", reason: "no_planner_response" });
    assert.deepEqual(decideStopAction(steps, { terminationReason: "NO_TOOL_CALL" }), {
      action: "noop",
      reason: "no_planner_response",
    });

    const records = steps.map((step) => ({ step_index: step.stepIndex, type: step.type, thinking: step.thinking, content: step.content }));
    const readTextFile = () => toJsonl(records);
    assert.deepEqual(
      handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath: "/virtual/t.jsonl" }), readTextFile),
      {},
    );
    assert.deepEqual(
      handleStop(
        JSON.stringify({ hookEventName: "Stop", transcriptPath: "/virtual/t.jsonl", terminationReason: "NO_TOOL_CALL" }),
        readTextFile,
      ),
      {},
    );
  });
});

describe("QA F1/F3/F5: denial detection, per-call denial mapping, legacy 사고 요약 markers", () => {
  const needle = "tool call denied by pre-tool hook";
  const englishStepsCall = { name: "update_steps", args: { steps: [{ title: "Inspect repository layout", status: "in_progress" }] } };
  const koreanStepsCall = { name: "update_steps", args: { steps: [{ title: "저장소 구조 점검", status: "in_progress" }] } };
  const readCall = { name: "view_file", args: { AbsolutePath: "src/a.mjs", toolSummary: "분석기 파일 읽기" } };

  it("F1: a file-read GENERIC that quotes the denial needle is not a PreToolUse denial on either read path", () => {
    const readOutput = {
      step_index: 2,
      type: "GENERIC",
      status: "DONE",
      content: `Showing lines 1-2\n1: export const PRE_TOOL_DENIAL_NEEDLE = "${needle}";\n2: export function isPreToolDenialStep(step) {`,
    };
    assert.equal(isPreToolDenialStep(readOutput), false);
    assert.equal(isPreToolDenialStep({ ...readOutput, status: "ERROR" }), false);
    // Real agy denial shape: status ERROR, error starts with the needle (reason may be empty).
    assert.equal(isPreToolDenialStep({ type: "GENERIC", status: "ERROR", error: `${needle}: ` }), true);
    assert.equal(isPreToolDenialStep({ type: "GENERIC", status: "ERROR", error: `Encountered error in step execution: ${needle}: x` }), true);
    assert.equal(isPreToolDenialStep({ type: "GENERIC", status: "DONE", content: `Created At: now\n${needle}: x` }), false);
    assert.equal(isPreToolDenialStep({ type: "GENERIC", status: "ERROR", content: `Created At: now\n${needle}: x` }), true);

    const dir = createTempDir("thinking-korean-f1-");
    const fullPath = join(dir, "transcript_full.jsonl");
    const records = [{ step_index: 0, type: "USER_INPUT", content: "점검해 줘" }, readOutput];
    writeFileSync(fullPath, toJsonl(records), "utf8");
    assert.equal(parseTranscriptJsonl(toJsonl(records)).length, 1);
    assert.equal(readTranscriptSteps(fullPath).length, 1);
    assert.deepEqual(readTranscriptSteps(fullPath, (path) => (path === fullPath ? toJsonl(records) : "")).length, 1);

    writeFileSync(fullPath, toJsonl([readOutput]), "utf8");
    writeFileSync(join(dir, "transcript.jsonl"), toJsonl([{ step_index: 0, type: "USER_INPUT", content: "점검해 줘" }]), "utf8");
    assert.deepEqual(readTranscriptSteps(join(dir, "transcript.jsonl")).map((step) => step.type), ["USER_INPUT"]);
  });

  it("F3: a Korean retry denied as the 2nd call of a multi-call planner step does not reset the retry budget", () => {
    const records = [
      { step_index: 0, type: "USER_INPUT", content: "점검해 줘" },
      { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [englishStepsCall] },
      { step_index: 2, type: "GENERIC", status: "ERROR", error: `${needle}: x` },
      { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [readCall, koreanStepsCall] },
      { step_index: 4, type: "GENERIC", status: "DONE", content: "1: file body" },
      { step_index: 5, type: "GENERIC", status: "ERROR", error: `${needle}: y` },
      { step_index: 6, type: "PLANNER_RESPONSE", tool_calls: [englishStepsCall] },
    ];
    const inMemory = records.map(({ step_index: stepIndex, tool_calls: toolCalls = [], ...rest }) => ({ stepIndex, toolCalls, ...rest }));
    for (const steps of [inMemory, parseTranscriptJsonl(toJsonl(records))]) {
      assert.equal(decidePreToolUseAction(englishStepsCall, steps).reason, "pre_tool_retry_cap_reached");
    }

    const passed = inMemory.map((step) => (step.stepIndex === 5 ? { ...step, status: "DONE", error: "" } : step));
    assert.equal(decidePreToolUseAction(englishStepsCall, passed).action, "deny");
  });

  it("F5: infers thinking and content from 1.0.x legacy 사고 요약 marker bodies", () => {
    const both = parseDriftMarkerStep(
      makeStep(0, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} 직전 내부 추론·사고 요약과 최종 응답이 모두 영어로 작성되었다.` }),
    );
    assert.equal(both?.structured, false);
    assert.deepEqual(both?.fields, ["thinking", "content"]);
    const thinkingOnly = parseDriftMarkerStep(
      makeStep(0, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} 직전 내부 추론과 사고 요약이 영어로 작성되었다.` }),
    );
    assert.deepEqual(thinkingOnly?.fields, ["thinking"]);
  });

  it("does not exhaust the Stop retry cap when a marker appears before any planner step in the turn", () => {
    const decision = decideStopAction(
      [
        makeStep(0, "USER_INPUT", { content: "구조를 분석해 줘" }),
        makeStep(1, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER}[대상:응답] 테스트` }),
        makeStep(2, "PLANNER_RESPONSE", {
          thinking: "이 추론과 생각 요약은 반드시 한국어로만 작성한다. 코드를 분석한다.",
          content: "This is a completely English final response that drifted from Korean.",
        }),
      ],
      { terminationReason: "NO_TOOL_CALL" },
    );
    assert.equal(decision.action, "continue");
  });
});

describe("regression: simultaneous cap reason and replayTrackers lastUserInput consistency", () => {
  const englishThinking = "Let me inspect the repository structure and verify all files carefully.";
  const koreanThinking = "먼저 저장소 구조를 차근차근 분석하고 핵심 파일을 점검한다.";
  const englishContent = "Here is the complete English translation and summary of the requested text.";
  const englishStepsCall = {
    name: "update_steps",
    args: { steps: [{ title: "Inspect repository layout", status: "in_progress" }] },
  };

  it("returns cap_reached when both thinking and ui hit their failure caps simultaneously", () => {
    const steps = [
      makeStep(0, "USER_INPUT", { content: "저장소를 점검해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(2, "SYSTEM_MESSAGE", { content: buildCorrectionMessage(["thinking", "ui"]) }),
      makeStep(3, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(4, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(5, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(6, "SYSTEM_MESSAGE", { content: buildCorrectionMessage(["thinking", "ui"]) }),
      makeStep(7, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(8, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(9, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(10, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
      makeStep(11, "PLANNER_RESPONSE", { thinking: englishThinking, toolCalls: [englishStepsCall] }),
    ];

    const decision = decideHookAction(steps);
    assert.deepEqual(decision, { action: "noop", reason: "cap_reached" });
  });

  it("applies lastUserInput exemption consistently inside replayTrackers when USER_INPUT is absent", () => {
    const steps = [
      makeStep(0, "PLANNER_RESPONSE", { thinking: koreanThinking, content: englishContent }),
      makeStep(1, "SYSTEM_MESSAGE", { content: `${DRIFT_MARKER} 한국어로 작성하라` }),
      makeStep(2, "PLANNER_RESPONSE", { thinking: englishThinking, content: englishContent }),
    ];

    const decision = decideHookAction(steps, { lastUserInput: "Please reply in English." });
    assert.deepEqual(decision, { action: "noop", reason: "cooldown_active" });
  });

  it("still injects ui drift when PreToolUse denied one tool call but a sibling non-denied tool call has English UI text", () => {
    const englishRunCommand = {
      name: "run_command",
      args: { CommandLine: "ls", toolSummary: "List all project files" },
    };
    const steps = [
      makeStep(0, "USER_INPUT", { content: "코드베이스를 점검해 줘" }),
      makeStep(1, "PLANNER_RESPONSE", {
        thinking: koreanThinking,
        toolCalls: [englishStepsCall, englishRunCommand],
      }),
      makeDenialStep(2),
    ];

    const decision = decideHookAction(steps);
    assert.equal(decision.action, "inject");
    assert.deepEqual(decision.driftedFields, ["ui"]);
  });
});
