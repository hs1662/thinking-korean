import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { analyzeField } from "../scripts/analyzer.mjs";
import { GATE_TOOL_NAME, VERDICT_HEADERS } from "../scripts/governance/constants.mjs";
import { decideGate } from "../scripts/governance/decide-gate.mjs";
import { normalizeWorkspacePath } from "../scripts/governance/fact-ledger.mjs";
import { createMcpServerHandler } from "../scripts/mcp/server.mjs";
import { handlePreToolGate } from "../scripts/pre-tool-gate.mjs";
import { DRIFT_MARKER, GATE_STOP_MARKER, parseDriftMarkerStep } from "../scripts/transcript.mjs";
import {
  HOOKS_JSON_PATH,
  HOOK_SCRIPT,
  PLUGIN_ROOT,
  STOP_HOOK_SCRIPT,
  createTempDir,
  runHookSubprocess,
  toJsonl,
  wrapAntigravityHookMessage,
} from "./helpers.mjs";

const PRE_TOOL_GATE_SCRIPT = join(PLUGIN_ROOT, "scripts", "pre-tool-gate.mjs");
const MCP_SERVER_SCRIPT = join(PLUGIN_ROOT, "scripts", "mcp", "server.mjs");

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initTempGitRepo(prefix = "hstack-hooks-repo-") {
  const repoDir = createTempDir(prefix);
  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.email", "test@example.com"]);
  runGit(repoDir, ["config", "user.name", "Test User"]);
  mkdirSync(join(repoDir, "src"), { recursive: true });
  mkdirSync(join(repoDir, "test"), { recursive: true });
  writeFileSync(join(repoDir, "src", "app.mjs"), "export const answer = 42;\n", "utf8");
  writeFileSync(join(repoDir, "test", "app.test.mjs"), "import assert from 'node:assert/strict'; assert.equal(1, 1);\n", "utf8");
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "initial"]);
  return repoDir;
}

function createMcpClient(envOverrides = {}) {
  const child = spawn(process.execPath, [MCP_SERVER_SCRIPT], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, ...envOverrides },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrText = "";
  const pending = new Map();

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrText += chunk;
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    let nlIdx = stdoutBuffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = stdoutBuffer.slice(0, nlIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
      if (line.length > 0) {
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
      nlIdx = stdoutBuffer.indexOf("\n");
    }
  });

  let nextId = 1;

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (stderr=${stderrText})`));
      }, 5000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`);
  }

  async function close() {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
      } else {
        child.once("close", resolve);
      }
    });
    return { exitCode: child.exitCode, stderrText };
  }

  return { request, notify, close };
}

describe("hooks.json PreToolUse matcher contract", () => {
  it("registers both narrow PreToolUse matchers for UI checks and hstack MCP gate", () => {
    const hooks = JSON.parse(readFileSync(HOOKS_JSON_PATH, "utf8"));
    const preToolEntries = Object.values(hooks).flatMap((group) => group.PreToolUse ?? []);

    const uiEntries = preToolEntries.filter((entry) =>
      entry.hooks.some((hook) => hook.command.includes("scripts/pre-tool-use.mjs")),
    );
    const gateEntries = preToolEntries.filter((entry) =>
      entry.hooks.some((hook) => hook.command.includes("scripts/pre-tool-gate.mjs")),
    );

    assert.equal(uiEntries.length, 1);
    assert.equal(gateEntries.length, 1);
    assert.equal(gateEntries[0].matcher, "^(mcp_hstack_.*|invoke_subagent)$");
    assert.equal(gateEntries[0].hooks[0].type, "command");
    assert.equal(gateEntries[0].hooks[0].command, "node ./scripts/pre-tool-gate.mjs");
  });
});

