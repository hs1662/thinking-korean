import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { analyzeField } from "../scripts/analyzer.mjs";
import { appendAuditRecord, resolveSchemaRegister } from "../scripts/governance/audit-log.mjs";
import { REGISTER_COPY, VERDICT_HEADERS } from "../scripts/governance/constants.mjs";
import { decideGate, isFillerUnverifiedEntry } from "../scripts/governance/decide-gate.mjs";
import { detectHedges } from "../scripts/governance/hedge-detector.mjs";
import { createTempDir } from "./helpers.mjs";

function makeLedger(overrides = {}) {
  return {
    transcriptAvailable: true,
    sessionReadFiles: new Set(["src/app.mjs"]),
    turnStartStepIndex: 0,
    turnWrittenFiles: new Set(["src/app.mjs"]),
    turnCodeWrittenFiles: new Set(["src/app.mjs"]),
    lastWriteStepIndex: 3,
    lastCodeWriteStepIndex: 3,
    turnExecutions: [
      {
        stepIndex: 5,
        command: "node --test test/app.test.mjs",
        kind: "verification",
        passed: true,
        status: "DONE",
        error: "",
        tail: "ℹ pass 5\nℹ fail 0",
      },
    ],
    turnGateAttempts: [],
    latestTokens: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 },
    gateBlockedThisTurn: false,
    ...overrides,
  };
}

function makeGitLedger(overrides = {}) {
  return {
    gitAvailable: true,
    gitRoot: "/repo",
    gitDirtyFiles: new Set(["src/app.mjs"]),
    ...overrides,
  };
}

function makeInput(overrides = {}) {
  return {
    modified_files: ["src/app.mjs"],
    inspected_files: ["src/app.mjs"],
    verification_runs: [{ command: "node --test test/app.test.mjs", outcome: "pass" }],
    unverified_scope: [],
    self_assessment: "수정 사항과 단위 테스트 결과를 직접 확인했습니다.",
    ...overrides,
  };
}

