import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import { GATE_TOOL_NAME, VERDICT_HEADERS, isExemptDocOrAssetPath } from "../scripts/governance/constants.mjs";
import {
  classifyCommand,
  detectTestInfrastructure,
  extractMcpCheckCommands,
  extractToolPaths,
  inferExecutionFailure,
  normalizeWorkspacePath,
  readFactLedger,
  readGitLedger,
} from "../scripts/governance/fact-ledger.mjs";
import { resolvePluginDataDir, streamTranscriptRecords } from "../scripts/hook-io.mjs";
import { GATE_STOP_MARKER } from "../scripts/transcript/markers.mjs";
import { createTempDir, toJsonl } from "./helpers.mjs";

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("resolvePluginDataDir and streamTranscriptRecords", () => {
  it("resolves PLUGIN_DATA > HSTACK_DATA_DIR > tmpdir fallback", () => {
    const prevPlugin = process.env.PLUGIN_DATA;
    const prevHstack = process.env.HSTACK_DATA_DIR;
    try {
      delete process.env.PLUGIN_DATA;
      delete process.env.HSTACK_DATA_DIR;
      assert.ok(resolvePluginDataDir().endsWith("hstack-data"));

      process.env.HSTACK_DATA_DIR = "  /tmp/custom-hstack-dir  ";
      assert.equal(resolvePluginDataDir(), "/tmp/custom-hstack-dir");

      process.env.PLUGIN_DATA = "  /tmp/custom-plugin-data  ";
      assert.equal(resolvePluginDataDir(), "/tmp/custom-plugin-data");

      process.env.PLUGIN_DATA = "   ";
      assert.equal(resolvePluginDataDir(), "/tmp/custom-hstack-dir");
    } finally {
      if (prevPlugin === undefined) delete process.env.PLUGIN_DATA;
      else process.env.PLUGIN_DATA = prevPlugin;
      if (prevHstack === undefined) delete process.env.HSTACK_DATA_DIR;
      else process.env.HSTACK_DATA_DIR = prevHstack;
    }
  });

  it("skips huge lines without buffering when peek returns false while keeping exact validRecordCount", () => {
    const dir = createTempDir("hstack-stream-");
    const filePath = join(dir, "transcript_full.jsonl");
    const bigGeneric = { step_index: 1, type: "GENERIC", content: "A".repeat(400_000) };
    const shortGeneric = { step_index: 2, type: "GENERIC", content: "ok" };
    const planner = { step_index: 3, type: "PLANNER_RESPONSE", thinking: "한국어 추론", content: "한국어 답변" };
    writeFileSync(
      filePath,
      `\uFEFF${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "확인해 줘" })}\n${JSON.stringify(bigGeneric)}\n{corrupt-json\n${JSON.stringify(shortGeneric)}\n${JSON.stringify(planner)}\n`,
      "utf8",
    );

    const delivered = [];
    const stats = streamTranscriptRecords(filePath, (prefixType, lineBuf, recordIndex) => {
      if (lineBuf === null) {
        return prefixType !== "GENERIC";
      }
      try {
        const parsed = JSON.parse(lineBuf.toString("utf8"));
        delivered.push({ prefixType, type: parsed.type, recordIndex });
        return true;
      } catch {
        return false;
      }
    });

    assert.equal(stats.hasContent, true);
    assert.equal(stats.validRecordCount, 4);
    assert.deepEqual(delivered, [
      { prefixType: "USER_INPUT", type: "USER_INPUT", recordIndex: 0 },
      { prefixType: "PLANNER_RESPONSE", type: "PLANNER_RESPONSE", recordIndex: 3 },
    ]);
  });
});

