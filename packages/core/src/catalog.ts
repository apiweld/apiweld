import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { ApiweldError } from "./errors.js";
import { runEngine } from "./engine.js";
import { isObject, sha256 } from "./json.js";
import { ensureDir, readSettings, type Runtime } from "./paths.js";
import { normalizeToStore } from "./store.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

export interface ApiRecord {
  id: string;
  provider: string;
  service: string;
  title: string;
  description: string;
  categories: string;
  logo: string;
  source: string;
  spec_url: string;
  origin_url: string;
  spec_version: string;
  updated_at: string;
}

export interface OperationRecord {
  api_id: string;
  method: string;
  path: string;
  operation_id: string;
  summary: string;
  description: string;
  tags: string;
  deprecated: number;
  auth: string;
  title?: string;
  spec_version?: string;
  updated_at?: string;
}

interface CatalogSource {
  id: string;
  provider: string;
  service: string;
  specPath: string;
  source: string;
  originUrl?: string;
}

export function catalogDbPath(cacheDir: string): string {
  return path.join(cacheDir, "catalog.db");
}

function openDatabase(cacheDir: string, reset = false): import("better-sqlite3").Database {
  ensureDir(cacheDir);
  const file = catalogDbPath(cacheDir);
  if (reset && fs.existsSync(file)) fs.rmSync(file);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS apis (
      id TEXT PRIMARY KEY,
      provider TEXT,
      service TEXT,
      title TEXT,
      description TEXT,
      categories TEXT,
      logo TEXT,
      source TEXT,
      spec_url TEXT,
      origin_url TEXT,
      spec_version TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS operations (
      api_id TEXT,
      method TEXT,
      path TEXT,
      operation_id TEXT,
      summary TEXT,
      description TEXT,
      tags TEXT,
      deprecated INTEGER,
      auth TEXT,
      PRIMARY KEY (api_id, method, path)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS ops_fts USING fts5(
      api_id UNINDEXED,
      method UNINDEXED,
      path,
      summary,
      description,
      tags,
      api_title,
      tokenize = 'porter'
    );
    CREATE TABLE IF NOT EXISTS spec_versions (
      api_id TEXT,
      spec_hash TEXT,
      version TEXT,
      fetched_at TEXT,
      PRIMARY KEY (api_id, spec_hash)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

export async function buildCatalog(
  rt: Runtime,
  opts: { from?: string } = {},
): Promise<{ apis: number; operations: number }> {
  const db = openDatabase(rt.cacheDir, true);
  const sources: CatalogSource[] = [];
  if (opts.from) sources.push(...sourcesFrom(opts.from, rt.cwd));
  const settings = readSettings(rt.cacheDir);
  for (const catalog of settings.catalogs ?? []) {
    if (catalog.path) sources.push(...sourcesFromDirectory(catalog.path, rt.cwd, catalog.name));
    for (const url of catalog.urls ?? []) {
      if (rt.offline) throw new ApiweldError(`Offline; cannot fetch custom catalog URL ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new ApiweldError(`Failed to fetch ${url} (${response.status})`);
      const temp = path.join(rt.cacheDir, "incoming", `${catalog.name}.json`);
      ensureDir(path.dirname(temp));
      fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
      sources.push({
        id: catalog.name,
        provider: catalog.name,
        service: catalog.name,
        specPath: temp,
        source: `custom:${catalog.name}`,
        originUrl: url,
      });
    }
  }
  if (!opts.from && (settings.catalogs ?? []).length === 0) {
    await indexApisGuru(rt, db);
  }
  let operations = 0;
  for (const source of sources) {
    operations += await indexSource(rt, db, source);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "built_at",
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schema", "1");
  const apis = db.prepare("SELECT COUNT(*) AS n FROM apis").get() as { n: number };
  db.close();
  return { apis: apis.n, operations };
}

async function indexApisGuru(rt: Runtime, db: import("better-sqlite3").Database): Promise<void> {
  if (rt.offline) {
    throw new ApiweldError("catalog build needs a network or --from <manifest-or-directory>");
  }
  const response = await fetch("https://api.apis.guru/v2/list.json");
  if (!response.ok) throw new ApiweldError(`APIs.guru list failed (${response.status})`);
  const list = (await response.json()) as Record<
    string,
    { preferred?: string; versions?: Record<string, { swaggerUrl?: string; updated?: string; info?: { title?: string; description?: string; version?: string } }> }
  >;
  for (const [id, entry] of Object.entries(list)) {
    const version = entry.preferred ? entry.versions?.[entry.preferred] : undefined;
    const specUrl = version?.swaggerUrl;
    if (!specUrl) continue;
    try {
      const specResponse = await fetch(specUrl);
      if (!specResponse.ok) continue;
      const temp = path.join(rt.cacheDir, "incoming", `${id.replaceAll(/[^\w.-]+/g, "_")}.json`);
      ensureDir(path.dirname(temp));
      fs.writeFileSync(temp, Buffer.from(await specResponse.arrayBuffer()));
      await indexSource(rt, db, {
        id,
        provider: id.split(":")[0] ?? id,
        service: id.includes(":") ? id.split(":").slice(1).join(":") : id,
        specPath: temp,
        source: `apisguru:${id}`,
        originUrl: specUrl,
      });
    } catch {
      // A single broken spec should not abort the snapshot.
    }
  }
}

async function indexSource(
  rt: Runtime,
  db: import("better-sqlite3").Database,
  source: CatalogSource,
): Promise<number> {
  const stored = await normalizeToStore(rt.cacheDir, source.specPath);
  const response = await runEngine({ command: "operations", spec: stored.specPath });
  const doc = JSON.parse(fs.readFileSync(stored.specPath, "utf8")) as Record<string, unknown>;
  const info = isObject(doc.info) ? doc.info : {};
  const origin = Array.isArray(doc["x-origin"])
    ? (doc["x-origin"] as Array<{ url?: string }>).find((item) => item.url)?.url
    : undefined;
  db.prepare(
    `INSERT OR REPLACE INTO apis
     (id, provider, service, title, description, categories, logo, source, spec_url, origin_url, spec_version, updated_at)
     VALUES (@id, @provider, @service, @title, @description, @categories, @logo, @source, @spec_url, @origin_url, @spec_version, @updated_at)`,
  ).run({
    id: source.id,
    provider: source.provider,
    service: source.service,
    title: String(info.title ?? source.id),
    description: String(info.description ?? ""),
    categories: "",
    logo: "",
    source: source.source,
    spec_url: source.specPath,
    origin_url: origin ?? source.originUrl ?? source.specPath,
    spec_version: stored.specVersion,
    updated_at: new Date().toISOString(),
  });
  db.prepare(
    "INSERT OR REPLACE INTO spec_versions (api_id, spec_hash, version, fetched_at) VALUES (?, ?, ?, ?)",
  ).run(source.id, stored.specHash, stored.specVersion, new Date().toISOString());
  const insertOp = db.prepare(
    `INSERT OR REPLACE INTO operations
     (api_id, method, path, operation_id, summary, description, tags, deprecated, auth)
     VALUES (@api_id, @method, @path, @operation_id, @summary, @description, @tags, @deprecated, @auth)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO ops_fts (api_id, method, path, summary, description, tags, api_title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ops = response.operations ?? [];
  const tx = db.transaction(() => {
    for (const op of ops) {
      insertOp.run({
        api_id: source.id,
        method: op.method,
        path: op.path,
        operation_id: op.operationId ?? "",
        summary: op.summary ?? "",
        description: op.description ?? "",
        tags: (op.tags ?? []).join(" "),
        deprecated: op.deprecated ? 1 : 0,
        auth: op.auth ?? "none",
      });
      insertFts.run(
        source.id,
        op.method,
        op.path,
        op.summary ?? "",
        op.description ?? "",
        (op.tags ?? []).join(" "),
        String(info.title ?? source.id),
      );
    }
  });
  tx();
  return ops.length;
}

function sourcesFrom(from: string, cwd: string): CatalogSource[] {
  const target = path.resolve(cwd, from);
  if (!fs.existsSync(target)) throw new ApiweldError(`Catalog source not found: ${target}`);
  if (fs.statSync(target).isDirectory()) return sourcesFromDirectory(target, cwd, path.basename(target));
  const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
    apis?: Array<{ id: string; provider?: string; service?: string; spec: string; source?: string }>;
  };
  if (!parsed.apis) throw new ApiweldError(`Catalog manifest ${target} has no apis array`);
  return parsed.apis.map((api) => {
    const specPath = path.resolve(path.dirname(target), api.spec);
    return {
      id: api.id,
      provider: api.provider ?? api.id,
      service: api.service ?? api.id,
      specPath,
      source: api.source?.startsWith("file:")
        ? `file:${specPath}`
        : (api.source ?? `file:${specPath}`),
    };
  });
}

function sourcesFromDirectory(dir: string, cwd: string, name: string): CatalogSource[] {
  const root = path.resolve(cwd, dir);
  return fs
    .readdirSync(root)
    .filter((file) => /\.(json|yaml|yml)$/.test(file) && file !== "manifest.json")
    .map((file) => {
      const specPath = path.join(root, file);
      const id = file.replace(/\.(json|yaml|yml)$/, "");
      return {
        id,
        provider: name,
        service: id,
        specPath,
        source: `custom:${name}`,
        originUrl: specPath,
      };
    });
}

function requireDb(cacheDir: string): import("better-sqlite3").Database {
  const file = catalogDbPath(cacheDir);
  if (!fs.existsSync(file)) {
    throw new ApiweldError("Catalog is empty. Run `apiweld catalog build` or `apiweld catalog sync`.");
  }
  return new Database(file, { readonly: true });
}

export function toFtsQuery(input: string): string {
  const stop = new Set(["a", "an", "the", "to", "of", "for", "and", "or", "in", "on", "with"]);
  const tokens = input
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((token) => token.length > 1 && !stop.has(token)) ?? [];
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(" AND ");
}

export function searchApis(cacheDir: string, query: string, limit = 20): ApiRecord[] {
  const db = requireDb(cacheDir);
  const fts = toFtsQuery(query);
  const rows = new Map<string, ApiRecord>();
  if (fts) {
    const matched = db
      .prepare(
        `SELECT a.* FROM ops_fts JOIN apis a ON a.id = ops_fts.api_id
         WHERE ops_fts MATCH ? GROUP BY a.id ORDER BY MIN(rank) LIMIT ?`,
      )
      .all(fts, limit) as ApiRecord[];
    for (const row of matched) rows.set(row.id, row);
  }
  const like = `%${query.replaceAll("%", "")}%`;
  const direct = db
    .prepare(
      `SELECT * FROM apis WHERE id LIKE ? OR title LIKE ? OR description LIKE ? LIMIT ?`,
    )
    .all(like, like, like, limit) as ApiRecord[];
  for (const row of direct) if (!rows.has(row.id)) rows.set(row.id, row);
  db.close();
  return [...rows.values()].slice(0, limit);
}

export function searchOperations(
  cacheDir: string,
  query: string,
  api?: string,
  limit = 30,
): OperationRecord[] {
  const db = requireDb(cacheDir);
  const fts = toFtsQuery(query);
  if (!fts) {
    db.close();
    return [];
  }
  const sql = api
    ? `SELECT o.*, a.title, a.spec_version, a.updated_at, rank
       FROM ops_fts
       JOIN operations o ON o.api_id = ops_fts.api_id AND o.method = ops_fts.method AND o.path = ops_fts.path
       JOIN apis a ON a.id = o.api_id
       WHERE ops_fts MATCH ? AND o.api_id = ?
       ORDER BY rank LIMIT ?`
    : `SELECT o.*, a.title, a.spec_version, a.updated_at, rank
       FROM ops_fts
       JOIN operations o ON o.api_id = ops_fts.api_id AND o.method = ops_fts.method AND o.path = ops_fts.path
       JOIN apis a ON a.id = o.api_id
       WHERE ops_fts MATCH ?
       ORDER BY rank LIMIT ?`;
  const rows = (api
    ? db.prepare(sql).all(fts, api, limit)
    : db.prepare(sql).all(fts, limit)) as OperationRecord[];
  db.close();
  return rows;
}

export function getApi(cacheDir: string, id: string): ApiRecord | undefined {
  if (!fs.existsSync(catalogDbPath(cacheDir))) return undefined;
  const db = requireDb(cacheDir);
  const row = db.prepare("SELECT * FROM apis WHERE id = ?").get(id) as ApiRecord | undefined;
  db.close();
  return row;
}

export async function syncCatalog(
  rt: Runtime,
  opts: { url?: string; sha256?: string } = {},
): Promise<{ path: string }> {
  const settings = readSettings(rt.cacheDir);
  const url = opts.url ?? settings.catalogSnapshotUrl ?? process.env.APIWELD_CATALOG_URL;
  if (!url) {
    throw new ApiweldError(
      "No catalog snapshot URL. Set catalogSnapshotUrl in settings.json, pass --url, or run `apiweld catalog build`.",
    );
  }
  const bytes = url.startsWith("file:")
    ? fs.readFileSync(url.slice("file:".length))
    : Buffer.from(await (await fetch(url)).arrayBuffer());
  const expected = (opts.sha256 ?? settings.catalogSnapshotSha256)?.replace(/^sha256:/, "");
  if (expected) {
    const got = sha256(bytes).replace(/^sha256:/, "");
    if (got !== expected) {
      throw new ApiweldError(`Catalog checksum mismatch: expected ${expected}, got ${got}`);
    }
  }
  ensureDir(rt.cacheDir);
  const target = catalogDbPath(rt.cacheDir);
  fs.writeFileSync(target, bytes);
  return { path: target };
}
