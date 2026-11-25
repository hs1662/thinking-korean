#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePlannerResponse } from "../scripts/analyzer.mjs";
import {
  PRE_TOOL_USE_UI_TOOLS,
  extractUiTextsFromToolCalls,
  getToolCalls,
  isPreToolDenialStep,
  parseDriftMarkerStep,
  parseTranscriptJsonl,
} from "../scripts/transcript.mjs";
import { deniedToolCallIndexes } from "../scripts/transcript/steps.mjs";
import { isDirectExecution } from "../scripts/hook-io.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(TEST_DIR, "..");
const DEFAULT_MODELS = ["gemini-4-neon-xhigh", "claude-opus-5-5-high"];
export const DEFAULT_TIMEOUT_SECONDS = 180;
const HARD_KILL_GRACE_MS = 10_000;
const PLUGIN_ENTRIES = ["plugin.json", "hooks.json", "mcp_config.json", "rules", "scripts", "assets"];
const AUTH_AND_BUILTIN_ITEMS = ["antigravity-oauth-token", "builtin", "installation_id"];
const ANALYZER_MODULE_DIR = join(PLUGIN_ROOT, "scripts", "analyzer");
const ANALYZE_FIELD_EXPORT_RE = /export\s+function\s+analyzeField\s*\(/;
const RELATIVE_IMPORT_RE = /(\bfrom\s+["'])\.\/([^"']+)(["'])/g;

// scripts/analyzer.mjs is a re-export facade, so the live sample must be the module that actually defines
// analyzeField: src/analyzer.mjs = that module, src/analyzer/ = its sibling submodules (imports rewritten).
function copyAnalyzerSample(workspaceDir) {
  const sampleDir = join(workspaceDir, "src");
  const subDir = join(sampleDir, "analyzer");
  mkdirSync(subDir, { recursive: true });

  const moduleFiles = readdirSync(ANALYZER_MODULE_DIR).filter((file) => file.endsWith(".mjs"));
  const sources = new Map(moduleFiles.map((file) => [file, readFileSync(join(ANALYZER_MODULE_DIR, file), "utf8")]));
  const mainFile = moduleFiles.find((file) => ANALYZE_FIELD_EXPORT_RE.test(sources.get(file)));
  if (!mainFile) {
    throw new Error(`No module in ${ANALYZER_MODULE_DIR} defines analyzeField`);
  }

  writeFileSync(
    join(sampleDir, "analyzer.mjs"),
    sources.get(mainFile).replace(RELATIVE_IMPORT_RE, (_, head, target, tail) => `${head}./analyzer/${target}${tail}`),
    "utf8",
  );
  for (const file of moduleFiles) {
    if (file === mainFile) {
      continue;
    }
    writeFileSync(
      join(subDir, file),
      sources
        .get(file)
        .replace(RELATIVE_IMPORT_RE, (match, head, target, tail) =>
          target === mainFile ? `${head}../analyzer.mjs${tail}` : match,
        ),
      "utf8",
    );
  }
}

const HEAVY_ENGLISH_SKILL_DOC = `---
name: engineering-discipline
description: Concise engineering workflow guidelines covering architecture boundaries, deterministic verification, diff sizing, and review hygiene.
---

# Engineering Discipline Guide

Use this reference document when auditing a module, refactoring state transitions, or validating CLI and hook behavior across repositories.

## Platform Adaptation

Different agent runtimes expose distinct tool names, transcript schemas, and hook lifecycles. Never assume a single cross-runtime mapping without verifying the active runtime contract:

- **Hook execution boundaries**: Validate whether a hook runs before model invocation, after tool completion, or only at session startup. Prefer stateless transcript inspection over brittle hidden files whenever the runtime provides a full JSONL log.
- **Process isolation**: Child CLI runs must strip inherited server address and authentication socket variables so they do not attach to a parent language server loaded with unrelated global plugins.
- **Artifact hygiene**: Temporary workspaces, conversation logs, and benchmark fixtures must live inside disposable directories and be cleaned up automatically unless explicit debugging flags are set.

## Non-Negotiable Rules

1. **Restate the target contract before editing.** Identify which files you own, what shared interfaces other modules rely on, and what observable behavior defines completion.
2. **Trace root causes before adding guards.** A fallback guard is legitimate only when the input state is genuinely valid at a system boundary. Do not mask malformed regular expressions, leaked globals, or silent status misclassifications with ad-hoc retries.
3. **Prefer deterministic line scanners over fragile backtracking regexes.** Multi-line markdown fences, nested backtick spans, and inline comparison operators break naive regular expressions and silently erase natural language prose.
4. **Separate user-facing verbatim requirements from internal reasoning hygiene.** Technical identifiers, CLI flags, file paths, and error quotes must remain verbatim in tool arguments and final responses without polluting natural-language checks.
5. **Explain every reported metric.** Unweighted step averages distort long multi-step sessions when a 10-character step weighs the same as a 2,000-character analysis. Always report character-weighted ratios alongside step counts.

## Core Principles

- **Boundary Discipline**: Validate untrusted inputs at entrypoints (stdin JSON payloads, CLI flags, JSONL lines, filesystem paths). Keep pure scoring and decision logic free of I/O side effects so unit tests exercise every branch deterministically.
- **Model the Domain**: Encode lifecycle states explicitly (pass, recovered, drifted, no_thinking, error) instead of inferring success from the absence of a single counter. An empty thinking trace is not a passing Korean trace.
- **Make Operations Idempotent**: Repeated hook invocations over the same transcript step must converge cleanly without duplicating injected messages or corrupting conversation history.
- **Guard the Context Window**: Cap consecutive unrecovered prompt injections when a downstream summarizer ignores corrections, while preserving independent safety budgets for user-facing response drift.
- **Test Behavior, Not Implementation**: Assert end-to-end observable outcomes—whether drift is caught, whether translation requests avoid false positives, and whether recovery resets backoff—rather than private helper internals.
- **Prove It Works**: Validate syntax, strict manifest schemas, file permissions in the git index, and isolated live transcripts before declaring a change shippable.

## Verification Checklist

When auditing a text analyzer and hook pipeline against real transcripts, check each boundary explicitly:

- **Fence and inline-code stripping**: Confirm CommonMark closing fences longer than the opening fence do not swallow trailing English paragraphs, and confirm multi-backtick spans do not leak inner words.
- **Quote and blockquote handling**: Preserve short verbatim error messages while keeping long English prose inside quotes or blockquotes evaluable for drift.
- **Technical token exemptions**: Avoid false positives on uppercase acronyms (\`CLI\`, \`HTTP\`, \`API\`, \`JSONL\`, \`STDOUT\`), kebab-case slugs and model IDs, dotfiles, directory paths, markdown tables, and comma-separated identifier lists.
- **Short prose and trailing segment detection**: Catch concise English transition thoughts and trailing English sentences appended after Korean explanations without flagging brief technical labels.
- **Explicit translation requests**: Inspect the user request body (excluding runtime metadata blocks) so explicit requests to translate or respond in English exempt response content without disabling Korean internal reasoning checks.
- **Large transcript latency**: Scan raw buffers line-by-line and parse only relevant event records (\`PLANNER_RESPONSE\`, \`SYSTEM_MESSAGE\`, \`USER_INPUT\`) so multi-megabyte tool outputs stay well within strict hook timeouts.

## Reporting Format

Write concise, direct analysis grounded in specific code paths and measured evidence. Avoid speculative claims when a direct file read or command check can verify the behavior.
`;

export const CASES = [
  {
    name: "korean-reasoning",
    prompt:
      "분산 작업 큐에서 재시도 백오프와 멱등성 키를 함께 설계할 때 생길 수 있는 중복 실행 시나리오 3가지를 분석하고, 각각의 방지 전략과 트레이드오프를 한국어로 정리해 줘. 도구는 호출하지 말고 바로 추론해서 답해 줘.",
    exemptContentDrift: false,
    setupWorkspace: null,
  },
  {
    name: "tool-code-analysis",
    prompt:
      "src/analyzer.mjs 파일을 직접 읽고 analyzeField의 드리프트 판정 순서와 예외 필터링 로직을 한국어로 분석해 줘.",
    exemptContentDrift: false,
    setupWorkspace(workspaceDir) {
      copyAnalyzerSample(workspaceDir);
    },
  },
  {
    name: "heavy-english-skill-tools",
    prompt:
      "먼저 docs/SKILL.md 파일 전체와 src/analyzer.mjs 파일을 직접 읽은 뒤, (1) docs/SKILL.md의 핵심 원칙 3가지가 이 분석기 검증 흐름에 어떻게 적용될 수 있는지, (2) src/analyzer.mjs의 드리프트 판정과 예외 필터링 로직에서 주의해야 할 경계 조건 3가지를 한국어로 상세히 분석해 줘.",
    exemptContentDrift: false,
    setupWorkspace(workspaceDir) {
      const docsDir = join(workspaceDir, "docs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "SKILL.md"), HEAVY_ENGLISH_SKILL_DOC, "utf8");
      copyAnalyzerSample(workspaceDir);
    },
  },
  {
    name: "explicit-translation",
    prompt:
      "도구는 호출하지 말고, 아래 한국어 문단을 자연스러운 영어로 번역해 줘. 번역문만 출력해 줘.\n\n분산 시스템에서 재시도 정책을 설계할 때는 지수 백오프와 지터를 함께 적용해 동시 재시도 폭주를 막아야 한다. 또한 모든 쓰기 요청에 멱등성 키를 부여하면 네트워크 타임아웃 뒤 재전송이 발생해도 중복 처리를 안전하게 방지할 수 있다.",
    exemptContentDrift: true,
    setupWorkspace: null,
  },
  {
    name: "todo-checklist",
    prompt:
      "먼저 update_steps 도구로 3단계 작업 체크리스트를 등록한 뒤, src/analyzer.mjs 파일을 읽고 핵심 판정 규칙을 한국어로 요약해 줘. 작업 단계 제목과 도구 요약, 추론, 최종 응답 모두 한국어로 작성해 줘.",
    exemptContentDrift: false,
    requiredTools: ["update_steps"],
    setupWorkspace(workspaceDir) {
      copyAnalyzerSample(workspaceDir);
    },
  },
  {
    name: "deep-code-audit",
    prompt:
      "scripts/hook-io.mjs, scripts/analyzer/stripper.mjs, scripts/transcript/english-request.mjs, scripts/transcript/decide-post.mjs 이 4개 파일만 직접 읽고, 각 파일에서 발견할 수 있는 경계 오류, 상태 추적 결함, 정규식 위험, 파서 불일치를 함수명과 줄 번호를 들어 심층 감사해 한국어로 보고해 줘. 다른 파일은 읽지 마.",
    exemptContentDrift: false,
    setupWorkspace(workspaceDir) {
      cpSync(join(PLUGIN_ROOT, "scripts"), join(workspaceDir, "scripts"), { recursive: true });
    },
  },
];

const CASE_BY_NAME = new Map(CASES.map((entry) => [entry.name, entry]));

function printUsage() {
  const caseNames = CASES.map((entry) => entry.name).join(",");
  process.stdout.write(
    [
      `Usage: node test/verify-live.mjs [options]`,
      "",
      "Options:",
      `  --models <list>     Comma-separated model IDs (default: ${DEFAULT_MODELS.join(",")})`,
      `  --cases <list>      Comma-separated test cases (default: ${caseNames})`,
      `  --timeout <sec>     Per-case timeout in seconds (default: ${DEFAULT_TIMEOUT_SECONDS})`,
      "  --keep-logs         Preserve isolated temp directories and brain transcripts",
      "  -h, --help          Show this help message",
      "",
    ].join("\n"),
  );
}

function parseCommaList(raw, flagName) {
  const items = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (items.length === 0) {
    throw new Error(`${flagName} must include at least one value`);
  }
  return items;
}

function parseTimeoutSeconds(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid --timeout value: ${raw} (expected a positive number of seconds)`);
  }
  return Math.ceil(value);
}

function resolveCases(caseNames) {
  const selected = [];
  const seen = new Set();
  for (const name of caseNames) {
    const found = CASE_BY_NAME.get(name);
    if (!found) {
      const valid = CASES.map((entry) => entry.name).join(", ");
      throw new Error(`Unknown case "${name}". Valid cases: ${valid}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      selected.push(found);
    }
  }
  return selected;
}