describe("normalizeWorkspacePath and doc/asset exemption", () => {
  it("normalizes slashes, dot prefixes, and absolute paths relative to gitRoot or cwd", () => {
    assert.equal(normalizeWorkspacePath("./src\\governance\\gate.mjs"), "src/governance/gate.mjs");
    assert.equal(normalizeWorkspacePath("/repo/src/a.mjs", "/repo/sub", "/repo"), "src/a.mjs");
    assert.equal(normalizeWorkspacePath("a.mjs", "/repo/sub", "/repo"), "sub/a.mjs");
    assert.equal(normalizeWorkspacePath("/work/file.mjs", "/work", ""), "file.mjs");
    assert.equal(normalizeWorkspacePath("C:\\repo\\src\\app.mjs", "C:\\repo", "C:\\repo"), "src/app.mjs");
    assert.equal(normalizeWorkspacePath("   "), "");
    assert.equal(normalizeWorkspacePath(null), "");
  });

  it("identifies exempt docs, assets, and LICENSE paths", () => {
    assert.equal(isExemptDocOrAssetPath("README.md"), true);
    assert.equal(isExemptDocOrAssetPath("docs/architecture/design.txt"), true);
    assert.equal(isExemptDocOrAssetPath("docs/spec.json"), true);
    assert.equal(isExemptDocOrAssetPath("assets/logo.SVG"), true);
    assert.equal(isExemptDocOrAssetPath("LICENSE"), true);
    assert.equal(isExemptDocOrAssetPath("scripts/governance/decide-gate.mjs"), false);
    assert.equal(isExemptDocOrAssetPath("package.json"), false);
  });
});

describe("classifyCommand and inferExecutionFailure", () => {
  it("classifies read-only commands, chained verification runs, and git global options", () => {
    assert.equal(classifyCommand("git status"), "read_only");
    assert.equal(classifyCommand("git -C repo --no-pager diff --stat"), "read_only");
    assert.equal(classifyCommand("ls -la && pwd | head -n 5"), "read_only");
    assert.equal(classifyCommand("npm test"), "verification");
    assert.equal(classifyCommand("git status && node --test"), "verification");
    assert.equal(classifyCommand("cd packages/core && pytest -q"), "verification");
    assert.equal(classifyCommand("NODE_ENV=test ./scripts/check.sh"), "verification");
    assert.equal(classifyCommand('echo "a && node --test"'), "read_only");
  });

  it("detects failures without false-triggering on node --test zero-failure TAP lines", () => {
    assert.equal(
      inferExecutionFailure({
        status: "DONE",
        error: "",
        tail: "ℹ tests 137\nℹ pass 137\nℹ fail 0\n",
      }),
      false,
    );
    assert.equal(inferExecutionFailure({ status: "ERROR", error: "", tail: "" }), true);
    assert.equal(inferExecutionFailure({ status: "DONE", error: "Command failed", tail: "" }), true);
    assert.equal(inferExecutionFailure({ status: "DONE", error: "", tail: "Process exited with exit code 1" }), true);
    assert.equal(inferExecutionFailure({ status: "DONE", error: "", tail: "AssertionError [ERR_ASSERTION]: 1 !== 2" }), true);
    assert.equal(inferExecutionFailure({ status: "DONE", error: "", tail: "  FAIL test/sample.test.mjs" }), true);
    assert.equal(inferExecutionFailure({ status: "DONE", error: "", tail: "ℹ fail 2" }), true);
  });
});

describe("extractToolPaths", () => {
  it("extracts paths from read, write, edit, and mcp_agy-fast_fast_apply_edits including stringified args", () => {
    assert.deepEqual(extractToolPaths({ name: "read_file", args: { Path: "/repo/src/a.mjs" } }, "/repo", "/repo"), {
      readPaths: ["src/a.mjs"],
      writePaths: [],
    });
    assert.deepEqual(extractToolPaths({ name: "write_file", args: { Path: "/repo/src/new.mjs" } }, "/repo", "/repo"), {
      readPaths: ["src/new.mjs"],
      writePaths: ["src/new.mjs"],
    });
    assert.deepEqual(
      extractToolPaths(
        {
          name: "mcp_agy-fast_fast_apply_edits",
          args: JSON.stringify({
            cwd: "/repo",
            edits: [
              { path: "src/edited.mjs", hunks: [{ target: "a", replacement: "b" }] },
              { path: "src/created.mjs", create: "export const x = 1;\n" },
            ],
          }),
        },
        "/repo",
        "/repo",
      ),
      {
        readPaths: ["src/created.mjs"],
        writePaths: ["src/edited.mjs", "src/created.mjs"],
      },
    );
  });
});

