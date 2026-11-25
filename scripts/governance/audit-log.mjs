import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePluginDataDir } from "../hook-io.mjs";
import { ALLOWED_SCHEMA_REGISTERS } from "./constants.mjs";

export function resolveSchemaRegister(dataDir = resolvePluginDataDir()) {
  const envVal = typeof process.env.HSTACK_SCHEMA_REGISTER === "string" ? process.env.HSTACK_SCHEMA_REGISTER.trim() : "";
  if (ALLOWED_SCHEMA_REGISTERS.has(envVal)) {
    return envVal;
  }

  try {
    const raw = readFileSync(join(dataDir, "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    const configVal = typeof parsed?.schemaRegister === "string" ? parsed.schemaRegister.trim() : "";
    if (ALLOWED_SCHEMA_REGISTERS.has(configVal)) {
      return configVal;
    }
  } catch {
    // fall through to default
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
