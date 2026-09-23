import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiEntry, ChangeClass } from "./define-config.js";
import { readDriftLog } from "./drift.js";
import { engineVersion, runEngine, type EngineFinding } from "./engine.js";
import { ApiweldError } from "./errors.js";
import { fetchCached } from "./http.js";
import { operationKey, parseOperation } from "./json.js";
import { hashDirectory, readLock, writeLock, type LockApi } from "./lock.js";
import { ensureDir, projectPaths, type Runtime } from "./paths.js";
import { resolveSource } from "./resolvers.js";
import { sliceDocument } from "./slicer.js";
import { normalizeToStore } from "./store.js";

export const DEFAULT_PRESLICE_BYTES = 5 * 1024 * 1024;

export interface ClassifiedFinding {
  id: string;
  level: ChangeClass;
  oasdiffLevel: string;
  operation: string;
  operationId?: string;
  detail: string;
}

export interface ApiCheck {
  api: string;
  drift: boolean;
  unusedChange: boolean;
  maxClass?: ChangeClass;
  specHash: string;
  specVersion?: string;
  sliceHash: string;
  previousSliceHash?: string;
  findings: ClassifiedFinding[];
  missing: string[];
  outputEdited: boolean;
  fetchedAt: string;
}

export interface CheckResult {
  ok: boolean;
  fail: boolean;
  drift: boolean;
  apis: ApiCheck[];
  driftLog: ReturnType<typeof readDriftLog>;
  reports?: string[];
}

const rank: Record<ChangeClass, number> = { safe: 0, risky: 1, breaking: 2 };

export function preSliceThreshold(): number {
  const raw = process.env.APIWELD_PRESLICE_BYTES;
  if (!raw) return DEFAULT_PRESLICE_BYTES;
  const value = Number(raw);
  return Number.isFinite(value) ? value : DEFAULT_PRESLICE_BYTES;
}

export async function checkApis(
  rt: Runtime,
  input: {
    apis: Record<string, ApiEntry>;
    only?: string;
    failOn?: ChangeClass;
    outputRoot: string;
  },
): Promise<CheckResult> {
  const lock = readLock(rt.cwd);
  const selected = Object.entries(input.apis).filter(([api]) => !input.only || api === input.only);
  if (input.only && selected.length === 0) throw new ApiweldError(`Unknown API "${input.only}"`);
  const apis: ApiCheck[] = [];
  for (const [api, entry] of selected) {
    apis.push(await checkOne(rt, api, entry, lock.apis[api], input.outputRoot));
  }
  const failOn = input.failOn ?? "breaking";
  const fail = apis.some((api) =>
    api.findings.some((finding) => rank[finding.level] >= rank[failOn]) || api.missing.length > 0,
  );
  const drift = apis.some((api) => api.drift);
  const reports = drift ? writeReports(rt.cwd, apis, readDriftLog(rt.cwd)) : [];
  for (const api of apis) {
    if (!api.unusedChange || api.drift) continue;
    const current = lock.apis[api.api];
    if (!current) continue;
    lock.apis[api.api] = {
      ...current,
      specHash: api.specHash,
      specVersion: api.specVersion ?? current.specVersion,
      sliceHash: api.sliceHash,
      fetchedAt: api.fetchedAt,
    };
  }
  if (apis.some((api) => api.unusedChange && !api.drift)) writeLock(rt.cwd, lock);
  return {
    ok: !fail,
    fail,
    drift,
    apis,
    driftLog: readDriftLog(rt.cwd),
    reports,
  };
}

async function checkOne(
  rt: Runtime,
  api: string,
  entry: ApiEntry,
  locked: LockApi | undefined,
  outputRoot: string,
): Promise<ApiCheck> {
  const loaded = await loadFreshSpec(rt, entry);
  const doc = JSON.parse(fs.readFileSync(loaded.specPath, "utf8")) as Record<string, unknown>;
  const slice = sliceDocument(doc, entry.operations);
  const output = hashDirectory(path.join(rt.cwd, outputRoot, api));
  const outputEdited = Boolean(locked && locked.outputHash && locked.outputHash !== output.hash && output.files.length > 0);
  const base: ApiCheck = {
    api,
    drift: false,
    unusedChange: false,
    specHash: loaded.specHash,
    specVersion: loaded.specVersion,
    sliceHash: slice.sliceHash,
    previousSliceHash: locked?.sliceHash,
    findings: [],
    missing: slice.missing,
    outputEdited,
    fetchedAt: new Date().toISOString(),
  };
  if (!locked) {
    base.drift = true;
    base.maxClass = "breaking";
    base.findings.push({
      id: "api-unpinned",
      level: "breaking",
      oasdiffLevel: "ERR",
      operation: "",
      detail: "API is not in the lockfile yet",
    });
    return base;
  }
  if (slice.sliceHash === locked.sliceHash) {
    base.unusedChange = loaded.specHash !== locked.specHash;
    base.specVersion = loaded.specVersion;
    return base;
  }
  const previous = specFile(rt.cacheDir, locked.specHash);
  if (!fs.existsSync(previous)) {
    throw new ApiweldError(`Locked spec ${locked.specHash} for ${api} is not in the local store`);
  }
  const oldDoc = JSON.parse(fs.readFileSync(previous, "utf8")) as Record<string, unknown>;
  const findings = await diffSpecs(previous, loaded.specPath, oldDoc, doc, entry);
  base.findings = findings;
  base.drift = true;
  base.maxClass = maxClass(findings, slice.missing) ?? "safe";
  return base;
}