describe("pre-tool-gate.mjs subprocess contract", () => {
  it("auto-approves mcp_hstack_gate_verify_completion, prefers sibling transcript_full.jsonl, and injects _session + toolSummary", () => {
    const dir = createTempDir("hstack-pregate-");
    const compactPath = join(dir, "transcript.jsonl");
    const fullPath = join(dir, "transcript_full.jsonl");
    writeFileSync(compactPath, "", "utf8");
    writeFileSync(fullPath, `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "작업해 줘" })}\n`, "utf8");

    const proc = runHookSubprocess(
      PRE_TOOL_GATE_SCRIPT,
      JSON.stringify({
        hookEventName: "PreToolUse",
        conversationId: "conv-123",
        transcriptPath: compactPath,
        cwd: dir,
        toolCall: { name: GATE_TOOL_NAME, args: {} },
      }),
    );

    assert.equal(proc.status, 0);
    assert.equal(proc.stderr, "");
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.decision, "auto_approve");
    assert.equal(parsed.overwrite.toolSummary, "증거 기반 완료 검증 실행");
    assert.deepEqual(parsed.overwrite._session, {
      conversationId: "conv-123",
      transcriptPath: fullPath,
      cwd: dir,
    });
  });

  it("allows non-matching tools and fails open on corrupt stdin", () => {
    for (const input of [
      JSON.stringify({ hookEventName: "PreToolUse", toolCall: { name: "update_steps", args: {} } }),
      JSON.stringify({ hookEventName: "PreToolUse", toolCall: { name: "read_file", args: { Path: "README.md" } } }),
      "{corrupt-json",
      "",
    ]) {
      const proc = runHookSubprocess(PRE_TOOL_GATE_SCRIPT, input);
      assert.equal(proc.status, 0);
      assert.equal(proc.stderr, "");
      assert.deepEqual(JSON.parse(proc.stdout), { decision: "allow" });
    }
    assert.deepEqual(handlePreToolGate("{broken"), { decision: "allow" });
  });
});

