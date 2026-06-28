// Lightweight, opt-out telemetry. Events append to ~/.ada/telemetry.jsonl, and (if
// ADA_OTLP_ENDPOINT is set) are also POSTed there as JSON. Disable with ADA_TELEMETRY=0.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE = join(homedir(), ".ada", "telemetry.jsonl");
const ENABLED = process.env.ADA_TELEMETRY !== "0";
const OTLP = process.env.ADA_OTLP_ENDPOINT;

export function track(event: string, data: Record<string, unknown> = {}): void {
  if (!ENABLED) return;
  const rec = { ts: new Date().toISOString(), event, ...data };
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, `${JSON.stringify(rec)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
  if (OTLP) {
    fetch(OTLP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) }).catch(() => undefined);
  }
}
