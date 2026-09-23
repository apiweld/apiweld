import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { checkApis, type ApiCheck, type ClassifiedFinding } from "./check.js";
import { editApiEntry, loadProjectConfig, outputDir, writeOperationTypes } from "./config.js";
import type { ApiEntry, ApiweldConfig } from "./define-config.js";
import { writeDriftRuntime } from "./drift.js";
import { engineVersion } from "./engine.js";
import { ApiweldError } from "./errors.js";
import { getGenerator } from "./generator.js";
import { assertApiKey, isObject, prettyJson } from "./json.js";
import { freshDiagnostics, identifiers, typecheckProject, withIsolatedTree, type TypeDiagnostic } from "./impact.js";
import { hashDirectory, readLock, writeLock, type LockApi, type LockFile } from "./lock.js";
import { ensureDir, projectPaths, type Runtime } from "./paths.js";
import { getApi } from "./catalog.js";
import { canonicalSource, resolveSource } from "./resolvers.js";
import { resolveOperationRefs, sliceDocument } from "./slicer.js";
import { normalizeToStore, specPath } from "./store.js";
import { fetchCached } from "./http.js";
import { describeOperation } from "./describe.js";

const exec = promisify(execFile);

function outputDirOption(cwd: string, output: string | undefined): string {
  const trimmed = (output ?? "src/apis").trim().replace(/\/+$/, "") || "src/apis";
  if (trimmed.includes("\0") || /[\r\n]/.test(trimmed)) {
    throw new ApiweldError("Output directory must be a relative path inside the project");
  }
  const relative = path.relative(cwd, path.resolve(cwd, trimmed));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ApiweldError("Output directory must stay inside the project");
  }
  return relative.split(path.sep).join("/");
}

function initConfig(output: string): string {
  return `import { defineConfig } from "apiweld";

export default defineConfig({
  output: ${JSON.stringify(output)},
  generator: {
    name: "hey-api",
    client: "fetch",
    validators: "zod",
  },
  verify: {
    typecheck: true,
  },
  apis: {},
});
`;
}

const AGENTS_SECTION = `## Third-party APIs

Use Apiweld for third-party HTTP APIs. Search the local catalog, add only the operations you call, and import the generated client. Do not hand-write those HTTP calls or install the provider's full SDK.

\`\`\`json
{
  "mcpServers": {
    "apiweld": {
      "command": "apiweld",
      "args": ["mcp"]
    }
  }
}
\`\`\`
`;

export async function initProject(
  rt: Runtime,
  opts: { agents?: boolean; output?: string } = {},
): Promise<{ created: string[] }> {
  const paths = projectPaths(rt.cwd);
  const created: string[] = [];
  if (!fs.existsSync(paths.config)) {
    fs.writeFileSync(paths.config, initConfig(outputDirOption(rt.cwd, opts.output)));
    created.push(paths.config);
  }
  const ignore = fs.existsSync(paths.gitignore) ? fs.readFileSync(paths.gitignore, "utf8") : "";
  if (!ignore.split("\n").some((line) => line.trim() === ".apiweld/")) {
    fs.writeFileSync(paths.gitignore, `${ignore.trimEnd()}\n.apiweld/\n`);
    created.push(paths.gitignore);
  }
  ensureDir(paths.dot);
  if (opts.agents) {
    for (const file of [paths.agents, paths.claude]) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (!current.includes("## Third-party APIs")) {
        fs.writeFileSync(file, `${current.trimEnd()}\n\n${AGENTS_SECTION}`);
        created.push(file);
      }
    }
  }
  return { created };
}