describe("scripts/mcp/server.mjs stdio JSON-RPC roundtrip", () => {
  it("serves verify_completion schema without _session/toolSummary, rejects unverified edits, passes after verification, and logs audit.jsonl", async () => {
    const dataDir = createTempDir("hstack-mcp-data-");
    const repoDir = initTempGitRepo("hstack-mcp-repo-");
    const transcriptDir = createTempDir("hstack-mcp-tr-");
    const transcriptPath = join(transcriptDir, "transcript_full.jsonl");

    writeFileSync(join(repoDir, "src", "app.mjs"), "export const answer = 43;\n", "utf8");
    const baseRecords = [
      { step_index: 0, type: "USER_INPUT", content: "src/app.mjs를 수정하고 검증해 줘" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        usage: { input_tokens: 4200, cache_read_tokens: 3000, output_tokens: 180 },
        tool_calls: [{ name: "read_file", args: { Path: join(repoDir, "src", "app.mjs") } }],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "export const answer = 42;" },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        tool_calls: [{ name: "edit_file", args: { Path: join(repoDir, "src", "app.mjs") } }],
      },
      { step_index: 4, type: "GENERIC", status: "DONE", content: "edited" },
    ];
    writeFileSync(transcriptPath, toJsonl(baseRecords), "utf8");

    const client = createMcpClient({ PLUGIN_DATA: dataDir, HSTACK_SCHEMA_REGISTER: "neutral" });
    try {
      const initRes = await client.request("initialize", { protocolVersion: "2024-11-05" });
      assert.equal(initRes.result.protocolVersion, "2024-11-05");
      assert.equal(initRes.result.serverInfo.name, "hstack-gate");
      client.notify("notifications/initialized");

      const pingRes = await client.request("ping");
      assert.deepEqual(pingRes.result, {});

      const listRes = await client.request("tools/list");
      assert.equal(listRes.result.tools.length, 2);
      const tool = listRes.result.tools.find((t) => t.name === "verify_completion");
      const handoffTool = listRes.result.tools.find((t) => t.name === "manage_handoff");
      assert.ok(tool);
      assert.ok(handoffTool);
      for (const candidate of [tool, handoffTool]) {
        assert.equal(candidate.inputSchema.additionalProperties, false);
        assert.equal("_session" in candidate.inputSchema.properties, false);
        assert.equal("toolSummary" in candidate.inputSchema.properties, false);
        assert.equal(candidate.inputSchema.required.includes("_session"), false);
        assert.equal(candidate.inputSchema.required.includes("toolSummary"), false);
        assert.equal(analyzeField("content", candidate.description).status, "korean");
        for (const prop of Object.values(candidate.inputSchema.properties)) {
          assert.equal(analyzeField("content", prop.description).status, "korean");
        }
      }

      const rejectRes = await client.request("tools/call", {
        name: "verify_completion",
        arguments: {
          modified_files: ["src/app.mjs"],
          inspected_files: ["src/app.mjs"],
          verification_runs: [],
          unverified_scope: [],
          self_assessment: "수정을 마쳤습니다.",
          toolSummary: "증거 기반 완료 검증 실행",
          _session: { conversationId: "conv-mcp-1", transcriptPath, cwd: repoDir },
        },
      });
      assert.equal(rejectRes.result.isError, false);
      const rejectText = rejectRes.result.content[0].text;
      assert.ok(rejectText.startsWith(VERDICT_HEADERS.REJECT_NEUTRAL));

      const afterVerifyRecords = [
        ...baseRecords,
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: GATE_TOOL_NAME, args: {} }],
        },
        { step_index: 6, type: "GENERIC", status: "DONE", content: rejectText },
        {
          step_index: 7,
          type: "PLANNER_RESPONSE",
          usage: { input_tokens: 5100, cache_read_tokens: 4000, output_tokens: 210 },
          tool_calls: [{ name: "run_command", args: { CommandLine: "node --test test/app.test.mjs" } }],
        },
        { step_index: 8, type: "GENERIC", status: "DONE", content: "ℹ tests 1\nℹ pass 1\nℹ fail 0\n" },
        {
          step_index: 9,
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: GATE_TOOL_NAME, args: {} }],
        },
      ];
      writeFileSync(transcriptPath, toJsonl(afterVerifyRecords), "utf8");

      const passRes = await client.request("tools/call", {
        name: "verify_completion",
        arguments: {
          modified_files: ["src/app.mjs"],
          inspected_files: ["src/app.mjs"],
          verification_runs: [{ command: "node --test test/app.test.mjs", outcome: "pass" }],
          unverified_scope: ["없음 (모든 수정 파일 단위 테스트 완료)"],
          self_assessment: "수정 사항과 단위 테스트 통과 결과를 직접 확인했습니다.",
          toolSummary: "증거 기반 완료 검증 실행",
          _session: { conversationId: "conv-mcp-1", transcriptPath, cwd: repoDir },
        },
      });
      assert.equal(passRes.result.isError, false);
      const passText = passRes.result.content[0].text;
      assert.ok(passText.startsWith(VERDICT_HEADERS.PASS));

      const skippedRes = await client.request("tools/call", {
        name: "verify_completion",
        arguments: {
          modified_files: ["src/app.mjs"],
          inspected_files: ["src/app.mjs"],
          verification_runs: [],
          unverified_scope: [],
          self_assessment: "세션 없이 호출했습니다.",
        },
      });
      assert.equal(skippedRes.result.isError, false);
      assert.ok(skippedRes.result.content[0].text.startsWith(VERDICT_HEADERS.SKIPPED_NO_SESSION));

      const badArgsRes = await client.request("tools/call", {
        name: "verify_completion",
        arguments: {
          modified_files: "not-an-array",
          inspected_files: [],
          verification_runs: [],
          unverified_scope: [],
          self_assessment: "잘못된 형식 테스트입니다.",
          extra_unexpected: true,
        },
      });
      assert.equal(badArgsRes.result.isError, false);
      assert.ok(badArgsRes.result.content[0].text.startsWith(VERDICT_HEADERS.REJECT_NEUTRAL));
    } finally {
      const { exitCode, stderrText } = await client.close();
      assert.equal(exitCode, 0);
      assert.equal(stderrText, "");
    }

    const auditLines = readFileSync(join(dataDir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(auditLines.length, 3);
    assert.equal(auditLines[0].event, "gate_verify");
    assert.equal(auditLines[0].sessionRole, "main");
    assert.equal(auditLines[0].verdict, "REJECT");
    assert.deepEqual(auditLines[0].blockedRules, ["R2_STALE_VERIFICATION"]);
    assert.equal(auditLines[0].attemptInTurn, 1);

    assert.equal(auditLines[1].verdict, "PASS");
    assert.equal(auditLines[1].sessionRole, "main");
    assert.equal(auditLines[1].attemptInTurn, 2);
    assert.equal(auditLines[1].metrics.inputTokens, 5100);
    assert.equal(auditLines[1].metrics.cacheReadTokens, 4000);
    assert.equal(auditLines[1].metrics.unverifiedScopeCount, 0);
    assert.equal(auditLines[1].metrics.fillerUnverifiedCount, 1);

    assert.equal(auditLines[2].verdict, "SKIPPED_NO_SESSION");
    assert.equal(auditLines[2].metrics.unverifiedScopeCount, 0);
    assert.equal(auditLines[2].metrics.fillerUnverifiedCount, 0);
  });

  it("honors HSTACK_SCHEMA_REGISTER=audit with [감사 기각] header", async () => {
    const dataDir = createTempDir("hstack-mcp-audit-");
    const repoDir = initTempGitRepo("hstack-mcp-audit-repo-");
    const transcriptPath = join(createTempDir("hstack-mcp-audit-tr-"), "transcript_full.jsonl");
    writeFileSync(join(repoDir, "src", "app.mjs"), "export const answer = 99;\n", "utf8");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "수정해 줘" },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "edit_file", args: { Path: join(repoDir, "src", "app.mjs") } }] },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "ok" },
      ]),
      "utf8",
    );

    const client = createMcpClient({ PLUGIN_DATA: dataDir, HSTACK_SCHEMA_REGISTER: "audit" });
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05" });
      const res = await client.request("tools/call", {
        name: "verify_completion",
        arguments: {
          modified_files: ["src/app.mjs"],
          inspected_files: [],
          verification_runs: [],
          unverified_scope: [],
          self_assessment: "수정을 마쳤습니다.",
          _session: { conversationId: "conv-audit", transcriptPath, cwd: repoDir },
        },
      });
      assert.equal(res.result.isError, false);
      assert.ok(res.result.content[0].text.startsWith(VERDICT_HEADERS.REJECT_AUDIT));
    } finally {
      const { exitCode } = await client.close();
      assert.equal(exitCode, 0);
    }
  });
});