describe("decideGate core rules R1-R7", () => {
  it("passes cleanly when all files and post-write verifications match", () => {
    const res = decideGate(makeInput(), {
      ledger: makeLedger(),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
      register: "neutral",
    });
    assert.equal(res.verdict, "PASS");
    assert.equal(res.passed, true);
    assert.deepEqual(res.blockedRules, []);
    assert.deepEqual(res.warnedRules, []);
    assert.ok(res.receiptText.startsWith(VERDICT_HEADERS.PASS));
  });

  it("R1_UNREAD_INSPECTED blocks when inspected_files includes an unread path", () => {
    const res = decideGate(makeInput({ inspected_files: ["src/app.mjs", "src/secret.mjs"] }), {
      ledger: makeLedger(),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "REJECT");
    assert.equal(res.passed, false);
    assert.deepEqual(res.blockedRules, ["R1_UNREAD_INSPECTED"]);
    assert.deepEqual(res.details.unreadInspected, ["src/secret.mjs"]);
  });

  it("R2_STALE_VERIFICATION blocks when no verification ran after lastCodeWriteStepIndex", () => {
    const res = decideGate(makeInput({ verification_runs: [] }), {
      ledger: makeLedger({
        lastCodeWriteStepIndex: 6,
        turnExecutions: [{ stepIndex: 4, command: "node --test", kind: "verification", passed: true }],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "REJECT");
    assert.deepEqual(res.blockedRules, ["R2_STALE_VERIFICATION"]);
  });

  it("R3_CONCEALED_FAILURE blocks when the final post-write verification failed or a claimed pass command last failed", () => {
    const res = decideGate(makeInput(), {
      ledger: makeLedger({
        turnExecutions: [
          {
            stepIndex: 5,
            command: "node --test test/app.test.mjs",
            kind: "verification",
            passed: false,
            status: "ERROR",
            error: "AssertionError",
            tail: "AssertionError",
          },
        ],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "REJECT");
    assert.deepEqual(res.blockedRules, ["R3_CONCEALED_FAILURE"]);

    const concealedPrior = decideGate(
      makeInput({
        verification_runs: [
          { command: "npm run lint", outcome: "pass" },
          { command: "node --test test/app.test.mjs", outcome: "pass" },
        ],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            { stepIndex: 5, command: "npm run lint", kind: "verification", passed: false },
            { stepIndex: 6, command: "node --test test/app.test.mjs", kind: "verification", passed: true },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(concealedPrior.verdict, "REJECT");
    assert.deepEqual(concealedPrior.blockedRules, ["R3_CONCEALED_FAILURE"]);
    assert.deepEqual(concealedPrior.details.failedVerifications, ["npm run lint"]);
  });

  it("R3_CONCEALED_FAILURE resolves an earlier narrower failure when a broader superset verification passes later, but still blocks unrelated failures", () => {
    const resolvedBySuperset = decideGate(
      makeInput({
        verification_runs: [{ command: "node --test", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            { stepIndex: 5, command: "node --test test/app.test.mjs", kind: "verification", passed: false },
            { stepIndex: 7, command: "node --test", kind: "verification", passed: true },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(resolvedBySuperset.verdict, "PASS");
    assert.deepEqual(resolvedBySuperset.blockedRules, []);

    const unresolvedUnrelated = decideGate(
      makeInput({
        verification_runs: [{ command: "node --test", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            { stepIndex: 5, command: "npm run lint", kind: "verification", passed: false },
            { stepIndex: 7, command: "node --test", kind: "verification", passed: true },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(unresolvedUnrelated.verdict, "REJECT");
    assert.deepEqual(unresolvedUnrelated.blockedRules, ["R3_CONCEALED_FAILURE"]);
    assert.deepEqual(unresolvedUnrelated.details.failedVerifications, ["npm run lint"]);

    const trailingFailureBlocks = decideGate(
      makeInput({
        verification_runs: [{ command: "node --test", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            { stepIndex: 5, command: "node --test", kind: "verification", passed: true },
            { stepIndex: 7, command: "node --test test/app.test.mjs", kind: "verification", passed: false },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(trailingFailureBlocks.verdict, "REJECT");
    assert.deepEqual(trailingFailureBlocks.blockedRules, ["R3_CONCEALED_FAILURE"]);
    assert.deepEqual(trailingFailureBlocks.details.failedVerifications, ["node --test test/app.test.mjs"]);
  });

  it("R4_UNREPORTED_MODIFIED blocks when a modified file in turnWrittenFiles is omitted", () => {
    const res = decideGate(makeInput({ modified_files: ["src/app.mjs"] }), {
      ledger: makeLedger({
        turnWrittenFiles: new Set(["src/app.mjs", "src/helper.mjs"]),
        turnCodeWrittenFiles: new Set(["src/app.mjs", "src/helper.mjs"]),
      }),
      gitLedger: makeGitLedger({ gitDirtyFiles: new Set(["src/app.mjs", "src/helper.mjs"]) }),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "REJECT");
    assert.deepEqual(res.blockedRules, ["R4_UNREPORTED_MODIFIED"]);
    assert.deepEqual(res.details.unreportedModified, ["src/helper.mjs"]);
  });

  it("R5_FABRICATED_COMMAND blocks when claimed pass command never ran after code write", () => {
    const res = decideGate(
      makeInput({ verification_runs: [{ command: "npm run e2e", outcome: "pass" }] }),
      {
        ledger: makeLedger(),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(res.verdict, "REJECT");
    assert.deepEqual(res.blockedRules, ["R5_FABRICATED_COMMAND"]);
    assert.deepEqual(res.details.fabricatedCommands, ["npm run e2e"]);
  });

  it("R6_PHANTOM_MODIFIED warns when other writes exist and blocks when zero writes exist in git repo", () => {
    const warnRes = decideGate(makeInput({ modified_files: ["src/app.mjs", "src/ghost.mjs"] }), {
      ledger: makeLedger(),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(warnRes.verdict, "PASS_WITH_WARNING");
    assert.equal(warnRes.passed, true);
    assert.deepEqual(warnRes.warnedRules, ["R6_PHANTOM_MODIFIED"]);

    const blockRes = decideGate(
      makeInput({ modified_files: ["src/ghost.mjs"], verification_runs: [] }),
      {
        ledger: makeLedger({
          turnWrittenFiles: new Set(),
          turnCodeWrittenFiles: new Set(),
          lastWriteStepIndex: -1,
          lastCodeWriteStepIndex: -1,
          turnExecutions: [],
        }),
        gitLedger: makeGitLedger({ gitDirtyFiles: new Set() }),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(blockRes.verdict, "REJECT");
    assert.deepEqual(blockRes.blockedRules, ["R6_PHANTOM_MODIFIED"]);
  });

  it("R7_HEDGE_DETECTED warns on >=2 hedges with empty unverified_scope and ignores code spans", () => {
    const cleanCodeHedge = detectHedges("`아마 추정 보입니다`는 코드 예시이며 직접 확인했습니다.");
    assert.equal(cleanCodeHedge.hedgeHits, 0);

    const warned = decideGate(
      makeInput({ self_assessment: "아마 정상 작동할 것으로 보입니다.", unverified_scope: [] }),
      {
        ledger: makeLedger(),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(warned.verdict, "PASS_WITH_WARNING");
    assert.deepEqual(warned.warnedRules, ["R7_HEDGE_DETECTED"]);

    const disclosed = decideGate(
      makeInput({
        self_assessment: "아마 정상 작동할 것으로 보입니다.",
        unverified_scope: ["실제 운영 환경 연동은 미검증"],
      }),
      {
        ledger: makeLedger(),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(disclosed.verdict, "PASS");
  });
});

describe("decideGate exceptions E1-E8", () => {
  it("E1: doc/asset-only edits skip R2 verification requirement", () => {
    const res = decideGate(
      makeInput({ modified_files: ["README.md", "docs/guide.txt"], inspected_files: ["README.md"], verification_runs: [] }),
      {
        ledger: makeLedger({
          sessionReadFiles: new Set(["README.md"]),
          turnWrittenFiles: new Set(["README.md", "docs/guide.txt"]),
          turnCodeWrittenFiles: new Set(),
          lastWriteStepIndex: 3,
          lastCodeWriteStepIndex: -1,
          turnExecutions: [],
        }),
        gitLedger: makeGitLedger({ gitDirtyFiles: new Set(["README.md", "docs/guide.txt"]) }),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(res.verdict, "PASS");
  });

  it("E2: downgrades R2 to PASS_WITH_WARNING when no test suite exists and not_applicable + unverified_scope are provided", () => {
    const res = decideGate(
      makeInput({
        verification_runs: [{ command: "N/A", outcome: "not_applicable", reason_if_na: "테스트 스위트가 없는 정적 스크립트 저장소" }],
        unverified_scope: ["자동화 테스트 미실행"],
      }),
      {
        ledger: makeLedger({ turnExecutions: [] }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: false, indicators: [] },
      },
    );
    assert.equal(res.verdict, "PASS_WITH_WARNING");
    assert.equal(res.passed, true);
    assert.deepEqual(res.warnedRules, ["R2_STALE_VERIFICATION"]);
  });

  it("E3: non-git workspace relies on transcript ledger without false R6 block", () => {
    const res = decideGate(makeInput({ modified_files: ["src/ghost.mjs"], verification_runs: [] }), {
      ledger: makeLedger({
        turnWrittenFiles: new Set(),
        turnCodeWrittenFiles: new Set(),
        lastWriteStepIndex: -1,
        lastCodeWriteStepIndex: -1,
        turnExecutions: [],
      }),
      gitLedger: { gitAvailable: false, gitRoot: null, gitDirtyFiles: new Set() },
      testInfra: { hasTestSuite: false, indicators: [] },
    });
    assert.equal(res.verdict, "PASS_WITH_WARNING");
    assert.deepEqual(res.warnedRules, ["R6_PHANTOM_MODIFIED"]);
  });

  it("E4: pre-existing git dirty files outside turnWrittenFiles do not trigger R4", () => {
    const res = decideGate(makeInput({ modified_files: ["src/app.mjs"] }), {
      ledger: makeLedger(),
      gitLedger: makeGitLedger({ gitDirtyFiles: new Set(["src/app.mjs", "src/preexisting-dirty.mjs"]) }),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "PASS");
  });

  it("E5: reverted files present in turnWrittenFiles but absent from gitDirtyFiles do not trigger R4", () => {
    const res = decideGate(makeInput({ modified_files: ["src/app.mjs"] }), {
      ledger: makeLedger({
        turnWrittenFiles: new Set(["src/app.mjs", "src/reverted.mjs"]),
        turnCodeWrittenFiles: new Set(["src/app.mjs", "src/reverted.mjs"]),
      }),
      gitLedger: makeGitLedger({ gitDirtyFiles: new Set(["src/app.mjs"]) }),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "PASS");
  });

  it("E6: Red-Green TDD with trailing read-only git diff passes without R3", () => {
    const res = decideGate(makeInput(), {
      ledger: makeLedger({
        turnExecutions: [
          { stepIndex: 5, command: "node --test test/app.test.mjs", kind: "verification", passed: false },
          { stepIndex: 7, command: "node --test test/app.test.mjs", kind: "verification", passed: true },
          { stepIndex: 9, command: "git diff --stat", kind: "read_only", passed: true },
        ],
      }),
      gitLedger: makeGitLedger(),
      testInfra: { hasTestSuite: true, indicators: ["test/"] },
    });
    assert.equal(res.verdict, "PASS");
  });

  it("E7: deadlock escape degrades on 4th attempt only when unverified_scope is non-empty and no pass is claimed", () => {
    const threeRejects = [
      { stepIndex: 6, verdict: "REJECT", passed: false },
      { stepIndex: 7, verdict: "REJECT", passed: false },
      { stepIndex: 8, verdict: "REJECT", passed: false },
    ];
    const degraded = decideGate(
      makeInput({
        verification_runs: [{ command: "node --test", outcome: "fail" }],
        unverified_scope: ["외부 데이터베이스 환경 테스트 미실행"],
      }),
      {
        ledger: makeLedger({ turnExecutions: [], turnGateAttempts: threeRejects }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(degraded.verdict, "PASS_WITH_DEGRADATION");
    assert.equal(degraded.passed, true);
    assert.deepEqual(degraded.details.degradedFromBlockedRules, ["R2_STALE_VERIFICATION"]);

    const falsePassStillBlocked = decideGate(
      makeInput({
        verification_runs: [{ command: "node --test", outcome: "pass" }],
        unverified_scope: ["일부 미검증"],
      }),
      {
        ledger: makeLedger({ turnExecutions: [], turnGateAttempts: threeRejects }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(falsePassStillBlocked.verdict, "REJECT");
    assert.equal(falsePassStillBlocked.passed, false);
  });

  it("E8: missing session skips gate cleanly with SKIPPED_NO_SESSION", () => {
    const res = decideGate(makeInput(), { sessionMissing: true, register: "audit" });
    assert.equal(res.verdict, "SKIPPED_NO_SESSION");
    assert.equal(res.passed, true);
    assert.ok(res.receiptText.startsWith(VERDICT_HEADERS.SKIPPED_NO_SESSION));
  });
});

describe("registers, pure-Korean analyzer compatibility, and audit log", () => {
  it("passes analyzeField('content', text) with status === 'korean' for every copy string and receipt in both registers", () => {
    for (const register of ["neutral", "audit"]) {
      const copy = REGISTER_COPY[register];
      const staticTexts = [
        copy.toolDescription,
        ...Object.values(copy.paramDescriptions),
        ...Object.values(copy.summaries),
        copy.degradedNotice,
      ];
      for (const text of staticTexts) {
        const analysis = analyzeField("content", text);
        assert.equal(analysis.status, "korean", `[${register}] static copy failed Korean check: ${text}`);
      }

      const scenarios = [
        decideGate(makeInput(), {
          ledger: makeLedger(),
          gitLedger: makeGitLedger(),
          testInfra: { hasTestSuite: true, indicators: ["test/"] },
          register,
        }),
        decideGate(
          makeInput({
            modified_files: ["src/app.mjs", "src/ghost.mjs"],
            inspected_files: ["src/app.mjs", "src/unread.mjs"],
            verification_runs: [{ command: "npm run fake-check --verbose", outcome: "pass" }],
            self_assessment: "아마 정상 작동할 것으로 보입니다.",
          }),
          {
            ledger: makeLedger({
              turnWrittenFiles: new Set(["src/app.mjs", "src/missed.mjs"]),
              turnCodeWrittenFiles: new Set(["src/app.mjs", "src/missed.mjs"]),
              turnExecutions: [{ stepIndex: 5, command: "node --test", kind: "verification", passed: false }],
            }),
            gitLedger: makeGitLedger({ gitDirtyFiles: new Set(["src/app.mjs", "src/missed.mjs"]) }),
            testInfra: { hasTestSuite: true, indicators: ["test/"] },
            register,
          },
        ),
        decideGate(
          makeInput({
            verification_runs: [{ command: "node --test", outcome: "fail" }],
            unverified_scope: ["원격 API 미검증"],
          }),
          {
            ledger: makeLedger({
              turnExecutions: [],
              turnGateAttempts: [
                { stepIndex: 6, verdict: "REJECT", passed: false },
                { stepIndex: 7, verdict: "REJECT", passed: false },
                { stepIndex: 8, verdict: "REJECT", passed: false },
              ],
            }),
            gitLedger: makeGitLedger(),
            testInfra: { hasTestSuite: true, indicators: ["test/"] },
            register,
          },
        ),
        decideGate(makeInput(), { sessionMissing: true, register }),
      ];

      for (const res of scenarios) {
        const analysis = analyzeField("content", res.receiptText);
        assert.equal(
          analysis.status,
          "korean",
          `[${register}/${res.verdict}] receipt failed Korean check (${analysis.driftReason}):\n${res.receiptText}`,
        );
      }

      const expectedRejectHeader = register === "audit" ? VERDICT_HEADERS.REJECT_AUDIT : VERDICT_HEADERS.REJECT_NEUTRAL;
      assert.ok(scenarios[1].receiptText.startsWith(expectedRejectHeader));
    }
  });

  it("resolves schema register precedence (env > config.json > neutral) and appends JSONL audit records fail-open", () => {
    const prevEnv = process.env.HSTACK_SCHEMA_REGISTER;
    const dataDir = createTempDir("hstack-audit-");
    try {
      delete process.env.HSTACK_SCHEMA_REGISTER;
      assert.equal(resolveSchemaRegister(dataDir), "neutral");

      writeFileSync(join(dataDir, "config.json"), JSON.stringify({ schemaRegister: "audit" }), "utf8");
      assert.equal(resolveSchemaRegister(dataDir), "audit");

      process.env.HSTACK_SCHEMA_REGISTER = "neutral";
      assert.equal(resolveSchemaRegister(dataDir), "neutral");

      process.env.HSTACK_SCHEMA_REGISTER = "invalid_value";
      assert.equal(resolveSchemaRegister(dataDir), "audit");

      assert.equal(appendAuditRecord({ ts: 1, verdict: "PASS" }, dataDir), true);
      assert.equal(appendAuditRecord({ ts: 2, verdict: "REJECT" }, dataDir), true);
      const lines = readFileSync(join(dataDir, "audit.jsonl"), "utf8").trim().split("\n");
      assert.equal(lines.length, 2);
      assert.deepEqual(JSON.parse(lines[0]), { ts: 1, verdict: "PASS" });
      assert.deepEqual(JSON.parse(lines[1]), { ts: 2, verdict: "REJECT" });

      const blockingFile = join(dataDir, "not-a-directory");
      writeFileSync(blockingFile, "block", "utf8");
      assert.equal(appendAuditRecord({ ts: 3 }, join(blockingFile, "nested")), false);
    } finally {
      if (prevEnv === undefined) delete process.env.HSTACK_SCHEMA_REGISTER;
      else process.env.HSTACK_SCHEMA_REGISTER = prevEnv;
    }
  });
});

describe("audit regression tests (decideGate R3 and R5)", () => {
  it("bug #4: R5 blocks claiming pass for read_only, failed, or reverse-substring fabricated commands", () => {
    const readOnlyClaim = decideGate(
      makeInput({
        modified_files: ["README.md"],
        inspected_files: ["README.md"],
        verification_runs: [{ command: "echo hi", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          sessionReadFiles: new Set(["README.md"]),
          turnWrittenFiles: new Set(["README.md"]),
          turnCodeWrittenFiles: new Set(),
          lastWriteStepIndex: 3,
          lastCodeWriteStepIndex: -1,
          turnExecutions: [{ stepIndex: 5, command: "echo hi", kind: "read_only", passed: true }],
        }),
        gitLedger: makeGitLedger({ gitDirtyFiles: new Set(["README.md"]) }),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(readOnlyClaim.verdict, "REJECT");
    assert.deepEqual(readOnlyClaim.blockedRules, ["R5_FABRICATED_COMMAND"]);

    const failedClaimOnDocTurn = decideGate(
      makeInput({
        modified_files: ["README.md"],
        inspected_files: ["README.md"],
        verification_runs: [{ command: "npm test", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          sessionReadFiles: new Set(["README.md"]),
          turnWrittenFiles: new Set(["README.md"]),
          turnCodeWrittenFiles: new Set(),
          lastWriteStepIndex: 3,
          lastCodeWriteStepIndex: -1,
          turnExecutions: [{ stepIndex: 5, command: "npm test", kind: "verification", passed: false }],
        }),
        gitLedger: makeGitLedger({ gitDirtyFiles: new Set(["README.md"]) }),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(failedClaimOnDocTurn.verdict, "REJECT");
    assert.deepEqual(failedClaimOnDocTurn.blockedRules, ["R5_FABRICATED_COMMAND"]);

    const reverseSubstringClaim = decideGate(
      makeInput({
        verification_runs: [{ command: "node -v && npm test", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [{ stepIndex: 5, command: "node -v", kind: "verification", passed: true }],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(reverseSubstringClaim.verdict, "REJECT");
    assert.deepEqual(reverseSubstringClaim.blockedRules, ["R5_FABRICATED_COMMAND"]);

    const bareRuntimeClaim = decideGate(
      makeInput({
        verification_runs: [{ command: "node", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [{ stepIndex: 5, command: "node -v", kind: "verification", passed: true }],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(bareRuntimeClaim.verdict, "REJECT");
    assert.deepEqual(bareRuntimeClaim.blockedRules, ["R5_FABRICATED_COMMAND"]);

    const validSegmentMatch = decideGate(
      makeInput({
        verification_runs: [{ command: "pytest", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [{ stepIndex: 5, command: "cd pkg && pytest", kind: "verification", passed: true }],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(validSegmentMatch.verdict, "PASS");
  });

  it("bug #5: R3 rejects bare runtime launcher resolution and resolves cd-prefixed failures", () => {
    const bareNodeDoesNotResolve = decideGate(
      makeInput({
        verification_runs: [{ command: "node", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            { stepIndex: 5, command: "node --test", kind: "verification", passed: false },
            { stepIndex: 7, command: "node", kind: "verification", passed: true },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(bareNodeDoesNotResolve.verdict, "REJECT");
    assert.ok(bareNodeDoesNotResolve.blockedRules.includes("R3_CONCEALED_FAILURE"));

    const bareNpxDoesNotResolve = decideGate(
      makeInput({
        verification_runs: [{ command: "npx", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            { stepIndex: 5, command: "npx eslint src", kind: "verification", passed: false },
            { stepIndex: 7, command: "npx", kind: "verification", passed: true },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(bareNpxDoesNotResolve.verdict, "REJECT");
    assert.ok(bareNpxDoesNotResolve.blockedRules.includes("R3_CONCEALED_FAILURE"));

    const cdPrefixedResolves = decideGate(
      makeInput({
        verification_runs: [{ command: "node --test", outcome: "pass" }],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            { stepIndex: 5, command: "cd /repo && node --test", kind: "verification", passed: false },
            { stepIndex: 7, command: "node --test", kind: "verification", passed: true },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(cdPrefixedResolves.verdict, "PASS");
    assert.deepEqual(cdPrefixedResolves.blockedRules, []);
  });
});

describe("Patch A: unverified_scope filler normalization, metrics, and audit copy", () => {
  it("classifies empty/filler declarations accurately without false positives on substantive Korean entries", () => {
    const fillers = [
      "",
      "   ",
      null,
      undefined,
      "없음",
      "없음.",
      "없음!",
      "없습니다",
      "없어요.",
      "없음 (모든 수정 파일에 대해 단위 테스트 및 CLI 직접 실행 검증을 완료함)",
      "없음 (모든 수정 파일에 대해 단위 테스트 완료)",
      "해당 없음",
      "해당없음",
      "해당 사항 없음",
      "해당사항 없음",
      "특이 사항 없음",
      "특이사항 없음",
      "누락 없음",
      "누락된 항목 없음",
      "제외 항목 없음",
      "제외항목 없음",
      "미검증 항목 없음",
      "미검증 범위 없음",
      "별도 없음",
      "별도 제한 없음",
      "추가 없음",
      "none",
      "None.",
      "N/A",
      "n/a (not applicable)",
      "na",
      "nil",
      "null",
      "nothing",
      "no gaps",
      "no issues",
    ];
    for (const entry of fillers) {
      assert.equal(isFillerUnverifiedEntry(entry), true, `expected filler: ${JSON.stringify(entry)}`);
    }

    const substantive = [
      "권한 없음(403) 분기 미검증",
      "권한 없음(403) 응답 분기 미검증",
      "없음 상태 폴백 로직 미확인",
      "없음 상태 폴백 미확인",
      "해당 없음 분기 처리 미검증",
      "실제 운영 환경 연동은 미검증",
      "Windows 경로 호환성 미확인",
    ];
    for (const entry of substantive) {
      assert.equal(isFillerUnverifiedEntry(entry), false, `expected substantive: ${JSON.stringify(entry)}`);
    }
  });

  it("excludes filler unverified_scope entries from E2, E7, R7 and exposes counts in metrics", () => {
    const e2Blocked = decideGate(
      makeInput({
        verification_runs: [{ command: "N/A", outcome: "not_applicable", reason_if_na: "테스트 스위트 없음" }],
        unverified_scope: ["없음 (모든 변경을 육안 확인함)", "해당 없음"],
      }),
      {
        ledger: makeLedger({ turnExecutions: [] }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: false, indicators: [] },
      },
    );
    assert.equal(e2Blocked.verdict, "REJECT");
    assert.deepEqual(e2Blocked.blockedRules, ["R2_STALE_VERIFICATION"]);
    assert.equal(e2Blocked.metrics.unverifiedScopeCount, 0);
    assert.equal(e2Blocked.metrics.fillerUnverifiedCount, 2);

    const e2AllowedWithSubstantive = decideGate(
      makeInput({
        verification_runs: [{ command: "N/A", outcome: "not_applicable", reason_if_na: "테스트 스위트 없음" }],
        unverified_scope: ["없음", "권한 없음(403) 응답 분기 미검증"],
      }),
      {
        ledger: makeLedger({ turnExecutions: [] }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: false, indicators: [] },
      },
    );
    assert.equal(e2AllowedWithSubstantive.verdict, "PASS_WITH_WARNING");
    assert.deepEqual(e2AllowedWithSubstantive.warnedRules, ["R2_STALE_VERIFICATION"]);
    assert.equal(e2AllowedWithSubstantive.metrics.unverifiedScopeCount, 1);
    assert.equal(e2AllowedWithSubstantive.metrics.fillerUnverifiedCount, 1);

    const threeRejects = [
      { stepIndex: 6, verdict: "REJECT", passed: false },
      { stepIndex: 7, verdict: "REJECT", passed: false },
      { stepIndex: 8, verdict: "REJECT", passed: false },
    ];
    const e7BlockedOnFiller = decideGate(
      makeInput({
        verification_runs: [{ command: "node --test", outcome: "fail" }],
        unverified_scope: ["특이사항 없음", "N/A"],
      }),
      {
        ledger: makeLedger({ turnExecutions: [], turnGateAttempts: threeRejects }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(e7BlockedOnFiller.verdict, "REJECT");
    assert.equal(e7BlockedOnFiller.metrics.unverifiedScopeCount, 0);
    assert.equal(e7BlockedOnFiller.metrics.fillerUnverifiedCount, 2);

    const r7WarnedOnFiller = decideGate(
      makeInput({
        self_assessment: "아마 정상 작동할 것으로 보입니다.",
        unverified_scope: ["없음."],
      }),
      {
        ledger: makeLedger(),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(r7WarnedOnFiller.verdict, "PASS_WITH_WARNING");
    assert.deepEqual(r7WarnedOnFiller.warnedRules, ["R7_HEDGE_DETECTED"]);
    assert.equal(r7WarnedOnFiller.metrics.unverifiedScopeCount, 0);
    assert.equal(r7WarnedOnFiller.metrics.fillerUnverifiedCount, 1);

    const r7ClearedOnSubstantive = decideGate(
      makeInput({
        self_assessment: "아마 정상 작동할 것으로 보입니다.",
        unverified_scope: ["없음", "없음 상태 폴백 로직 미확인"],
      }),
      {
        ledger: makeLedger(),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(r7ClearedOnSubstantive.verdict, "PASS");
    assert.equal(r7ClearedOnSubstantive.metrics.unverifiedScopeCount, 1);
    assert.equal(r7ClearedOnSubstantive.metrics.fillerUnverifiedCount, 1);

    const skippedMetrics = decideGate(
      makeInput({ unverified_scope: ["없음", "원격 연동 미검증"] }),
      { sessionMissing: true },
    );
    assert.equal(skippedMetrics.verdict, "SKIPPED_NO_SESSION");
    assert.equal(skippedMetrics.metrics.unverifiedScopeCount, 1);
    assert.equal(skippedMetrics.metrics.fillerUnverifiedCount, 1);
  });

  it("refines audit unverified_scope schema guidance in pure Korean", () => {
    const desc = REGISTER_COPY.audit.paramDescriptions.unverified_scope;
    assert.ok(desc.includes("빈 배열"));
    assert.equal(analyzeField("content", desc).status, "korean");
  });
});

describe("Patch B: agy-fast mcp_agy-fast_fast_run_checks gate evaluation", () => {
  it("passes when verification_runs claims executed sub-command, tool name, or check label from mcp_agy-fast_fast_run_checks", () => {
    const mcpLedger = makeLedger({
      turnExecutions: [
        {
          stepIndex: 5,
          toolName: "mcp_agy-fast_fast_run_checks",
          command: "node --test && agy plugin validate --strict --json .",
          subCommands: ["node --test", "agy plugin validate --strict --json ."],
          checkLabels: ["unit-tests", "plugin-validate"],
          kind: "verification",
          passed: true,
          status: "DONE",
          error: "",
          tail: "Checks: 2/2 passed (wall: 420ms)",
        },
      ],
    });

    for (const claimed of ["node --test", "mcp_agy-fast_fast_run_checks", "unit-tests"]) {
      const res = decideGate(
        makeInput({ verification_runs: [{ command: claimed, outcome: "pass" }] }),
        {
          ledger: mcpLedger,
          gitLedger: makeGitLedger(),
          testInfra: { hasTestSuite: true, indicators: ["test/"] },
        },
      );
      assert.equal(res.verdict, "PASS", `expected PASS for claim ${claimed}`);
      assert.deepEqual(res.blockedRules, []);
    }
  });

  it("blocks with R3_CONCEALED_FAILURE when mcp_agy-fast_fast_run_checks fails and resolves when rerun passes", () => {
    const failedRun = decideGate(
      makeInput({ verification_runs: [{ command: "node --test", outcome: "pass" }] }),
      {
        ledger: makeLedger({
          turnExecutions: [
            {
              stepIndex: 5,
              toolName: "mcp_agy-fast_fast_run_checks",
              command: "node --test && npm run lint",
              subCommands: ["node --test", "npm run lint"],
              checkLabels: ["unit", "lint"],
              kind: "verification",
              passed: false,
              status: "DONE",
              error: "",
              tail: "Checks: 1/2 passed, 1 failed (wall: 500ms)",
            },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(failedRun.verdict, "REJECT");
    assert.deepEqual(failedRun.blockedRules, ["R3_CONCEALED_FAILURE"]);

    const resolvedRun = decideGate(
      makeInput({
        verification_runs: [
          { command: "node --test", outcome: "pass" },
          { command: "npm run lint", outcome: "pass" },
        ],
      }),
      {
        ledger: makeLedger({
          turnExecutions: [
            {
              stepIndex: 5,
              toolName: "mcp_agy-fast_fast_run_checks",
              command: "node --test && npm run lint",
              subCommands: ["node --test", "npm run lint"],
              checkLabels: ["unit", "lint"],
              kind: "verification",
              passed: false,
            },
            {
              stepIndex: 7,
              toolName: "mcp_agy-fast_fast_run_checks",
              command: "node --test && npm run lint",
              subCommands: ["node --test", "npm run lint"],
              checkLabels: ["unit", "lint"],
              kind: "verification",
              passed: true,
            },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(resolvedRun.verdict, "PASS");
    assert.deepEqual(resolvedRun.blockedRules, []);
  });

  it("blocks with R5_FABRICATED_COMMAND when claiming an unrelated command not present in mcp_agy-fast_fast_run_checks", () => {
    const res = decideGate(
      makeInput({ verification_runs: [{ command: "npm run e2e", outcome: "pass" }] }),
      {
        ledger: makeLedger({
          turnExecutions: [
            {
              stepIndex: 5,
              toolName: "mcp_agy-fast_fast_run_checks",
              command: "node --test",
              subCommands: ["node --test"],
              checkLabels: ["unit"],
              kind: "verification",
              passed: true,
            },
          ],
        }),
        gitLedger: makeGitLedger(),
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(res.verdict, "REJECT");
    assert.deepEqual(res.blockedRules, ["R5_FABRICATED_COMMAND"]);
    assert.deepEqual(res.details.fabricatedCommands, ["npm run e2e"]);
  });

  it("evaluates end-to-end transcript with edit_file -> mcp_agy-fast_fast_run_checks (fail via header/ERROR -> R3, pass -> PASS)", async () => {
    const { readFactLedger } = await import("../scripts/governance/fact-ledger.mjs");
    const { toJsonl } = await import("./helpers.mjs");
    const dir = createTempDir("hstack-mcp-e2e-");

    const failPath = join(dir, "fail.jsonl");
    writeFileSync(
      failPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "수정하고 검증해 줘" },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file", args: { Path: "/repo/src/app.mjs" } }] },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "export const a = 1;" },
        { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/app.mjs" } }] },
        { step_index: 4, type: "GENERIC", status: "DONE", content: "ok" },
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "mcp_agy-fast_fast_run_checks",
              args: { commands: [{ name: "lint", command: "npm run lint" }, { name: "unit", command: "node --test" }] },
            },
          ],
        },
        {
          step_index: 6,
          type: "GENERIC",
          status: "DONE",
          content: `Checks: 1/2 passed, 1 failed (wall: 500ms)\n## [FAIL] lint (50ms)\nerror\n## [PASS] unit (450ms)\n${"ok\n".repeat(1200)}`,
        },
      ]),
      "utf8",
    );
    const failLedger = readFactLedger(failPath, "/repo", "/repo");
    const failDecision = decideGate(
      makeInput({ verification_runs: [{ command: "node --test", outcome: "pass" }] }),
      { ledger: failLedger, gitLedger: makeGitLedger(), testInfra: { hasTestSuite: true, indicators: ["test/"] } },
    );
    assert.equal(failDecision.verdict, "REJECT");
    assert.deepEqual(failDecision.blockedRules, ["R3_CONCEALED_FAILURE"]);

    const passPath = join(dir, "pass.jsonl");
    writeFileSync(
      passPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "수정하고 검증해 줘" },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file", args: { Path: "/repo/src/app.mjs" } }] },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "export const a = 1;" },
        { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/app.mjs" } }] },
        { step_index: 4, type: "GENERIC", status: "DONE", content: "ok" },
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "mcp_agy-fast_fast_run_checks",
              args: { commands: [{ name: "unit", command: "node --test" }] },
            },
          ],
        },
        { step_index: 6, type: "GENERIC", status: "DONE", content: "Checks: 1/1 passed (wall: 300ms)\n## [PASS] unit (300ms)\n" },
      ]),
      "utf8",
    );
    const passLedger = readFactLedger(passPath, "/repo", "/repo");
    const passDecision = decideGate(
      makeInput({ verification_runs: [{ command: "mcp_agy-fast_fast_run_checks", outcome: "pass" }] }),
      { ledger: passLedger, gitLedger: makeGitLedger(), testInfra: { hasTestSuite: true, indicators: ["test/"] } },
    );
    assert.equal(passDecision.verdict, "PASS");
    assert.deepEqual(passDecision.blockedRules, []);
  });
});
