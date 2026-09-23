import fs from "node:fs";
import path from "node:path";
import { ApiweldError } from "./errors.js";
import { ensureDir, type Runtime } from "./paths.js";

interface CacheEntry {
  etag?: string;
  lastModified?: string;
  bodyPath: string;
  fetchedAt: string;
}

interface HttpCache {
  [url: string]: CacheEntry;
}

function cacheFile(cacheDir: string): string {
  return path.join(cacheDir, "http-cache.json");
}

function readCache(cacheDir: string): HttpCache {
  const file = cacheFile(cacheDir);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as HttpCache;
}

function writeCache(cacheDir: string, cache: HttpCache): void {
  ensureDir(cacheDir);
  fs.writeFileSync(cacheFile(cacheDir), `${JSON.stringify(cache, null, 2)}\n`);
}

export async function fetchCached(
  rt: Runtime,
  url: string,
): Promise<{ file: string; etag?: string; status: number; notModified: boolean }> {
  const cache = readCache(rt.cacheDir);
  const previous = cache[url];
  if (rt.offline) {
    if (!previous || !fs.existsSync(previous.bodyPath)) {
      throw new ApiweldError(`Offline and ${url} is not in the HTTP cache`);
    }
    return { file: previous.bodyPath, etag: previous.etag, status: 200, notModified: true };
  }
  const headers: Record<string, string> = {};
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
  const response = await fetch(url, { headers });
  if (response.status === 304 && previous && fs.existsSync(previous.bodyPath)) {
    return { file: previous.bodyPath, etag: previous.etag, status: 304, notModified: true };
  }
  if (!response.ok) throw new ApiweldError(`GET ${url} failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const rawDir = path.join(rt.cacheDir, "raw");
  ensureDir(rawDir);
  const file = path.join(rawDir, `${Buffer.from(url).toString("hex").slice(0, 40)}.body`);
  fs.writeFileSync(file, bytes);
  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;
  cache[url] = { etag, lastModified, bodyPath: file, fetchedAt: new Date().toISOString() };
  writeCache(rt.cacheDir, cache);
  return { file, etag, status: response.status, notModified: false };
}