describe("readFactLedger performance and turn semantics", () => {
  it("scans a 5MB transcript with multiple 512KB read_file GENERIC lines within 100ms", () => {
    const dir = createTempDir("hstack-perf-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const halfMb = "X".repeat(512 * 1024);
    const records = [
      { step_index: 0, type: "USER_INPUT", content: "기능을 구현해 줘" },
    ];
    let stepIndex = 1;
    for (let i = 0; i < 10; i += 1) {
      records.push({
        step_index: stepIndex++,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "read_file", args: { Path: `/repo/src/file-${i}.mjs` } }],
      });
      records.push({
        step_index: stepIndex++,
        type: "GENERIC",
        status: "DONE",
        content: halfMb,
      });
    }
    records.push({
      step_index: stepIndex++,
      type: "PLANNER_RESPONSE",
      tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/file-0.mjs" } }],
    });
    records.push({ step_index: stepIndex++, type: "GENERIC", status: "DONE", content: "ok" });
    records.push({
      step_index: stepIndex++,
      type: "PLANNER_RESPONSE",
      usage: { input_tokens: 12000, cache_read_tokens: 8000, output_tokens: 450 },
      tool_calls: [{ name: "run_command", args: { CommandLine: "node --test" } }],
    });
    records.push({
      step_index: stepIndex++,
      type: "GENERIC",
      status: "DONE",
      content: `${"L".repeat(4096)}\nℹ tests 10\nℹ pass 10\nℹ fail 0\n`,
    });

    const payload = toJsonl(records);
    assert.ok(Buffer.byteLength(payload, "utf8") >= 5 * 1024 * 1024);
    writeFileSync(transcriptPath, payload, "utf8");

    const start = performance.now();
    const ledger = readFactLedger(transcriptPath, "/repo", "/repo");
    const elapsedMs = performance.now() - start;

    assert.equal(ledger.transcriptAvailable, true);
    assert.equal(ledger.sessionReadFiles.size, 10);
    assert.equal(ledger.turnWrittenFiles.has("src/file-0.mjs"), true);
    assert.equal(ledger.turnExecutions.length, 1);
    assert.equal(ledger.turnExecutions[0].kind, "verification");
    assert.equal(ledger.turnExecutions[0].passed, true);
    assert.ok(ledger.turnExecutions[0].tail.length <= 2048);
    assert.ok(ledger.turnExecutions[0].tail.includes("ℹ fail 0"));
    assert.deepEqual(ledger.latestTokens, { inputTokens: 12000, cacheReadTokens: 8000, outputTokens: 450 });
    assert.ok(elapsedMs <= 100, `5MB transcript scan took ${elapsedMs.toFixed(2)}ms (> 100ms)`);
  });

  it("resets turn-scoped facts on USER_INPUT while preserving cumulative sessionReadFiles and tracks gate attempts", () => {
    const dir = createTempDir("hstack-turns-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "첫 번째 요청" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            { name: "read_file", args: { Path: "/repo/src/shared.mjs" } },
            { name: "edit_file", args: { Path: "/repo/src/old.mjs" } },
          ],
        },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "shared content" },
        { step_index: 3, type: "GENERIC", status: "DONE", content: "edited old" },
        { step_index: 4, type: "USER_INPUT", content: "두 번째 요청" },
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            { name: "write_file", args: { Path: "/repo/src/new.mjs" } },
            { name: "edit_file", args: { Path: "/repo/README.md" } },
          ],
        },
        { step_index: 6, type: "GENERIC", status: "DONE", content: "created" },
        { step_index: 7, type: "GENERIC", status: "DONE", content: "updated readme" },
        {
          step_index: 8,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            { name: "read_file", args: { Path: "/repo/src/extra.mjs" } },
            { name: "run_command", args: { CommandLine: "npm test" } },
            { name: GATE_TOOL_NAME, args: {} },
          ],
        },
        { step_index: 9, type: "GENERIC", status: "DONE", content: "extra file contents" },
        { step_index: 10, type: "GENERIC", status: "DONE", content: "AssertionError: boom" },
        {
          step_index: 11,
          type: "GENERIC",
          status: "DONE",
          content: `A pre-tool hook changed the arguments.\n${VERDICT_HEADERS.REJECT_NEUTRAL}\n사유`,
        },
        { step_index: 12, type: "SYSTEM_MESSAGE", content: `${GATE_STOP_MARKER} 검증을 실행하세요.` },
      ]),
      "utf8",
    );

    const ledger = readFactLedger(transcriptPath, "/repo", "/repo");
    assert.equal(ledger.turnStartStepIndex, 4);
    assert.equal(ledger.sessionReadFiles.has("src/shared.mjs"), true);
    assert.equal(ledger.sessionReadFiles.has("src/new.mjs"), true);
    assert.equal(ledger.sessionReadFiles.has("src/extra.mjs"), true);
    assert.equal(ledger.turnWrittenFiles.has("src/old.mjs"), false);
    assert.equal(ledger.turnWrittenFiles.has("src/new.mjs"), true);
    assert.equal(ledger.turnWrittenFiles.has("README.md"), true);
    assert.equal(ledger.turnCodeWrittenFiles.has("README.md"), false);
    assert.equal(ledger.turnCodeWrittenFiles.has("src/new.mjs"), true);
    assert.equal(ledger.turnExecutions.length, 1);
    assert.equal(ledger.turnExecutions[0].passed, false);
    assert.equal(ledger.turnGateAttempts.length, 1);
    assert.equal(ledger.turnGateAttempts[0].verdict, "REJECT");
    assert.equal(ledger.turnGateAttempts[0].passed, false);
    assert.equal(ledger.gateBlockedThisTurn, true);
  });

  it("fails open when transcript is missing or empty", () => {
    const missing = readFactLedger("/tmp/definitely-does-not-exist-hstack.jsonl");
    assert.equal(missing.transcriptAvailable, false);
    assert.equal(missing.sessionReadFiles.size, 0);
  });
});

