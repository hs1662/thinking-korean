#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePlannerResponse } from "../scripts/analyzer.mjs";
import { DRIFT_MARKER, parseTranscriptJsonl } from "../scripts/transcript.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "..");
const DEFAULT_MODELS = ["gemini-4-neon-xhigh", "claude-opus-5-5-high"];
const PLUGIN_ENTRIES = ["plugin.json", "hooks.json", "rules", "scripts", "assets"];

const CASES = [
  {
    name: "korean-reasoning",
    prompt:
      "분산 작업 큐에서 재시도 백오프와 멱등성 키를 함께 설계할 때 생길 수 있는 중복 실행 시나리오 3가지를 분석하고, 각각의 방지 전략과 트레이드오프를 한국어로 정리해 줘. 도구는 호출하지 말고 바로 추론해서 답해 줘.",
  },
  {
    name: "tool-code-analysis",
    prompt:
      "src/analyzer.mjs 파일을 직접 읽고 analyzeField의 드리프트 판정 순서와 예외 필터링 로직을 한국어로 분석해 줘.",
  },
];

function printUsage() {
  process.stdout.write(
    `Usage: node test/verify-live.mjs [--models ${DEFAULT_MODELS.join(",")}]\n`,
  );
}

function parseCliArgs(argv) {
  let models = [...DEFAULT_MODELS];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { help: true, models };
    }
    if (arg === "--models") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --models");
      }
      models = parseModelList(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--models=")) {
      models = parseModelList(arg.slice("--models=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { help: false, models };
}

function parseModelList(raw) {
  const models = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (models.length === 0) {
    throw new Error("--models must include at least one model name");
  }
  return models;
}

function createTempWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "thinking-korean-live-"));
  const pluginDest = join(workspace, ".agents", "plugins", "thinking-korean");
  mkdirSync(pluginDest, { recursive: true });

  for (const entry of PLUGIN_ENTRIES) {
    const src = join(PLUGIN_ROOT, entry);
    if (existsSync(src)) {
      cpSync(src, join(pluginDest, entry), { recursive: true });
    }
  }

  const sampleDir = join(workspace, "src");
  mkdirSync(sampleDir, { recursive: true });
  cpSync(join(PLUGIN_ROOT, "scripts", "analyzer.mjs"), join(sampleDir, "analyzer.mjs"));
  return workspace;
}

function extractConversationId(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const id =
      event?.conversation_id ??
      event?.result?.conversation_id ??
      event?.step_update?.conversation_id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return null;
}

function resolveTranscriptPath(conversationId) {
  const appDataDir = process.env.AGY_APP_DATA_DIR || join(homedir(), ".gemini", "antigravity-cli");
  const logsDir = join(appDataDir, "brain", conversationId, ".system_generated", "logs");
  const fullPath = join(logsDir, "transcript_full.jsonl");
  if (existsSync(fullPath)) {
    return fullPath;
  }
  const compactPath = join(logsDir, "transcript.jsonl");
  if (existsSync(compactPath)) {
    return compactPath;
  }
  return null;
}

function roundRatio(value) {
  return Math.round(value * 10000) / 10000;
}

function formatFieldResult(result) {
  return {
    status: result.status,
    driftReason: result.driftReason,
    hangulCount: result.hangulCount,
    latinCount: result.latinCount,
    naturalCharCount: result.naturalCharCount,
    hangulRatio: roundRatio(result.hangulRatio),
  };
}

function summarizeTranscript(steps) {
  let driftInjections = 0;
  const plannerSteps = [];

  for (const step of steps) {
    if (step.type === "SYSTEM_MESSAGE" && step.content.includes(DRIFT_MARKER)) {
      driftInjections += 1;
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") {
      continue;
    }
    const evaluation = evaluatePlannerResponse(step);
    plannerSteps.push({
      stepIndex: step.stepIndex,
      kind: evaluation.kind,
      driftedFields: evaluation.kind === "drifted" ? evaluation.driftedFields : [],
      thinking: formatFieldResult(evaluation.thinking),
      content: formatFieldResult(evaluation.content),
    });
  }

  const driftedStepCount = plannerSteps.filter((step) => step.kind === "drifted").length;
  const thinkingWithNaturalText = plannerSteps.filter((step) => step.thinking.naturalCharCount > 0);
  const avgThinkingHangulRatio =
    thinkingWithNaturalText.length > 0
      ? roundRatio(
          thinkingWithNaturalText.reduce((sum, step) => sum + step.thinking.hangulRatio, 0) /
            thinkingWithNaturalText.length,
        )
      : null;
  const finalStepKind = plannerSteps.length > 0 ? plannerSteps[plannerSteps.length - 1].kind : null;

  let status;
  if (plannerSteps.length === 0) {
    status = "error";
  } else if (driftedStepCount === 0) {
    status = "pass";
  } else if (driftInjections > 0 && finalStepKind === "ok") {
    status = "recovered";
  } else {
    status = "drifted";
  }

  return {
    status,
    driftInjections,
    plannerResponseCount: plannerSteps.length,
    driftedStepCount,
    avgThinkingHangulRatio,
    finalStepKind,
    plannerSteps,
  };
}

function runLiveCase(model, testCase) {
  const workspace = createTempWorkspace();
  try {
    const proc = spawnSync(
      "agy",
      [
        "--model",
        model,
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "-p",
        testCase.prompt,
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );

    const exitCode = proc.status ?? 1;
    const conversationId = extractConversationId(proc.stdout || "");

    if (proc.error) {
      return {
        model,
        case: testCase.name,
        conversationId,
        exitCode,
        status: "error",
        error: proc.error.message,
      };
    }

    if (!conversationId) {
      return {
        model,
        case: testCase.name,
        conversationId: null,
        exitCode,
        status: "error",
        error: (proc.stderr || "No conversation_id found in agy stream-json output").trim(),
      };
    }

    const transcriptPath = resolveTranscriptPath(conversationId);
    if (!transcriptPath) {
      return {
        model,
        case: testCase.name,
        conversationId,
        exitCode,
        status: "error",
        error: `Transcript not found for conversation ${conversationId}`,
      };
    }

    const rawTranscript = readFileSync(transcriptPath, "utf8");
    const steps = parseTranscriptJsonl(rawTranscript);
    const analysis = summarizeTranscript(steps);

    return {
      model,
      case: testCase.name,
      conversationId,
      exitCode,
      transcriptPath,
      ...analysis,
      status: exitCode !== 0 ? "error" : analysis.status,
      ...(exitCode !== 0 ? { error: (proc.stderr || `agy exited with ${exitCode}`).trim() } : {}),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function isDirectExecution() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  }
}

function main() {
  let options;
  try {
    options = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  const results = [];
  for (const model of options.models) {
    for (const testCase of CASES) {
      results.push(runLiveCase(model, testCase));
    }
  }

  const totals = {
    runs: results.length,
    pass: results.filter((entry) => entry.status === "pass").length,
    recovered: results.filter((entry) => entry.status === "recovered").length,
    drifted: results.filter((entry) => entry.status === "drifted").length,
    error: results.filter((entry) => entry.status === "error").length,
  };

  const report = {
    models: options.models,
    cases: CASES.map((entry) => entry.name),
    totals,
    results,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (totals.error > 0 || totals.drifted > 0) {
    process.exitCode = 1;
  }
}

if (isDirectExecution()) {
  main();
}
