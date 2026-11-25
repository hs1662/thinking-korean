import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readTranscriptSteps } from "../scripts/hook-io.mjs";
import { handlePostInvocation } from "../scripts/post-invocation.mjs";
import { handlePreToolUse } from "../scripts/pre-tool-use.mjs";
import { handleStop } from "../scripts/stop.mjs";
import {
  DRIFT_MARKER,
  PRE_TOOL_DENIAL_NEEDLE,
  PRE_TOOL_USE_UI_TOOLS,
  buildCorrectionMessage,
  isPreToolDenialStep,
  parseDriftMarkerStep,
} from "../scripts/transcript.mjs";
import {
  HOOKS_JSON_PATH,
  HOOK_SCRIPT,
  PRE_TOOL_HOOK_SCRIPT,
  STOP_HOOK_SCRIPT,
  createTempDir,
  runHookSubprocess,
  toJsonl,
} from "./helpers.mjs";

describe("post-invocation hook CLI and adapter", () => {
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

    const proc = runHookSubprocess(
      HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "PostInvocation",
        transcriptPath,
      }),
    );

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

    const proc = runHookSubprocess(
      HOOK_SCRIPT,
      JSON.stringify({ transcriptPath: compactPath }),
    );

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
    const proc = runHookSubprocess(
      HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "PostInvocation",
        transcriptPath: `  ${transcriptPath}  `,
        lastUserInput: "이 문단을 자연스러운 영어로 번역해 줘",
      }),
    );
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

    const proc = runHookSubprocess(
      HOOK_SCRIPT,
      JSON.stringify({ transcriptPath }),
    );

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
      const proc = runHookSubprocess(
        HOOK_SCRIPT,
        stdinText,
      );
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

describe("stop hook CLI", () => {
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

    const proc = runHookSubprocess(
      STOP_HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath: compactPath,
        continuationActive: false,
        terminationReason: "NO_TOOL_CALL",
      }),
    );

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
      const proc = runHookSubprocess(STOP_HOOK_SCRIPT, input);
      assert.equal(proc.status, 0);
      assert.equal(proc.stderr, "");
      assert.deepEqual(JSON.parse(proc.stdout), {});
    }
  });
});

describe("pre-tool-use hook CLI", () => {
  it("runs scripts/pre-tool-use.mjs as a real subprocess and fails open on errors or missing transcript", () => {
    const dir = createTempDir("thinking-korean-pretool-sub-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(transcriptPath, toJsonl([{ step_index: 0, type: "USER_INPUT", content: "점검해 줘" }]), "utf8");

    const englishStepsCall = {
      name: "update_steps",
      args: {
        steps: [{ title: "Run adversarial review and verify findings", status: "in_progress" }],
      },
    };

    for (const payload of [
      { hookEventName: "PreToolUse", transcriptPath, toolCall: englishStepsCall },
      { hookEventName: "PreToolUse", transcript_path: transcriptPath, tool_call: englishStepsCall },
    ]) {
      const procDeny = runHookSubprocess(PRE_TOOL_HOOK_SCRIPT, JSON.stringify(payload));
      assert.equal(procDeny.status, 0);
      assert.equal(procDeny.stderr, "");
      const parsedDeny = JSON.parse(procDeny.stdout);
      assert.equal(parsedDeny.decision, "deny");
      assert.ok(parsedDeny.reason.startsWith(DRIFT_MARKER));
      assert.equal(/[A-Za-z]/.test(parsedDeny.reason), false);
    }

    // Missing, blank, or non-string transcriptPath fails open with explicit allow so retries cannot loop.
    for (const missingPathPayload of [
      { hookEventName: "PreToolUse", toolCall: englishStepsCall },
      { hookEventName: "PreToolUse", transcriptPath: "", toolCall: englishStepsCall },
      { hookEventName: "PreToolUse", transcriptPath: 123, toolCall: englishStepsCall },
    ]) {
      const procMissing = runHookSubprocess(PRE_TOOL_HOOK_SCRIPT, JSON.stringify(missingPathPayload));
      assert.equal(procMissing.status, 0);
      assert.equal(procMissing.stderr, "");
      assert.deepEqual(JSON.parse(procMissing.stdout), { decision: "allow" });
    }

    const procAllow = runHookSubprocess(
      PRE_TOOL_HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "PreToolUse",
        transcriptPath,
        toolCall: {
          name: "update_steps",
          args: {
            steps: [{ title: "핵심 모듈과 테스트 검증", status: "in_progress" }],
          },
        },
      }),
    );
    assert.equal(procAllow.status, 0);
    assert.deepEqual(JSON.parse(procAllow.stdout), { decision: "allow" });

    assert.deepEqual(handlePreToolUse("{invalid"), { decision: "allow" });
    assert.deepEqual(handlePreToolUse(JSON.stringify({ hookEventName: "PostInvocation", toolCall: {} })), {
      decision: "allow",
    });
  });
});

