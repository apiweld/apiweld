import { createHash } from "node:crypto";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function sha256(data: string | Buffer): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function parseOperation(
  input: string,
): { method: string; path: string } | undefined {
  const match = input.trim().match(/^([A-Za-z]+)\s+(\/\S+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { method: match[1].toUpperCase(), path: match[2] };
}

export function assertApiKey(api: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(api) || api.includes("..")) {
    throw new Error(`Invalid API name "${api}"`);
  }
}