describe("unified stop.mjs orchestrator with continuationActive: false", () => {
  it("blocks gate-only violation once and allows subsequent stop after marker appears in transcript", () => {
    const dataDir = createTempDir("hstack-stop-data-");
    const dir = createTempDir("hstack-stop-gate-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const baseRecords = [
      { step_index: 0, type: "USER_INPUT", content: "src/app.mjs를 수정해 줘" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        thinking: "먼저 대상 파일을 수정한다.",
        tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/app.mjs" } }],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "ok" },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        thinking: "수정을 마쳤으니 한국어로 안내한다.",
        content: "src/app.mjs 파일 수정을 완료했습니다.",
      },
    ];
    writeFileSync(transcriptPath, toJsonl(baseRecords), "utf8");

    const firstProc = runHookSubprocess(
      STOP_HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath,
        cwd: "/repo",
        continuationActive: false,
        executionNum: 0,
        terminationReason: "NO_TOOL_CALL",
      }),
      { env: { ...process.env, PLUGIN_DATA: dataDir } },
    );
    assert.equal(firstProc.status, 0);
    const firstOut = JSON.parse(firstProc.stdout);
    assert.equal(firstOut.decision, "continue");
    assert.ok(firstOut.reason.startsWith(GATE_STOP_MARKER));
    assert.equal(analyzeField("content", firstOut.reason).status, "korean");

    writeFileSync(
      transcriptPath,
      toJsonl([
        ...baseRecords,
        { step_index: 4, type: "SYSTEM_MESSAGE", content: wrapAntigravityHookMessage(firstOut.reason, "Stop") },
        {
          step_index: 5,
          type: "PLANNER_RESPONSE",
          thinking: "완료 보고를 다시 작성한다.",
          content: "파일 수정을 완료했습니다.",
        },
      ]),
      "utf8",
    );

    const secondProc = runHookSubprocess(
      STOP_HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath,
        cwd: "/repo",
        continuationActive: false,
        executionNum: 1,
        terminationReason: "NO_TOOL_CALL",
      }),
      { env: { ...process.env, PLUGIN_DATA: dataDir } },
    );
    assert.equal(secondProc.status, 0);
    assert.deepEqual(JSON.parse(secondProc.stdout), {});
  });

  it("merges dual violation (unverified write + English response) into one pure-Korean continue with both markers and enforces executionNum >= 2 cap", () => {
    const dataDir = createTempDir("hstack-stop-dual-data-");
    const dir = createTempDir("hstack-stop-dual-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    const records = [
      { step_index: 0, type: "USER_INPUT", content: "파일을 수정하고 설명해 줘" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        thinking: "파일을 수정한다.",
        tool_calls: [{ name: "write_file", args: { Path: "/repo/src/new.mjs" } }],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "created" },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        thinking: "이제 결과를 보고한다.",
        content: "I created the new module and updated everything cleanly for your project.",
      },
    ];
    writeFileSync(transcriptPath, toJsonl(records), "utf8");

    const dualProc = runHookSubprocess(
      STOP_HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath,
        cwd: "/repo",
        continuationActive: false,
        executionNum: 0,
        terminationReason: "NO_TOOL_CALL",
      }),
      { env: { ...process.env, PLUGIN_DATA: dataDir } },
    );
    assert.equal(dualProc.status, 0);
    const dualOut = JSON.parse(dualProc.stdout);
    assert.equal(dualOut.decision, "continue");
    assert.ok(dualOut.reason.includes(GATE_STOP_MARKER));
    assert.ok(dualOut.reason.includes(`${DRIFT_MARKER}[대상:응답]`));
    assert.equal(/[A-Za-z]/.test(dualOut.reason), false);
    assert.equal(analyzeField("content", dualOut.reason).status, "korean");

    const parsedDual = parseDriftMarkerStep({
      type: "SYSTEM_MESSAGE",
      content: wrapAntigravityHookMessage(dualOut.reason, "Stop"),
    });
    assert.equal(parsedDual?.sourceHook, "Stop");
    assert.deepEqual(parsedDual?.fields, ["content"]);

    const capProc = runHookSubprocess(
      STOP_HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath,
        cwd: "/repo",
        continuationActive: false,
        executionNum: 2,
        terminationReason: "NO_TOOL_CALL",
      }),
      { env: { ...process.env, PLUGIN_DATA: dataDir } },
    );
    assert.equal(capProc.status, 0);
    assert.deepEqual(JSON.parse(capProc.stdout), {});
  });

  it("allows stop after any passing verify_completion verdict and on read-only turns", () => {
    const dataDir = createTempDir("hstack-stop-pass-data-");
    const dir = createTempDir("hstack-stop-pass-");

    for (const header of [
      VERDICT_HEADERS.PASS,
      VERDICT_HEADERS.PASS_WITH_WARNING,
      VERDICT_HEADERS.PASS_WITH_DEGRADATION,
      VERDICT_HEADERS.SKIPPED_NO_SESSION,
    ]) {
      const transcriptPath = join(dir, `pass-${header.length}-${Math.random().toString(36).slice(2)}.jsonl`);
      writeFileSync(
        transcriptPath,
        toJsonl([
          { step_index: 0, type: "USER_INPUT", content: "수정해 줘" },
          { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/a.mjs" } }] },
          { step_index: 2, type: "GENERIC", status: "DONE", content: "ok" },
          { step_index: 3, type: "PLANNER_RESPONSE", tool_calls: [{ name: GATE_TOOL_NAME, args: {} }] },
          { step_index: 4, type: "GENERIC", status: "DONE", content: `${header}\n검증을 마쳤습니다.` },
          { step_index: 5, type: "PLANNER_RESPONSE", content: "모든 수정과 완료 검증을 마쳤습니다." },
        ]),
        "utf8",
      );
      const proc = runHookSubprocess(
        STOP_HOOK_SCRIPT,
        JSON.stringify({
          hookEventName: "Stop",
          transcriptPath,
          cwd: "/repo",
          continuationActive: false,
          terminationReason: "NO_TOOL_CALL",
        }),
        { env: { ...process.env, PLUGIN_DATA: dataDir } },
      );
      assert.equal(proc.status, 0);
      assert.deepEqual(JSON.parse(proc.stdout), {});
    }

    const readOnlyPath = join(dir, "readonly.jsonl");
    writeFileSync(
      readOnlyPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "구조만 확인해 줘" },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file", args: { Path: "/repo/README.md" } }] },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "# README" },
        { step_index: 3, type: "PLANNER_RESPONSE", content: "저장소 구조를 확인했습니다." },
      ]),
      "utf8",
    );
    const roProc = runHookSubprocess(
      STOP_HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "Stop",
        transcriptPath: readOnlyPath,
        cwd: "/repo",
        continuationActive: false,
        terminationReason: "NO_TOOL_CALL",
      }),
      { env: { ...process.env, PLUGIN_DATA: dataDir } },
    );
    assert.equal(roProc.status, 0);
    assert.deepEqual(JSON.parse(roProc.stdout), {});
  });
});

