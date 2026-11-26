import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { resolvePluginDataDir } from "../hook-io.mjs";
import {
  DEFAULT_POLLUTION_THRESHOLDS,
  HANDOFF_COPY,
} from "./constants.mjs";
import { normalizeWorkspacePath } from "./fact-ledger.mjs";

const MAX_SNAPSHOTS_PER_WORKSPACE = 20;
const MAX_LIST_SNAPSHOTS = 10;
const MAX_RECENT_VERIFICATIONS = 5;
const SAFE_SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL_SPAN_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const FILE_PATH_TOKEN_RE = /(?:^|[\s`'"(\[])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.[A-Za-z0-9]{1,10})(?=$|[\s`'")\],:;])/g;
const PASS_CLAIM_RE = /(?:통과|성공|모두\s*통과|pass(?:ed)?)/i;
const TEST_CONTEXT_RE = /(?:테스트|검증|빌드|린트|test|vitest|jest|pytest|cargo\s+test|go\s+test)/i;
const MAX_HASH_FILE_BYTES = 256 * 1024;

function safeRealpath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return "";
  }
  try {
    return realpathSync(rawPath.trim());
  } catch {
    return resolve(rawPath.trim());
  }
}

export function computeWorkspaceKey(cwd, gitRoot = "") {
  const base = safeRealpath(gitRoot || cwd || process.cwd());
  return createHash("sha256").update(base, "utf8").digest("hex").slice(0, 12);
}

function atomicWriteJson(targetPath, data) {
  const dir = resolve(targetPath, "..");
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}

function computeDirtyFingerprint(dirtyFiles, baseDir) {
  if (!Array.isArray(dirtyFiles) || dirtyFiles.length === 0 || !baseDir) {
    return "";
  }
  const hasher = createHash("sha256");
  for (const relPath of [...dirtyFiles].sort()) {
    hasher.update(relPath, "utf8");
    hasher.update("\0");
    const absPath = join(baseDir, relPath);
    try {
      const st = statSync(absPath);
      if (st.isFile()) {
        if (st.size <= MAX_HASH_FILE_BYTES) {
          hasher.update(readFileSync(absPath));
        } else {
          hasher.update(`size:${st.size}:mtime:${st.mtimeMs}`);
        }
      } else {
        hasher.update("nonfile");
      }
    } catch {
      hasher.update("missing");
    }
    hasher.update("\n");
  }
  return hasher.digest("hex").slice(0, 16);
}

function sanitizeSessionFileId(conversationId) {
  if (typeof conversationId !== "string") {
    return "";
  }
  const trimmed = conversationId.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (SAFE_SESSION_ID_RE.test(trimmed)) {
    return trimmed;
  }
  return createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 24);
}

export function resolveSessionStatePath(conversationId, dataDir = resolvePluginDataDir()) {
  const safeId = sanitizeSessionFileId(conversationId);
  if (!safeId) {
    return "";
  }
  return join(dataDir, "sessions", `${safeId}.json`);
}