export async function addOperations(
  rt: Runtime,
  opts: { api: string; as?: string; source?: string; operations: string[] },
): Promise<{ api: string; operations: string[]; files: string[]; importPath: string; edited: boolean; snippet?: string }> {
  const key = opts.as ?? opts.api;
  assertApiKey(key);
  const config = await loadProjectConfig(rt.cwd);
  const source = await resolveAddSource(rt, config, opts.api, key, opts.source);
  const current = config.apis[key]?.operations ?? [];
  const loaded = await materialize(rt, { source, operations: current });
  const spec = JSON.parse(fs.readFileSync(loaded.specPath, "utf8")) as Record<string, unknown>;
  const selected = resolveOperationRefs(spec, opts.operations);
  if (selected.missing.length > 0) {
    throw new ApiweldError(`${key} is missing operations: ${selected.missing.join(", ")}`);
  }
  const kept = resolveOperationRefs(spec, current);
  const operations = [...new Set([...kept.operations, ...selected.operations])].sort();
  const edited = await editApiEntry(rt.cwd, key, (existing) => ({
    source: canonicalSource(existing?.source || source),
    operations,
    policy: existing?.policy ?? { autoRegenerate: "safe" },
    patch: existing?.patch,
    levelOverrides: existing?.levelOverrides,
    allowRemoteHosts: existing?.allowRemoteHosts,
  }));
  if (!edited.edited) {
    throw new ApiweldError(`Could not edit apiweld.config.ts safely. Insert this snippet:\n${edited.snippet ?? ""}`);
  }
  const refreshed = await loadProjectConfig(rt.cwd);
  const entry = refreshed.apis[key];
  if (!entry) throw new ApiweldError(`Could not read ${key} back from apiweld.config.ts`);
  const generated = await generateApi(rt, refreshed, key, entry);
  return {
    api: key,
    operations,
    files: generated.files,
    importPath: path.relative(rt.cwd, generated.outDir),
    edited: edited.edited,
    snippet: edited.snippet,
  };
}

export async function removeOperations(
  rt: Runtime,
  opts: { api: string; operations: string[] },
): Promise<{ api: string; operations: string[]; files: string[] }> {
  assertApiKey(opts.api);
  const config = await loadProjectConfig(rt.cwd);
  const entry = config.apis[opts.api];
  if (!entry) throw new ApiweldError(`API ${opts.api} is not in the config`);
  const loaded = await materialize(rt, entry);
  const spec = JSON.parse(fs.readFileSync(loaded.specPath, "utf8")) as Record<string, unknown>;
  const selected = resolveOperationRefs(spec, opts.operations);
  if (selected.missing.length > 0) {
    throw new ApiweldError(`${opts.api} is missing operations: ${selected.missing.join(", ")}`);
  }
  const drop = new Set(selected.operations);
  const operations = resolveOperationRefs(spec, entry.operations).operations.filter((operation) => !drop.has(operation));
  await editApiEntry(rt.cwd, opts.api, (existing) => ({
    ...(existing ?? entry),
    operations,
  }));
  const refreshed = await loadProjectConfig(rt.cwd);
  const next = refreshed.apis[opts.api];
  if (!next) throw new ApiweldError(`API ${opts.api} disappeared from the config`);
  if (operations.length === 0) {
    fs.rmSync(outputDir(rt, refreshed, opts.api), { recursive: true, force: true });
    const lock = readLock(rt.cwd);
    delete lock.apis[opts.api];
    writeLock(rt.cwd, lock);
    writeOperationTypes(rt.cwd, Object.fromEntries(Object.entries(refreshed.apis).map(([api, value]) => [api, value.operations])));
    return { api: opts.api, operations, files: [] };
  }
  const generated = await generateApi(rt, refreshed, opts.api, next);
  return { api: opts.api, operations, files: generated.files };
}

export async function generateLocked(rt: Runtime, only?: string): Promise<{ apis: string[]; files: string[] }> {
  const config = await loadProjectConfig(rt.cwd);
  const lock = readLock(rt.cwd);
  const names = Object.keys(config.apis).filter((api) => !only || api === only);
  const files: string[] = [];
  for (const api of names) {
    const entry = config.apis[api];
    const locked = lock.apis[api];
    if (!entry) continue;
    if (!locked) throw new ApiweldError(`${api} is not in the lockfile. Run \`apiweld add\` first.`);
    const file = specPath(rt.cacheDir, locked.specHash);
    if (!fs.existsSync(file)) throw new ApiweldError(`Locked spec for ${api} is not in the cache`);
    const generated = await generateFromSpec(rt, config, api, entry, file, locked.resolvedUrl, locked.etag);
    files.push(...generated.files);
  }
  return { apis: names, files };
}