describe("post-invocation.mjs non-blocking telemetry", () => {
  it("preserves exact output without metadata and appends post_invocation telemetry to PLUGIN_DATA/audit.jsonl", () => {
    const dataDir = createTempDir("hstack-post-data-");
    const dir = createTempDir("hstack-post-tr-");
    const transcriptPath = join(dir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "코드를 설명해 줘" },
        {
          step_index: 1,
          type: "PLANNER_RESPONSE",
          usage: { input_tokens: 2500, cache_read_tokens: 1800, output_tokens: 95 },
          thinking: "Let me inspect the repository modules carefully before writing a reply.",
          content: "저장소 구조를 확인하고 핵심 모듈을 정리했습니다.",
        },
      ]),
      "utf8",
    );

    const proc = runHookSubprocess(
      HOOK_SCRIPT,
      JSON.stringify({
        hookEventName: "PostInvocation",
        conversationId: "conv-post-1",
        transcriptPath,
      }),
      { env: { ...process.env, PLUGIN_DATA: dataDir } },
    );
    assert.equal(proc.status, 0);
    assert.equal(proc.stderr, "");
    const parsed = JSON.parse(proc.stdout);
    assert.equal(parsed.injectSteps.length, 1);
    assert.equal("metadata" in parsed.injectSteps[0].systemMessage, false);

    const records = readFileSync(join(dataDir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].event, "post_invocation");
    assert.equal(records[0].conversationId, "conv-post-1");
    assert.equal(records[0].langAction, "inject");
    assert.deepEqual(records[0].metrics, { inputTokens: 2500, cacheReadTokens: 1800, outputTokens: 95 });
  });
});