export function parseCliArgs(argv) {
  let models = [...DEFAULT_MODELS];
  let selectedCases = [...CASES];
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  let keepLogs = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return {
        help: true,
        models,
        cases: selectedCases,
        timeoutSeconds,
        timeoutMs: timeoutSeconds * 1000,
        keepLogs,
      };
    }
    if (arg === "--keep-logs") {
      keepLogs = true;
      continue;
    }
    if (arg === "--models") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --models");
      }
      models = parseCommaList(next, "--models");
      i += 1;
      continue;
    }
    if (arg.startsWith("--models=")) {
      models = parseCommaList(arg.slice("--models=".length), "--models");
      continue;
    }
    if (arg === "--cases") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) {
        throw new Error("Missing value for --cases");
      }
      selectedCases = resolveCases(parseCommaList(next, "--cases"));
      i += 1;
      continue;
    }
    if (arg.startsWith("--cases=")) {
      selectedCases = resolveCases(parseCommaList(arg.slice("--cases=".length), "--cases"));
      continue;
    }
    if (arg === "--timeout") {
      const next = argv[i + 1];
      if (!next || (next.startsWith("-") && !/^-\d/.test(next))) {
        throw new Error("Missing value for --timeout");
      }
      timeoutSeconds = parseTimeoutSeconds(next);
      i += 1;
      continue;
    }
    if (arg.startsWith("--timeout=")) {
      timeoutSeconds = parseTimeoutSeconds(arg.slice("--timeout=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    help: false,
    models,
    cases: selectedCases,
    timeoutSeconds,
    timeoutMs: timeoutSeconds * 1000,
    keepLogs,
  };
}

function readPluginManifest() {
  const manifestPath = join(PLUGIN_ROOT, "plugin.json");
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

function resolveSourceAppDataDirs() {
  const candidates = [];
  for (const envKey of ["ANTIGRAVITY_APP_DATA_DIR", "AGY_APP_DATA_DIR"]) {
    const val = process.env[envKey];
    if (val && existsSync(val) && !candidates.includes(val)) {
      candidates.push(val);
    }
  }
  const defaultDir = join(homedir(), ".gemini", "antigravity-cli");
  if (existsSync(defaultDir) && !candidates.includes(defaultDir)) {
    candidates.push(defaultDir);
  }
  return candidates;
}

export function buildIsolatedEnv(homeDir, appDataDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTIGRAVITY_") || key.startsWith("AGY_")) {
      delete env[key];
    }
  }
  env.HOME = homeDir;
  env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  env.AGY_APP_DATA_DIR = appDataDir;
  return env;
}

