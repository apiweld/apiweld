import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DriftIssue {
  path: string;
  expected: string;
  received: string;
}

export function appendDrift(entry: { operation: string; issues: DriftIssue[] }, logPath = process.env.APIWELD_DRIFT_LOG ?? ".apiweld/drift.log.jsonl"): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const line = JSON.stringify({ time: new Date().toISOString(), operation: entry.operation, issues: entry.issues });
  appendFileSync(logPath, `${line}\n`);
}