describe("transcript reader", () => {
  it("falls back past whitespace-only transcript_full.jsonl and handles UTF-8 BOM + CRLF", () => {
    const dir = createTempDir();
    const fullPath = join(dir, "transcript_full.jsonl");
    const compactPath = join(dir, "transcript.jsonl");

    writeFileSync(fullPath, "\n   \r\n", "utf8");
    writeFileSync(
      compactPath,
      `\uFEFF${JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", thinking: "한국어 사고 테스트 문장입니다." })}\r\n`,
      "utf8",
    );

    const steps = readTranscriptSteps(compactPath);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].type, "PLANNER_RESPONSE");
    assert.equal(steps[0].thinking, "한국어 사고 테스트 문장입니다.");
  });
});

describe("P0 #1: PreToolUse CLI always prints an explicit allow decision when not denying", () => {
  const ALLOW_STDOUT = '{"decision":"allow"}\n';
  const englishStepsCall = {
    name: "update_steps",
    args: { steps: [{ title: "Inspect repository layout and baseline checks", status: "in_progress" }] },
  };

  function assertAllow(proc, label) {
    assert.equal(proc.status, 0, `${label}: exit code`);
    assert.equal(proc.stderr, "", `${label}: stderr`);
    assert.equal(proc.stdout, ALLOW_STDOUT, `${label}: stdout`);
  }

  it("prints exactly {\"decision\":\"allow\"} for malformed stdin, wrong event, missing toolCall, non-UI tool, and Korean labels", () => {
    const cases = {
      "empty stdin": "",
      "malformed stdin": "{not-json",
      "array stdin": JSON.stringify([]),
      "wrong hookEventName": JSON.stringify({ hookEventName: "PostInvocation", toolCall: englishStepsCall }),
      "missing toolCall": JSON.stringify({ hookEventName: "PreToolUse" }),
      "non-object toolCall": JSON.stringify({ hookEventName: "PreToolUse", toolCall: "update_steps" }),
      "non-UI tool": JSON.stringify({
        hookEventName: "PreToolUse",
        toolCall: { name: "run_command", args: { CommandLine: "npm test", toolSummary: "Run unit tests" } },
      }),
      "Korean UI labels": JSON.stringify({
        hookEventName: "PreToolUse",
        toolCall: { name: "update_steps", args: { steps: [{ title: "핵심 모듈과 테스트 검증", status: "in_progress" }] } },
      }),
    };
    for (const [label, input] of Object.entries(cases)) {
      assertAllow(runHookSubprocess(PRE_TOOL_HOOK_SCRIPT, input), label);
    }
  });

  it("prints exactly {\"decision\":\"allow\"} when the retry cap is reached or the handler throws", () => {
    const dir = createTempDir("thinking-korean-pretool-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "점검해 줘" },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [englishStepsCall] },
        { step_index: 2, type: "PLANNER_RESPONSE", tool_calls: [englishStepsCall] },
      ]),
      "utf8",
    );
    assertAllow(
      runHookSubprocess(
        PRE_TOOL_HOOK_SCRIPT,
        JSON.stringify({ hookEventName: "PreToolUse", transcriptPath, toolCall: englishStepsCall }),
      ),
      "retry cap reached",
    );

    // Force an exception inside the handler: a preload makes String#trim throw for a sentinel payload.
    const sentinel = "__TK_FORCE_HANDLER_EXCEPTION__";
    const preload = `data:text/javascript,${encodeURIComponent(
      `const trim = String.prototype.trim; String.prototype.trim = function () { if (String(this).includes(${JSON.stringify(sentinel)})) { throw new Error("forced"); } return trim.call(this); };`,
    )}`;
    const throwingInput = JSON.stringify({
      hookEventName: "PreToolUse",
      transcriptPath: `/tmp/${sentinel}.jsonl`,
      toolCall: { name: "update_steps", args: { steps: [{ title: `Inspect ${sentinel} layout`, status: "pending" }] } },
    });
    assertAllow(runHookSubprocess(PRE_TOOL_HOOK_SCRIPT, throwingInput, { nodeArgs: ["--import", preload] }), "handler exception");
  });
});