async function generateApi(rt: Runtime, config: ApiweldConfig, api: string, entry: ApiEntry) {
  const loaded = await materialize(rt, entry);
  return generateFromSpec(rt, config, api, entry, loaded.specPath, loaded.resolvedUrl, loaded.etag, loaded.specVersion);
}

async function generateFromSpec(
  rt: Runtime,
  config: ApiweldConfig,
  api: string,
  entry: ApiEntry,
  specFile: string,
  resolvedUrl: string,
  etag?: string,
  specVersion?: string,
) {
  const doc = JSON.parse(fs.readFileSync(specFile, "utf8")) as Record<string, unknown>;
  const slice = sliceDocument(doc, entry.operations);
  if (slice.missing.length > 0) {
    throw new ApiweldError(`${api} is missing operations: ${slice.missing.join(", ")}`);
  }
  const outDir = outputDir(rt, config, api);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const generatorName = config.generator?.name ?? "hey-api";
  const adapter = getGenerator(generatorName);
  const generated = await adapter.generate({
    specPath: specFile,
    operations: entry.operations,
    outDir,
    options: {
      client: config.generator?.client ?? "fetch",
      validators: config.generator?.validators ?? false,
      ...(config.generator?.options ?? {}),
    },
    patch: entry.patch,
    apiName: api,
  });
  if (config.generator?.validators === "zod" && generatorName === "hey-api") {
    const driftFile = writeDriftRuntime(outDir, doc, entry.operations);
    generated.files.push(driftFile);
    appendDriftExport(outDir);
  }
  const version = isObject(doc.info) && typeof doc.info.version === "string" ? doc.info.version : specVersion ?? "";
  const output = hashDirectory(outDir);
  const lock = readLock(rt.cwd);
  const storedHash = path.basename(specFile, ".json");
  lock.apis[api] = {
    resolvedUrl,
    specHash: storedHash.startsWith("sha256") ? `sha256:${storedHash}` : hashOfFile(specFile),
    specVersion: version,
    fetchedAt: new Date().toISOString(),
    etag,
    operations: [...entry.operations].sort(),
    sliceHash: slice.sliceHash,
    schemas: slice.schemas.length,
    generator: await adapter.version(),
    engine: await engineVersion(),
    outputHash: output.hash,
  };
  // spec files are named <hex>.json and hashes are sha256:<hex>
  lock.apis[api].specHash = `sha256:${path.basename(specFile, ".json")}`;
  writeLock(rt.cwd, lock);
  const types: Record<string, string[]> = {};
  const fresh = await loadProjectConfig(rt.cwd);
  for (const [name, value] of Object.entries(fresh.apis)) types[name] = value.operations;
  writeOperationTypes(rt.cwd, types);
  return { files: generated.files, outDir, lock: lock.apis[api] as LockApi };
}

function hashOfFile(file: string): string {
  return `sha256:${path.basename(file, ".json")}`;
}

function appendDriftExport(outDir: string): void {
  const index = path.join(outDir, "index.ts");
  const line = `export { reportResponse, reportingFetch } from "./apiweld-drift";\n`;
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, line);
    return;
  }
  const current = fs.readFileSync(index, "utf8");
  if (!current.includes("apiweld-drift")) fs.appendFileSync(index, `\n${line}`);
}

async function materialize(rt: Runtime, entry: ApiEntry) {
  const resolved = await resolveSource(entry.source, rt);
  if (resolved.kind === "file") {
    const stored = await normalizeToStore(rt.cacheDir, resolved.url);
    return { ...stored, resolvedUrl: resolved.url, etag: undefined as string | undefined };
  }
  const fetched = await fetchCached(rt, resolved.url);
  const stored = await normalizeToStore(rt.cacheDir, fetched.file);
  return { ...stored, resolvedUrl: resolved.url, etag: fetched.etag };
}

