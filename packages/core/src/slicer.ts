import { ApiweldError } from "./errors.js";
import { canonicalJson, isObject, operationKey, parseOperation, sha256 } from "./json.js";

export interface SliceResult {
  spec: Record<string, unknown>;
  sliceHash: string;
  schemas: string[];
  missing: string[];
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

export function resolveOperationRefs(
  doc: Record<string, unknown>,
  operations: string[],
): { operations: string[]; missing: string[] } {
  const byKey = new Set<string>();
  const byId = new Map<string, string[]>();
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [opPath, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !isObject(op)) continue;
      const key = operationKey(method, opPath);
      byKey.add(key);
      if (typeof op.operationId !== "string" || op.operationId.length === 0) continue;
      const matches = byId.get(op.operationId) ?? [];
      matches.push(key);
      byId.set(op.operationId, matches);
    }
  }
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const raw of operations) {
    const parsed = parseOperation(raw);
    if (parsed) {
      const key = operationKey(parsed.method, parsed.path);
      if (byKey.has(key)) resolved.push(key);
      else missing.push(key);
      continue;
    }
    const id = raw.trim();
    const matches = byId.get(id) ?? [];
    if (matches.length === 1 && matches[0]) resolved.push(matches[0]);
    else if (matches.length > 1) {
      throw new ApiweldError(`operationId ${id} matches more than one operation: ${matches.join(", ")}`);
    } else missing.push(raw);
  }
  return { operations: resolved, missing };
}

export function sliceDocument(doc: Record<string, unknown>, operations: string[]): SliceResult {
  const paths = isObject(doc.paths) ? doc.paths : {};
  const selected = new Map<string, { method: string; path: string }>();
  const resolved = resolveOperationRefs(doc, operations);
  const missing = [...resolved.missing];
  for (const key of resolved.operations) {
    const parsed = parseOperation(key);
    if (!parsed) continue;
    selected.set(key, parsed);
  }

  const slicedPaths: Record<string, unknown> = {};
  const refs = new Set<string>();
  const schemeNames = new Set<string>();
  for (const parsed of selected.values()) {
    const item = paths[parsed.path];
    if (!isObject(item)) continue;
    const method = parsed.method.toLowerCase();
    const pathItem: Record<string, unknown> = {};
    if (item.parameters) pathItem.parameters = item.parameters;
    pathItem[method] = item[method];
    slicedPaths[parsed.path] = pathItem;
    collectRefs(pathItem, refs);
    const operation = item[method];
    const security = isObject(operation) && operation.security !== undefined
      ? operation.security
      : doc.security;
    collectSchemes(security, schemeNames);
  }

  const components = copyComponents(doc, refs, schemeNames);
  const security = filterSecurity(doc.security, schemeNames);
  const spec: Record<string, unknown> = {
    openapi: typeof doc.openapi === "string" ? doc.openapi : "3.0.3",
    info: {
      title: isObject(doc.info) && typeof doc.info.title === "string" ? doc.info.title : "API",
      version: isObject(doc.info) && typeof doc.info.version === "string" ? doc.info.version : "0",
    },
    paths: slicedPaths,
  };
  if (Object.keys(components).length > 0) spec.components = components;
  if (security) spec.security = security;
  const schemas = isObject(components.schemas) ? Object.keys(components.schemas).sort() : [];
  const sliceHash = sha256(
    canonicalJson({
      components: spec.components ?? {},
      paths: slicedPaths,
      security: spec.security ?? [],
    }),
  );
  return { spec, sliceHash, schemas, missing };
}

function copyComponents(
  doc: Record<string, unknown>,
  refs: Set<string>,
  schemeNames: Set<string>,
): Record<string, unknown> {
  const source = isObject(doc.components) ? doc.components : {};
  const out: Record<string, unknown> = {};
  const pending = [...refs];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const ref = pending.pop();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const pointer = parsePointer(ref);
    if (!pointer) continue;
    const [group, name] = pointer;
    if (!group || !name) continue;
    const bucket = source[group];
    if (!isObject(bucket) || !(name in bucket)) continue;
    const current = isObject(out[group]) ? out[group] : {};
    current[name] = bucket[name];
    out[group] = current;
    const more = new Set<string>();
    collectRefs(bucket[name], more);
    for (const item of more) if (!seen.has(item)) pending.push(item);
  }
  if (schemeNames.size > 0 && isObject(source.securitySchemes)) {
    const schemes: Record<string, unknown> = {};
    for (const name of [...schemeNames].sort()) {
      if (name in source.securitySchemes) schemes[name] = source.securitySchemes[name];
    }
    if (Object.keys(schemes).length > 0) out.securitySchemes = schemes;
  }
  return out;
}

function parsePointer(ref: string): [string, string] | undefined {
  const match = ref.match(/^#\/components\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return [match[1], decodeURIComponent(match[2])];
}

function collectRefs(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
    return;
  }
  if (!isObject(node)) return;
  if (typeof node.$ref === "string") refs.add(node.$ref);
  for (const value of Object.values(node)) collectRefs(value, refs);
}

function collectSchemes(security: unknown, names: Set<string>): void {
  if (!Array.isArray(security)) return;
  for (const requirement of security) {
    if (!isObject(requirement)) continue;
    for (const name of Object.keys(requirement)) names.add(name);
  }
}

function filterSecurity(security: unknown, names: Set<string>): unknown[] | undefined {
  if (!Array.isArray(security) || names.size === 0) return undefined;
  const kept = security.filter(
    (requirement) => isObject(requirement) && Object.keys(requirement).some((name) => names.has(name)),
  );
  return kept.length > 0 ? kept : undefined;
}
