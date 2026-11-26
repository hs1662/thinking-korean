import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { analyzeField } from "../scripts/analyzer.mjs";
import { AUDITOR_SESSION_MARKER, POLLUTION_WARNING_LINE } from "../scripts/governance/constants.mjs";
import {
  computeWorkspaceKey,
  listHandoffSnapshots,
  loadHandoffSnapshot,
  readSessionState,
  saveHandoffSnapshot,
  updateSessionPollutionState,
} from "../scripts/governance/handoff-store.mjs";
import { handlePostInvocation } from "../scripts/post-invocation.mjs";
import { PLUGIN_ROOT, createTempDir, toJsonl } from "./helpers.mjs";

const MCP_SERVER_SCRIPT = join(PLUGIN_ROOT, "scripts", "mcp", "server.mjs");

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function initTempGitRepo(prefix = "hstack-handoff-repo-") {
  const repoDir = createTempDir(prefix);
  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.email", "test@example.com"]);
  runGit(repoDir, ["config", "user.name", "Test User"]);
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "app.mjs"), "export const v = 1;\n", "utf8");
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
      if (child.exitCode !== null) resolve();
      else child.once("close", resolve);
    });
    return { exitCode: child.exitCode, stderrText };
  }

  return { request, notify, close };
}

describe("handoff-store workspace isolation, pruning, epistemic warnings, and stale tree detection", () => {
  it("isolates snapshots by workspace hash and prunes snapshots beyond 20", () => {
    const dataDir = createTempDir("hstack-handoff-data-");
    const repoA = initTempGitRepo("hstack-ws-a-");
    const repoB = initTempGitRepo("hstack-ws-b-");

    assert.notEqual(computeWorkspaceKey(repoA, repoA), computeWorkspaceKey(repoB, repoB));

    for (let i = 0; i < 23; i += 1) {
      saveHandoffSnapshot({
        input: {
          objective: `작업 목표 ${i}`,
          verified_facts: [`확인 ${i}`],
          failed_approaches: [],
          remaining_tasks: [`남은 작업 ${i}`],
        },
        gitLedger: { gitAvailable: true, gitRoot: repoA, gitDirtyFiles: new Set(), diffNumstat: new Map(), gitBranch: "main", gitHead: "abc1234" },
        cwd: repoA,
        conversationId: "conv-a",
        dataDir,
      });
    }

    const keyA = computeWorkspaceKey(repoA, repoA);
    const dirA = join(dataDir, "handoffs", keyA);
    const snapshotFiles = readdirSync(dirA).filter((f) => f.endsWith(".json") && f !== "latest.json");
    assert.equal(snapshotFiles.length, 20);
    assert.ok(existsSync(join(dirA, "latest.json")));

    const listB = listHandoffSnapshots({ cwd: repoB, gitLedger: { gitRoot: repoB }, dataDir });
    assert.equal(listB.items.length, 0);

    const listA = listHandoffSnapshots({ cwd: repoA, gitLedger: { gitRoot: repoA }, dataDir });
    assert.equal(listA.items.length, 10);
  });

  it("tags unread file claims and contradictory pass claims in unverifiedWarnings", () => {
    const dataDir = createTempDir("hstack-epistemic-");
    const repo = initTempGitRepo("hstack-epistemic-repo-");
    const { snapshot } = saveHandoffSnapshot({
      input: {
        objective: "인증 버그 수정",
        verified_facts: [
          "src/app.mjs 에서 초기값을 확인했습니다.",
          "src/unread.mjs 의 토큰 검사 로직이 정상입니다.",
          "단위 테스트가 모두 통과했습니다.",
        ],
        failed_approaches: ["정규식 교체 시도는 실패"],
        remaining_tasks: ["실패 테스트 수정"],
      },
      ledger: {
        transcriptAvailable: true,
        sessionReadFiles: new Set(["src/app.mjs"]),
        turnWrittenFiles: new Set(["src/app.mjs"]),
        turnExecutions: [{ stepIndex: 4, command: "node --test", kind: "verification", passed: false }],
        turnFailedExecutionCount: 1,
        fileEditCounts: new Map([["src/app.mjs", 1]]),
        latestTokens: { inputTokens: 12000 },
      },
      gitLedger: { gitAvailable: true, gitRoot: repo, gitDirtyFiles: new Set(["src/app.mjs"]), diffNumstat: new Map(), gitBranch: "main", gitHead: "1111111" },
      cwd: repo,
      conversationId: "conv-ep",
      dataDir,
    });

    assert.equal(snapshot.unverifiedWarnings.length, 2);
    assert.ok(snapshot.unverifiedWarnings.some((w) => w.includes("src/unread.mjs")));
    assert.ok(snapshot.unverifiedWarnings.some((w) => w.includes("node --test")));
  });

  it("detects working tree drift on load and rejects path traversal snapshot_id", () => {
    const dataDir = createTempDir("hstack-drift-");
    const repo = initTempGitRepo("hstack-drift-repo-");
    saveHandoffSnapshot({
      input: {
        objective: "기능 완료",
        verified_facts: ["src/app.mjs 확인"],
        failed_approaches: [],
        remaining_tasks: ["마무리 테스트"],
      },
      gitLedger: { gitAvailable: true, gitRoot: repo, gitDirtyFiles: new Set(["src/app.mjs"]), diffNumstat: new Map(), gitBranch: "main", gitHead: "aaaaaaa" },
      cwd: repo,
      conversationId: "conv-1",
      dataDir,
    });

    const cleanLoad = loadHandoffSnapshot({
      cwd: repo,
      gitLedger: { gitAvailable: true, gitRoot: repo, gitDirtyFiles: new Set(["src/app.mjs"]), gitHead: "aaaaaaa" },
      dataDir,
    });
    assert.equal(cleanLoad.ok, true);
    assert.equal(cleanLoad.treeChanged, false);
    assert.ok(!cleanLoad.formattedText.includes("[작업 트리 변동 감지]"));

    const driftedLoad = loadHandoffSnapshot({
      cwd: repo,
      gitLedger: { gitAvailable: true, gitRoot: repo, gitDirtyFiles: new Set(["src/app.mjs", "src/extra.mjs"]), gitHead: "bbbbbbb" },
      dataDir,
    });
    assert.equal(driftedLoad.ok, true);
    assert.equal(driftedLoad.treeChanged, true);
    assert.ok(driftedLoad.formattedText.includes("[작업 트리 변동 감지]"));
    assert.equal(analyzeField("content", driftedLoad.formattedText).status, "korean");

    const traversal = loadHandoffSnapshot({
      snapshotId: "../../etc/passwd",
      cwd: repo,
      gitLedger: { gitAvailable: true, gitRoot: repo, gitDirtyFiles: new Set(), gitHead: "aaaaaaa" },
      dataDir,
    });
    assert.equal(traversal.ok, false);
  });
});