export function readSessionState(conversationId, dataDir = resolvePluginDataDir()) {
  const filePath = resolveSessionStatePath(conversationId, dataDir);
  if (!filePath || !existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function updateSessionPollutionState({
  conversationId,
  turnStartStepIndex = null,
  inputTokens = null,
  failedExecutionsInTurn = 0,
  maxSingleFileEdits = 0,
  thresholds = DEFAULT_POLLUTION_THRESHOLDS,
  dataDir = resolvePluginDataDir(),
} = {}) {
  const filePath = resolveSessionStatePath(conversationId, dataDir);
  if (!filePath) {
    return null;
  }

  const prev = readSessionState(conversationId, dataDir) ?? {};
  const isNewTurn =
    typeof turnStartStepIndex === "number" &&
    Number.isFinite(turnStartStepIndex) &&
    typeof prev.turnStartStepIndex === "number" &&
    prev.turnStartStepIndex !== turnStartStepIndex;

  const mergedInputTokens =
    typeof inputTokens === "number" && Number.isFinite(inputTokens)
      ? Math.max(inputTokens, Number.isFinite(prev.inputTokens) ? prev.inputTokens : 0)
      : (Number.isFinite(prev.inputTokens) ? prev.inputTokens : null);
  const nextFailed = Number.isFinite(failedExecutionsInTurn) ? failedExecutionsInTurn : 0;
  const nextEdits = Number.isFinite(maxSingleFileEdits) ? maxSingleFileEdits : 0;
  const mergedFailed = isNewTurn
    ? nextFailed
    : Math.max(nextFailed, Number.isFinite(prev.failedExecutionsInTurn) ? prev.failedExecutionsInTurn : 0);
  const mergedFileEdits = isNewTurn
    ? nextEdits
    : Math.max(nextEdits, Number.isFinite(prev.maxSingleFileEdits) ? prev.maxSingleFileEdits : 0);

  const tokenLimit = thresholds?.inputTokensWarning ?? DEFAULT_POLLUTION_THRESHOLDS.inputTokensWarning;
  const failLimit = thresholds?.failedExecutionsInTurn ?? DEFAULT_POLLUTION_THRESHOLDS.failedExecutionsInTurn;
  const churnLimit = thresholds?.repeatedFileEditChurn ?? DEFAULT_POLLUTION_THRESHOLDS.repeatedFileEditChurn;

  const pollutionAlert =
    (mergedInputTokens !== null && mergedInputTokens >= tokenLimit) ||
    mergedFailed >= failLimit ||
    mergedFileEdits >= churnLimit;

  const state = {
    conversationId,
    turnStartStepIndex:
      typeof turnStartStepIndex === "number" && Number.isFinite(turnStartStepIndex)
        ? turnStartStepIndex
        : (typeof prev.turnStartStepIndex === "number" ? prev.turnStartStepIndex : 0),
    updatedAt: new Date().toISOString(),
    inputTokens: mergedInputTokens,
    failedExecutionsInTurn: mergedFailed,
    maxSingleFileEdits: mergedFileEdits,
    pollutionAlert,
  };

  try {
    atomicWriteJson(filePath, state);
  } catch {
  }
  return state;
}

function summarizeDiffStat(gitLedger) {
  if (!gitLedger?.diffNumstat || !(gitLedger.diffNumstat instanceof Map) || gitLedger.diffNumstat.size === 0) {
    return "변경량 없음";
  }
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const stat of gitLedger.diffNumstat.values()) {
    files += 1;
    added += Number.isFinite(stat?.added) ? stat.added : 0;
    deleted += Number.isFinite(stat?.deleted) ? stat.deleted : 0;
  }
  return `${files}개 파일 (+${added} / -${deleted}줄)`;
}

function collectRecentVerifications(ledger) {
  const execs = Array.isArray(ledger?.turnExecutions) ? ledger.turnExecutions : [];
  const verifications = execs.filter((exec) => exec.kind === "verification");
  return verifications.slice(-MAX_RECENT_VERIFICATIONS).map((exec) => ({
    command: exec.command || "",
    passed: Boolean(exec.passed),
    stepIndex: exec.stepIndex,
  }));
}

function detectEpistemicWarnings(verifiedFacts, ledger, cwd, gitRoot) {
  const warnings = [];
  const readFiles = ledger?.sessionReadFiles instanceof Set ? ledger.sessionReadFiles : new Set();
  const verifications = Array.isArray(ledger?.turnExecutions)
    ? ledger.turnExecutions.filter((exec) => exec.kind === "verification")
    : [];
  const lastVerification = verifications.length > 0 ? verifications[verifications.length - 1] : null;
  const hasUnresolvedFailure = Boolean(lastVerification && !lastVerification.passed);

  for (const fact of verifiedFacts) {
    if (typeof fact !== "string" || fact.trim().length === 0) {
      continue;
    }
    const withoutUrls = fact.replace(URL_SPAN_RE, " ");
    const matches = withoutUrls.matchAll(FILE_PATH_TOKEN_RE);
    for (const match of matches) {
      const candidate = normalizeWorkspacePath(match[1], cwd, gitRoot);
      if (candidate && !readFiles.has(candidate)) {
        const msg = `세션 열람 기록에 없는 파일 \`${candidate}\` 이 확인된 사실에 언급되었습니다.`;
        if (!warnings.includes(msg)) {
          warnings.push(msg);
        }
      }
    }
    if (hasUnresolvedFailure && TEST_CONTEXT_RE.test(fact) && PASS_CLAIM_RE.test(fact)) {
      const msg = `최근 검증 실행(\`${lastVerification.command}\`)이 실패 상태인데 확인된 사실에서 통과를 주장했습니다.`;
      if (!warnings.includes(msg)) {
        warnings.push(msg);
      }
    }
  }
  return warnings;
}

function generateSnapshotId() {
  const iso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${iso}-${suffix}`;
}

function pruneOldSnapshots(workspaceDir) {
  try {
    const entries = readdirSync(workspaceDir)
      .filter((name) => name.endsWith(".json") && name !== "latest.json")
      .map((name) => {
        const fullPath = join(workspaceDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(fullPath).mtimeMs;
        } catch {
        }
        return { name, fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

    if (entries.length <= MAX_SNAPSHOTS_PER_WORKSPACE) {
      return 0;
    }
    let removed = 0;
    for (const old of entries.slice(MAX_SNAPSHOTS_PER_WORKSPACE)) {
      try {
        unlinkSync(old.fullPath);
        removed += 1;
      } catch {
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

function normalizeTextArray(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.filter((v) => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

export function saveHandoffSnapshot({
  input = {},
  ledger = null,
  gitLedger = null,
  cwd = "",
  conversationId = "",
  dataDir = resolvePluginDataDir(),
} = {}) {
  const gitRoot = typeof gitLedger?.gitRoot === "string" ? gitLedger.gitRoot : "";
  const workspaceKey = computeWorkspaceKey(cwd, gitRoot);
  const workspaceDir = join(dataDir, "handoffs", workspaceKey);
  const snapshotId = generateSnapshotId();

  const objective = typeof input.objective === "string" ? input.objective.trim() : "";
  const verifiedFacts = normalizeTextArray(input.verified_facts);
  const failedApproaches = normalizeTextArray(input.failed_approaches);
  const remainingTasks = normalizeTextArray(input.remaining_tasks);
  const openRisks = normalizeTextArray(input.open_risks);

  const unverifiedWarnings = ledger?.transcriptAvailable
    ? detectEpistemicWarnings(verifiedFacts, ledger, cwd, gitRoot)
    : [];

  let maxSingleFileEdits = Number.isFinite(ledger?.maxSingleFileEdits) ? ledger.maxSingleFileEdits : 0;
  if (maxSingleFileEdits === 0 && ledger?.fileEditCounts instanceof Map) {
    for (const count of ledger.fileEditCounts.values()) {
      if (count > maxSingleFileEdits) {
        maxSingleFileEdits = count;
      }
    }
  }

  const dirtyFilesSorted = Array.from(gitLedger?.gitDirtyFiles ?? []).sort();
  const dirtyFingerprint = computeDirtyFingerprint(dirtyFilesSorted, gitRoot || cwd);

  const snapshot = {
    schemaVersion: 1,
    snapshotId,
    workspaceKey,
    savedAt: new Date().toISOString(),
    sourceConversationId: conversationId,
    objective,
    verifiedFacts,
    failedApproaches,
    remainingTasks,
    openRisks,
    unverifiedWarnings,
    machineEvidence: {
      gitBranch: gitLedger?.gitBranch ?? "",
      gitHead: gitLedger?.gitHead ?? "",
      dirtyFiles: dirtyFilesSorted,
      dirtyFingerprint,
      diffStatSummary: summarizeDiffStat(gitLedger),
      sessionReadFiles: Array.from(ledger?.sessionReadFiles ?? []).sort().slice(0, 40),
      turnWrittenFiles: Array.from(ledger?.turnWrittenFiles ?? []).sort(),
      recentVerifications: collectRecentVerifications(ledger),
      sourceMetrics: {
        inputTokens: ledger?.latestTokens?.inputTokens ?? null,
        failedExecutionsInTurn: ledger?.turnFailedExecutionCount ?? 0,
        maxSingleFileEdits,
      },
    },
  };

  atomicWriteJson(join(workspaceDir, `${snapshotId}.json`), snapshot);
  atomicWriteJson(join(workspaceDir, "latest.json"), snapshot);
  const prunedCount = pruneOldSnapshots(workspaceDir);

  return { snapshot, workspaceKey, prunedCount };
}

function sameStringList(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function formatLoadedHandoffText(snapshot, { treeChanged = false } = {}) {
  const lines = [
    "[팩트 증류 인수인계서]",
    `- 스냅샷: \`${snapshot.snapshotId}\` (저장 시각: \`${snapshot.savedAt}\`)`,
    `- 목표: ${snapshot.objective || "미기재"}`,
  ];

  if (treeChanged) {
    lines.push(HANDOFF_COPY.staleTreeWarning);
  }

  const ev = snapshot.machineEvidence ?? {};
  lines.push(
    `- 작업 공간 기준: 브랜치 \`${ev.gitBranch || "미확인"}\`, 커밋 \`${ev.gitHead || "없음"}\`, 변경량 ${ev.diffStatSummary || "없음"}`,
  );

  if (Array.isArray(ev.dirtyFiles) && ev.dirtyFiles.length > 0) {
    lines.push(`- 수정 중인 파일: ${ev.dirtyFiles.slice(0, 8).map((f) => `\`${f}\``).join(", ")}`);
  }

  if (Array.isArray(snapshot.verifiedFacts) && snapshot.verifiedFacts.length > 0) {
    lines.push("확인된 사실:");
    for (const fact of snapshot.verifiedFacts.slice(0, 6)) {
      lines.push(`- ${fact}`);
    }
  }

  if (Array.isArray(snapshot.failedApproaches) && snapshot.failedApproaches.length > 0) {
    lines.push("실패하거나 폐기한 접근:");
    for (const item of snapshot.failedApproaches.slice(0, 4)) {
      lines.push(`- ${item}`);
    }
  }

  if (Array.isArray(snapshot.remainingTasks) && snapshot.remainingTasks.length > 0) {
    lines.push("남은 작업:");
    for (const task of snapshot.remainingTasks.slice(0, 6)) {
      lines.push(`- ${task}`);
    }
  }

  if (Array.isArray(snapshot.openRisks) && snapshot.openRisks.length > 0) {
    lines.push("열린 위험:");
    for (const risk of snapshot.openRisks.slice(0, 3)) {
      lines.push(`- ${risk}`);
    }
  }

  if (Array.isArray(ev.recentVerifications) && ev.recentVerifications.length > 0) {
    const summary = ev.recentVerifications
      .slice(-3)
      .map((v) => `\`${v.command}\`(${v.passed ? "통과" : "실패"})`)
      .join(", ");
    lines.push(`- 최근 검증 기록: ${summary}`);
  }

  if (Array.isArray(snapshot.unverifiedWarnings) && snapshot.unverifiedWarnings.length > 0) {
    lines.push("주의(미확인 주장):");
    for (const warn of snapshot.unverifiedWarnings.slice(0, 3)) {
      lines.push(`- ${warn}`);
    }
  }

  return lines.join("\n");
}