describe("readGitLedger and detectTestInfrastructure", () => {
  it("reads modified, untracked, and renamed files in a real git repo and fails open outside git", () => {
    const nonGitDir = createTempDir("hstack-nongit-");
    const nonGit = readGitLedger(nonGitDir);
    assert.equal(nonGit.gitAvailable, false);
    assert.equal(nonGit.gitRoot, null);
    assert.equal(nonGit.gitDirtyFiles.size, 0);

    const repoDir = createTempDir("hstack-git-");
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "keep.mjs"), "export const a = 1;\n", "utf8");
    writeFileSync(join(repoDir, "src", "old.mjs"), "export const b = 2;\n", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "initial"]);

    writeFileSync(join(repoDir, "src", "keep.mjs"), "export const a = 2;\n", "utf8");
    writeFileSync(join(repoDir, "src", "untracked.mjs"), "export const c = 3;\n", "utf8");
    renameSync(join(repoDir, "src", "old.mjs"), join(repoDir, "src", "moved.mjs"));
    runGit(repoDir, ["add", "-A", "src/old.mjs", "src/moved.mjs"]);

    const gitLedger = readGitLedger(join(repoDir, "src"));
    assert.equal(gitLedger.gitAvailable, true);
    assert.ok(gitLedger.gitRoot);
    assert.equal(gitLedger.gitDirtyFiles.has("src/keep.mjs"), true);
    assert.equal(gitLedger.gitDirtyFiles.has("src/untracked.mjs"), true);
    assert.equal(gitLedger.gitDirtyFiles.has("src/old.mjs"), true);
    assert.equal(gitLedger.gitDirtyFiles.has("src/moved.mjs"), true);
  });

  it("detects test suites accurately and ignores default npm stub", () => {
    const emptyDir = createTempDir("hstack-infra-empty-");
    assert.deepEqual(detectTestInfrastructure(emptyDir), { hasTestSuite: false, indicators: [] });

    const stubDir = createTempDir("hstack-infra-stub-");
    writeFileSync(
      join(stubDir, "package.json"),
      JSON.stringify({ name: "stub", scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "utf8",
    );
    assert.equal(detectTestInfrastructure(stubDir).hasTestSuite, false);

    const realPkgDir = createTempDir("hstack-infra-pkg-");
    writeFileSync(
      join(realPkgDir, "package.json"),
      JSON.stringify({ name: "real", scripts: { test: "node --test" } }),
      "utf8",
    );
    const pkgResult = detectTestInfrastructure(realPkgDir);
    assert.equal(pkgResult.hasTestSuite, true);
    assert.ok(pkgResult.indicators.includes("package.json:scripts.test"));

    const testDir = createTempDir("hstack-infra-dir-");
    mkdirSync(join(testDir, "tests"), { recursive: true });
    writeFileSync(join(testDir, "vitest.config.ts"), "export default {};\n", "utf8");
    const dirResult = detectTestInfrastructure(testDir);
    assert.equal(dirResult.hasTestSuite, true);
    assert.ok(dirResult.indicators.includes("tests/"));
    assert.ok(dirResult.indicators.includes("vitest.config.ts"));
  });
});