function specFile(cacheDir: string, hash: string): string {
  return path.join(cacheDir, "specs", `${hash.replace(/^sha256:/, "")}.json`);
}

async function loadFreshSpec(
  rt: Runtime,
  entry: ApiEntry,
): Promise<{ specPath: string; specHash: string; specVersion: string; etag?: string; resolvedUrl: string }> {
  const resolved = await resolveSource(entry.source, rt);
  if (resolved.kind === "file") {
    const stored = await normalizeToStore(rt.cacheDir, resolved.url);
    return { ...stored, resolvedUrl: resolved.url };
  }
  const fetched = await fetchCached(rt, resolved.url);
  const stored = await normalizeToStore(rt.cacheDir, fetched.file);
  return { ...stored, etag: fetched.etag, resolvedUrl: resolved.url };
}

async function diffSpecs(
  oldPath: string,
  newPath: string,
  oldDoc: Record<string, unknown>,
  newDoc: Record<string, unknown>,
  entry: ApiEntry,
): Promise<ClassifiedFinding[]> {
  let base = oldPath;
  let revision = newPath;
  const threshold = preSliceThreshold();
  if (fs.statSync(oldPath).size > threshold || fs.statSync(newPath).size > threshold) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apiweld-slice-"));
    base = path.join(dir, "old.json");
    revision = path.join(dir, "new.json");
    fs.writeFileSync(base, JSON.stringify(sliceDocument(oldDoc, entry.operations).spec));
    fs.writeFileSync(revision, JSON.stringify(sliceDocument(newDoc, entry.operations).spec));
  }
  const response = await runEngine({ command: "changelog", base, revision });
  const keys = new Set(
    entry.operations.map((op) => {
      const parsed = parseOperation(op);
      return parsed ? operationKey(parsed.method, parsed.path) : op;
    }),
  );
  const findings = (response.findings ?? [])
    .map((finding) => classify(finding, entry))
    .filter((finding) => finding.operation !== "" && keys.has(finding.operation));
  const covered = new Set(findings.map((finding) => finding.operation));
  for (const op of sliceDocument(newDoc, entry.operations).missing) {
    if (!covered.has(op)) {
      findings.push({
        id: "api-removed",
        level: entry.levelOverrides?.["api-removed"] ?? "breaking",
        oasdiffLevel: "ERR",
        operation: op,
        detail: "selected operation no longer exists in the spec",
      });
    }
  }
  return findings;
}

function classify(finding: EngineFinding, entry: ApiEntry): ClassifiedFinding {
  const operation = finding.operation && finding.path
    ? operationKey(finding.operation, finding.path)
    : finding.path ?? "";
  const mapped = finding.level === "ERR" ? "breaking" : finding.level === "WARN" ? "risky" : "safe";
  return {
    id: finding.id,
    level: entry.levelOverrides?.[finding.id] ?? mapped,
    oasdiffLevel: finding.level,
    operation,
    operationId: finding.operationId,
    detail: finding.text,
  };
}

function maxClass(findings: ClassifiedFinding[], missing: string[]): ChangeClass | undefined {
  let best: ChangeClass | undefined;
  for (const finding of findings) {
    if (!best || rank[finding.level] > rank[best]) best = finding.level;
  }
  if (missing.length > 0 && (!best || rank.breaking > rank[best])) best = "breaking";
  return best;
}

function writeReports(cwd: string, apis: ApiCheck[], driftLog: ReturnType<typeof readDriftLog>): string[] {
  const dir = projectPaths(cwd).reports;
  ensureDir(dir);
  const day = new Date().toISOString().slice(0, 10);
  const written: string[] = [];
  for (const api of apis.filter((item) => item.drift)) {
    const base = path.join(dir, `${api.api}-${day}`);
    fs.writeFileSync(`${base}.json`, `${JSON.stringify({ ...api, driftLog }, null, 2)}\n`);
    fs.writeFileSync(`${base}.md`, renderMarkdown(api, driftLog));
    written.push(`${base}.json`, `${base}.md`);
  }
  return written;
}

function renderMarkdown(api: ApiCheck, driftLog: ReturnType<typeof readDriftLog>): string {
  const lines = [`# ${api.api} drift`, "", `Spec \`${api.specHash}\``, ""];
  if (api.missing.length > 0) lines.push(`Missing operations: ${api.missing.join(", ")}`, "");
  if (api.outputEdited) lines.push("Generated files differ from the lock outputHash. Hand edits will be overwritten.", "");
  lines.push("| Class | Operation | Check | Detail |", "| --- | --- | --- | --- |");
  for (const finding of api.findings) {
    lines.push(`| ${finding.level} | ${finding.operation} | ${finding.id} | ${finding.detail.replaceAll("|", "\\|")} |`);
  }
  if (driftLog.length > 0) {
    lines.push("", "## Runtime drift log", "");
    for (const entry of driftLog) {
      for (const issue of entry.issues) {
        lines.push(`- ${entry.operation} \`${issue.path}\` expected ${issue.expected}, received ${issue.received}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function engineLabel(): Promise<string> {
  return engineVersion();
}