describe("regression #6: GENERIC denial probe versus huge GENERIC skip in the fast reader", () => {
  const englishThinking = "Let me inspect the repository layout carefully before updating the checklist.";
  const englishStepsCall = {
    name: "update_steps",
    args: { steps: [{ title: "Inspect repository layout and baseline checks", status: "in_progress" }] },
  };

  it("keeps a ~64KiB GENERIC denial line and skips a 5MB GENERIC line", () => {
    const dir = createTempDir("thinking-korean-generic-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const denialRecord = {
      step_index: 2,
      type: "GENERIC",
      content: `${"D".repeat(60 * 1024)}\n${PRE_TOOL_DENIAL_NEEDLE}: 작업 단계 제목을 한국어로 바꿔라`,
    };
    const denialLine = JSON.stringify(denialRecord);
    assert.ok(Buffer.byteLength(denialLine, "utf8") > 256 && Buffer.byteLength(denialLine, "utf8") < 64 * 1024);
    const base = [
      { step_index: 0, type: "USER_INPUT", content: "점검해 줘" },
      { step_index: 1, type: "PLANNER_RESPONSE", thinking: englishThinking, tool_calls: [englishStepsCall] },
    ];

    writeFileSync(transcriptPath, `${toJsonl(base)}${denialLine}\n`, "utf8");
    const probed = readTranscriptSteps(transcriptPath);
    assert.equal(probed.length, 3);
    assert.equal(isPreToolDenialStep(probed[2]), true);
    const probedOutput = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    assert.equal(probedOutput.injectSteps.length, 1);
    const injected = probedOutput.injectSteps[0].systemMessage.systemMessage;
    assert.deepEqual(parseDriftMarkerStep({ type: "SYSTEM_MESSAGE", content: injected })?.fields, ["thinking"]);

    const hugeRecord = { step_index: 2, type: "GENERIC", content: `${"G".repeat(5 * 1024 * 1024)}\n${PRE_TOOL_DENIAL_NEEDLE}` };
    writeFileSync(transcriptPath, `${toJsonl(base)}${JSON.stringify(hugeRecord)}\n`, "utf8");
    const skipped = readTranscriptSteps(transcriptPath);
    assert.deepEqual(
      skipped.map((step) => step.type),
      ["USER_INPUT", "PLANNER_RESPONSE"],
    );
    const skippedOutput = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    const skippedMessage = skippedOutput.injectSteps[0].systemMessage.systemMessage;
    assert.deepEqual(parseDriftMarkerStep({ type: "SYSTEM_MESSAGE", content: skippedMessage })?.fields, ["thinking", "ui"]);
  });

  it("matches PreToolUse denial text case-insensitively in both the fast and readTextFile readers", () => {
    const dir = createTempDir("thinking-korean-case-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const jsonl = toJsonl([
      { step_index: 0, type: "USER_INPUT", content: "점검해 줘" },
      { step_index: 1, type: "PLANNER_RESPONSE", thinking: "한국어 사고 문장으로 충분히 작성한다.", tool_calls: [englishStepsCall] },
      { step_index: 2, type: "GENERIC", status: "ERROR", content: "Tool call denied by pre-tool hook: 한국어로 작성하라" },
    ]);
    writeFileSync(transcriptPath, jsonl, "utf8");
    const fastOut = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }));
    const slowOut = handlePostInvocation(JSON.stringify({ hookEventName: "PostInvocation", transcriptPath }), () => jsonl);
    assert.deepEqual(fastOut, {});
    assert.deepEqual(slowOut, {});
  });
});

describe("regression #7: dual read path and hooks.json contract", () => {
  it("falls back from a GENERIC-only transcript_full.jsonl to transcript.jsonl identically on both read paths", () => {
    const dir = createTempDir("thinking-korean-fallback-");
    const fullPath = join(dir, "transcript_full.jsonl");
    const compactPath = join(dir, "transcript.jsonl");
    writeFileSync(
      fullPath,
      toJsonl([
        { step_index: 0, type: "GENERIC", content: "tool output" },
        { step_index: 1, type: "GENERIC", content: "G".repeat(300) },
      ]),
      "utf8",
    );
    writeFileSync(
      compactPath,
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

    const viaTextReader = readTranscriptSteps(compactPath, (path) => readFileSync(path, "utf8"));
    const viaFastReader = readTranscriptSteps(compactPath);
    assert.equal(viaTextReader.length, 2);
    assert.deepEqual(viaFastReader, viaTextReader);

    const proc = runHookSubprocess(HOOK_SCRIPT, JSON.stringify({ hookEventName: "PostInvocation", transcriptPath: compactPath }));
    assert.equal(proc.status, 0);
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.injectSteps?.length, 1);
    assert.ok(parsed.injectSteps[0].systemMessage.systemMessage.startsWith(DRIFT_MARKER));
  });

  it("keeps the hooks.json PreToolUse matcher in 1:1 sync with PRE_TOOL_USE_UI_TOOLS", () => {
    const hooks = JSON.parse(readFileSync(HOOKS_JSON_PATH, "utf8"));
    const preToolEntries = Object.values(hooks).flatMap((group) => group.PreToolUse ?? []);
    assert.equal(preToolEntries.length, 1);
    const [entry] = preToolEntries;
    assert.match(entry.matcher, /^[a-z_]+(?:\|[a-z_]+)*$/);
    const matcherTools = entry.matcher.split("|");
    assert.equal(new Set(matcherTools).size, matcherTools.length, "matcher must not repeat tools");
    assert.deepEqual([...matcherTools].sort(), [...PRE_TOOL_USE_UI_TOOLS].sort());
    assert.ok(entry.hooks.some((hook) => hook.command.includes("scripts/pre-tool-use.mjs")));
  });
});