describe("Checkpoint 3 governance polish regressions", () => {
  it("R3_CONCEALED_FAILURE blocks when lint failed and test later passed while lint was omitted from verification_runs", () => {
    const res = decideGate(
      {
        modified_files: ["src/app.mjs"],
        inspected_files: ["src/app.mjs"],
        verification_runs: [{ command: "node --test test/app.test.mjs", outcome: "pass" }],
        unverified_scope: [],
        self_assessment: "단위 테스트 통과를 확인했습니다.",
      },
      {
        ledger: {
          transcriptAvailable: true,
          sessionReadFiles: new Set(["src/app.mjs"]),
          turnStartStepIndex: 0,
          turnWrittenFiles: new Set(["src/app.mjs"]),
          turnCodeWrittenFiles: new Set(["src/app.mjs"]),
          lastWriteStepIndex: 3,
          lastCodeWriteStepIndex: 3,
          turnExecutions: [
            { stepIndex: 5, command: "npm run lint", kind: "verification", passed: false },
            { stepIndex: 6, command: "node --test test/app.test.mjs", kind: "verification", passed: true },
          ],
          turnGateAttempts: [],
        },
        gitLedger: { gitAvailable: true, gitRoot: "/repo", gitDirtyFiles: new Set(["src/app.mjs"]) },
        testInfra: { hasTestSuite: true, indicators: ["test/"] },
      },
    );
    assert.equal(res.verdict, "REJECT");
    assert.deepEqual(res.blockedRules, ["R3_CONCEALED_FAILURE"]);
    assert.deepEqual(res.details.failedVerifications, ["npm run lint"]);
  });

  it("normalizes paths consistently across symlinked cwd and canonical gitRoot", () => {
    const base = createTempDir("hstack-symlink-");
    const realRepo = join(base, "real-repo");
    const linkRepo = join(base, "link-repo");
    mkdirSync(join(realRepo, "src"), { recursive: true });
    symlinkSync(realRepo, linkRepo, "dir");

    assert.equal(normalizeWorkspacePath(join(linkRepo, "src", "app.mjs"), linkRepo, realRepo), "src/app.mjs");
    assert.equal(normalizeWorkspacePath(join(realRepo, "src", "app.mjs"), linkRepo, realRepo), "src/app.mjs");
    assert.equal(normalizeWorkspacePath("app.mjs", join(linkRepo, "src"), realRepo), "src/app.mjs");
  });

  it("bug #3: MCP verify_completion fails open with SKIPPED_NO_SESSION when transcript is missing or empty and logs internal errors to audit.jsonl", async () => {
    const dataDir = createTempDir("hstack-mcp-missing-tr-data-");
    const repoDir = initTempGitRepo("hstack-mcp-missing-tr-repo-");
    const trDir = createTempDir("hstack-mcp-missing-tr-");
    const missingPath = join(trDir, "does-not-exist.jsonl");
    const emptyPath = join(trDir, "empty.jsonl");
    writeFileSync(emptyPath, "", "utf8");

    const client = createMcpClient({ PLUGIN_DATA: dataDir, HSTACK_SCHEMA_REGISTER: "neutral" });
    try {
      await client.request("initialize", { protocolVersion: "2024-11-05" });
      for (const transcriptPath of [missingPath, emptyPath]) {
        const res = await client.request("tools/call", {
          name: "verify_completion",
          arguments: {
            modified_files: ["src/app.mjs"],
            inspected_files: ["src/app.mjs"],
            verification_runs: [{ command: "node --test", outcome: "pass" }],
            unverified_scope: [],
            self_assessment: "수정을 완료하고 확인했습니다.",
            _session: { conversationId: "conv-missing", transcriptPath, cwd: repoDir },
          },
        });
        assert.equal(res.result.isError, false);
        assert.ok(
          res.result.content[0].text.startsWith(VERDICT_HEADERS.SKIPPED_NO_SESSION),
          `expected SKIPPED_NO_SESSION for ${transcriptPath}, got:\n${res.result.content[0].text}`,
        );
      }
    } finally {
      const { exitCode, stderrText } = await client.close();
      assert.equal(exitCode, 0);
      assert.equal(stderrText, "");
    }

    const auditLines = readFileSync(join(dataDir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(auditLines.length, 2);
    assert.equal(auditLines[0].verdict, "SKIPPED_NO_SESSION");
    assert.equal(auditLines[1].verdict, "SKIPPED_NO_SESSION");

    const errDataDir = createTempDir("hstack-mcp-catch-data-");
    const handler = createMcpServerHandler({ dataDir: errDataDir, register: "neutral" });
    const throwingArgs = {
      get modified_files() {
        throw new Error("boom-from-getter");
      },
    };
    const errRes = handler({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "verify_completion", arguments: throwingArgs },
    });
    assert.equal(errRes.result.isError, false);
    assert.ok(errRes.result.content[0].text.startsWith(VERDICT_HEADERS.SKIPPED_NO_SESSION));

    const errAuditLines = readFileSync(join(errDataDir, "audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(errAuditLines.length, 1);
    assert.equal(errAuditLines[0].event, "gate_verify");
    assert.equal(errAuditLines[0].verdict, "SKIPPED_NO_SESSION");
    assert.ok(errAuditLines[0].error.includes("boom-from-getter"));
  });
});
