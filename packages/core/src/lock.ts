import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prettyJson } from "./json.js";
import { projectPaths } from "./paths.js";

export interface LockApi {
  resolvedUrl: string;
  specHash: string;
  specVersion: string;
  fetchedAt: string;
  etag?: string;
  operations: string[];
  sliceHash: string;
  schemas: number;
  generator: string;
  engine: string;
  outputHash: string;
}

export interface LockFile {
  lockVersion: 1;
  apis: Record<string, LockApi>;
}

export function readLock(cwd: string): LockFile {
  const file = projectPaths(cwd).lock;
  if (!fs.existsSync(file)) return { lockVersion: 1, apis: {} };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
  return { lockVersion: 1, apis: parsed.apis ?? {} };
}

export function writeLock(cwd: string, lock: LockFile): void {
  const file = projectPaths(cwd).lock;
  const apis: Record<string, LockApi> = {};
  for (const key of Object.keys(lock.apis).sort()) {
    const entry = lock.apis[key];
    if (!entry) continue;
    apis[key] = {
      ...entry,
      operations: [...entry.operations].sort(),
    };
  }
  fs.writeFileSync(file, prettyJson({ lockVersion: 1, apis }));
}

export function hashDirectory(root: string): { hash: string; files: string[] } {
  if (!fs.existsSync(root)) return { hash: "sha256:", files: [] };
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".heyapi-logs") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return { hash: `sha256:${hash.digest("hex")}`, files };
}
