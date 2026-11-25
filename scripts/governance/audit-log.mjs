import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePluginDataDir } from "../hook-io.mjs";
import { ALLOWED_SCHEMA_REGISTERS } from "./constants.mjs";

export function readGovernanceConfig(dataDir = resolvePluginDataDir()) {
  try {
    const raw = readFileSync(join(dataDir, "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function resolveSchemaRegister(dataDir = resolvePluginDataDir()) {
  const envVal = typeof process.env.HSTACK_SCHEMA_REGISTER === "string" ? process.env.HSTACK_SCHEMA_REGISTER.trim() : "";
  if (ALLOWED_SCHEMA_REGISTERS.has(envVal)) {
    return envVal;
  }

  const parsed = readGovernanceConfig(dataDir);
  const configVal = typeof parsed?.schemaRegister === "string" ? parsed.schemaRegister.trim() : "";
  if (ALLOWED_SCHEMA_REGISTERS.has(configVal)) {
    return configVal;
  }

  return "neutral";
}

export function appendAuditRecord(record, dataDir = resolvePluginDataDir()) {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, "audit.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
