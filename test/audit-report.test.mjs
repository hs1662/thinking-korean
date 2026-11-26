import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  formatAuditReportTable,
  parseAuditLines,
  parseCliArgs,
  resolveAuditLogPath,
  summarizeAuditRecords,
} from "../scripts/audit-report.mjs";

const CLI_PATH = resolve("scripts/audit-report.mjs");

function makeTempDir(prefix = "hstack-audit-report-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("audit-report parser and aggregator", () => {
  it("parses mixed Phase 1, Phase 2, and malformed JSONL lines and computes all 6 summary sections", () => {
    const rawJsonl = [
      JSON.stringify({
        ts: "2026-11-20T09:00:00.000Z",
        event: "gate_verify",
        attemptInTurn: 1,
        schemaRegister: "neutral",
        verdict: "REJECT",
        blockedRules: ["R2_STALE_VERIFICATION", "R5_FABRICATED_COMMAND"],
        warnedRules: ["R7_HEDGE_DETECTED"],
        metrics: {
          unverifiedScopeCount: 0,
          fillerUnverifiedCount: 1,
          inputTokens: 10000,
          cacheReadTokens: 20000,
          ledgerScanMs: 10,
          gitScanMs: 20,
        },
      }),
      "{malformed json line",
      "[]",
      JSON.stringify({
        ts: "2026-11-20T09:05:00.000Z",
        event: "gate_verify",
        eventType: "gate_verify",
        attemptInTurn: 2,
        sessionRole: "main",
        schemaRegister: "audit",
        verdict: "ESCALATE_AUDIT_REQUIRED",
        riskTier: "TIER_1",
        riskReasons: ["sensitive_path", "large_diff_lines"],
        auditVerdict: null,
        blockedRules: [],
        warnedRules: [],
        metrics: {
          unverifiedScopeCount: 1,
          fillerUnverifiedCount: 0,
          pollutionAlert: false,
          inputTokens: 20000,
          cacheReadTokens: 40000,
          ledgerScanMs: 30,
          gitScanMs: 40,
        },
      }),
      JSON.stringify({
        ts: "2026-11-25T10:00:00.000Z",
        event: "gate_verify",
        eventType: "gate_verify",
        attemptInTurn: 1,
        sessionRole: "main",
        schemaRegister: "neutral",
        verdict: "PASS",
        riskTier: "TIER_1",
        riskReasons: ["sensitive_path"],
        auditVerdict: "PASS",
        blockedRules: [],
        warnedRules: ["R7_HEDGE_DETECTED"],
        metrics: {
          unverifiedScopeCount: 2,
          fillerUnverifiedCount: 2,
          pollutionAlert: true,
          inputTokens: 30000,
          cacheReadTokens: 60000,
          ledgerScanMs: 50,
          gitScanMs: 60,
        },
      }),
      JSON.stringify({
        ts: "2026-11-25T11:00:00.000Z",
        event: "gate_verify",
        eventType: "gate_verify",
        attemptInTurn: 1,
        sessionRole: "worker",
        schemaRegister: "neutral",
        verdict: "PASS_WITH_AUDIT_DEGRADATION",
        riskTier: "TIER_1",
        riskReasons: ["large_file_count"],
        auditVerdict: "REJECT",
        blockedRules: ["R8_AUDIT_REJECTED"],
        warnedRules: [],
        metrics: {
          unverifiedScopeCount: 1,
          fillerUnverifiedCount: 0,
          pollutionAlert: false,
          inputTokens: 40000,
          cacheReadTokens: 80000,
          ledgerScanMs: 70,
          gitScanMs: 80,
        },
      }),
      JSON.stringify({
        ts: "2026-11-25T12:00:00.000Z",
        event: "gate_verify",
        eventType: "gate_verify",
        attemptInTurn: 1,
        sessionRole: "auditor",
        schemaRegister: "neutral",
        verdict: "PASS",
        riskTier: "TIER_0",
        riskReasons: [],
        auditVerdict: null,
        blockedRules: [],
        warnedRules: [],
        metrics: {
          unverifiedScopeCount: 0,
          fillerUnverifiedCount: 0,
          pollutionAlert: false,
          inputTokens: 50000,
          cacheReadTokens: 100000,
          ledgerScanMs: 90,
          gitScanMs: 100,
        },
      }),
      JSON.stringify({
        ts: "2026-11-25T12:10:00.000Z",
        eventType: "handoff_save",
        snapshotId: "snap-1",
      }),
      JSON.stringify({
        ts: "2026-11-25T12:15:00.000Z",
        eventType: "handoff_load",
        snapshotId: "snap-1",
      }),
      JSON.stringify({
        ts: "2026-11-25T12:20:00.000Z",
        event: "post_invocation",
        pollutionAlert: true,
        metrics: {
          inputTokens: 60000,
          cacheReadTokens: 120000,
        },
      }),
    ].join("\n");

    const parsed = parseAuditLines(rawJsonl);
    assert.equal(parsed.records.length, 8);
    assert.equal(parsed.malformedLines, 2);

    const summary = summarizeAuditRecords(parsed, {
      filePath: "/tmp/audit.jsonl",
      fileExists: true,
      groupBy: "day",
    });

    assert.equal(summary.meta.totalRecords, 8);
    assert.equal(summary.meta.malformedLines, 2);
    assert.equal(summary.overview.gateVerifyTotal, 5);
    assert.equal(summary.overview.rejectCount, 1);
    assert.equal(summary.overview.rejectRate, 20);
    assert.equal(summary.overview.firstAttemptTotal, 4);
    assert.equal(summary.overview.firstAttemptRejects, 1);
    assert.equal(summary.overview.firstAttemptRejectRate, 25);
    assert.deepEqual(summary.overview.sessionRoles, { main: 2, auditor: 1, worker: 1, unknown: 1 });
    assert.deepEqual(summary.overview.schemaRegisters, { neutral: 4, audit: 1, unknown: 0 });
    assert.deepEqual(summary.overview.handoff, { save: 1, load: 1 });

    assert.equal(summary.periodTrend.length, 2);
    assert.deepEqual(summary.periodTrend[0], {
      period: "2026-11-20",
      total: 2,
      rejects: 1,
      escalations: 1,
      rejectRate: 50,
    });
    assert.deepEqual(summary.periodTrend[1], {
      period: "2026-11-25",
      total: 3,
      rejects: 0,
      escalations: 0,
      rejectRate: 0,
    });

    assert.equal(summary.rules.totalHits, 5);
    assert.equal(summary.rules.items[0].rule, "R7_HEDGE_DETECTED");
    assert.equal(summary.rules.items[0].total, 2);
    assert.equal(summary.rules.items[0].sharePct, 40);

    assert.deepEqual(summary.tier1Audit.tiers, { TIER_0: 1, TIER_1: 3, unknown: 1 });
    assert.equal(summary.tier1Audit.escalations, 1);
    assert.deepEqual(summary.tier1Audit.auditVerdicts, {
      PASS: 1,
      REJECT: 0,
      PASS_WITH_AUDIT_DEGRADATION: 1,
    });
    assert.equal(summary.tier1Audit.auditPassRate, 50);
    assert.deepEqual(summary.tier1Audit.riskReasons, {
      sensitive_path: 2,
      large_file_count: 1,
      large_diff_lines: 1,
    });

    assert.equal(summary.contextHealth.pollutionCheckedCount, 5);
    assert.equal(summary.contextHealth.pollutionAlertCount, 2);
    assert.equal(summary.contextHealth.pollutionAlertRate, 40);
    assert.equal(summary.contextHealth.avgInputTokens, 35000);
    assert.equal(summary.contextHealth.avgCacheReadTokens, 70000);
    assert.equal(summary.contextHealth.avgUnverifiedScopeCount, 0.8);
    assert.equal(summary.contextHealth.fillerUnverifiedTotal, 3);

    assert.deepEqual(summary.scanLatencyMs.ledgerScanMs, { count: 5, avg: 50, p50: 50, p95: 90, max: 90 });
    assert.deepEqual(summary.scanLatencyMs.gitScanMs, { count: 5, avg: 60, p50: 60, p95: 100, max: 100 });

    const table = formatAuditReportTable(summary);
    for (const heading of [
      "[1] 전체 요약",
      "[2] 기간별 반려율 추이",
      "[3] R1~R8 규칙 위반·경고 분포",
      "[4] Tier 1 독립 감사 현황",
      "[5] 컨텍스트 오염 경보 및 미검증 보고",
      "[6] 로컬 스캔 지연 통계",
    ]) {
      assert.ok(table.includes(heading), `missing section heading: ${heading}`);
    }
  });

  it("supports --days, --since, --group-by week filtering and safe zero-denominator defaults", () => {
    const parsed = parseAuditLines(
      [
        JSON.stringify({ ts: "2026-11-01T00:00:00.000Z", eventType: "gate_verify", verdict: "REJECT", attemptInTurn: 1 }),
        JSON.stringify({ ts: "2026-11-24T12:00:00.000Z", eventType: "gate_verify", verdict: "PASS", attemptInTurn: 1 }),
      ].join("\n"),
    );

    const byDays = summarizeAuditRecords(parsed, {
      days: 7,
      nowMs: Date.parse("2026-11-26T00:00:00.000Z"),
      groupBy: "week",
    });
    assert.equal(byDays.meta.totalRecords, 1);
    assert.equal(byDays.periodTrend[0].period, "2026-W48");
    assert.equal(byDays.overview.rejectRate, 0);

    const bySince = summarizeAuditRecords(parsed, { since: "2026-11-24" });
    assert.equal(bySince.meta.totalRecords, 1);

    const emptySummary = summarizeAuditRecords(parseAuditLines(""), { filePath: "/none", fileExists: false });
    assert.equal(emptySummary.overview.gateVerifyTotal, 0);
    assert.equal(emptySummary.overview.rejectRate, 0);
    assert.equal(emptySummary.scanLatencyMs.ledgerScanMs.avg, null);
    const renderedEmpty = formatAuditReportTable(emptySummary);
    assert.ok(renderedEmpty.includes("(파일 없음)"));
    assert.ok(renderedEmpty.includes("0.0%"));
  });

  it("resolves default audit.jsonl path by precedence and validates CLI options", () => {
    const resolvedExplicit = resolveAuditLogPath({ file: "./custom-audit.jsonl" });
    assert.equal(resolvedExplicit, resolve("./custom-audit.jsonl"));

    const existing = new Set(["/data/app/plugin_data/hstack/audit.jsonl"]);
    const resolvedAppData = resolveAuditLogPath({
      env: { PLUGIN_DATA: "/missing/plugin", ANTIGRAVITY_APP_DATA_DIR: "/data/app" },
      homedir: "/home/tester",
      existsSync: (p) => existing.has(p),
    });
    assert.equal(resolvedAppData, "/data/app/plugin_data/hstack/audit.jsonl");

    assert.throws(() => parseCliArgs(["--days", "0"]), /1 이상의 정수/);
    assert.throws(() => parseCliArgs(["--days", "abc"]), /1 이상의 정수/);
    assert.throws(() => parseCliArgs(["--since", "2026-02-30"]), /YYYY-MM-DD/);
    assert.throws(() => parseCliArgs(["--group-by", "month"]), /day 또는 week/);
    assert.throws(() => parseCliArgs(["--unknown-flag"]), /알 수 없는 옵션/);
  });
});