export function loadHandoffSnapshot({
  snapshotId = "",
  cwd = "",
  gitLedger = null,
  dataDir = resolvePluginDataDir(),
} = {}) {
  const gitRoot = typeof gitLedger?.gitRoot === "string" ? gitLedger.gitRoot : "";
  const workspaceKey = computeWorkspaceKey(cwd, gitRoot);
  const workspaceDir = join(dataDir, "handoffs", workspaceKey);

  const trimmedId = typeof snapshotId === "string" ? snapshotId.trim() : "";
  if (trimmedId.length > 0 && !SAFE_SNAPSHOT_ID_RE.test(trimmedId)) {
    return {
      ok: false,
      error: "올바르지 않은 스냅샷 식별자 형식입니다. 경로 구분자나 특수 문자 없이 지정해 주세요.",
      workspaceKey,
    };
  }

  const targetFile = trimmedId.length > 0 ? `${trimmedId}.json` : "latest.json";
  const targetPath = join(workspaceDir, targetFile);
  if (!existsSync(targetPath)) {
    return {
      ok: false,
      error:
        trimmedId.length > 0
          ? `요청한 스냅샷 \`${trimmedId}\` 을 현재 작업 공간에서 찾을 수 없습니다.`
          : "현재 작업 공간에 저장된 핸드오프 스냅샷이 없습니다.",
      workspaceKey,
    };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(targetPath, "utf8"));
  } catch {
    return {
      ok: false,
      error: "저장된 스냅샷 파일을 읽을 수 없습니다. 파일이 손상되었는지 확인해 주세요.",
      workspaceKey,
    };
  }

  const savedHead = snapshot?.machineEvidence?.gitHead ?? "";
  const savedDirty = Array.isArray(snapshot?.machineEvidence?.dirtyFiles)
    ? [...snapshot.machineEvidence.dirtyFiles].sort()
    : [];
  const savedFingerprint = typeof snapshot?.machineEvidence?.dirtyFingerprint === "string"
    ? snapshot.machineEvidence.dirtyFingerprint
    : "";
  const currentHead = gitLedger?.gitHead ?? "";
  const currentDirty = Array.from(gitLedger?.gitDirtyFiles ?? []).sort();
  const currentFingerprint =
    savedFingerprint.length > 0 ? computeDirtyFingerprint(currentDirty, gitRoot || cwd) : "";

  const treeChanged = Boolean(
    gitLedger?.gitAvailable &&
      (savedHead !== currentHead ||
        !sameStringList(savedDirty, currentDirty) ||
        (savedFingerprint.length > 0 && savedFingerprint !== currentFingerprint)),
  );

  return {
    ok: true,
    snapshot,
    treeChanged,
    workspaceKey,
    formattedText: formatLoadedHandoffText(snapshot, { treeChanged }),
  };
}

export function listHandoffSnapshots({ cwd = "", gitLedger = null, dataDir = resolvePluginDataDir() } = {}) {
  const gitRoot = typeof gitLedger?.gitRoot === "string" ? gitLedger.gitRoot : "";
  const workspaceKey = computeWorkspaceKey(cwd, gitRoot);
  const workspaceDir = join(dataDir, "handoffs", workspaceKey);
  if (!existsSync(workspaceDir)) {
    return { workspaceKey, items: [] };
  }

  const files = readdirSync(workspaceDir)
    .filter((name) => name.endsWith(".json") && name !== "latest.json")
    .map((name) => {
      const fullPath = join(workspaceDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(fullPath).mtimeMs;
      } catch {
      }
      return { name, fullPath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(0, MAX_LIST_SNAPSHOTS);

  const items = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file.fullPath, "utf8"));
      items.push({
        snapshotId: parsed.snapshotId || file.name.replace(/\.json$/, ""),
        savedAt: parsed.savedAt || "",
        objective: parsed.objective || "",
      });
    } catch {
      continue;
    }
  }
  return { workspaceKey, items };
}
