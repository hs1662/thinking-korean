import { resolvePluginDataDir } from "../hook-io.mjs";
import { readGovernanceConfig } from "./audit-log.mjs";
import {
  ALLOWED_AUDIT_ESCALATION_MODES,
  DEFAULT_RISK_THRESHOLDS,
  DEFAULT_SENSITIVE_PATTERNS,
} from "./constants.mjs";

export function resolveAuditEscalationMode(dataDir = resolvePluginDataDir(), configOverride = null) {
  const envVal =
    typeof process.env.HSTACK_AUDIT_ESCALATION === "string"
      ? process.env.HSTACK_AUDIT_ESCALATION.trim().toLowerCase()
      : "";
  if (ALLOWED_AUDIT_ESCALATION_MODES.has(envVal)) {
    return envVal;
  }

  const config = configOverride ?? readGovernanceConfig(dataDir);
  const cfgVal =
    typeof config?.auditEscalation === "string" ? config.auditEscalation.trim().toLowerCase() : "";
  if (ALLOWED_AUDIT_ESCALATION_MODES.has(cfgVal)) {
    return cfgVal;
  }

  return "auto";
}

const MAX_CUSTOM_SENSITIVE_PATTERNS = 50;
const NESTED_QUANTIFIER_RE = /\([^()]*[+*?][^()]*\)[+*?{]|\([^()]*\|[^()]*\)[+*?{]/;
const BACKREFERENCE_RE = /\\[1-9]/;

function isSafeCustomRegex(source) {
  if (typeof source !== "string") {
    return false;
  }
  const trimmed = source.trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    return false;
  }
  if (NESTED_QUANTIFIER_RE.test(trimmed) || BACKREFERENCE_RE.test(trimmed)) {
    return false;
  }
  return true;
}

function compileSensitivePatterns(rawPatterns) {
  if (!Array.isArray(rawPatterns) || rawPatterns.length === 0) {
    return DEFAULT_SENSITIVE_PATTERNS;
  }
  const compiled = [];
  for (const item of rawPatterns.slice(0, MAX_CUSTOM_SENSITIVE_PATTERNS)) {
    if (item instanceof RegExp) {
      if (isSafeCustomRegex(item.source)) {
        compiled.push(item);
      }
    } else if (isSafeCustomRegex(item)) {
      try {
        compiled.push(new RegExp(item.trim(), "i"));
      } catch {
        continue;
      }
    }
  }
  return compiled.length > 0 ? compiled : DEFAULT_SENSITIVE_PATTERNS;
}

function toPositiveInt(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 1 ? num : fallback;
}

function sumChangedLines(codeFiles, diffNumstat) {
  if (!(diffNumstat instanceof Map) || diffNumstat.size === 0) {
    return 0;
  }
  let total = 0;
  for (const filePath of codeFiles) {
    const stat = diffNumstat.get(filePath);
    if (!stat || typeof stat !== "object") {
      continue;
    }
    const added = Number.isFinite(stat.added) ? Math.max(0, stat.added) : 0;
    const deleted = Number.isFinite(stat.deleted) ? Math.max(0, stat.deleted) : 0;
    total += added + deleted;
  }
  return total;
}

export function classifyRisk({ turnCodeWrittenFiles, gitLedger, config = null } = {}) {
  const codeFiles =
    turnCodeWrittenFiles instanceof Set
      ? Array.from(turnCodeWrittenFiles)
      : Array.isArray(turnCodeWrittenFiles)
        ? Array.from(new Set(turnCodeWrittenFiles.filter((p) => typeof p === "string" && p.length > 0)))
        : [];

  if (codeFiles.length === 0) {
    return {
      tier: "TIER_0",
      reasons: [],
      matchedSensitiveFiles: [],
      changedLines: 0,
    };
  }

  const patterns = compileSensitivePatterns(config?.sensitivePatterns);
  const minCodeFiles = toPositiveInt(config?.riskThresholds?.minCodeFiles, DEFAULT_RISK_THRESHOLDS.minCodeFiles);
  const minChangedLines = toPositiveInt(
    config?.riskThresholds?.minChangedLines,
    DEFAULT_RISK_THRESHOLDS.minChangedLines,
  );

  const matchedSensitiveFiles = [];
  for (const filePath of codeFiles) {
    if (patterns.some((re) => re.test(filePath))) {
      matchedSensitiveFiles.push(filePath);
    }
  }

  const changedLines = sumChangedLines(codeFiles, gitLedger?.diffNumstat);
  const reasons = [];
  if (matchedSensitiveFiles.length > 0) {
    reasons.push("sensitive_path");
  }
  if (codeFiles.length >= minCodeFiles) {
    reasons.push("large_file_count");
  }
  if (changedLines >= minChangedLines) {
    reasons.push("large_diff_lines");
  }

  return {
    tier: reasons.length > 0 ? "TIER_1" : "TIER_0",
    reasons,
    matchedSensitiveFiles,
    changedLines,
  };
}
