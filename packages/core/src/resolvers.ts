import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiweldError } from "./errors.js";
import { isObject } from "./json.js";
import type { Runtime } from "./paths.js";

export interface ResolvedSource {
  kind: "file" | "http";
  url: string;
}

interface UpstreamsFile {
  [id: string]: { specUrl: string; title?: string };
}

let cachedUpstreams: UpstreamsFile | undefined;

export function loadUpstreams(): UpstreamsFile {
  if (cachedUpstreams) return cachedUpstreams;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "catalog", "upstreams.json");
    if (fs.existsSync(candidate)) {
      cachedUpstreams = JSON.parse(fs.readFileSync(candidate, "utf8")) as UpstreamsFile;
      return cachedUpstreams;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedUpstreams = {};
  return cachedUpstreams;
}

export function canonicalSource(source: string): string {
  return source.startsWith("url:") ? source.slice("url:".length) : source;
}

export async function resolveSource(
  source: string,
  rt: Runtime,
  deps?: { fetch?: typeof fetch },
): Promise<ResolvedSource> {
  const canonical = canonicalSource(source);
  if (canonical.startsWith("file:")) {
    const raw = canonical.slice("file:".length);
    const file = path.isAbsolute(raw) ? raw : path.resolve(rt.cwd, raw);
    if (!fs.existsSync(file)) throw new ApiweldError(`Spec file not found: ${file}`);
    return { kind: "file", url: file };
  }
  if (/^https?:\/\//.test(canonical)) return { kind: "http", url: canonical };
  if (canonical.startsWith("apisguru:")) {
    return resolveApisGuru(canonical.slice("apisguru:".length), rt, deps?.fetch ?? fetch);
  }
  if (canonical.startsWith("wellknown:")) {
    return resolveWellKnown(canonical.slice("wellknown:".length), rt, deps?.fetch ?? fetch);
  }
  throw new ApiweldError(
    `Unknown source "${source}". Use a URL, file:, apisguru:, or wellknown:.`,
  );
}

async function resolveApisGuru(
  id: string,
  rt: Runtime,
  fetchImpl: typeof fetch,
): Promise<ResolvedSource> {
  const curated = loadUpstreams()[id];
  if (curated?.specUrl) return { kind: "http", url: curated.specUrl };
  if (rt.offline) {
    throw new ApiweldError(`Offline and no curated upstream for apisguru:${id}`);
  }
  const metaUrl = `https://api.apis.guru/v2/specs/${id}.json`;
  const metaResponse = await fetchImpl(metaUrl);
  if (!metaResponse.ok) {
    throw new ApiweldError(`APIs.guru has no entry for ${id} (${metaResponse.status})`);
  }
  const meta = (await metaResponse.json()) as {
    preferred?: string;
    versions?: Record<string, { swaggerUrl?: string }>;
  };
  const preferred = meta.preferred ? meta.versions?.[meta.preferred] : undefined;
  const specUrl =
    preferred?.swaggerUrl ??
    Object.values(meta.versions ?? {})[0]?.swaggerUrl;
  if (!specUrl) throw new ApiweldError(`APIs.guru entry ${id} has no spec URL`);
  const specResponse = await fetchImpl(specUrl);
  if (!specResponse.ok) {
    throw new ApiweldError(`Failed to fetch ${specUrl} (${specResponse.status})`);
  }
  const spec = (await specResponse.json()) as { "x-origin"?: Array<{ url?: string }> };
  const origin = spec["x-origin"]?.find((item) => item.url)?.url;
  return { kind: "http", url: origin ?? specUrl };
}

export async function resolveWellKnown(
  domain: string,
  rt: Runtime,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedSource> {
  if (rt.offline) throw new ApiweldError(`Offline; cannot probe wellknown:${domain}`);
  const catalogUrl = `https://${domain}/.well-known/api-catalog`;
  const response = await fetchImpl(catalogUrl, {
    headers: { accept: "application/linkset+json, application/json" },
  });
  if (!response.ok) {
    throw new ApiweldError(`No API catalog at ${catalogUrl} (${response.status})`);
  }
  const body = (await response.json()) as unknown;
  const href = pickOpenApiHref(body);
  if (!href) throw new ApiweldError(`API catalog at ${catalogUrl} has no OpenAPI link`);
  const absolute = new URL(href, `https://${domain}/`).toString();
  return { kind: "http", url: absolute };
}

export function pickOpenApiHref(body: unknown): string | undefined {
  if (!isObject(body)) return undefined;
  const linkset = body.linkset;
  if (!Array.isArray(linkset)) return undefined;
  const hrefs: Array<{ href: string; type?: string }> = [];
  for (const entry of linkset) {
    if (!isObject(entry)) continue;
    for (const [key, value] of Object.entries(entry)) {
      if (key === "anchor") continue;
      const items = Array.isArray(value) ? value : [];
      for (const item of items) {
        if (!isObject(item) || typeof item.href !== "string") continue;
        hrefs.push({
          href: item.href,
          type: typeof item.type === "string" ? item.type : undefined,
        });
      }
    }
  }
  const typed = hrefs.find(
    (item) => item.type?.includes("openapi") || item.href.includes("openapi"),
  );
  return (typed ?? hrefs[0])?.href;
}