describe("MCP manage_handoff stdio roundtrip and pollution alert integration", () => {
  it("exposes verify_completion and manage_handoff without _session/toolSummary, roundtrips save/list/load, and logs audit.jsonl", async () => {
    const dataDir = createTempDir("hstack-mcp-handoff-");
    const repo = initTempGitRepo("hstack-mcp-handoff-repo-");
    const transcriptPath = join(dataDir, "transcript_full.jsonl");
    writeFileSync(
      transcriptPath,
      toJsonl([
        { step_index: 0, type: "USER_INPUT", content: "작업 진행" },
        { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file", args: { Path: "src/app.mjs" } }] },
        { step_index: 2, type: "GENERIC", status: "DONE", content: "export const v = 1;" },
      ]),
      "utf8",
    );

    const client = createMcpClient({ PLUGIN_DATA: dataDir });
    try {
      const init = await client.request("initialize", { protocolVersion: "2024-11-05" });
      assert.equal(init.result.serverInfo.version, "2.1.0");
      client.notify("notifications/initialized");

      const listRes = await client.request("tools/list");
      const tools = listRes.result.tools;
      assert.deepEqual(
        tools.map((t) => t.name),
        ["verify_completion", "manage_handoff"],
      );
      for (const tool of tools) {
        assert.equal("_session" in tool.inputSchema.properties, false);
        assert.equal("toolSummary" in tool.inputSchema.properties, false);
      }

      const saveRes = await client.request("tools/call", {
        name: "manage_handoff",
        arguments: {
          action: "save",
          objective: "기존 모듈 리팩터링을 마무리합니다.",
          verified_facts: ["src/app.mjs 의 내보내기 상수가 1임을 확인했습니다."],
          failed_approaches: ["전역 상태 캐시 방식은 격리 테스트와 충돌해 폐기했습니다."],
          remaining_tasks: ["src/app.mjs 상수를 2로 변경하고 단위 테스트를 확인합니다."],
          open_risks: ["추가 모듈 의존성 확인 필요"],
          _session: { conversationId: "conv-h1", transcriptPath, cwd: repo },
        },
      });
      assert.equal(saveRes.result.isError, false);
      const saveText = saveRes.result.content[0].text;
      assert.ok(saveText.includes("[핸드오프 저장 완료]"));
      assert.equal(analyzeField("content", saveText).status, "korean");

      const listSnapRes = await client.request("tools/call", {
        name: "manage_handoff",
        arguments: {
          action: "list",
          _session: { conversationId: "conv-h2", transcriptPath: "", cwd: repo },
        },
      });
      assert.equal(listSnapRes.result.isError, false);
      assert.ok(listSnapRes.result.content[0].text.includes("기존 모듈 리팩터링"));

      const loadRes = await client.request("tools/call", {
        name: "manage_handoff",
        arguments: {
          action: "load",
          _session: { conversationId: "conv-h2", transcriptPath: "", cwd: repo },
        },
      });
      assert.equal(loadRes.result.isError, false);
      const loadText = loadRes.result.content[0].text;
      assert.ok(loadText.includes("[팩트 증류 인수인계서]"));
      assert.ok(loadText.includes("기존 모듈 리팩터링"));
      assert.ok(loadText.includes("전역 상태 캐시 방식은 격리 테스트와 충돌"));

      // Trigger pollution alert via session state and verify verify_completion appends warning line
      updateSessionPollutionState({
        conversationId: "conv-polluted",
        inputTokens: 135_000,
        failedExecutionsInTurn: 0,
        maxSingleFileEdits: 1,
        dataDir,
      });

      const verifyRes = await client.request("tools/call", {
        name: "verify_completion",
        arguments: {
          modified_files: [],
          inspected_files: ["src/app.mjs"],
          verification_runs: [],
          unverified_scope: [],
          self_assessment: "읽기 전용 분석 결과를 확인했습니다.",
          _session: { conversationId: "conv-polluted", transcriptPath, cwd: repo },
        },
      });
      assert.equal(verifyRes.result.isError, false);
      assert.ok(verifyRes.result.content[0].text.includes(POLLUTION_WARNING_LINE));

      const auditLines = readFileSync(join(dataDir, "audit.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(auditLines.some((r) => r.eventType === "handoff_save"));
      assert.ok(auditLines.some((r) => r.eventType === "handoff_load"));
      assert.ok(auditLines.some((r) => r.eventType === "gate_verify"));

      // M6: missing _session.cwd must return an error instead of falling back to process.cwd()
      const missingSessionRes = await client.request("tools/call", {
        name: "manage_handoff",
        arguments: {
          action: "save",
          objective: "세션 누락 테스트",
          verified_facts: [],
          failed_approaches: [],
          remaining_tasks: [],
        },
      });
      assert.equal(missingSessionRes.result.isError, false);
      assert.ok(missingSessionRes.result.content[0].text.includes("[핸드오프 처리 오류]"));
    } finally {
      await client.close();
    }
  });

  it("Checkpoint 4 regressions M6/L2/L3: detects dirty file content drift, resets per-turn pollution counters, and ignores URLs in verified_facts", () => {
    const dataDir = createTempDir("hstack-cp4-handoff-");
    const repo = initTempGitRepo("hstack-cp4-handoff-repo-");
    writeFileSync(join(repo, "src", "app.mjs"), "export const v = 2;\n", "utf8");
    const gitBefore = {
      gitAvailable: true,
      gitRoot: repo,
      gitDirtyFiles: new Set(["src/app.mjs"]),
      diffNumstat: new Map([["src/app.mjs", { added: 1, deleted: 1 }]]),
      gitBranch: "main",
      gitHead: "abc1234",
    };

    const { snapshot } = saveHandoffSnapshot({
      input: {
        objective: "내용 변경 감지 테스트",
        verified_facts: [
          "참고 문서 https://example.com/docs/guide.html 의 명세를 확인했습니다.",
        ],
        failed_approaches: [],
        remaining_tasks: ["후속 확인"],
      },
      ledger: {
        transcriptAvailable: true,
        sessionReadFiles: new Set(["src/app.mjs"]),
        turnWrittenFiles: new Set(["src/app.mjs"]),
        turnExecutions: [],
        turnFailedExecutionCount: 0,
        fileEditCounts: new Map([["src/app.mjs", 1]]),
        latestTokens: { inputTokens: 1000 },
      },
      gitLedger: gitBefore,
      cwd: repo,
      conversationId: "conv-m6",
      dataDir,
    });
    // L3: URL must not be flagged as unread local file
    assert.equal(snapshot.unverifiedWarnings.length, 0);

    // M6: modifying same dirty file's content must trigger treeChanged even with same gitHead and dirtyFiles list
    writeFileSync(join(repo, "src", "app.mjs"), "export const v = 999;\nexport const extra = 1;\n", "utf8");
    const loaded = loadHandoffSnapshot({
      cwd: repo,
      gitLedger: {
        gitAvailable: true,
        gitRoot: repo,
        gitDirtyFiles: new Set(["src/app.mjs"]),
        gitHead: "abc1234",
      },
      dataDir,
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.treeChanged, true);
    assert.ok(loaded.formattedText.includes("[작업 트리 변동 감지]"));

    // L2: new turn (changed turnStartStepIndex) must reset per-turn failedExecutionsInTurn and pollutionAlert when tokens are below threshold
    updateSessionPollutionState({
      conversationId: "conv-turn-reset",
      turnStartStepIndex: 0,
      inputTokens: 10_000,
      failedExecutionsInTurn: 5,
      maxSingleFileEdits: 1,
      dataDir,
    });
    assert.equal(readSessionState("conv-turn-reset", dataDir)?.pollutionAlert, true);

    const nextTurn = updateSessionPollutionState({
      conversationId: "conv-turn-reset",
      turnStartStepIndex: 12,
      inputTokens: 12_000,
      failedExecutionsInTurn: 0,
      maxSingleFileEdits: 0,
      dataDir,
    });
    assert.equal(nextTurn.failedExecutionsInTurn, 0);
    assert.equal(nextTurn.pollutionAlert, false);
  });

  it("updates pollution state on post-invocation for main sessions and skips auditor sessions", () => {
    const dataDir = createTempDir("hstack-post-pollution-");
    const prevPluginData = process.env.PLUGIN_DATA;
    process.env.PLUGIN_DATA = dataDir;
    try {
      const mainTranscript = join(dataDir, "main_full.jsonl");
      writeFileSync(
        mainTranscript,
        toJsonl([
          { step_index: 0, type: "USER_INPUT", content: "작업 수행" },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            thinking: "파일을 반복 수정합니다.",
            content: "수정했습니다.",
            usage: { inputTokens: 125_000, outputTokens: 500 },
            tool_calls: [{ name: "edit_file", args: { Path: "src/a.mjs" } }],
          },
        ]),
        "utf8",
      );

      handlePostInvocation(
        JSON.stringify({
          hookEventName: "PostInvocation",
          conversationId: "conv-main-p",
          cwd: dataDir,
          transcriptPath: mainTranscript,
        }),
      );
      const mainState = readSessionState("conv-main-p", dataDir);
      assert.equal(mainState?.pollutionAlert, true);
      assert.equal(mainState?.inputTokens, 125_000);

      const auditorTranscript = join(dataDir, "auditor_full.jsonl");
      writeFileSync(
        auditorTranscript,
        toJsonl([
          { step_index: 0, type: "USER_INPUT", content: `독립 검토\n${AUDITOR_SESSION_MARKER}` },
          {
            step_index: 1,
            type: "PLANNER_RESPONSE",
            thinking: "코드를 검토합니다.",
            content: "결함 없음.\n[감사 판정: 통과]",
            usage: { inputTokens: 200_000, outputTokens: 100 },
          },
        ]),
        "utf8",
      );

      handlePostInvocation(
        JSON.stringify({
          hookEventName: "PostInvocation",
          conversationId: "conv-auditor-p",
          cwd: dataDir,
          transcriptPath: auditorTranscript,
        }),
      );
      assert.equal(readSessionState("conv-auditor-p", dataDir), null);
    } finally {
      if (prevPluginData === undefined) delete process.env.PLUGIN_DATA;
      else process.env.PLUGIN_DATA = prevPluginData;
    }
  });
});