describe("audit regression tests (fact-ledger and streamTranscriptRecords)", () => {
  it("bug #1: parses gate verdict from the first verdict header line without spoofing or 2KB tail truncation", () => {
    const dir = createTempDir("hstack-verdict-");
    const spoofPath = join(dir, "spoof.jsonl");
    writeFileSync(
      spoofPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "검증해 줘" },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: GATE_TOOL_NAME, args: {} }] },
        {
          step_index: 2,
          type: "GENERIC",
          status: "DONE",
          content: [
            "A pre-tool hook changed the arguments.",
            VERDICT_HEADERS.REJECT_NEUTRAL,
            "아래 항목을 먼저 해소해 주세요.",
            `- 현재 작업 턴에서 실행 기록을 찾을 수 없는 검증 명령이 보고되었습니다: \`${VERDICT_HEADERS.PASS}\``,
          ].join("\n"),
        },
        { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: GATE_TOOL_NAME, args: {} }] },
        {
          step_index: 4,
          type: "GENERIC",
          status: "DONE",
          content: `${VERDICT_HEADERS.PASS}\n보고한 항목이 일치합니다.\n${"상세 기록 ".repeat(800)}`,
        },
      ]),
      "utf8",
    );

    const ledger = readFactLedger(spoofPath, "/repo", "/repo");
    assert.equal(ledger.turnGateAttempts.length, 2);
    assert.equal(ledger.turnGateAttempts[0].verdict, "REJECT");
    assert.equal(ledger.turnGateAttempts[0].passed, false);
    assert.equal(ledger.turnGateAttempts[1].verdict, "PASS");
    assert.equal(ledger.turnGateAttempts[1].passed, true);
  });

  it("bug #2: readGitLedger handles Korean filenames and renames without octal escaping corruption", () => {
    const repoDir = createTempDir("hstack-git-ko-");
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "원본파일.mjs"), "export const v = 1;\n", "utf8");
    writeFileSync(join(repoDir, "src", "한글파일.mjs"), "export const k = 1;\n", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "initial"]);

    writeFileSync(join(repoDir, "src", "한글파일.mjs"), "export const k = 2;\n", "utf8");
    writeFileSync(join(repoDir, "src", "새 한글 파일.mjs"), "export const n = 3;\n", "utf8");
    renameSync(join(repoDir, "src", "원본파일.mjs"), join(repoDir, "src", "이동된파일.mjs"));
    runGit(repoDir, ["add", "-A", "src/원본파일.mjs", "src/이동된파일.mjs"]);

    const gitLedger = readGitLedger(repoDir);
    assert.equal(gitLedger.gitAvailable, true);
    assert.equal(gitLedger.gitDirtyFiles.has("src/한글파일.mjs"), true);
    assert.equal(gitLedger.gitDirtyFiles.has("src/새 한글 파일.mjs"), true);
    assert.equal(gitLedger.gitDirtyFiles.has("src/원본파일.mjs"), true);
    assert.equal(gitLedger.gitDirtyFiles.has("src/이동된파일.mjs"), true);
  });

  it("bug #6: inferExecutionFailure ignores TAP passing test names mentioning AssertionError or Command failed", () => {
    assert.equal(
      inferExecutionFailure({
        status: "DONE",
        error: "",
        tail: [
          "ok 1 - throws AssertionError when input is invalid",
          "ok 2 - handles Command failed gracefully",
          "✔ parses AssertionError output",
          "ℹ tests 3",
          "ℹ pass 3",
          "ℹ fail 0",
        ].join("\n"),
      }),
      false,
    );
    assert.equal(
      inferExecutionFailure({
        status: "DONE",
        error: "",
        tail: "ok 1 - passes\nAssertionError [ERR_ASSERTION]: expected true",
      }),
      true,
    );
  });

  it("bug #7: normalizeWorkspacePath resolves ../ relative paths from subdirectory cwd", () => {
    assert.equal(normalizeWorkspacePath("../other/file.js", "/repo/sub", "/repo"), "other/file.js");
    assert.equal(normalizeWorkspacePath("a.mjs", "/repo/sub", "/repo"), "sub/a.mjs");

    const repoDir = createTempDir("hstack-norm-");
    mkdirSync(join(repoDir, "sub"), { recursive: true });
    mkdirSync(join(repoDir, "other"), { recursive: true });
    writeFileSync(join(repoDir, "sub", "a.js"), "export const a = 1;\n", "utf8");
    writeFileSync(join(repoDir, "other", "file.js"), "export const b = 2;\n", "utf8");

    assert.equal(normalizeWorkspacePath("sub/a.js", join(repoDir, "sub"), repoDir), "sub/a.js");
    assert.equal(normalizeWorkspacePath("../other/file.js", join(repoDir, "sub"), repoDir), "other/file.js");
  });

  it("bug #8: corrupt GENERIC lines do not shift pendingCalls and skipped prefixType===null valid JSON counts toward validRecordCount", () => {
    const dir = createTempDir("hstack-corrupt-");
    const transcriptPath = join(dir, "corrupt-generic.jsonl");
    const lines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "테스트 실행해 줘" }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "read_file", args: { Path: "/repo/src/a.mjs" } },
          { name: "run_command", args: { CommandLine: "node --test" } },
        ],
      }),
      '{"type":"GENERIC","content":"broken-truncated-line',
      JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "file content" }),
      JSON.stringify({ step_index: 3, type: "GENERIC", status: "ERROR", error: "test failed", content: "exit code 1" }),
    ];
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");

    const ledger = readFactLedger(transcriptPath, "/repo", "/repo");
    assert.equal(ledger.turnExecutions.length, 1);
    assert.equal(ledger.turnExecutions[0].passed, false);
    assert.equal(ledger.turnExecutions[0].status, "ERROR");

    const streamPath = join(dir, "null-prefix.jsonl");
    writeFileSync(
      streamPath,
      [
        JSON.stringify({ payload: "no-type-field-short" }),
        JSON.stringify({ payload: "B".repeat(400) }),
        JSON.stringify({ step_index: 2, type: "USER_INPUT", content: "확인" }),
      ].join("\n") + "\n",
      "utf8",
    );
    const seen = [];
    const stats = streamTranscriptRecords(streamPath, (prefixType, lineBuf, recordIndex) => {
      if (lineBuf === null) {
        return prefixType === "USER_INPUT";
      }
      seen.push({ prefixType, recordIndex });
      return true;
    });
    assert.equal(stats.validRecordCount, 3);
    assert.deepEqual(seen, [{ prefixType: "USER_INPUT", recordIndex: 2 }]);
  });

  it("bug #9: classifyCommand handles wrapper flags and non-read-only shell redirections", () => {
    assert.equal(classifyCommand("env -u NODE_OPTIONS node --test"), "verification");
    assert.equal(classifyCommand("env -i PATH=/usr/bin pytest -q"), "verification");
    assert.equal(classifyCommand("sudo -E npm test"), "verification");
    assert.equal(classifyCommand("sudo -u runner cargo test"), "verification");
    assert.equal(classifyCommand("time -p go test ./..."), "verification");
    assert.equal(classifyCommand("command -p node --test"), "verification");
    assert.equal(classifyCommand("echo hello > out.txt"), "other");
    assert.equal(classifyCommand("cat src/a.mjs >> out.txt"), "other");
    assert.equal(classifyCommand("git status 2>&1"), "read_only");
    assert.equal(classifyCommand("ls -la 2>/dev/null"), "read_only");
    assert.equal(classifyCommand('echo "a > b"'), "read_only");
  });
});