describe("audit-report CLI subprocess execution", () => {
  it("runs --help, --json, empty file, missing file, and invalid flags cleanly", () => {
    const helpRes = spawnSync(process.execPath, [CLI_PATH, "--help"], { encoding: "utf8" });
    assert.equal(helpRes.status, 0);
    assert.ok(helpRes.stdout.includes("--group-by"));

    const invalidRes = spawnSync(process.execPath, [CLI_PATH, "--days", "0"], { encoding: "utf8" });
    assert.equal(invalidRes.status, 1);
    assert.ok(invalidRes.stderr.includes("--days"));

    const tempDir = makeTempDir();
    try {
      const missingPath = join(tempDir, "missing.jsonl");
      const missingRes = spawnSync(process.execPath, [CLI_PATH, "--file", missingPath, "--json"], {
        encoding: "utf8",
      });
      assert.equal(missingRes.status, 0);
      const missingJson = JSON.parse(missingRes.stdout);
      assert.equal(missingJson.meta.fileExists, false);
      assert.equal(missingJson.meta.totalRecords, 0);

      const emptyPath = join(tempDir, "empty.jsonl");
      writeFileSync(emptyPath, "", "utf8");
      const emptyRes = spawnSync(process.execPath, [CLI_PATH, "--file", emptyPath], { encoding: "utf8" });
      assert.equal(emptyRes.status, 0);
      assert.ok(emptyRes.stdout.includes("유효 레코드: 0건"));

      const samplePath = join(tempDir, "audit.jsonl");
      writeFileSync(
        samplePath,
        [
          JSON.stringify({
            ts: "2026-11-25T08:00:00.000Z",
            eventType: "gate_verify",
            attemptInTurn: 1,
            sessionRole: "main",
            schemaRegister: "neutral",
            verdict: "PASS",
            riskTier: "TIER_0",
            riskReasons: [],
            blockedRules: [],
            warnedRules: [],
            metrics: { unverifiedScopeCount: 0, fillerUnverifiedCount: 0, ledgerScanMs: 12.5, gitScanMs: 7.5 },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const jsonRes = spawnSync(
        process.execPath,
        [CLI_PATH, "--file", samplePath, "--since", "2026-11-25", "--group-by", "week", "--json"],
        { encoding: "utf8" },
      );
      assert.equal(jsonRes.status, 0);
      const parsedJson = JSON.parse(jsonRes.stdout);
      assert.equal(parsedJson.overview.gateVerifyTotal, 1);
      assert.equal(parsedJson.periodTrend[0].period, "2026-W48");
      assert.equal(parsedJson.scanLatencyMs.ledgerScanMs.p50, 12.5);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