async function resolveAddSource(
  rt: Runtime,
  config: ApiweldConfig,
  requested: string,
  key: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return canonicalSource(explicit);
  if (config.apis[key]?.source) return canonicalSource(config.apis[key].source);
  if (config.apis[requested]?.source) return canonicalSource(config.apis[requested].source);
  const row = getApi(rt.cacheDir, requested) ?? getApi(rt.cacheDir, key);
  if (!row) throw new ApiweldError(`No source for ${requested}. Pass --source or add it to the catalog.`);
  const source = canonicalSource(row.source);
  if (source.startsWith("file:")) return `file:${row.spec_url}`;
  if (/^https?:\/\//.test(source) || source.startsWith("apisguru:") || source.startsWith("wellknown:")) return source;
  return `file:${row.spec_url}`;
}

export async function showApi(
  rt: Runtime,
  api: string,
  operation?: string,
  depth = 1,
): Promise<{ api: string; text: string }> {
  const config = fs.existsSync(projectPaths(rt.cwd).config)
    ? await loadProjectConfig(rt.cwd).catch(() => undefined)
    : undefined;
  const entry = config?.apis[api];
  let specFile: string | undefined;
  if (entry) {
    const loaded = await materialize(rt, entry);
    specFile = loaded.specPath;
  } else {
    const row = getApi(rt.cacheDir, api);
    if (!row) throw new ApiweldError(`Unknown API ${api}`);
    const loaded = await materialize(rt, { source: row.source.startsWith("file:") ? `file:${row.spec_url}` : `file:${row.spec_url}`, operations: [] });
    specFile = loaded.specPath;
  }
  const doc = JSON.parse(fs.readFileSync(specFile, "utf8")) as Record<string, unknown>;
  if (operation) {
    const selected = resolveOperationRefs(doc, [operation]);
    if (selected.missing.length > 0 || !selected.operations[0]) {
      throw new ApiweldError(`${api} is missing operations: ${operation}`);
    }
    operation = selected.operations[0];
  }
  if (!operation) {
    const paths = isObject(doc.paths) ? doc.paths : {};
    const lines = [`# ${isObject(doc.info) ? doc.info.title : api}`, ""];
    for (const [opPath, item] of Object.entries(paths)) {
      if (!isObject(item)) continue;
      for (const method of Object.keys(item)) {
        if (!["get", "post", "put", "patch", "delete", "head", "options"].includes(method)) continue;
        const op = item[method];
        const summary = isObject(op) && typeof op.summary === "string" ? op.summary : "";
        lines.push(`- ${method.toUpperCase()} ${opPath}${summary ? ` — ${summary}` : ""}`);
      }
    }
    return { api, text: lines.join("\n") };
  }
  return { api, text: describeOperation(doc, api, operation, depth) };
}

export async function updateApis(rt: Runtime, only?: string): Promise<{ apis: ApiCheck[]; regenerated: string[] }> {
  const config = await loadProjectConfig(rt.cwd);
  const checked = await checkApis(rt, {
    apis: config.apis,
    only,
    outputRoot: config.output ?? "src/apis",
  });
  const regenerated: string[] = [];
  for (const result of checked.apis) {
    const entry = config.apis[result.api];
    if (!entry || !result.drift) continue;
    const policy = entry.policy?.autoRegenerate ?? "safe";
    if (result.maxClass === "safe" && policy === "safe") {
      await generateApi(rt, config, result.api, entry);
      regenerated.push(result.api);
      continue;
    }
    if (result.maxClass === "risky") {
      await withIsolatedTree(rt.cwd, async (dir) => {
        const copyRuntime = { ...rt, cwd: dir };
        const copyConfig = await loadProjectConfig(dir);
        const copyEntry = copyConfig.apis[result.api];
        if (!copyEntry) return;
        await generateApi(copyRuntime, copyConfig, result.api, copyEntry);
        typecheckProject(dir);
      });
    }
  }
  return { apis: checked.apis, regenerated };
}

export interface HealPlan {
  api: string;
  from: { specHash: string; version: string };
  to: { specHash: string; version: string };
  findings: Array<ClassifiedFinding & { callSites: Array<{ file: string; line: number; symbol?: string; tsError: string }>; hints: string[] }>;
  verify: { typecheck: string; test?: string };
  workspace: "worktree" | "copy";
  applied: boolean;
}

export async function healApi(rt: Runtime, api: string, opts: { apply?: boolean } = {}): Promise<HealPlan> {
  assertApiKey(api);
  const config = await loadProjectConfig(rt.cwd);
  const entry = config.apis[api];
  if (!entry) throw new ApiweldError(`Unknown API ${api}`);
  const lock = readLock(rt.cwd);
  const previous = lock.apis[api];
  if (!previous) throw new ApiweldError(`${api} is not locked`);
  const loaded = await materialize(rt, entry);
  const oldFile = specPath(rt.cacheDir, previous.specHash);
  const newDoc = JSON.parse(fs.readFileSync(loaded.specPath, "utf8")) as Record<string, unknown>;
  const oldDoc = JSON.parse(fs.readFileSync(oldFile, "utf8")) as Record<string, unknown>;
  const checked = await checkApis(rt, { apis: { [api]: entry }, only: api, outputRoot: config.output ?? "src/apis" });
  const apiCheck = checked.apis[0];
  if (!apiCheck) throw new ApiweldError(`No check result for ${api}`);
  const baseline = typecheckProject(rt.cwd);
  const isolated = await withIsolatedTree(rt.cwd, async (dir) => {
    const copyRuntime = { ...rt, cwd: dir };
    const copyConfig = await loadProjectConfig(dir);
    const copyEntry = copyConfig.apis[api];
    if (!copyEntry) return [] as TypeDiagnostic[];
    await generateFromSpec(
      copyRuntime,
      copyConfig,
      api,
      copyEntry,
      loaded.specPath,
      loaded.resolvedUrl,
      loaded.etag,
      loaded.specVersion,
    );
    const next = typecheckProject(dir);
    if (opts.apply) {
      const from = outputDir(copyRuntime, copyConfig, api);
      const to = outputDir(rt, config, api);
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    }
    return next;
  });
  const fresh = freshDiagnostics(baseline, isolated.value).filter(
    (diagnostic) => !diagnostic.file.startsWith(config.output ?? "src/apis"),
  );
  const findings = apiCheck.findings.map((finding) => ({
    ...finding,
    callSites: matchCallSites(finding, fresh),
    hints: hintsFor(finding, oldDoc, newDoc),
  }));
  const plan: HealPlan = {
    api,
    from: { specHash: previous.specHash, version: previous.specVersion },
    to: { specHash: loaded.specHash, version: loaded.specVersion },
    findings,
    verify: {
      typecheck: "tsc --noEmit",
      test: config.verify?.test,
    },
    workspace: isolated.mode,
    applied: Boolean(opts.apply),
  };
  const dir = projectPaths(rt.cwd).reports;
  ensureDir(dir);
  const base = path.join(dir, `${api}-${new Date().toISOString().slice(0, 10)}-heal`);
  fs.writeFileSync(`${base}.json`, prettyJson(plan));
  fs.writeFileSync(`${base}.md`, renderHeal(plan));
  if (opts.apply) {
    const realLock = readLock(rt.cwd);
    const output = hashDirectory(outputDir(rt, config, api));
    const slice = sliceDocument(newDoc, entry.operations);
    realLock.apis[api] = {
      ...previous,
      resolvedUrl: loaded.resolvedUrl,
      specHash: loaded.specHash,
      specVersion: loaded.specVersion,
      fetchedAt: new Date().toISOString(),
      etag: loaded.etag,
      operations: [...entry.operations].sort(),
      sliceHash: slice.sliceHash,
      schemas: slice.schemas.length,
      outputHash: output.hash,
      engine: await engineVersion(),
    };
    writeLock(rt.cwd, realLock);
    writeOperationTypes(rt.cwd, Object.fromEntries(Object.entries(config.apis).map(([name, value]) => [name, value.operations])));
  }
  return plan;
}

function matchCallSites(finding: ClassifiedFinding, diagnostics: TypeDiagnostic[]) {
  const tokens = identifiers(finding.detail);
  return diagnostics
    .filter((diagnostic) => {
      if (diagnostic.symbol && tokens.has(diagnostic.symbol)) return true;
      const messageTokens = identifiers(diagnostic.message);
      for (const token of messageTokens) if (tokens.has(token)) return true;
      return false;
    })
    .map((diagnostic) => ({
      file: diagnostic.file,
      line: diagnostic.line,
      symbol: diagnostic.symbol,
      tsError: `${diagnostic.code}: ${diagnostic.message}`,
    }));
}

function hintsFor(finding: ClassifiedFinding, oldDoc: Record<string, unknown>, newDoc: Record<string, unknown>): string[] {
  const name = finding.detail.match(/`([A-Za-z0-9_.-]+)`/)?.[1];
  if (!name) return ["Review the finding against the new schema."];
  const properties = schemaProperties(newDoc);
  if (properties.some((property) => property.description?.includes(name))) {
    return [`A field description in the new schema mentions ${name}.`];
  }
  const similar = properties.find((property) => property.name !== name && (property.name.includes(name) || name.includes(property.name)));
  if (similar) return [`Possible related field: ${similar.name}`];
  if (!properties.some((property) => property.name === name)) {
    return ["No replacement field found in the new schema."];
  }
  void oldDoc;
  return ["The field still exists under a different shape."];
}

function schemaProperties(doc: Record<string, unknown>): Array<{ name: string; description?: string }> {
  const schemas = isObject(doc.components) && isObject(doc.components.schemas) ? doc.components.schemas : {};
  const fields: Array<{ name: string; description?: string }> = [];
  for (const schema of Object.values(schemas)) {
    if (!isObject(schema) || !isObject(schema.properties)) continue;
    for (const [name, value] of Object.entries(schema.properties)) {
      fields.push({
        name,
        description: isObject(value) && typeof value.description === "string" ? value.description : undefined,
      });
    }
  }
  return fields;
}

function renderHeal(plan: HealPlan): string {
  const lines = [`# Heal ${plan.api}`, "", `From \`${plan.from.version}\` to \`${plan.to.version}\`.`, ""];
  for (const finding of plan.findings) {
    lines.push(`## ${finding.level}: ${finding.id}`, "", finding.detail, "");
    if (finding.operation) lines.push(`Operation: \`${finding.operation}\``, "");
    if (finding.callSites.length === 0) lines.push("No compiler call sites.", "");
    for (const site of finding.callSites) {
      lines.push(`- \`${site.file}:${site.line}\` ${site.symbol ?? ""} — ${site.tsError}`);
    }
    for (const hint of finding.hints) lines.push(`- Hint: ${hint}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function verifyProject(rt: Runtime): Promise<{
  typecheck: { ok: boolean; errors: TypeDiagnostic[] };
  test?: { ok: boolean; skipped?: boolean; stdout?: string };
}> {
  const config = fs.existsSync(projectPaths(rt.cwd).config)
    ? await loadProjectConfig(rt.cwd)
    : undefined;
  const errors = typecheckProject(rt.cwd);
  const result: {
    typecheck: { ok: boolean; errors: TypeDiagnostic[] };
    test?: { ok: boolean; skipped?: boolean; stdout?: string };
  } = { typecheck: { ok: errors.length === 0, errors } };
  if (config?.verify?.test) {
    try {
      const { stdout, stderr } = await exec("sh", ["-c", config.verify.test], { cwd: rt.cwd });
      result.test = { ok: true, stdout: `${stdout}\n${stderr}`.trim() };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      result.test = { ok: false, stdout: `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`.trim() };
    }
  }
  return result;
}

export function mcpConfigSnippet(): string {
  return AGENTS_SECTION;
}

export type { LockFile };