describe("Patch B: agy-fast mcp_agy-fast_fast_run_checks ledger recognition", () => {
  it("extracts commands and check labels from object, stringified JSON, checks fallback, and single command", () => {
    assert.deepEqual(
      extractMcpCheckCommands({
        name: "mcp_agy-fast_fast_run_checks",
        args: {
          cwd: "/repo",
          commands: [
            { name: "unit", command: "node --test test/app.test.mjs" },
            { name: "lint", command: "npm run lint" },
          ],
        },
      }),
      {
        commands: ["node --test test/app.test.mjs", "npm run lint"],
        labels: ["unit", "lint"],
      },
    );

    assert.deepEqual(
      extractMcpCheckCommands({
        name: "mcp_agy-fast_fast_run_checks",
        args: JSON.stringify({ checks: ["pytest -q", { label: "typecheck", command: "tsc --noEmit" }] }),
      }),
      {
        commands: ["pytest -q", "tsc --noEmit"],
        labels: ["typecheck"],
      },
    );

    assert.deepEqual(
      extractMcpCheckCommands({
        name: "mcp_agy-fast_fast_run_checks",
        args: { command: "cargo test" },
      }),
      {
        commands: ["cargo test"],
        labels: [],
      },
    );
  });

  it("tracks mcp_agy-fast_fast_run_checks GENERIC results for pass, head-truncated fail, FAIL block, ERROR status, and read-only checks", () => {
    const dir = createTempDir("hstack-run-checks-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const longPassingLog = `${"ok line\n".repeat(400)}ℹ tests 5\nℹ pass 5\nℹ fail 0\n`;

    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "수정 후 검증해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/app.mjs" } }],
        },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "ok" },
        {
          step_index: 3,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "mcp_agy-fast_fast_run_checks",
              args: {
                cwd: "/repo",
                commands: [
                  { name: "unit", command: "node --test" },
                  { name: "validate", command: "agy plugin validate --strict --json ." },
                ],
              },
            },
          ],
        },
        {
          step_index: 4,
          type: "GENERIC",
          status: "DONE",
          content: `Checks: 2/2 passed (wall: 450ms)\n## [PASS] unit (220ms)\n${longPassingLog}## [PASS] validate (230ms)\nvalid`,
        },
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "mcp_agy-fast_fast_run_checks",
              args: {
                commands: [
                  { name: "lint", command: "npm run lint" },
                  { name: "unit", command: "node --test" },
                ],
              },
            },
          ],
        },
        {
          step_index: 6,
          type: "GENERIC",
          status: "DONE",
          content: `Checks: 1/2 passed, 1 failed (wall: 600ms)\n## [FAIL] lint (120ms)\nlint error\n## [PASS] unit (480ms)\n${longPassingLog}`,
        },
        {
          step_index: 7,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "mcp_agy-fast_fast_run_checks",
              args: {
                commands: [{ name: "slow", command: "npm run check" }],
              },
            },
          ],
        },
        {
          step_index: 8,
          type: "GENERIC",
          status: "DONE",
          content: `Checks: 0/1 passed, 1 not run (call time budget exceeded)\n## [NOT RUN] slow\n`,
        },
        {
          step_index: 9,
          type: "PLANNER_RESPONSE",
          tool_calls: [
            {
              name: "mcp_agy-fast_fast_run_checks",
              args: {
                commands: [{ name: "status", command: "git status" }],
              },
            },
          ],
        },
        {
          step_index: 10,
          type: "GENERIC",
          status: "ERROR",
          error: "MCP tool error",
          content: "",
        },
      ]),
      "utf8",
    );

    const ledger = readFactLedger(transcriptPath, "/repo", "/repo");
    assert.equal(ledger.turnExecutions.length, 4);

    assert.equal(ledger.turnExecutions[0].toolName, "mcp_agy-fast_fast_run_checks");
    assert.equal(ledger.turnExecutions[0].kind, "verification");
    assert.equal(ledger.turnExecutions[0].passed, true);
    assert.deepEqual(ledger.turnExecutions[0].subCommands, ["node --test", "agy plugin validate --strict --json ."]);
    assert.deepEqual(ledger.turnExecutions[0].checkLabels, ["unit", "validate"]);

    assert.equal(ledger.turnExecutions[1].kind, "verification");
    assert.equal(ledger.turnExecutions[1].passed, false);

    assert.equal(ledger.turnExecutions[2].kind, "verification");
    assert.equal(ledger.turnExecutions[2].passed, false);

    assert.equal(ledger.turnExecutions[3].kind, "read_only");
    assert.equal(ledger.turnExecutions[3].passed, false);
  });

  it("inferExecutionFailure distinguishes passing run_checks headers from failed or not-run headers", () => {
    assert.equal(
      inferExecutionFailure({
        status: "DONE",
        error: "",
        head: "Checks: 2/2 passed (wall: 450ms)\n## [PASS] unit (200ms)\n",
        tail: "AssertionError mentioned inside passing test title\n",
      }),
      false,
    );
    assert.equal(
      inferExecutionFailure({
        status: "DONE",
        error: "",
        head: "Checks: 1/2 passed, 1 failed (wall: 500ms)\n",
        tail: "ℹ tests 10\nℹ pass 10\nℹ fail 0\n",
      }),
      true,
    );
    assert.equal(
      inferExecutionFailure({
        status: "DONE",
        error: "",
        head: "",
        tail: "## [FAIL] lint (90ms)\nerror found\n",
      }),
      true,
    );
  });
});
