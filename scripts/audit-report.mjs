#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDirectExecution, resolvePluginDataDir } from "./hook-io.mjs";

const VERDICT_ORDER = [
  "PASS",
  "REJECT",
  "ESCALATE_AUDIT_REQUIRED",
  "PASS_WITH_WARNING",
  "PASS_WITH_DEGRADATION",
  "PASS_WITH_AUDIT_DEGRADATION",
  "SKIPPED_NO_SESSION",
];

const SESSION_ROLES = ["main", "auditor", "worker", "challenger"];
const SCHEMA_REGISTERS = ["neutral", "audit"];
const RISK_REASON_KEYS = ["sensitive_path", "large_file_count", "large_diff_lines"];
const PREFLIGHT_VERDICT_KEYS = ["PROCEED", "CONDITIONAL", "RETHINK", "ERROR", "MISSING_VERDICT"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function mapToPlainCounts(map) {
  const out = {};
  for (const [key, value] of map.entries()) {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export const USAGE_TEXT = [
  "사용법: node ./scripts/audit-report.mjs [옵션]",
  "",
  "옵션:",
  "  --file <path>          대상 audit.jsonl 경로를 직접 지정합니다.",
  "  --days <N>             최근 N일(ts 기준, 양의 정수) 레코드만 집계합니다.",
  "  --since <YYYY-MM-DD>   지정 날짜(UTC 00:00:00Z) 이후 레코드만 집계합니다.",
  "  --group-by day|week    기간별 추이 집계 단위 (기본값: day)",
  "  --json                 기계 판독용 JSON만 표준 출력에 기록합니다.",
  "  -h, --help             사용법을 출력하고 종료합니다.",
].join("\n");

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function toFiniteNumber(value) {
  return isFiniteNumber(value) ? value : null;
}

function formatPercent(numerator, denominator) {
  if (!denominator || denominator <= 0) {
    return "0.0%";
  }
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function round1(value) {
  if (!isFiniteNumber(value)) {
    return null;
  }
  return Math.round(value * 10) / 10;
}

function formatMs(value) {
  return isFiniteNumber(value) ? `${value.toFixed(1)} ms` : "-";
}

function formatFloat(value, digits = 1) {
  return isFiniteNumber(value) ? value.toFixed(digits) : "-";
}

function formatInt(value) {
  return isFiniteNumber(value) ? Math.round(value).toLocaleString("en-US") : "-";
}

function parseIsoDateBoundary(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.trim().match(DATE_ONLY_RE);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const check = new Date(utcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return utcMs;
}

function parseTimestampMs(ts) {
  if (typeof ts !== "string" || ts.trim().length === 0) {
    return null;
  }
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function formatUtcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatIsoWeek(ms) {
  const date = new Date(ms);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utc - yearStart) / MS_PER_DAY + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function computeLatencyStats(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { count: 0, avg: null, p50: null, p95: null, max: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const percentile = (p) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  };
  return {
    count: sorted.length,
    avg: round1(sum / sorted.length),
    p50: round1(percentile(0.5)),
    p95: round1(percentile(0.95)),
    max: round1(sorted[sorted.length - 1]),
  };
}

function normalizeEventType(record) {
  const raw =
    typeof record.eventType === "string" && record.eventType.trim().length > 0
      ? record.eventType.trim()
      : typeof record.event === "string" && record.event.trim().length > 0
        ? record.event.trim()
        : "";

  if (raw === "gate_verify") return "gate_verify";
  if (raw === "preflight_complete") return "preflight_complete";
  if (raw === "handoff_save") return "handoff_save";
  if (raw === "handoff_load") return "handoff_load";
  if (raw === "post_telemetry" || raw === "post_invocation") return "post_telemetry";
  if (raw === "stop_decision") return "stop_decision";
  if (typeof record.verdict === "string" && record.verdict.length > 0) return "gate_verify";
  if (raw.length > 0) return raw;
  return "unknown";
}

const SCAN_LATENCY_ALIASES = {
  ledgerScanMs: ["ledgerScanMs", "ledger_scan_ms", "ledgerMs", "ledger"],
  gitScanMs: ["gitScanMs", "git_scan_ms", "gitMs", "git"],
};

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractScanLatency(record, key) {
  const aliases = SCAN_LATENCY_ALIASES[key] ?? [key];
  const containers = [
    record.metrics,
    record.metrics?.timings,
    record.metrics?.scanMs,
    record.timings,
    record.scanMs,
    record,
  ];
  for (const container of containers) {
    if (!isPlainObject(container)) {
      continue;
    }
    for (const alias of aliases) {
      const value = toFiniteNumber(container[alias]);
      if (value !== null && value >= 0) {
        return value;
      }
    }
  }
  return null;
}

function extractPollutionFlag(record) {
  if (typeof record.pollutionAlert === "boolean") {
    return record.pollutionAlert;
  }
  if (typeof record.metrics?.pollutionAlert === "boolean") {
    return record.metrics.pollutionAlert;
  }
  if (typeof record.contextHealth?.pollutionAlert === "boolean") {
    return record.contextHealth.pollutionAlert;
  }
  return null;
}

function extractTokenValue(record, key) {
  const fromMetrics = toFiniteNumber(record.metrics?.[key]);
  if (fromMetrics !== null && fromMetrics >= 0) {
    return fromMetrics;
  }
  const fromHealth = toFiniteNumber(record.contextHealth?.[key]);
  if (fromHealth !== null && fromHealth >= 0) {
    return fromHealth;
  }
  return null;
}

export function resolveAuditLogPath(options = {}) {
  const explicitFile = typeof options.file === "string" ? options.file.trim() : "";
  if (explicitFile.length > 0) {
    return resolve(explicitFile);
  }

  const hasCustomEnv = options.env !== undefined;
  const env = options.env ?? process.env;
  const checkExists = typeof options.existsSync === "function" ? options.existsSync : existsSync;
  const home = typeof options.homedir === "string" && options.homedir.length > 0 ? options.homedir : homedir();

  for (const key of ["PLUGIN_DATA", "HSTACK_DATA_DIR"]) {
    if (typeof env[key] === "string" && env[key].trim().length > 0) {
      return join(env[key].trim(), "audit.jsonl");
    }
  }
  if (typeof env.ANTIGRAVITY_APP_DATA_DIR === "string" && env.ANTIGRAVITY_APP_DATA_DIR.trim().length > 0) {
    return join(env.ANTIGRAVITY_APP_DATA_DIR.trim(), "plugin_data", "hstack", "audit.jsonl");
  }

  const defaultHomePath = join(home, ".gemini", "antigravity-cli", "plugin_data", "hstack", "audit.jsonl");
  const fallbackDataDir = hasCustomEnv ? join(tmpdir(), "hstack-data") : resolvePluginDataDir();
  const fallbackPath = join(fallbackDataDir, "audit.jsonl");

  if (checkExists(defaultHomePath)) {
    return defaultHomePath;
  }
  if (checkExists(fallbackPath)) {
    return fallbackPath;
  }
  return defaultHomePath;
}

export function parseCliArgs(argv) {
  const options = {
    file: "",
    days: null,
    since: null,
    sinceMs: null,
    groupBy: "day",
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--file 옵션에는 파일 경로가 필요합니다.");
      }
      options.file = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--file=")) {
      const value = arg.slice("--file=".length).trim();
      if (!value) {
        throw new Error("--file 옵션에는 파일 경로가 필요합니다.");
      }
      options.file = value;
      continue;
    }
    if (arg === "--days" || arg.startsWith("--days=")) {
      const raw = arg === "--days" ? argv[i + 1] : arg.slice("--days=".length);
      if (arg === "--days") {
        i += 1;
      }
      if (!raw || !/^\d+$/.test(raw.trim())) {
        throw new Error("--days 옵션은 1 이상의 정수여야 합니다.");
      }
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error("--days 옵션은 1 이상의 정수여야 합니다.");
      }
      options.days = parsed;
      continue;
    }
    if (arg === "--since" || arg.startsWith("--since=")) {
      const raw = arg === "--since" ? argv[i + 1] : arg.slice("--since=".length);
      if (arg === "--since") {
        i += 1;
      }
      const sinceMs = parseIsoDateBoundary(raw);
      if (sinceMs === null) {
        throw new Error("--since 옵션은 유효한 YYYY-MM-DD 형식이어야 합니다.");
      }
      options.since = raw.trim();
      options.sinceMs = sinceMs;
      continue;
    }
    if (arg === "--group-by" || arg.startsWith("--group-by=")) {
      const raw = arg === "--group-by" ? argv[i + 1] : arg.slice("--group-by=".length);
      if (arg === "--group-by") {
        i += 1;
      }
      if (raw !== "day" && raw !== "week") {
        throw new Error("--group-by 옵션은 day 또는 week만 허용됩니다.");
      }
      options.groupBy = raw;
      continue;
    }
    throw new Error(`알 수 없는 옵션입니다: ${arg}`);
  }

  return options;
}

export function parseAuditLines(content) {
  if (typeof content !== "string" || content.length === 0) {
    return { records: [], malformedLines: 0 };
  }

  const records = [];
  let malformedLines = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformedLines += 1;
      continue;
    }
    const tsMs = parseTimestampMs(parsed.ts);
    records.push({
      ...parsed,
      _eventType: normalizeEventType(parsed),
      _tsMs: tsMs,
    });
  }

  return { records, malformedLines };
}

export function summarizeAuditRecords(parsedInput, options = {}) {
  const rawRecords = Array.isArray(parsedInput)
    ? parsedInput.map((rec) => ({
        ...rec,
        _eventType: rec._eventType ?? normalizeEventType(rec),
        _tsMs: rec._tsMs ?? parseTimestampMs(rec.ts),
      }))
    : Array.isArray(parsedInput?.records)
      ? parsedInput.records
      : [];
  const malformedLines = Number.isInteger(parsedInput?.malformedLines) ? parsedInput.malformedLines : 0;
  const filePath = typeof options.filePath === "string" ? options.filePath : "";
  const fileExists = options.fileExists !== false;
  const groupBy = options.groupBy === "week" ? "week" : "day";
  const nowMs = isFiniteNumber(options.nowMs) ? options.nowMs : Date.now();
  const days = Number.isInteger(options.days) && options.days >= 1 ? options.days : null;
  const sinceMs =
    isFiniteNumber(options.sinceMs)
      ? options.sinceMs
      : typeof options.since === "string"
        ? parseIsoDateBoundary(options.since)
        : null;

  let cutoffMs = null;
  if (days !== null) {
    cutoffMs = nowMs - days * MS_PER_DAY;
  }
  if (sinceMs !== null) {
    cutoffMs = cutoffMs === null ? sinceMs : Math.max(cutoffMs, sinceMs);
  }

  const filtered =
    cutoffMs === null
      ? rawRecords
      : rawRecords.filter((rec) => rec._tsMs !== null && rec._tsMs >= cutoffMs);

  let minTsMs = null;
  let maxTsMs = null;
  const eventCounts = {
    gate_verify: 0,
    preflight_complete: 0,
    handoff_save: 0,
    handoff_load: 0,
    post_telemetry: 0,
    stop_decision: 0,
    other: 0,
  };
  const verdictsMap = new Map(VERDICT_ORDER.map((v) => [v, 0]));
  const sessionRoles = { main: 0, auditor: 0, worker: 0, unknown: 0 };
  const schemaRegisters = { neutral: 0, audit: 0, unknown: 0 };
  const periodMap = new Map();
  const ruleMap = new Map();

  let gateTotal = 0;
  let gateRejects = 0;
  let firstAttemptTotal = 0;
  let firstAttemptRejects = 0;

  const tierCounts = { TIER_0: 0, TIER_1: 0, unknown: 0 };
  let tier1Escalations = 0;
  const auditVerdictCounts = {
    PASS: 0,
    REJECT: 0,
    PASS_WITH_AUDIT_DEGRADATION: 0,
    ERROR: 0,
    MISSING_VERDICT: 0,
  };
  const riskReasonMap = new Map(RISK_REASON_KEYS.map((key) => [key, 0]));

  const preflightTurnMap = new Map();
  let syntheticPreflightSeq = 0;
  const makePreflightTurnKey = (rec) => {
    const cid = typeof rec.conversationId === "string" ? rec.conversationId.trim() : "";
    const turnStart = isFiniteNumber(rec.turnStartStepIndex) ? rec.turnStartStepIndex : null;
    if (cid.length > 0 && turnStart !== null) {
      return `${cid}::${turnStart}`;
    }
    syntheticPreflightSeq += 1;
    return `__anon_${syntheticPreflightSeq}`;
  };
  const recordPreflightTurn = (rec, { verdict, voted }) => {
    const key = makePreflightTurnKey(rec);
    const normVerdict = PREFLIGHT_VERDICT_KEYS.includes(verdict) ? verdict : "MISSING_VERDICT";
    const existing = preflightTurnMap.get(key);
    if (!existing) {
      preflightTurnMap.set(key, { verdict: normVerdict, voted: Boolean(voted) });
      return;
    }
    if (normVerdict !== "MISSING_VERDICT" || existing.verdict === "MISSING_VERDICT") {
      existing.verdict = normVerdict;
    }
    if (voted === true) {
      existing.voted = true;
    }
  };

  let pollutionCheckedCount = 0;
  let pollutionAlertCount = 0;
  let inputTokenSum = 0;
  let inputTokenCount = 0;
  let cacheReadTokenSum = 0;
  let cacheReadTokenCount = 0;
  let unverifiedScopeSum = 0;
  let unverifiedScopeSamples = 0;
  let fillerUnverifiedTotal = 0;

  const ledgerScanSamples = [];
  const gitScanSamples = [];

  for (const rec of filtered) {
    if (rec._tsMs !== null) {
      if (minTsMs === null || rec._tsMs < minTsMs) minTsMs = rec._tsMs;
      if (maxTsMs === null || rec._tsMs > maxTsMs) maxTsMs = rec._tsMs;
    }

    const ev = rec._eventType;
    if (Object.hasOwn(eventCounts, ev)) {
      eventCounts[ev] += 1;
    } else {
      eventCounts.other += 1;
    }

    const ledgerMs = extractScanLatency(rec, "ledgerScanMs");
    if (ledgerMs !== null) ledgerScanSamples.push(ledgerMs);
    const gitMs = extractScanLatency(rec, "gitScanMs");
    if (gitMs !== null) gitScanSamples.push(gitMs);

    const pollutionFlag = extractPollutionFlag(rec);
    if (pollutionFlag !== null) {
      pollutionCheckedCount += 1;
      if (pollutionFlag) pollutionAlertCount += 1;
    }

    const inputTok = extractTokenValue(rec, "inputTokens");
    if (inputTok !== null) {
      inputTokenSum += inputTok;
      inputTokenCount += 1;
    }
    const cacheTok = extractTokenValue(rec, "cacheReadTokens");
    if (cacheTok !== null) {
      cacheReadTokenSum += cacheTok;
      cacheReadTokenCount += 1;
    }

    if (ev === "preflight_complete") {
      recordPreflightTurn(rec, {
        verdict: typeof rec.verdict === "string" ? rec.verdict : "MISSING_VERDICT",
        voted: rec.voted === true,
      });
      continue;
    }

    if (ev !== "gate_verify") {
      continue;
    }

    if (isPlainObject(rec.preflight) && rec.preflight.used === true) {
      recordPreflightTurn(rec, {
        verdict: typeof rec.preflight.verdict === "string" ? rec.preflight.verdict : "MISSING_VERDICT",
        voted: rec.preflight.voted === true,
      });
    }

    gateTotal += 1;
    const verdict = typeof rec.verdict === "string" ? rec.verdict : "UNKNOWN";
    verdictsMap.set(verdict, (verdictsMap.get(verdict) ?? 0) + 1);
    if (verdict === "REJECT") {
      gateRejects += 1;
    }
    if (rec.attemptInTurn === 1) {
      firstAttemptTotal += 1;
      if (verdict === "REJECT") {
        firstAttemptRejects += 1;
      }
    }

    const role = typeof rec.sessionRole === "string" ? rec.sessionRole : "";
    if (SESSION_ROLES.includes(role)) {
      if (!Object.hasOwn(sessionRoles, role)) {
        sessionRoles[role] = 0;
      }
      sessionRoles[role] += 1;
    } else {
      sessionRoles.unknown += 1;
    }

    const register = typeof rec.schemaRegister === "string" ? rec.schemaRegister : "";
    if (SCHEMA_REGISTERS.includes(register)) {
      schemaRegisters[register] += 1;
    } else {
      schemaRegisters.unknown += 1;
    }

    const bucketKey =
      rec._tsMs === null ? "미상" : groupBy === "week" ? formatIsoWeek(rec._tsMs) : formatUtcDay(rec._tsMs);
    if (!periodMap.has(bucketKey)) {
      periodMap.set(bucketKey, { period: bucketKey, total: 0, rejects: 0, escalations: 0 });
    }
    const bucket = periodMap.get(bucketKey);
    bucket.total += 1;
    if (verdict === "REJECT") bucket.rejects += 1;
    if (verdict === "ESCALATE_AUDIT_REQUIRED") bucket.escalations += 1;

    if (Array.isArray(rec.blockedRules)) {
      for (const rule of rec.blockedRules) {
        if (typeof rule !== "string" || rule.length === 0) continue;
        const entry = ruleMap.get(rule) ?? { rule, blocked: 0, warned: 0, total: 0 };
        entry.blocked += 1;
        entry.total += 1;
        ruleMap.set(rule, entry);
      }
    }
    if (Array.isArray(rec.warnedRules)) {
      for (const rule of rec.warnedRules) {
        if (typeof rule !== "string" || rule.length === 0) continue;
        const entry = ruleMap.get(rule) ?? { rule, blocked: 0, warned: 0, total: 0 };
        entry.warned += 1;
        entry.total += 1;
        ruleMap.set(rule, entry);
      }
    }

    const riskTier =
      typeof rec.riskTier === "string"
        ? rec.riskTier
        : typeof rec.metrics?.riskTier === "string"
          ? rec.metrics.riskTier
          : "";
    if (riskTier === "TIER_0") {
      tierCounts.TIER_0 += 1;
    } else if (riskTier === "TIER_1") {
      tierCounts.TIER_1 += 1;
    } else {
      tierCounts.unknown += 1;
    }

    if (verdict === "ESCALATE_AUDIT_REQUIRED") {
      tier1Escalations += 1;
    }

    if (verdict === "PASS_WITH_AUDIT_DEGRADATION") {
      auditVerdictCounts.PASS_WITH_AUDIT_DEGRADATION += 1;
    } else if (rec.auditVerdict === "PASS") {
      auditVerdictCounts.PASS += 1;
    } else if (rec.auditVerdict === "REJECT") {
      auditVerdictCounts.REJECT += 1;
    } else if (rec.auditVerdict === "ERROR") {
      auditVerdictCounts.ERROR += 1;
    } else if (rec.auditVerdict === "MISSING_VERDICT") {
      auditVerdictCounts.MISSING_VERDICT += 1;
    }

    if (Array.isArray(rec.riskReasons)) {
      for (const reason of rec.riskReasons) {
        if (typeof reason !== "string" || reason.length === 0) continue;
        riskReasonMap.set(reason, (riskReasonMap.get(reason) ?? 0) + 1);
      }
    }

    const unverifiedCount = toFiniteNumber(rec.metrics?.unverifiedScopeCount);
    if (unverifiedCount !== null && unverifiedCount >= 0) {
      unverifiedScopeSum += unverifiedCount;
      unverifiedScopeSamples += 1;
    }
    const fillerCount = toFiniteNumber(rec.metrics?.fillerUnverifiedCount);
    if (fillerCount !== null && fillerCount >= 0) {
      fillerUnverifiedTotal += fillerCount;
    }
  }

  const periodTrend = Array.from(periodMap.values())
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((row) => ({
      ...row,
      rejectRate: row.total > 0 ? round1((row.rejects / row.total) * 100) : 0,
    }));

  const totalRuleHits = Array.from(ruleMap.values()).reduce((acc, item) => acc + item.total, 0);
  const rules = Array.from(ruleMap.values())
    .sort((a, b) => b.total - a.total || a.rule.localeCompare(b.rule))
    .map((entry) => ({
      ...entry,
      sharePct: totalRuleHits > 0 ? round1((entry.total / totalRuleHits) * 100) : 0,
    }));

  const auditDecidedTotal =
    auditVerdictCounts.PASS +
    auditVerdictCounts.REJECT +
    auditVerdictCounts.PASS_WITH_AUDIT_DEGRADATION +
    auditVerdictCounts.ERROR +
    auditVerdictCounts.MISSING_VERDICT;

  const verdicts = mapToPlainCounts(verdictsMap);
  const riskReasonCounts = mapToPlainCounts(riskReasonMap);

  const preflightVerdictCounts = {
    PROCEED: 0,
    CONDITIONAL: 0,
    RETHINK: 0,
    ERROR: 0,
    MISSING_VERDICT: 0,
  };
  let preflightVotedCount = 0;
  for (const item of preflightTurnMap.values()) {
    if (Object.hasOwn(preflightVerdictCounts, item.verdict)) {
      preflightVerdictCounts[item.verdict] += 1;
    } else {
      preflightVerdictCounts.MISSING_VERDICT += 1;
    }
    if (item.voted) {
      preflightVotedCount += 1;
    }
  }
  const preflightTotal = preflightTurnMap.size;
  const r9RuleEntry = ruleMap.get("R9_PREFLIGHT_UNVOTED") ?? { blocked: 0, warned: 0, total: 0 };

  return {
    meta: {
      filePath,
      fileExists,
      groupBy,
      days,
      since: options.since ?? null,
      dateRange: {
        from: minTsMs !== null ? new Date(minTsMs).toISOString() : null,
        to: maxTsMs !== null ? new Date(maxTsMs).toISOString() : null,
      },
      totalRecords: filtered.length,
      totalUnfilteredRecords: rawRecords.length,
      malformedLines,
    },
    overview: {
      eventCounts,
      gateVerifyTotal: gateTotal,
      verdicts,
      rejectCount: gateRejects,
      rejectRate: gateTotal > 0 ? round1((gateRejects / gateTotal) * 100) : 0,
      firstAttemptTotal,
      firstAttemptRejects,
      firstAttemptRejectRate: firstAttemptTotal > 0 ? round1((firstAttemptRejects / firstAttemptTotal) * 100) : 0,
      sessionRoles,
      schemaRegisters,
      handoff: {
        save: eventCounts.handoff_save,
        load: eventCounts.handoff_load,
      },
    },
    periodTrend,
    rules: {
      totalHits: totalRuleHits,
      items: rules,
    },
    tier1Audit: {
      tiers: tierCounts,
      escalations: tier1Escalations,
      auditVerdicts: auditVerdictCounts,
      auditDecidedTotal,
      auditPassRate: auditDecidedTotal > 0 ? round1((auditVerdictCounts.PASS / auditDecidedTotal) * 100) : 0,
      riskReasons: riskReasonCounts,
    },
    contextHealth: {
      pollutionCheckedCount,
      pollutionAlertCount,
      pollutionAlertRate:
        pollutionCheckedCount > 0 ? round1((pollutionAlertCount / pollutionCheckedCount) * 100) : 0,
      avgInputTokens: inputTokenCount > 0 ? round1(inputTokenSum / inputTokenCount) : null,
      avgCacheReadTokens: cacheReadTokenCount > 0 ? round1(cacheReadTokenSum / cacheReadTokenCount) : null,
      avgUnverifiedScopeCount:
        unverifiedScopeSamples > 0 ? round1(unverifiedScopeSum / unverifiedScopeSamples) : null,
      fillerUnverifiedTotal,
    },
    scanLatencyMs: {
      ledgerScanMs: computeLatencyStats(ledgerScanSamples),
      gitScanMs: computeLatencyStats(gitScanSamples),
    },
    preflight: {
      totalChallenges: preflightTotal,
      verdicts: preflightVerdictCounts,
      votedCount: preflightVotedCount,
      voteCompletionRate: preflightTotal > 0 ? round1((preflightVotedCount / preflightTotal) * 100) : 0,
      r9BlockedCount: r9RuleEntry.blocked,
      r9WarnedCount: r9RuleEntry.warned,
    },
  };
}

export function formatAuditReportTable(summary) {
  const { meta, overview, periodTrend, rules, tier1Audit, contextHealth, scanLatencyMs } = summary;
  const preflight = summary.preflight ?? {
    totalChallenges: 0,
    verdicts: { PROCEED: 0, CONDITIONAL: 0, RETHINK: 0, ERROR: 0, MISSING_VERDICT: 0 },
    votedCount: 0,
    voteCompletionRate: 0,
    r9BlockedCount: 0,
    r9WarnedCount: 0,
  };
  const rangeLabel =
    meta.dateRange.from && meta.dateRange.to
      ? `${meta.dateRange.from.slice(0, 19).replace("T", " ")}Z ~ ${meta.dateRange.to.slice(0, 19).replace("T", " ")}Z`
      : "기록 없음";

  const lines = [];
  lines.push("=== hstack 감사 로그 요약 리포트 ===");
  lines.push("");

  lines.push("[1] 전체 요약");
  lines.push(`- 대상 파일: ${meta.filePath || "(직접 입력)"}${meta.fileExists ? "" : " (파일 없음)"}`);
  lines.push(`- 기간 범위: ${rangeLabel}`);
  lines.push(
    `- 유효 레코드: ${meta.totalRecords}건 (전체 ${meta.totalUnfilteredRecords}건, 손상 줄 ${meta.malformedLines}건)`,
  );
  lines.push(
    `- gate_verify 호출: ${overview.gateVerifyTotal}건 | 전체 반려율: ${formatPercent(overview.rejectCount, overview.gateVerifyTotal)} (${overview.rejectCount}/${overview.gateVerifyTotal}) | 1차 반려율: ${formatPercent(overview.firstAttemptRejects, overview.firstAttemptTotal)} (${overview.firstAttemptRejects}/${overview.firstAttemptTotal})`,
  );
  lines.push(
    `- 판정 분포: ${VERDICT_ORDER.map((v) => `${v}=${overview.verdicts[v] ?? 0}`).join(", ")}`,
  );
  lines.push(
    `- sessionRole 분포: main=${overview.sessionRoles.main}, auditor=${overview.sessionRoles.auditor}, worker=${overview.sessionRoles.worker}${overview.sessionRoles.challenger > 0 ? `, challenger=${overview.sessionRoles.challenger}` : ""}${overview.sessionRoles.unknown > 0 ? `, 미기재=${overview.sessionRoles.unknown}` : ""}`,
  );
  lines.push(
    `- schemaRegister 분포: neutral=${overview.schemaRegisters.neutral}, audit=${overview.schemaRegisters.audit}${overview.schemaRegisters.unknown > 0 ? `, 미기재=${overview.schemaRegisters.unknown}` : ""}`,
  );
  lines.push(
    `- 핸드오프 건수: save=${overview.handoff.save}, load=${overview.handoff.load} (보조 텔레메트리: post=${overview.eventCounts.post_telemetry}, stop=${overview.eventCounts.stop_decision})`,
  );
  lines.push("");

  lines.push(`[2] 기간별 반려율 추이 (단위: ${meta.groupBy})`);
  if (periodTrend.length === 0) {
    lines.push("- 집계 대상 gate_verify 레코드가 없습니다.");
  } else {
    lines.push("기간        | 호출 | 반려 | 반려율 | 에스컬레이션");
    lines.push("------------+------+------+--------+-------------");
    for (const row of periodTrend) {
      lines.push(
        `${row.period.padEnd(11)} | ${String(row.total).padStart(4)} | ${String(row.rejects).padStart(4)} | ${`${row.rejectRate.toFixed(1)}%`.padStart(6)} | ${String(row.escalations).padStart(12)}`,
      );
    }
  }
  lines.push("");

  lines.push("[3] R1~R9 규칙 위반·경고 분포");
  if (rules.items.length === 0) {
    lines.push("- 기록된 규칙 위반·경고가 없습니다.");
  } else {
    lines.push("규칙                         | 차단 | 경고 | 합계 | 비중");
    lines.push("-----------------------------+------+------+------+-------");
    for (const item of rules.items) {
      lines.push(
        `${item.rule.padEnd(28)} | ${String(item.blocked).padStart(4)} | ${String(item.warned).padStart(4)} | ${String(item.total).padStart(4)} | ${`${item.sharePct.toFixed(1)}%`.padStart(5)}`,
      );
    }
  }
  lines.push("");

  lines.push("[4] Tier 1 독립 감사 현황");
  lines.push(
    `- 위험 등급: TIER_0=${tier1Audit.tiers.TIER_0}, TIER_1=${tier1Audit.tiers.TIER_1}${tier1Audit.tiers.unknown > 0 ? `, 미기재=${tier1Audit.tiers.unknown}` : ""}`,
  );
  lines.push(`- 에스컬레이션(ESCALATE_AUDIT_REQUIRED): ${tier1Audit.escalations}건`);
  lines.push(
    `- 감사 판정: PASS=${tier1Audit.auditVerdicts.PASS}, REJECT=${tier1Audit.auditVerdicts.REJECT}, PASS_WITH_AUDIT_DEGRADATION=${tier1Audit.auditVerdicts.PASS_WITH_AUDIT_DEGRADATION}, ERROR=${tier1Audit.auditVerdicts.ERROR}, MISSING_VERDICT=${tier1Audit.auditVerdicts.MISSING_VERDICT} | 통과율: ${tier1Audit.auditDecidedTotal > 0 ? `${tier1Audit.auditPassRate.toFixed(1)}%` : "-"}`,
  );
  const reasonParts = Object.entries(tier1Audit.riskReasons).map(([reason, count]) => `${reason}=${count}`);
  lines.push(`- 위험 사유 분포: ${reasonParts.join(", ")}`);
  lines.push("");

  lines.push("[5] 컨텍스트 오염 경보 및 미검증 보고");
  lines.push(
    `- 오염 경보(pollutionAlert=true): ${contextHealth.pollutionAlertCount}건 / ${contextHealth.pollutionCheckedCount}건 (${contextHealth.pollutionCheckedCount > 0 ? `${contextHealth.pollutionAlertRate.toFixed(1)}%` : "-"})`,
  );
  lines.push(
    `- 평균 토큰: inputTokens=${formatInt(contextHealth.avgInputTokens)}, cacheReadTokens=${formatInt(contextHealth.avgCacheReadTokens)}`,
  );
  lines.push(
    `- 미검증 보고: 평균 unverifiedScopeCount=${formatFloat(contextHealth.avgUnverifiedScopeCount, 2)}, fillerUnverifiedCount 합계=${contextHealth.fillerUnverifiedTotal}건`,
  );
  lines.push("");

  lines.push("[6] 로컬 스캔 지연 통계");
  lines.push("항목          | 표본 | 평균     | 중앙(p50) | p95      | 최대");
  lines.push("--------------+------+----------+-----------+----------+---------");
  for (const [label, stats] of [
    ["ledgerScanMs", scanLatencyMs.ledgerScanMs],
    ["gitScanMs", scanLatencyMs.gitScanMs],
  ]) {
    lines.push(
      `${label.padEnd(13)} | ${String(stats.count).padStart(4)} | ${formatMs(stats.avg).padStart(8)} | ${formatMs(stats.p50).padStart(9)} | ${formatMs(stats.p95).padStart(8)} | ${formatMs(stats.max).padStart(8)}`,
    );
  }
  lines.push("");

  lines.push("[7] 적대적 사전 검토(Preflight) 현황");
  lines.push(
    `- 총 사전 검토: ${preflight.totalChallenges}건 | 표결 완료율: ${preflight.totalChallenges > 0 ? `${preflight.voteCompletionRate.toFixed(1)}% (${preflight.votedCount}/${preflight.totalChallenges})` : "-"}`,
  );
  lines.push(
    `- 판정 분포: PROCEED=${preflight.verdicts.PROCEED}, CONDITIONAL=${preflight.verdicts.CONDITIONAL}, RETHINK=${preflight.verdicts.RETHINK}, ERROR=${preflight.verdicts.ERROR}, MISSING_VERDICT=${preflight.verdicts.MISSING_VERDICT}`,
  );
  lines.push(
    `- R9_PREFLIGHT_UNVOTED: 차단=${preflight.r9BlockedCount}건, 경고=${preflight.r9WarnedCount}건`,
  );

  return lines.join("\n");
}

export function runAuditReportCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let parsedArgs;
  try {
    parsedArgs = parseCliArgs(argv);
  } catch (err) {
    stderr.write(`오류: ${err.message}\n${USAGE_TEXT}\n`);
    return 1;
  }

  if (parsedArgs.help) {
    stdout.write(`${USAGE_TEXT}\n`);
    return 0;
  }

  const filePath = resolveAuditLogPath({
    file: parsedArgs.file,
    env: io.env ?? process.env,
    homedir: io.homedir,
  });

  let rawText = "";
  let fileExists = false;
  if (existsSync(filePath)) {
    fileExists = true;
    try {
      rawText = readFileSync(filePath, "utf8");
    } catch (err) {
      stderr.write(`오류: 감사 로그 파일을 읽을 수 없습니다 (${filePath}): ${err.message}\n`);
      return 1;
    }
  }

  const parsed = parseAuditLines(rawText);
  const summary = summarizeAuditRecords(parsed, {
    filePath,
    fileExists,
    days: parsedArgs.days,
    since: parsedArgs.since,
    sinceMs: parsedArgs.sinceMs,
    groupBy: parsedArgs.groupBy,
    nowMs: io.nowMs,
  });

  if (parsedArgs.json) {
    stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    stdout.write(`${formatAuditReportTable(summary)}\n`);
  }
  return 0;
}

if (isDirectExecution(import.meta.url)) {
  process.exitCode = runAuditReportCli();
}