function safeRealpath(pathValue) {
  try {
    return realpathSync(pathValue);
  } catch {
    return resolve(pathValue);
  }
}

function readHooksConfig() {
  return JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks.json"), "utf8"));
}

function createIsolatedEnvironment(testCase, pluginManifest) {
  const runRoot = mkdtempSync(join(tmpdir(), "hstack-live-"));
  try {
    const homeDir = join(runRoot, "home");
    const appDataDir = join(homeDir, ".gemini", "antigravity-cli");
    const configDir = join(homeDir, ".gemini", "config");
    const configPluginsDir = join(configDir, "plugins");
    const workspaceDir = join(runRoot, "workspace");

    mkdirSync(appDataDir, { recursive: true });
    mkdirSync(configPluginsDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    const sourceAppDataDirs = resolveSourceAppDataDirs();
    for (const item of AUTH_AND_BUILTIN_ITEMS) {
      for (const sourceDir of sourceAppDataDirs) {
        const src = join(sourceDir, item);
        if (existsSync(src)) {
          const symlinkType = statSync(src).isDirectory() ? "dir" : "file";
          symlinkSync(src, join(appDataDir, item), symlinkType);
          break;
        }
      }
    }

    const trustedWorkspaces = Array.from(
      new Set([runRoot, safeRealpath(runRoot), workspaceDir, safeRealpath(workspaceDir)]),
    );

    writeFileSync(
      join(appDataDir, "settings.json"),
      `${JSON.stringify(
        {
          allowNonWorkspaceAccess: true,
          showThinking: true,
          toolPermission: "always-proceed",
          trustedWorkspaces,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(join(configDir, "config.json"), `${JSON.stringify({ plugins: {} }, null, 2)}\n`, "utf8");

    const pluginName = pluginManifest.name || "hstack";
    const pluginDest = join(configPluginsDir, pluginName);
    mkdirSync(pluginDest, { recursive: true });
    for (const entry of PLUGIN_ENTRIES) {
      const src = join(PLUGIN_ROOT, entry);
      if (existsSync(src)) {
        cpSync(src, join(pluginDest, entry), { recursive: true });
      }
    }

    if (typeof testCase.setupWorkspace === "function") {
      testCase.setupWorkspace(workspaceDir);
    }

    const env = buildIsolatedEnv(homeDir, appDataDir);
    const gitInit = spawnSync("git", ["init", "-q"], {
      cwd: workspaceDir,
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (gitInit.error || gitInit.status !== 0) {
      const reason = gitInit.error?.message || (gitInit.stderr || `git init exited with ${gitInit.status}`).trim();
      throw new Error(`Failed to initialize temp git workspace: ${reason}`);
    }

    return { runRoot, homeDir, appDataDir, workspaceDir, pluginDest, env };
  } catch (error) {
    rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
}

function verifyIsolatedPlugin(workspaceDir, env, pluginDest, pluginManifest) {
  const proc = spawnSync("agy", ["plugin", "list", "--json"], {
    cwd: workspaceDir,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (proc.error) {
    return { ok: false, error: `Failed to run agy plugin list: ${proc.error.message}`, loadedPlugins: [] };
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      error: `agy plugin list exited with ${proc.status}: ${(proc.stderr || "").trim()}`,
      loadedPlugins: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(proc.stdout || "[]");
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON from agy plugin list: ${error.message}`,
      loadedPlugins: [],
    };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Unexpected non-array output from agy plugin list", loadedPlugins: [] };
  }

  const loadedPlugins = parsed.map((entry) => ({
    name: entry.name,
    enabled: entry.enabled,
    version: entry.version,
    path: entry.path,
    rules: entry.rules ?? [],
    hooks: entry.hooks ?? [],
  }));

  const expectedName = pluginManifest.name || "hstack";
  if (loadedPlugins.length !== 1) {
    return {
      ok: false,
      error: `Plugin isolation failed: expected only [${expectedName}], found [${loadedPlugins.map((p) => p.name).join(", ")}]`,
      loadedPlugins,
    };
  }

  const [onlyPlugin] = loadedPlugins;
  if (onlyPlugin.name !== expectedName || onlyPlugin.enabled !== true) {
    return {
      ok: false,
      error: `Expected enabled plugin "${expectedName}", found "${onlyPlugin.name}" (enabled=${onlyPlugin.enabled})`,
      loadedPlugins,
    };
  }

  if (safeRealpath(onlyPlugin.path || "") !== safeRealpath(pluginDest)) {
    return {
      ok: false,
      error: `Plugin path not isolated: expected ${safeRealpath(pluginDest)}, got ${onlyPlugin.path}`,
      loadedPlugins,
    };
  }

  if (pluginManifest.version && onlyPlugin.version !== pluginManifest.version) {
    return {
      ok: false,
      error: `Plugin version mismatch: expected ${pluginManifest.version}, got ${onlyPlugin.version}`,
      loadedPlugins,
    };
  }

  if (!Array.isArray(onlyPlugin.rules) || !onlyPlugin.rules.includes("AGENTS.md")) {
    return {
      ok: false,
      error: `Plugin "${expectedName}" loaded without AGENTS.md rule`,
      loadedPlugins,
    };
  }

  const expectedHookKeys = Object.keys(readHooksConfig());
  const missingHooks = expectedHookKeys.filter(
    (hookKey) => !Array.isArray(onlyPlugin.hooks) || !onlyPlugin.hooks.includes(hookKey),
  );
  if (missingHooks.length > 0) {
    return {
      ok: false,
      error: `Plugin "${expectedName}" loaded without expected hook group(s): ${missingHooks.join(", ")}`,
      loadedPlugins,
    };
  }

  return { ok: true, loadedPlugins };
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

function resolveIsolatedTranscriptPath(appDataDir, conversationId) {
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

// SYSTEM_MESSAGE drift markers only; PreToolUse denials (GENERIC steps) are counted separately.
function parseInjectionMarker(step) {
  if (isPreToolDenialStep(step)) {
    return null;
  }
  return parseDriftMarkerStep(step);
}

function callNameOf(call) {
  return call && typeof call.name === "string" ? call.name : "";
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

export function summarizeTranscript(steps, testCase = {}) {
  const exemptContentDrift = Boolean(testCase.exemptContentDrift);
  const requiredTools = Array.isArray(testCase.requiredTools) ? testCase.requiredTools : [];
  const requiredToolsExecuted = Object.fromEntries(requiredTools.map((tool) => [tool, false]));
  const deniedTools = [];
  let driftInjections = 0;
  let contentDriftInjections = 0;
  let preToolDenials = 0;
  let lastCorrectionPos = -1;
  let lastDriftedPlannerPos = -1;
  const plannerSteps = [];

  for (let pos = 0; pos < steps.length; pos += 1) {
    const step = steps[pos];
    if (!step || typeof step !== "object") {
      continue;
    }
    if (isPreToolDenialStep(step)) {
      preToolDenials += 1;
      lastCorrectionPos = pos;
      continue;
    }
    const marker = parseInjectionMarker(step);
    if (marker) {
      driftInjections += 1;
      if (marker.fields.includes("content")) {
        contentDriftInjections += 1;
      }
      lastCorrectionPos = pos;
      continue;
    }
    if (step.type !== "PLANNER_RESPONSE") {
      continue;
    }
    const toolCalls = getToolCalls(step);
    // The k-th tool call's result is the k-th GENERIC after this planner step, so only that call is denied.
    const deniedIndexes = deniedToolCallIndexes(steps, pos);
    toolCalls.forEach((call, k) => {
      const name = callNameOf(call);
      if (deniedIndexes.has(k)) {
        if (PRE_TOOL_USE_UI_TOOLS.has(name) && !deniedTools.includes(name)) {
          deniedTools.push(name);
        }
      } else if (Object.hasOwn(requiredToolsExecuted, name)) {
        requiredToolsExecuted[name] = true;
      }
    });
    const evaluation = evaluatePlannerResponse({
      thinking: step.thinking,
      content: step.content,
      uiTexts: extractUiTextsFromToolCalls(toolCalls),
    });
    const rawDriftedFields = evaluation.kind === "drifted" ? evaluation.driftedFields : [];
    const effectiveDriftedFields = exemptContentDrift
      ? rawDriftedFields.filter((field) => field !== "content")
      : rawDriftedFields;
    const effectiveKind = effectiveDriftedFields.length > 0 ? "drifted" : "ok";

    if (effectiveKind === "drifted") {
      lastDriftedPlannerPos = pos;
    }

    plannerSteps.push({
      _pos: pos,
      stepIndex: step.stepIndex,
      kind: effectiveKind,
      driftedFields: effectiveDriftedFields,
      ...(exemptContentDrift ? { contentExempted: true } : {}),
      thinking: formatFieldResult(evaluation.thinking),
      content: formatFieldResult(evaluation.content),
      ui: formatFieldResult(evaluation.ui),
    });
  }

  const missingRequiredTools = requiredTools.filter((tool) => !requiredToolsExecuted[tool]);
  const koreanThinkingStepCount = plannerSteps.filter((step) => step.thinking.status === "korean").length;
  const driftedStepCount = plannerSteps.filter((step) => step.kind === "drifted").length;
  const thinkingWithNaturalText = plannerSteps.filter((step) => step.thinking.naturalCharCount > 0);
  const avgThinkingHangulRatio =
    thinkingWithNaturalText.length > 0
      ? roundRatio(
          thinkingWithNaturalText.reduce((sum, step) => sum + step.thinking.hangulRatio, 0) /
            thinkingWithNaturalText.length,
        )
      : null;

  const totalThinkingHangulChars = plannerSteps.reduce((sum, step) => sum + step.thinking.hangulCount, 0);
  const totalThinkingNaturalChars = plannerSteps.reduce((sum, step) => sum + step.thinking.naturalCharCount, 0);
  const weightedThinkingHangulRatio =
    totalThinkingNaturalChars > 0 ? roundRatio(totalThinkingHangulChars / totalThinkingNaturalChars) : null;

  const finalStepKind = plannerSteps.length > 0 ? plannerSteps[plannerSteps.length - 1].kind : null;
  const driftedThinkingEver = plannerSteps.some((step) => step.driftedFields.includes("thinking"));
  const driftedContentEver = plannerSteps.some((step) => step.driftedFields.includes("content"));
  const driftedUiEver = plannerSteps.some((step) => step.driftedFields.includes("ui"));
  // A PreToolUse denial counts as a ui correction: recovery must show Korean UI labels afterwards.
  const hasKoreanRecovery =
    (driftInjections > 0 || preToolDenials > 0) &&
    finalStepKind === "ok" &&
    plannerSteps.some(
      (step) =>
        step._pos > lastCorrectionPos &&
        step._pos > lastDriftedPlannerPos &&
        step.kind === "ok" &&
        (!driftedThinkingEver || step.thinking.status === "korean") &&
        (!driftedContentEver || step.content.status === "korean") &&
        (!driftedUiEver || step.ui.status !== "drifted") &&
        (preToolDenials === 0 || step.ui.status === "korean") &&
        (step.thinking.status === "korean" || step.content.status === "korean" || step.ui.status === "korean"),
    );

  const hasFalsePositiveContentExemptionInjection =
    exemptContentDrift &&
    (contentDriftInjections > 0 || (driftedStepCount === 0 && driftInjections > 0));
  const contentExemptionPassed = exemptContentDrift
    ? plannerSteps.length > 0 &&
      plannerSteps.every((step) => step.contentExempted === true) &&
      !hasFalsePositiveContentExemptionInjection
    : undefined;

  let status;
  let error = null;
  let falsePositiveDriftInjection = false;

  if (plannerSteps.length === 0) {
    status = "error";
    error = "No PLANNER_RESPONSE steps found in transcript";
  } else if (hasFalsePositiveContentExemptionInjection) {
    status = "error";
    falsePositiveDriftInjection = true;
    error =
      contentDriftInjections > 0
        ? `False-positive content drift injection (${contentDriftInjections}) triggered during explicit-translation case`
        : `False-positive drift injection (${driftInjections}) triggered during explicit-translation case`;
  } else if (missingRequiredTools.length > 0) {
    status = "error";
    error = `Required tool(s) not executed without hook denial: ${missingRequiredTools.join(", ")}`;
  } else if (preToolDenials > 0) {
    status = hasKoreanRecovery ? "recovered" : "drifted";
  } else if (driftedStepCount === 0) {
    status = koreanThinkingStepCount > 0 ? "pass" : "no_thinking";
  } else if (hasKoreanRecovery) {
    status = "recovered";
  } else {
    status = "drifted";
  }

  const publicPlannerSteps = plannerSteps.map(({ _pos, ...rest }) => rest);

  return {
    status,
    driftInjections,
    preToolDenials,
    deniedTools,
    plannerResponseCount: publicPlannerSteps.length,
    koreanThinkingStepCount,
    driftedStepCount,
    avgThinkingHangulRatio,
    weightedThinkingHangulRatio,
    totalThinkingHangulChars,
    totalThinkingNaturalChars,
    finalStepKind,
    ...(requiredTools.length > 0 ? { requiredToolsExecuted, missingRequiredTools } : {}),
    ...(exemptContentDrift ? { contentExemptionPassed, contentDriftInjections } : {}),
    ...(falsePositiveDriftInjection ? { falsePositiveDriftInjection: true } : {}),
    ...(error ? { error } : {}),
    plannerSteps: publicPlannerSteps,
  };
}

function makeErrorResult(model, testCase, error, fields = {}) {
  return {
    model,
    case: testCase.name,
    conversationId: null,
    exitCode: 1,
    ...fields,
    status: "error",
    error,
  };
}

function runLiveCase(model, testCase, options, pluginManifest) {
  let isolated;
  try {
    isolated = createIsolatedEnvironment(testCase, pluginManifest);
  } catch (error) {
    return makeErrorResult(model, testCase, error.message);
  }

  const { runRoot, appDataDir, workspaceDir, pluginDest, env } = isolated;
  try {
    const pluginCheck = verifyIsolatedPlugin(workspaceDir, env, pluginDest, pluginManifest);
    if (!pluginCheck.ok) {
      return makeErrorResult(model, testCase, pluginCheck.error, {
        pluginVerified: false,
        loadedPlugins: pluginCheck.loadedPlugins,
        ...(options.keepLogs ? { runDir: runRoot } : {}),
      });
    }

    const startedAt = Date.now();
    const proc = spawnSync(
      "agy",
      [
        "--model",
        model,
        "--dangerously-skip-permissions",
        "--print-timeout",
        `${options.timeoutSeconds}s`,
        "--output-format",
        "stream-json",
        "-p",
        testCase.prompt,
      ],
      {
        cwd: workspaceDir,
        env,
        encoding: "utf8",
        timeout: options.timeoutMs + HARD_KILL_GRACE_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const elapsedMs = Date.now() - startedAt;

    const exitCode = proc.status ?? 1;
    const conversationId = extractConversationId(proc.stdout || "");
    const runFields = {
      exitCode,
      elapsedMs,
      pluginVerified: true,
      loadedPlugins: pluginCheck.loadedPlugins,
      ...(options.keepLogs ? { runDir: runRoot } : {}),
    };

    if (proc.error) {
      const errorMessage =
        proc.error.code === "ETIMEDOUT"
          ? `agy timed out after ${options.timeoutSeconds}s`
          : proc.error.message;
      return makeErrorResult(model, testCase, errorMessage, { conversationId, ...runFields });
    }

    if (!conversationId) {
      return makeErrorResult(
        model,
        testCase,
        (proc.stderr || "No conversation_id found in agy stream-json output").trim(),
        runFields,
      );
    }

    const transcriptPath = resolveIsolatedTranscriptPath(appDataDir, conversationId);
    if (!transcriptPath) {
      return makeErrorResult(
        model,
        testCase,
        `Transcript not found in isolated appDataDir for conversation ${conversationId}`,
        { conversationId, ...runFields },
      );
    }

    const rawTranscript = readFileSync(transcriptPath, "utf8");
    const steps = parseTranscriptJsonl(rawTranscript);
    const analysis = summarizeTranscript(steps, testCase);

    const status = exitCode !== 0 ? "error" : analysis.status;
    const error =
      exitCode !== 0
        ? (proc.stderr || `agy exited with ${exitCode}`).trim()
        : analysis.error;

    return {
      model,
      case: testCase.name,
      conversationId,
      exitCode,
      elapsedMs,
      pluginVerified: true,
      loadedPlugins: pluginCheck.loadedPlugins,
      ...(options.keepLogs ? { runDir: runRoot, transcriptPath } : {}),
      ...analysis,
      status,
      ...(error ? { error } : {}),
    };
  } finally {
    if (!options.keepLogs) {
      rmSync(runRoot, { recursive: true, force: true });
    }
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

  const pluginManifest = readPluginManifest();
  const results = [];
  for (const model of options.models) {
    for (const testCase of options.cases) {
      results.push(runLiveCase(model, testCase, options, pluginManifest));
    }
  }

  const totals = {
    runs: results.length,
    pass: results.filter((entry) => entry.status === "pass").length,
    recovered: results.filter((entry) => entry.status === "recovered").length,
    drifted: results.filter((entry) => entry.status === "drifted").length,
    no_thinking: results.filter((entry) => entry.status === "no_thinking").length,
    error: results.filter((entry) => entry.status === "error").length,
  };

  const report = {
    models: options.models,
    cases: options.cases.map((entry) => entry.name),
    timeoutSeconds: options.timeoutSeconds,
    keepLogs: options.keepLogs,
    totals,
    results,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (totals.error > 0 || totals.drifted > 0 || totals.no_thinking > 0) {
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url) && !process.env.NODE_TEST_CONTEXT) {
  main();
}
